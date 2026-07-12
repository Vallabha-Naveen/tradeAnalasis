/**
 * Live trading script.
 *
 * Starts the live listener that polls a Telegram channel for new trade
 * screenshots (phase-1 GetPeerDialogs check every 500 ms, phase-2
 * GetHistory fetch only when new messages are detected) and executes
 * them via Fyers API.
 *
 * Usage: npm run live-trade
 *
 * Prerequisites:
 *   1. Run `npm run fyers-auth` to authenticate with Fyers
 *   2. Set DRY_RUN=false in .env to enable real trading (default is true)
 *
 * SHUTDOWN
 * --------
 * Handles both SIGINT (Ctrl+C) and SIGTERM (PM2/Docker stop) gracefully:
 *   - Stops the polling loop (cancels the next scheduled poll)
 *   - Disconnects Telegram client
 *   - Shuts down trading engine
 *   - Closes the SQLite database (flushes WAL)
 */

import dotenv from 'dotenv';

import { startLiveListener } from '../telegram/liveListener.js';
import { authenticate, disconnect } from '../telegram/auth.js';
import { closeDb, getDb } from '../database/db.js';
import { TradeRepository } from '../database/tradeRepository.js';
import { createTradeBotFromEnv, type TradeBot } from '../bot/tradeBot.js';
import {
  TradeManager,
  createTradeManagerConfig,
} from '../trade/tradeManager.js';
import type { TradingEngine } from '../fyers/tradingEngine.js';
import input from 'input';

dotenv.config();

/**
 * Configure the Fixie proxy URL (without activating it globally).
 *
 * WHY
 * ---
 * Fyers requires only ORDER PLACEMENT calls to come from a whitelisted
 * static IP. Read-only calls (profile, quotes, option chain, positions,
 * order book) work fine from any IP.
 *
 * So instead of setting HTTP_PROXY/HTTPS_PROXY globally (which routes ALL
 * Fyers calls through Fixie), we store the Fixie URL in a custom env var
 * (`FIXIE_URL`) and the FyersClient toggles the proxy on/off around the
 * `place_order` call only.
 *
 * This minimizes Fixie usage (1 request per trade instead of 7) and keeps
 * read calls fast and direct.
 *
 * FIXIE_URL format: http://USERNAME:PASSWORD@proxy.usefixie.com:80
 */
function configureFixieProxy(): void {
  const fixieUrl = process.env['FIXIE_URL'];
  if (!fixieUrl) {
    console.log('Fixie proxy: not configured (set FIXIE_URL in .env to enable)');
    return;
  }

  // Store in a custom env var — FyersClient.placeOrder() reads this and
  // toggles HTTPS_PROXY on/off around the place_order call.
  const safeUrl = fixieUrl.replace(/(\/\/)([^:]+):([^@]+)@/, '$1***:***@');
  console.log(`Fixie proxy configured (used for order placement only): ${safeUrl}`);
}

