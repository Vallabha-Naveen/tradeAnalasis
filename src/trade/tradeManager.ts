/**
 * Trade manager — monitors open trades and exits them on SL / target / EOD.
 *
 * DESIGN
 * ------
 * After a trade is placed (SELL option), the liveListener registers it here.
 * The manager keeps an in-memory map of all OPEN trades and runs a single
 * background polling loop that:
 *
 *   1. Every TRADE_MONITOR_INTERVAL_MS (default 1.5s):
 *      - Collects all open trades currently in PROGRAM mode
 *      - Batches their symbols into ONE getQuotes() call (Fyers supports
 *        multi-symbol quotes — one call for N trades, not N calls)
 *      - For each trade, checks if current LTP ≥ entry+SL or ≤ entry−target
 *      - If yes → places MARKET BUY via FyersClient.squareOffPosition(),
 *        marks the trade as EXITED, updates the DB, edits the bot message
 *
 *   2. Every tick also checks EOD:
 *      - If current IST time ≥ EOD_SQUARE_OFF_TIME → exit ALL program-managed
 *        open trades with reason=EOD
 *
 * TOGGLING MODE
 * -------------
 * The bot calls setMode(tradeId, 'PROGRAM' | 'MANUAL') when the user taps
 * an inline button. MANUAL mode removes the trade from the polling batch
 * (the program stops monitoring). Toggling back to PROGRAM resumes it —
 * the SL/target prices are NOT recomputed; they're still relative to the
 * ORIGINAL entry price (so if you toggled to MANUAL at +10 profit and the
 * LTP is now back at entry, the original SL/target still apply).
 *
 * DRY RUN
 * -------
 * In dry-run mode the trade is tracked but no real BUY order is placed on
 * exit — the manager logs what it WOULD have done and marks the trade
 * exited with the computed P&L.
 *
 * CONCURRENCY
 * -----------
 * The polling loop is a single self-scheduling setTimeout chain (like the
 * liveListener). Exits are serialized via an AsyncMutex to prevent
 * overlapping Fyers calls. Each trade can only be exited once — a
 * CAS-style `status` field guards against double-exit.
 */

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import { AsyncMutex } from '../utils/concurrency.js';
import type { FyersClient } from '../fyers/client.js';
import type { TradeRepository, OpenManagedTrade } from '../database/tradeRepository.js';
import type { TradeBot, TradeMode, ExitReason, TradeNotification } from '../bot/tradeBot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal representation of a managed (open) trade. */
interface ManagedTrade {
  /** DB trade.id — primary key */
  tradeId: number;
  /** Underlying for SL/target lookup */
  underlying: 'NIFTY' | 'BANKNIFTY';
  /** Fully-qualified Fyers option symbol */
  fyersSymbol: string;
  /** Quantity (units, not lots) */
  qty: number;
  /** Approximate entry price (option LTP at SELL order time) */
  entryPrice: number;
  /** SL price = entryPrice + slPoints (premium rose against seller) */
  slPrice: number;
  /** Target price = entryPrice - targetPoints (premium fell in favour) */
  targetPrice: number;
  /** Current mode — only PROGRAM-mode trades are polled */
  mode: TradeMode;
  /** OPEN = still being monitored, EXITED = closed */
  status: 'OPEN' | 'EXITED';
  /** Telegram bot message ID (for in-place edits). Null if bot disabled. */
  botMessageId: number | null;
  /** Static notification details (for composing bot messages on exit) */
  notification: TradeNotification;
  /** Dry-run flag */
  dryRun: boolean;
  /** Timestamp the trade was registered */
  placedAt: Date;
}

export interface TradeManagerConfig {
  /** Polling interval in ms */
  monitorIntervalMs: number;
  /** EOD square-off time in "HH:MM" IST */
  eodSquareOffTime: string;
  /** Dry-run flag */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reasonable minimum polling interval — protects against misconfiguration. */
const MIN_MONITOR_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// TradeManager
// ---------------------------------------------------------------------------

export class TradeManager {
  private fyersClient: FyersClient;
  private repo: TradeRepository;
  private bot: TradeBot | null;
  private config: TradeManagerConfig;

  /** Open trades keyed by tradeId. */
  private trades = new Map<number, ManagedTrade>();

  /** Background loop state. */
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private loopInFlight = false;

  /** Serializes exit operations (Fyers order placement). */
  private exitMutex = new AsyncMutex();

  /** True once EOD square-off has fired (prevents re-firing every tick after 15:15). */
  private eodFired = false;

  /** Tick counter for periodic position reconciliation. */
  private tickCount = 0;

  /**
   * Run position reconciliation every N ticks.
   *
   * At the default 1.5s interval, 10 ticks ≈ 15 seconds. This adds one
   * getPositions() API call every 15s — negligible load. The reconciliation
   * catches manual closes / external exits that happen between SL/target
   * checks, so the program doesn't keep polling LTP for a dead position
   * and fire a spurious BUY when SL/target is eventually hit.
   */
  private readonly RECONCILE_EVERY_N_TICKS = 10;

