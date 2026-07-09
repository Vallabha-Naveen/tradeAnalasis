/**
 * Live trading script.
 *
 * Starts the live listener that monitors a Telegram channel for trade
 * screenshots and executes them via Fyers API.
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
 *   - Disconnects Telegram client
 *   - Shuts down trading engine
 *   - Closes the SQLite database (flushes WAL)
 */

import dotenv from 'dotenv';

import { startLiveListener } from '../telegram/liveListener.js';
import { authenticate, disconnect } from '../telegram/auth.js';
import { closeDb } from '../database/db.js';
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
  let shuttingDown = false;

  // Single cleanup function — idempotent, safe to call from any signal handler.
  const cleanup = async (): Promise<void> => {
    if (shuttingDown) return; // Prevent double-cleanup
    shuttingDown = true;
    console.log('\n\nShutting down...');

    if (tradingEngine) {
      try {
        tradingEngine.shutdown();
        console.log('Trading engine shut down.');
      } catch (err) {
        console.error('Error shutting down trading engine:', err);
      }
    }

    if (client) {
      try {
        await disconnect(client);
        console.log('Telegram disconnected.');
      } catch (err) {
        console.error('Error disconnecting Telegram:', err);
      }
    }

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

    const result = await startLiveListener(client, {
      channelUsername,
      enableTrading: true,
    });
    tradingEngine = result.tradingEngine;

    console.log('\nLive trading started. Press Ctrl+C to stop.');
    console.log('Monitoring channel for trade signals...\n');

    // Keep the process alive — the Telegram event loop handles everything.
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