async function main(): Promise<void> {
  console.log('=== Live Trading Mode ===\n');

  // Configure Fixie proxy BEFORE any Fyers API calls
  configureFixieProxy();

  const channelUsername = process.env['CHANNEL_USERNAME'];
  const dryRun = process.env['DRY_RUN'] !== 'false';

  if (!channelUsername) {
    console.error('ERROR: CHANNEL_USERNAME must be set in .env file');
    process.exit(1);
  }

  console.log(`Channel: ${channelUsername}`);
  console.log(
    `Dry-run mode: ${dryRun ? 'ENABLED (no real trades)' : 'DISABLED (real trades!)'}`,
  );
  console.log(
    `Market hours: ${process.env['MARKET_OPEN_TIME'] || '09:20'} - ` +
      `${process.env['MARKET_CLOSE_TIME'] || '15:15'} IST`,
  );
  console.log();

  if (!dryRun) {
    console.log('⚠️  WARNING: Real trading is enabled!');
    console.log('⚠️  Make sure you have proper risk controls in place.');
    console.log();
    const confirm = await input.text('Type "CONFIRM" to proceed: ');
    if (confirm !== 'CONFIRM') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  let tradingEngine: TradingEngine | null = null;
  let client: Awaited<ReturnType<typeof authenticate>> | null = null;
  let tradeBot: TradeBot | null = null;
  let tradeManager: TradeManager | null = null;
  // `stopListener` cancels the polling loop and terminates the OCR worker.
  // We MUST call this BEFORE disconnecting the Telegram client, otherwise
  // an in-flight poll could error out against a dead connection during shutdown.
  let stopListener: (() => Promise<void>) | null = null;
  let shuttingDown = false;

  // Single cleanup function — idempotent, safe to call from any signal handler.
  const cleanup = async (): Promise<void> => {
    if (shuttingDown) return; // Prevent double-cleanup
    shuttingDown = true;
    console.log('\n\nShutting down...');

    // 0. Stop the trade manager FIRST — no more LTP polls or exit attempts.
    //    Open positions are NOT auto-closed on shutdown (the user is
    //    responsible for them; the next session resumes monitoring if we
    //    add persistence later).
    if (tradeManager) {
      try {
        tradeManager.stop();
        console.log('Trade manager stopped.');
      } catch (err) {
        console.error('Error stopping trade manager:', err);
      }
    }

    // 0b. Stop the trade bot (closes its long-polling connection).
    if (tradeBot) {
      try {
        tradeBot.stop();
        console.log('Trade bot stopped.');
      } catch (err) {
        console.error('Error stopping trade bot:', err);
      }
    }

    // 1. Stop the polling loop — no more new messages will be fetched.
    //    This also terminates the Tesseract OCR worker thread.
    if (stopListener) {
      try {
        await stopListener();
        console.log('Polling loop stopped.');
      } catch (err) {
        console.error('Error stopping polling loop:', err);
      }
    }

    // 2. Shut down the trading engine (cancels any in-flight order mutex).
    if (tradingEngine) {
      try {
        tradingEngine.shutdown();
        console.log('Trading engine shut down.');
      } catch (err) {
        console.error('Error shutting down trading engine:', err);
      }
    }

    // 3. Disconnect Telegram — safe now that the polling loop is stopped.
    if (client) {
      try {
        await disconnect(client);
        console.log('Telegram disconnected.');
      } catch (err) {
        console.error('Error disconnecting Telegram:', err);
      }
    }

    // 4. Close the DB (flushes WAL).
    try {
      closeDb();
      console.log('Database closed.');
    } catch (err) {
      console.error('Error closing database:', err);
    }

    process.exit(0);
  };

  // Register both signal handlers — SIGINT for terminal Ctrl+C,
  // SIGTERM for PM2/Docker/systemd stop.
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    console.log('Connecting to Telegram...');
    client = await authenticate();

    // ------------------------------------------------------------------
    // Start the trade management bot (optional — disabled if BOT_TOKEN
    // is not set in .env).
    // ------------------------------------------------------------------
    tradeBot = createTradeBotFromEnv();
    if (tradeBot) {
      console.log('Starting trade management bot...');
      const botOk = await tradeBot.start();
      if (botOk) {
        console.log('Trade bot running. Send /start to your bot in Telegram to verify.');
      } else {
        console.log('Trade bot failed to start — trades will self-manage without notifications.');
        tradeBot = null;
      }
    } else {
      console.log('Trade bot disabled (BOT_TOKEN not set). Trades will self-manage silently.');
    }

    // ------------------------------------------------------------------
    // Start the live listener. The trading engine is created INSIDE
    // startLiveListener, so we pass tradeManager=null for now and
    // attach it after we have the FyersClient.
    // ------------------------------------------------------------------
    const result = await startLiveListener(client, {
      channelUsername,
      enableTrading: true,
      tradeManager: null,
    });
    tradingEngine = result.tradingEngine;
    stopListener = result.stop;

    // ------------------------------------------------------------------
    // Build the trade manager now that we have the FyersClient.
    // We access it via a small getter on the trading engine.
    // ------------------------------------------------------------------
    if (tradingEngine) {
      const fyersClient = tradingEngine.getClient();
      if (fyersClient) {
        const repo = new TradeRepository(getDb());
        const mgrCfg = createTradeManagerConfig();
        tradeManager = new TradeManager(fyersClient, repo, tradeBot, mgrCfg);
        tradeManager.start();
        console.log(
          `Trade manager started (poll every ${mgrCfg.monitorIntervalMs}ms, ` +
            `EOD at ${mgrCfg.eodSquareOffTime} IST).`,
        );

        // --------------------------------------------------------------
        // Resume monitoring of any trades that were open when the
        // previous process exited. This queries the DB for trades with
        // no exit_reason, verifies each against Fyers' open positions,
        // and either re-registers them (position still open) or marks
        // them as closed-externally (position was closed during downtime).
        // --------------------------------------------------------------
        try {
          const resumeResult = await tradeManager.resumeFromDb();
          if (resumeResult.resumed > 0 || resumeResult.closedExternally > 0) {
            console.log(
              `Resume: ${resumeResult.resumed} trade(s) resumed, ` +
                `${resumeResult.closedExternally} closed externally, ` +
                `${resumeResult.skipped} skipped, ${resumeResult.failed} failed.`,
            );
          }
        } catch (err) {
          console.error('Error resuming trades from DB:', err);
        }

        // Attach to the live listener so future trades get registered.
        result.attachTradeManager?.(tradeManager);
      } else {
        console.log('Warning: could not obtain FyersClient — trade management disabled');
      }
    }

    console.log('\nLive trading started. Press Ctrl+C to stop.');
    console.log('Polling channel for trade signals (phase-1 check every 500ms)...\n');

    // Keep the process alive — the polling loop runs on its own timer.
    // The cleanup handler above will fire on SIGINT/SIGTERM.
  } catch (err) {
    console.error('Fatal error:', err);
    await cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