  constructor(
    fyersClient: FyersClient,
    repo: TradeRepository,
    bot: TradeBot | null,
    config: TradeManagerConfig,
  ) {
    this.fyersClient = fyersClient;
    this.repo = repo;
    this.bot = bot;
    this.config = config;

    // Register the toggle callback so the bot can call into us
    if (this.bot) {
      this.bot.onToggle(async (tradeId, newMode) => this.setMode(tradeId, newMode));
      this.bot.onForceClose(async (tradeId) => this.forceClose(tradeId));
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the background polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.eodFired = false;
    this.scheduleNext(0);
    logger.info(
      `TradeManager: started — polling every ${this.config.monitorIntervalMs}ms, ` +
        `EOD square-off at ${this.config.eodSquareOffTime} IST`,
    );
  }

  /** Stop the polling loop. Does NOT exit open trades — caller decides. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('TradeManager: stopped');
  }

  // -------------------------------------------------------------------------
  // Trade registration
  // -------------------------------------------------------------------------

  /**
   * Register a newly-placed trade for monitoring.
   *
   * Called by the liveListener immediately after executeOrder() succeeds.
   * Sends the bot notification (if bot is running) and stores the trade
   * in the in-memory map. Default mode is PROGRAM (per the user's chosen
   * "initial state = program manages" answer).
   *
   * @returns The bot message ID (or null if bot disabled) — caller stores
   *          this in the DB for later editing.
   */
  async registerTrade(input: {
    tradeId: number;
    underlying: 'NIFTY' | 'BANKNIFTY';
    fyersSymbol: string;
    strike: number;
    optionType: 'CE' | 'PE';
    qty: number;
    entryPrice: number;
    fyersOrderId?: string;
    dryRun: boolean;
  }): Promise<{ botMessageId: number | null }> {
    const slPoints = this.readPointsConfig(input.underlying, 'SL');
    const targetPoints = this.readPointsConfig(input.underlying, 'TARGET');

    const managed: ManagedTrade = {
      tradeId: input.tradeId,
      underlying: input.underlying,
      fyersSymbol: input.fyersSymbol,
      qty: input.qty,
      entryPrice: input.entryPrice,
      slPrice: input.entryPrice + slPoints,
      targetPrice: input.entryPrice - targetPoints,
      mode: 'PROGRAM', // default per user's clarification
      status: 'OPEN',
      botMessageId: null,
      dryRun: input.dryRun,
      placedAt: new Date(),
      notification: {
        tradeId: input.tradeId,
        underlying: input.underlying,
        optionType: input.optionType,
        strike: input.strike,
        fyersSymbol: input.fyersSymbol,
        qty: input.qty,
        entryPrice: input.entryPrice,
        slPoints,
        targetPoints,
        fyersOrderId: input.fyersOrderId,
        dryRun: input.dryRun,
      },
    };

    // Send the bot notification (if enabled) BEFORE adding to the map,
    // so the message ID is available even if the polling loop fires
    // immediately and tries to exit the trade.
    let botMessageId: number | null = null;
    if (this.bot) {
      botMessageId = await this.bot.sendTradePlaced(managed.notification);
      if (botMessageId === null) {
        // Bot was running but sendMessage failed — sendTradePlaced
        // already logged the error. Warn here too so it's visible at
        // warn level in the console.
        logger.warn(
          `TradeManager: trade ${input.tradeId} placed but bot notification FAILED to send. ` +
            'Check the error log above. The trade WILL still be monitored.',
        );
      }
    } else {
      logger.warn(
        `TradeManager: trade ${input.tradeId} placed but NO bot is configured — ` +
          'no Telegram notification will be sent.\n' +
          '  → To enable notifications, set BOT_TOKEN and TELEGRAM_USER_ID in .env,\n' +
          '    send /start to your bot in Telegram, then restart.\n' +
          '  → The trade WILL still be monitored (SL/target/EOD) by the program.',
      );
    }
    managed.botMessageId = botMessageId;

    // Persist to DB (including strike/qty/dryRun so resume-on-startup can
    // reconstruct the full trade state from the DB alone).
    this.repo.updateTradeManagement(input.tradeId, {
      fyersOrderId: input.fyersOrderId ?? null,
      fyersSymbol: input.fyersSymbol,
      entryPrice: input.entryPrice,
      tradeMode: 'PROGRAM',
      botMessageId,
      strike: input.strike,
      quantity: input.qty,
      dryRun: input.dryRun,
    });

    this.trades.set(input.tradeId, managed);

    logger.info(
      `TradeManager: registered trade ${input.tradeId} ` +
        `(${input.underlying} ${input.strike} ${input.optionType} qty=${input.qty} ` +
        `entry=₹${input.entryPrice.toFixed(2)} SL=₹${managed.slPrice.toFixed(2)} ` +
        `target=₹${managed.targetPrice.toFixed(2)} botMsg=${botMessageId ?? 'none'})`,
    );

    return { botMessageId };
  }

  // -------------------------------------------------------------------------
  // Resume on startup
  // -------------------------------------------------------------------------

  /**
   * Resume monitoring of trades that were open when the previous process
   * exited.
   *
   * Called once at startup (after `start()`) by liveTrade.ts. The method:
   *   1. Queries the DB for trades with `exit_reason IS NULL`
   *   2. For each, verifies against Fyers that the position is actually
   *      still open (skipped for dry-run trades — they have no real position)
   *   3. If the position is open → re-registers the trade in the in-memory
   *      map, restores its last-known mode (PROGRAM / MANUAL), and edits
   *      the bot message with a "↩️ Resumed after restart" note
   *   4. If the position is NOT open → the trade was closed externally
   *      during downtime (user closed manually, or Fyers auto-squared-off
   *      at EOD). Marks it EXITED with reason=EXTERNAL, edits the bot
   *      message to show the final state.
   *
   * BEST-EFFORT: errors for individual trades are logged but don't abort
   * the whole resume. The polling loop is already running by the time this
   * is called, so any successfully-resumed trade is immediately monitored.
   *
   * @returns summary counts for logging
   */
  async resumeFromDb(): Promise<{
    resumed: number;
    closedExternally: number;
    skipped: number;
    failed: number;
  }> {
    const counts = { resumed: 0, closedExternally: 0, skipped: 0, failed: 0 };

    let openTrades: OpenManagedTrade[];
    try {
      openTrades = this.repo.findOpenManagedTrades();
    } catch (err) {
      logger.error('TradeManager: resume — failed to query open trades from DB', {
        error: errToString(err),
      });
      return counts;
    }

    if (openTrades.length === 0) {
      logger.info('TradeManager: resume — no open trades found in DB (clean start)');
      return counts;
    }

    logger.info(`TradeManager: resume — found ${openTrades.length} open trade(s) in DB`);

    // Fetch all open Fyers positions ONCE (one API call) for verification.
    // For dry-run trades, we skip the verification — they have no real
    // position but should still be resumed for in-memory tracking.
    let fyersPositions: Map<string, { qty: number; pnl: number }> = new Map();
    const hasRealTrades = openTrades.some((t) => !t.dryRun);
    if (hasRealTrades) {
      try {
        fyersPositions = await this.fyersClient.getOpenPositionsMap();
        logger.info(
          `TradeManager: resume — Fyers reports ${fyersPositions.size} open position(s)`,
        );
        // Log each position for debugging — helps diagnose why a trade
        // was resumed vs. marked closed-externally
        if (fyersPositions.size > 0) {
          for (const [sym, pos] of fyersPositions) {
            logger.info(
              `TradeManager: resume — Fyers position: ${sym} qty=${pos.qty} pnl=${pos.pnl}`,
            );
          }
        }
      } catch (err) {
        logger.error(
          'TradeManager: resume — failed to fetch Fyers positions; will assume all DB trades are still open (risky)',
          { error: errToString(err) },
        );
        // If we can't verify, assume all are open — safer than marking
        // everything closed-externally (which would lose monitoring).
      }
    }

    // Log each DB trade and whether it was found in Fyers positions
    for (const ot of openTrades) {
      const inFyers = fyersPositions.has(ot.fyersSymbol);
      const fyersQty = inFyers ? fyersPositions.get(ot.fyersSymbol)?.qty : 'N/A';
      logger.info(
        `TradeManager: resume — DB trade ${ot.id}: ${ot.fyersSymbol} ` +
          `DB_qty=${ot.quantity} dryRun=${ot.dryRun} ` +
          `inFyers=${inFyers} fyersQty=${fyersQty}`,
      );
    }

    for (const ot of openTrades) {
      try {
        // Skip trades with incomplete data (legacy rows without symbol/qty/strike)
        if (!ot.symbol || !ot.quantity || ot.strike === null) {
          logger.warn(
            `TradeManager: resume — trade ${ot.id} has incomplete data ` +
              `(symbol=${ot.symbol}, qty=${ot.quantity}, strike=${ot.strike}), skipping`,
          );
          counts.skipped++;
          continue;
        }

        const underlying = ot.symbol as 'NIFTY' | 'BANKNIFTY';
        const optionType = (ot.optionType ?? 'CE') as 'CE' | 'PE';

        // For real (non-dry-run) trades, verify the position still exists.
        let positionStillOpen = true;
        if (!ot.dryRun) {
          positionStillOpen = fyersPositions.has(ot.fyersSymbol);
        }

        if (!positionStillOpen) {
          // Position was closed externally during downtime.
          // Try to find the fill price in today's order book (best-effort).
          const exitPrice = await this.tryFindExternalExitPrice(ot);
          const pnl = exitPrice > 0 ? (ot.entryPrice - exitPrice) * ot.quantity : 0;

          this.repo.updateTradeExit(ot.id, {
            exitPrice,
            exitTime: new Date().toISOString(),
            exitReason: 'EXTERNAL',
            realizedPnl: pnl,
          });

          // Edit the bot message if we have one
          if (this.bot && ot.botMessageId) {
            const notification = this.buildNotificationFromDb(ot, underlying, optionType);
            await this.bot
              .editTradeMessageExited(ot.id, ot.botMessageId, notification, {
                reason: 'EXTERNAL',
                exitPrice,
                pnl,
                mode: ot.tradeMode,
              })
              .catch((err) => {
                logger.debug('TradeManager: resume — bot edit on external-close failed', {
                  error: errToString(err),
                  tradeId: ot.id,
                });
              });
          }

          logger.info(
            `TradeManager: resume — trade ${ot.id} was closed externally during downtime ` +
              `(exitPrice=${exitPrice > 0 ? '₹' + exitPrice.toFixed(2) : 'unknown'})`,
          );
          counts.closedExternally++;
          continue;
        }

        // Position is still open (or dry-run) → re-register for monitoring.
        const slPoints = this.readPointsConfig(underlying, 'SL');
        const targetPoints = this.readPointsConfig(underlying, 'TARGET');

        const notification: TradeNotification = {
          tradeId: ot.id,
          underlying,
          optionType,
          strike: ot.strike,
          fyersSymbol: ot.fyersSymbol,
          qty: ot.quantity,
          entryPrice: ot.entryPrice,
          slPoints,
          targetPoints,
          fyersOrderId: ot.fyersOrderId ?? undefined,
          dryRun: ot.dryRun,
        };

        const managed: ManagedTrade = {
          tradeId: ot.id,
          underlying,
          fyersSymbol: ot.fyersSymbol,
          qty: ot.quantity,
          entryPrice: ot.entryPrice,
          slPrice: ot.entryPrice + slPoints,
          targetPrice: ot.entryPrice - targetPoints,
          mode: ot.tradeMode,
          status: 'OPEN',
          botMessageId: ot.botMessageId,
          dryRun: ot.dryRun,
          placedAt: new Date(), // we don't have the original; use now
          notification,
        };

        this.trades.set(ot.id, managed);

        // Edit the bot message to show current state + resumed note
        if (this.bot && ot.botMessageId) {
          await this.bot
            .editTradeMessage(
              ot.id,
              ot.botMessageId,
              notification,
              ot.tradeMode,
              '↩️ Resumed after restart',
            )
            .catch((err) => {
              logger.debug('TradeManager: resume — bot edit on resume failed', {
                error: errToString(err),
                tradeId: ot.id,
              });
            });
        }

        logger.info(
          `TradeManager: resume — trade ${ot.id} resumed ` +
            `(mode=${ot.tradeMode}, ${underlying} ${ot.strike} ${optionType} ` +
            `qty=${ot.quantity} entry=₹${ot.entryPrice.toFixed(2)} ` +
            `SL=₹${managed.slPrice.toFixed(2)} target=₹${managed.targetPrice.toFixed(2)})`,
        );
        counts.resumed++;
      } catch (err) {
        logger.error(`TradeManager: resume — failed to resume trade ${ot.id}`, {
          error: errToString(err),
        });
        counts.failed++;
      }
    }

    logger.info(
      `TradeManager: resume complete — ${counts.resumed} resumed, ` +
        `${counts.closedExternally} closed externally, ` +
        `${counts.skipped} skipped, ${counts.failed} failed`,
    );
    return counts;
  }

  /**
   * Try to find the fill price of an externally-closed position by
   * scanning today's Fyers order book for a BUY order matching the symbol.
   *
   * Returns 0 if no matching BUY order is found (e.g., the position was
   * closed on a previous trading day, or the order book doesn't go back
   * far enough). The caller treats 0 as "unknown P&L".
   */
  private async tryFindExternalExitPrice(ot: OpenManagedTrade): Promise<number> {
    try {
      const book = await this.fyersClient.getOrderBook();
      const rawOrders: any[] = book?.orderBook ?? book?.orderBag ?? [];
      // Look for BUY orders (side=1) for the same symbol, status filled (2),
      // placed AFTER our SELL order. We don't have the SELL timestamp
      // precisely, so we just take the most recent filled BUY for this symbol.
      const matchingBuys = rawOrders
        .filter((o) => o.symbol === ot.fyersSymbol)
        .filter((o) => Number(o.side) === 1) // BUY
        .filter((o) => Number(o.status) === 2) // filled
        .filter((o) => Number(o.qty) === ot.quantity)
        .sort((a, b) => Number(b.orderDateTime ?? 0) - Number(a.orderDateTime ?? 0));

      if (matchingBuys.length > 0) {
        const tp = Number(matchingBuys[0]!.traded_price ?? matchingBuys[0]!.tradedPrice ?? 0);
        if (tp > 0) return tp;
      }
      return 0;
    } catch (err) {
      logger.debug('TradeManager: tryFindExternalExitPrice failed', {
        error: errToString(err),
        tradeId: ot.id,
      });
      return 0;
    }
  }

  /** Build a TradeNotification from a DB row (for bot message composition). */
  private buildNotificationFromDb(
    ot: OpenManagedTrade,
    underlying: 'NIFTY' | 'BANKNIFTY',
    optionType: 'CE' | 'PE',
  ): TradeNotification {
    const slPoints = this.readPointsConfig(underlying, 'SL');
    const targetPoints = this.readPointsConfig(underlying, 'TARGET');
    return {
      tradeId: ot.id,
      underlying,
      optionType,
      strike: ot.strike ?? 0,
      fyersSymbol: ot.fyersSymbol,
      qty: ot.quantity ?? 0,
      entryPrice: ot.entryPrice,
      slPoints,
      targetPoints,
      fyersOrderId: ot.fyersOrderId ?? undefined,
      dryRun: ot.dryRun,
    };
  }

  /**
   * Toggle a trade between PROGRAM and MANUAL mode.
   * Called when the user taps an inline button.
   *
   * On success, edits the bot message in place to reflect the new state.
   * On failure (trade not found / already exited), returns success=false.
   */
  async setMode(tradeId: number, newMode: TradeMode): Promise<{
    success: boolean;
    newMode?: TradeMode;
    reason?: string;
  }> {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      return { success: false, reason: 'Trade not found (may have been closed already)' };
    }
    if (trade.status === 'EXITED') {
      return { success: false, reason: 'Trade already closed' };
    }
    if (trade.mode === newMode) {
      // Idempotent — still update the message to be safe (in case it was
      // out of sync). Return success.
      logger.debug(`TradeManager: trade ${tradeId} already in ${newMode} mode`);
      if (this.bot && trade.botMessageId) {
        await this.bot.editTradeMessage(tradeId, trade.botMessageId, trade.notification, newMode);
      }
      return { success: true, newMode };
    }

    trade.mode = newMode;

    // Persist mode change to DB
    this.repo.updateTradeManagement(tradeId, { tradeMode: newMode });

    // Edit the bot message in place
    if (this.bot && trade.botMessageId) {
      await this.bot.editTradeMessage(tradeId, trade.botMessageId, trade.notification, newMode);
    }

    logger.info(`TradeManager: trade ${tradeId} toggled → ${newMode}`);
    return { success: true, newMode };
  }

  // -------------------------------------------------------------------------
  // Force close (manual override)
  // -------------------------------------------------------------------------

  /**
   * Force-close a trade — mark it as EXITED WITHOUT placing a BUY order.
   *
   * Use this when:
   *   - You've already closed the position manually in the Fyers app
   *   - The position was auto-squared-off by Fyers (e.g. EOD)
   *   - The reconciliation failed to detect the close
   *   - You want to stop monitoring for any reason
   *
   * The trade is marked as EXITED with reason='MANUAL'. No BUY order is
   * placed — this is purely a bookkeeping operation. P&L is computed using
   * the current LTP (best-effort).
   *
   * @param tradeId DB trade ID
   * @returns success/failure result
   */
  async forceClose(tradeId: number): Promise<{ success: boolean; reason?: string }> {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      return { success: false, reason: 'Trade not found (may have been closed already or never registered)' };
    }
    if (trade.status === 'EXITED') {
      return { success: false, reason: 'Trade already closed' };
    }

    // Fetch current LTP for best-effort P&L
    const ltp = await this.fetchLtpSafe(trade.fyersSymbol);
    const exitPrice = ltp > 0 ? ltp : trade.entryPrice;
    const pnl = (trade.entryPrice - exitPrice) * trade.qty;

    trade.status = 'EXITED';

    // Update DB
    this.repo.updateTradeExit(tradeId, {
      exitPrice,
      exitTime: new Date().toISOString(),
      exitReason: 'MANUAL',
      realizedPnl: pnl,
    });

    // Edit bot message to final state
    if (this.bot && trade.botMessageId) {
      await this.bot
        .editTradeMessageExited(tradeId, trade.botMessageId, trade.notification, {
          reason: 'MANUAL',
          exitPrice,
          pnl,
          mode: trade.mode,
        })
        .catch((err) => {
          logger.debug('TradeManager: forceClose — bot edit failed', {
            error: errToString(err),
            tradeId,
          });
        });
    }

    logger.info(
      `TradeManager: trade ${tradeId} FORCE-CLOSED — reason=MANUAL ` +
        `exit=₹${exitPrice.toFixed(2)} P&L=${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
    );
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Background polling loop
  // -------------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    const delay = Math.max(delayMs, 0);
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      if (this.loopInFlight) {
        // Previous tick still running — skip and reschedule.
        this.scheduleNext(this.config.monitorIntervalMs);
        return;
      }
      this.loopInFlight = true;
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error('TradeManager: poll iteration failed', { error: errToString(err) });
      } finally {
        this.loopInFlight = false;
        if (this.running) {
          this.scheduleNext(this.config.monitorIntervalMs);
        }
      }
    }, delay);
  }

  /**
   * One polling iteration:
   *   1. Check EOD — if past EOD time, exit all program-managed trades.
   *   2. Periodically (every N ticks) reconcile positions with Fyers —
   *      detect trades that were closed externally (manually by user, or
   *      auto-squared-off) so we don't keep monitoring dead positions.
   *   3. Batch-fetch LTPs for all open PROGRAM trades and check SL/target.
   */
  private async pollOnce(): Promise<void> {
    const openTrades = Array.from(this.trades.values()).filter((t) => t.status === 'OPEN');
    if (openTrades.length === 0) return;

    this.tickCount++;

    // ----- EOD check -----
    if (this.isPastEod() && !this.eodFired) {
      this.eodFired = true;
      logger.info('TradeManager: EOD reached — squaring off all program-managed trades');
      const programTrades = openTrades.filter((t) => t.mode === 'PROGRAM');
      for (const trade of programTrades) {
        await this.exitTrade(trade, 'EOD');
      }
      // MANUAL-mode trades at EOD are NOT auto-closed — the user is
      // responsible. Log a warning so the operator knows.
      const manualRemaining = openTrades.filter((t) => t.mode === 'MANUAL');
      if (manualRemaining.length > 0) {
        logger.warn(
          `TradeManager: ${manualRemaining.length} MANUAL trade(s) still open at EOD — not auto-closed ` +
            `(user is managing). Trade IDs: ${manualRemaining.map((t) => t.tradeId).join(', ')}`,
        );
        if (this.bot) {
          for (const t of manualRemaining) {
            if (t.botMessageId) {
              await this.bot.editTradeMessageExited(t.tradeId, t.botMessageId, t.notification, {
                reason: 'EOD',
                exitPrice: t.entryPrice, // unknown until user closes
                pnl: 0,
                mode: 'MANUAL',
              }).catch(() => {});
            }
          }
        }
      }
      return;
    }

    // ----- Periodic position reconciliation -----
    // Every N ticks, fetch all open Fyers positions and check whether each
    // of our tracked trades still has a matching position. If not, the
    // position was closed externally (manually by user, or auto-squared-off
    // by Fyers). Mark those trades as EXITED with reason=EXTERNAL so we
    // don't keep polling LTP for a dead position — and more importantly,
    // don't fire a spurious BUY when SL/target is eventually hit.
    let currentOpenTrades = openTrades;
    if (this.tickCount % this.RECONCILE_EVERY_N_TICKS === 0) {
      await this.reconcilePositions(openTrades);
      // Re-filter after reconciliation (some trades may have been marked EXITED)
      currentOpenTrades = Array.from(this.trades.values()).filter((t) => t.status === 'OPEN');
      if (currentOpenTrades.length === 0) return;
    }

    // ----- SL / target check -----
    const programTrades = currentOpenTrades.filter((t) => t.mode === 'PROGRAM');
    if (programTrades.length === 0) return;

    // Batch-fetch LTPs in one call
    const symbols = programTrades.map((t) => t.fyersSymbol);
    let quotes: Map<string, number>;
    try {
      quotes = await this.fetchLtps(symbols);
    } catch (err) {
      logger.error('TradeManager: failed to fetch quotes', { error: errToString(err) });
      return;
    }

    // Check each trade
    for (const trade of programTrades) {
      const ltp = quotes.get(trade.fyersSymbol);
      if (ltp === undefined) {
        logger.debug(`TradeManager: no quote for ${trade.fyersSymbol} (trade ${trade.tradeId})`);
        continue;
      }

      // SL: premium rose against seller
      if (ltp >= trade.slPrice) {
        logger.info(
          `TradeManager: SL hit for trade ${trade.tradeId} ` +
            `(LTP ₹${ltp.toFixed(2)} ≥ SL ₹${trade.slPrice.toFixed(2)})`,
        );
        await this.exitTrade(trade, 'SL', ltp);
        continue;
      }

      // Target: premium fell in seller's favour
      if (ltp <= trade.targetPrice) {
        logger.info(
          `TradeManager: Target hit for trade ${trade.tradeId} ` +
            `(LTP ₹${ltp.toFixed(2)} ≤ Target ₹${trade.targetPrice.toFixed(2)})`,
        );
        await this.exitTrade(trade, 'TARGET', ltp);
        continue;
      }
    }
  }

  /**
   * Reconcile tracked trades against Fyers' open positions.
   *
   * For each tracked OPEN trade (both PROGRAM and MANUAL mode), check if
   * Fyers still reports an open position for that symbol. If not, the
   * position was closed externally — mark the trade as EXITED with
   * reason=EXTERNAL.
   *
   * This catches:
   *   - User manually closed the position in the Fyers app
   *   - Fyers auto-squared-off the position (e.g. weekly expiry settlement)
   *   - Another program/script closed the position
   *
   * Without this, the trade manager would keep polling LTP for a dead
   * position and — critically — fire a spurious MARKET BUY when SL/target
   * is eventually hit, OPENING A NEW LONG POSITION. That's a real-money bug.
   *
   * Dry-run trades are skipped (no real Fyers position to verify).
   */
  private async reconcilePositions(trades: ManagedTrade[]): Promise<void> {
    // Only reconcile real (non-dry-run) trades that are still OPEN
    const realTrades = trades.filter((t) => !t.dryRun && t.status === 'OPEN');
    if (realTrades.length === 0) return;

    let positions: Map<string, { qty: number; pnl: number }>;
    try {
      positions = await this.fyersClient.getOpenPositionsMap();
    } catch (err) {
      logger.warn('TradeManager: reconcile — failed to fetch positions, skipping this tick', {
        error: errToString(err),
      });
      return;
    }

    for (const trade of realTrades) {
      // Re-check status — a previous iteration in this loop may have exited it
      if (trade.status === 'EXITED') continue;

      const pos = positions.get(trade.fyersSymbol);
      const posQty = pos ? Math.abs(Number(pos.qty ?? 0)) : 0;

      if (!pos || posQty < trade.qty) {
        // Position is gone (or partially closed). Mark as EXTERNAL exit.
        logger.info(
          `TradeManager: reconcile — trade ${trade.tradeId} (${trade.fyersSymbol}) ` +
            `position no longer open on Fyers (expected qty=${trade.qty}, found qty=${posQty}). ` +
            `Marking as EXTERNAL exit — user likely closed manually.`,
        );

        // Fetch current LTP for best-effort exit price + P&L
        const ltp = await this.fetchLtpSafe(trade.fyersSymbol);
        const exitPrice = ltp > 0 ? ltp : trade.entryPrice;
        const pnl = (trade.entryPrice - exitPrice) * trade.qty;

        trade.status = 'EXITED';
        this.repo.updateTradeExit(trade.tradeId, {
          exitPrice,
          exitTime: new Date().toISOString(),
          exitReason: 'EXTERNAL',
          realizedPnl: pnl,
        });

        if (this.bot && trade.botMessageId) {
          await this.bot
            .editTradeMessageExited(trade.tradeId, trade.botMessageId, trade.notification, {
              reason: 'EXTERNAL',
              exitPrice,
              pnl,
              mode: trade.mode,
            })
            .catch((err) => {
              logger.debug('TradeManager: reconcile — bot edit failed', {
                error: errToString(err),
                tradeId: trade.tradeId,
              });
            });
        }

        logger.info(
          `TradeManager: trade ${trade.tradeId} EXITED via reconcile — reason=EXTERNAL ` +
            `exit=₹${exitPrice.toFixed(2)} P&L=${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
        );
      }
    }
  }

  /**
   * Exit a single trade: place MARKET BUY, mark EXITED, update DB, edit bot message.
   * Serialized via exitMutex to prevent overlapping Fyers calls.
   *
   * The `triggerLtp` is the LTP that caused the exit (for P&L calculation).
   * If omitted (EOD case), we use the LTP at exit time.
   */
  private async exitTrade(
    trade: ManagedTrade,
    reason: ExitReason,
    triggerLtp?: number,
  ): Promise<void> {
    // CAS guard — only one exit per trade
    if (trade.status === 'EXITED') {
      logger.debug(`TradeManager: trade ${trade.tradeId} already exited, skipping`);
      return;
    }

    await this.exitMutex.run(async () => {
      // Re-check inside the mutex (another tick may have exited it)
      if (trade.status === 'EXITED') return;

      let exitPrice: number;
      let buyOrderId: string | null = null;

      if (trade.dryRun) {
        // Dry-run: don't actually place the BUY. Use trigger LTP (or fetch one).
        exitPrice = triggerLtp ?? (await this.fetchLtpSafe(trade.fyersSymbol)) ?? trade.entryPrice;
        logger.info(
          `[DRY RUN] TradeManager: would place MARKET BUY for trade ${trade.tradeId} ` +
            `(${trade.fyersSymbol} qty=${trade.qty} @ ~₹${exitPrice.toFixed(2)}, reason=${reason})`,
        );
      } else {
        // ----------------------------------------------------------------
        // CRITICAL: Verify the position is still open before placing BUY.
        // The user may have closed it manually in the Fyers app. If we
        // place a BUY without checking, we'd OPEN A NEW LONG POSITION
        // instead of closing the short — that's a real-money bug.
        // ----------------------------------------------------------------
        let positionStillOpen = true;
        try {
          const positions = await this.fyersClient.getOpenPositionsMap();
          const pos = positions.get(trade.fyersSymbol);
          // Position is considered "still open" if it exists AND has
          // at least the expected qty. Partial closes (|qty| < trade.qty)
          // are treated as "closed" to avoid over-closing.
          if (!pos || Math.abs(Number(pos.qty ?? 0)) < trade.qty) {
            positionStillOpen = false;
          }
        } catch (err) {
          // If we can't verify, proceed with the BUY — better to attempt
          // the close than to skip it (if the position IS still open,
          // skipping would leave it unmanaged). Log a warning.
          logger.warn(
            `TradeManager: could not verify position for trade ${trade.tradeId} ` +
              `before exit — proceeding with BUY anyway (risk: position may already be closed)`,
            { error: errToString(err) },
          );
        }

        if (!positionStillOpen) {
          // Position was closed externally (user closed manually, or
          // Fyers auto-squared-off). Do NOT place a BUY. Mark as
          // EXTERNAL exit with the trigger LTP as best-effort exit price.
          logger.info(
            `TradeManager: position for trade ${trade.tradeId} (${trade.fyersSymbol}) ` +
              `is NO LONGER OPEN — skipping BUY (user likely closed manually). ` +
              `Marking as EXTERNAL exit.`,
          );
          exitPrice = triggerLtp ?? (await this.fetchLtpSafe(trade.fyersSymbol)) ?? trade.entryPrice;

          // Fall through to the common exit-recording path below with
          // reason overridden to EXTERNAL and buyOrderId staying null.
          reason = 'EXTERNAL';
        } else {
          // Position is still open — proceed with the BUY.
          try {
            buyOrderId = await this.fyersClient.squareOffPosition(
              trade.fyersSymbol,
              trade.qty,
              `exit${trade.tradeId}`.slice(0, 25),
            );
            // Try to fetch the actual fill price from the order book.
            // MARKET orders fill near-instantly, but the order book may
            // take a moment to update — retry once after 500ms.
            exitPrice = await this.fetchFillPrice(buyOrderId);
            if (exitPrice === 0) {
              await new Promise((r) => setTimeout(r, 500));
              exitPrice = await this.fetchFillPrice(buyOrderId);
            }
            if (exitPrice === 0) {
              // Could not get fill price — fall back to trigger LTP
              logger.warn(
                `TradeManager: could not fetch fill price for order ${buyOrderId}, using trigger LTP`,
              );
              exitPrice = triggerLtp ?? trade.entryPrice;
            }
          } catch (err) {
            logger.error(
              `TradeManager: square-off FAILED for trade ${trade.tradeId} — position may still be open!`,
              { error: errToString(err) },
            );
            // Don't mark as EXITED — leave it OPEN so the next tick can retry.
            return;
          }
        }
      }

      // Compute P&L.
      // For option SELLING: P&L = (entryPrice - exitPrice) * qty
      //   - exit < entry → profit (premium decayed)
      //   - exit > entry → loss (premium rose)
      const pnl = (trade.entryPrice - exitPrice) * trade.qty;

      trade.status = 'EXITED';

      // Update DB
      this.repo.updateTradeExit(trade.tradeId, {
        exitPrice,
        exitTime: new Date().toISOString(),
        exitReason: reason,
        realizedPnl: pnl,
      });

      // Edit bot message to final state
      if (this.bot && trade.botMessageId) {
        await this.bot
          .editTradeMessageExited(trade.tradeId, trade.botMessageId, trade.notification, {
            reason,
            exitPrice,
            pnl,
            mode: trade.mode,
          })
          .catch((err) => {
            logger.debug('TradeManager: bot edit on exit failed', { error: errToString(err) });
          });
      }

      logger.info(
        `TradeManager: trade ${trade.tradeId} EXITED — reason=${reason} ` +
          `exit=₹${exitPrice.toFixed(2)} P&L=${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Helpers: quotes, time, env
  // -------------------------------------------------------------------------

  /**
   * Batch-fetch LTPs for a list of symbols.
   * Returns a Map<symbol, ltp>. Symbols missing from the response are
   * simply absent from the map (caller checks with .has()).
   */
  private async fetchLtps(symbols: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (symbols.length === 0) return result;

    const resp = await this.fyersClient.getQuotes(symbols);
    if (resp.s !== 'ok' || !resp.d) {
      logger.warn('TradeManager: getQuotes returned non-ok', {
        message: resp.message,
      });
      return result;
    }

    for (const entry of resp.d) {
      // Fyers quote shape: { n: "symbol", v: { lp: <last price>, ... } }
      const sym: string | undefined = entry?.n;
      const v: any = entry?.v;
      if (!sym || !v) continue;
      // Try common field names — Fyers has used lp, last_traded_price, ltp
      const ltp = Number(v.lp ?? v.ltp ?? v.last_traded_price ?? v.lastTradedPrice ?? 0);
      if (ltp > 0) {
        result.set(sym, ltp);
      }
    }
    return result;
  }

  /** Fetch a single symbol's LTP. Returns 0 on failure. */
  private async fetchLtpSafe(symbol: string): Promise<number> {
    try {
      const m = await this.fetchLtps([symbol]);
      return m.get(symbol) ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch the fill price of a placed order from the order book.
   * Returns 0 if the order isn't found or hasn't filled yet.
   */
  private async fetchFillPrice(orderId: string): Promise<number> {
    try {
      const order = await this.fyersClient.getOrderById(orderId);
      if (!order) return 0;
      // Fyers order shape: traded_price is the average fill price.
      // May be 0 if not filled yet.
      const tp = Number(order.traded_price ?? order.tradedPrice ?? 0);
      return tp;
    } catch (err) {
      logger.debug('TradeManager: getOrderById failed', { error: errToString(err) });
      return 0;
    }
  }

  /**
   * Check if current IST time is past the configured EOD square-off time.
   */
  private isPastEod(): boolean {
    const eodMin = this.parseTimeStr(this.config.eodSquareOffTime, 15 * 60 + 15);
    const now = new Date();
    const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const ist = new Date(istStr);
    const day = ist.getDay();
    // Only fire EOD on trading days (Mon-Fri)
    if (day === 0 || day === 6) return false;
    const nowMin = ist.getHours() * 60 + ist.getMinutes();
    return nowMin >= eodMin;
  }

  /** Parse "HH:MM" → minutes since midnight. Returns fallback on failure. */
  private parseTimeStr(s: string | undefined, fallback: number): number {
    if (!s) return fallback;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return fallback;
    const h = parseInt(m[1]!);
    const min = parseInt(m[2]!);
    if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
    return h * 60 + min;
  }

  /**
   * Read SL or target points for a given underlying from env.
   *   NIFTY     → NIFTY_SL_POINTS / NIFTY_TARGET_POINTS
   *   BANKNIFTY → BANKNIFTY_SL_POINTS / BANKNIFTY_TARGET_POINTS
   */
  private readPointsConfig(
    underlying: 'NIFTY' | 'BANKNIFTY',
    kind: 'SL' | 'TARGET',
  ): number {
    const envName = `${underlying}_${kind}_POINTS`;
    const raw = process.env[envName];
    const fallback = underlying === 'NIFTY' ? (kind === 'SL' ? 20 : 40) : kind === 'SL' ? 40 : 80;
    if (!raw) {
      logger.warn(
        `TradeManager: ${envName} not set in .env — using default ${fallback}`,
      );
      return fallback;
    }
    const val = parseFloat(raw);
    if (isNaN(val) || val <= 0) {
      logger.warn(`TradeManager: invalid ${envName}="${raw}" — using default ${fallback}`);
      return fallback;
    }
    return val;
  }

  // -------------------------------------------------------------------------
  // Public getters (for status / debugging)
  // -------------------------------------------------------------------------

  getOpenTradeCount(): number {
    let n = 0;
    for (const t of this.trades.values()) {
      if (t.status === 'OPEN') n++;
    }
    return n;
  }

  getOpenTradeIds(): number[] {
    const ids: number[] = [];
    for (const [id, t] of this.trades) {
      if (t.status === 'OPEN') ids.push(id);
    }
    return ids;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTradeManagerConfig(): TradeManagerConfig {
  const intervalRaw = parseInt(process.env['TRADE_MONITOR_INTERVAL_MS'] || '1500');
  const monitorIntervalMs =
    isNaN(intervalRaw) || intervalRaw < MIN_MONITOR_INTERVAL_MS
      ? 1500
      : intervalRaw;

  return {
    monitorIntervalMs,
    eodSquareOffTime: process.env['EOD_SQUARE_OFF_TIME'] || '15:15',
    dryRun: process.env['DRY_RUN'] !== 'false',
  };
}
