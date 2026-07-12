/**
 * Trade management Telegram bot.
 *
 * Sends a notification to the configured user (TELEGRAM_USER_ID) every time
 * a trade is placed, with two inline buttons:
 *
 *     [✅ I'll manage]   [🤖 You manage]
 *
 * Tapping a button toggles who is monitoring the trade:
 *   - "I'll manage"  → MANUAL mode: program stops monitoring, user takes over
 *   - "You manage"   → PROGRAM mode: program monitors with SL/target, polls LTP
 *
 * The bot EDITS the same message in place on every toggle, so each trade has
 * exactly ONE living message in the chat that always reflects the current
 * state. The user can toggle back and forth any number of times.
 *
 * SECURITY
 * --------
 * The bot only responds to TELEGRAM_USER_ID. Callback queries from any other
 * user are answered with "Not authorised" and ignored. This prevents
 * strangers from toggling your trades if your bot username leaks.
 *
 * ARCHITECTURE
 * ------------
 * The bot is a SEPARATE Telegram session from the gramJS user client that
 * polls the signal channel. They run independently — the bot uses long-
 * polling (getUpdates) via telegraf, the gramJS client uses its own polling.
 *
 * The bot does NOT call Fyers directly. It receives toggle events and
 * forwards them to the TradeManager via the `onToggle` callback registered
 * at startup.
 */

import { Telegraf, Markup, type Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Trade mode: who is currently responsible for managing the trade. */
export type TradeMode = 'PROGRAM' | 'MANUAL';

/**
 * Reason a trade was exited.
 * - SL / TARGET / EOD — program-driven exits
 * - EXTERNAL — position was closed outside this program (manually by user,
 *   or auto-squared-off by Fyers during downtime). P&L may be unknown.
 * - ERROR — exit attempt failed (logged; position may still be open)
 */
export type ExitReason = 'SL' | 'TARGET' | 'EOD' | 'EXTERNAL' | 'ERROR';

/** Information about a placed trade, used to compose the bot notification. */
export interface TradeNotification {
  /** DB trade ID — used as the callback data prefix */
  tradeId: number;
  /** Display name of the underlying, e.g. "NIFTY" or "BANKNIFTY" */
  underlying: 'NIFTY' | 'BANKNIFTY';
  /** Option type for display, e.g. "CE" or "PE" */
  optionType: 'CE' | 'PE';
  /** Strike price for display, e.g. 23500 */
  strike: number;
  /** Fully-qualified Fyers symbol, e.g. "NSE:NIFTY24N0723500CE" */
  fyersSymbol: string;
  /** Quantity (in units, not lots) */
  qty: number;
  /** Approximate entry price (option LTP at order time) */
  entryPrice: number;
  /** SL points (from env) */
  slPoints: number;
  /** Target points (from env) */
  targetPoints: number;
  /** Fyers order ID of the SELL */
  fyersOrderId?: string;
  /** Dry-run? */
  dryRun: boolean;
}

/** Result of a toggle attempt. */
export interface ToggleResult {
  success: boolean;
  /** New mode if successful */
  newMode?: TradeMode;
  /** Reason for failure */
  reason?: string;
}

/**
 * Callback signature for toggle events. The bot calls this when the user
 * taps a button; the TradeManager implements it and updates its state.
 */
export type ToggleCallback = (tradeId: number, newMode: TradeMode) => Promise<ToggleResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Callback data format: "tg:<tradeId>:<mode>" where mode is "P" (program)
 * or "M" (manual). Kept short because Telegram limits callback_data to 64
 * bytes.
 *
 * Examples:
 *   "tg:42:P"  → user tapped "You manage" → wants PROGRAM mode
 *   "tg:42:M"  → user tapped "I'll manage" → wants MANUAL mode
 */
const CB_PREFIX = 'tg:';

// ---------------------------------------------------------------------------
// Bot wrapper
// ---------------------------------------------------------------------------

export class TradeBot {
  private bot: Telegraf<Context<Update>> | null = null;
  private readonly token: string;
  private readonly allowedUserId: number;
  private onToggleCb: ToggleCallback | null = null;

  /** Set to true after start() succeeds. */
  private started = false;

  constructor(token: string, allowedUserId: number) {
    this.token = token;
    this.allowedUserId = allowedUserId;
  }

  /**
   * Register the toggle callback. Must be called BEFORE start().
   * The TradeManager registers itself here so button presses flow into it.
   */
  onToggle(cb: ToggleCallback): void {
    this.onToggleCb = cb;
  }

  /**
   * Start the bot: launch long-polling and register callback handlers.
   * Returns true if the bot is running; false if the token is missing
   * (in which case the bot is a no-op and trade management falls back
   * to PROGRAM-only mode).
   */
  async start(): Promise<boolean> {
    if (!this.token) {
      logger.info('TradeBot: BOT_TOKEN not set — bot disabled, program will self-manage all trades');
      return false;
    }
    if (!this.allowedUserId) {
      logger.warn('TradeBot: TELEGRAM_USER_ID not set — bot disabled even though BOT_TOKEN is present');
      return false;
    }

    try {
      this.bot = new Telegraf(this.token);

      // ----- /start command (registers the chat) -----
      this.bot.start((ctx) => {
        if (ctx.from?.id !== this.allowedUserId) {
          void ctx.reply('🚫 You are not authorised to use this bot.');
          return;
        }
        void ctx.reply(
          '👋 Trade management bot online.\n\n' +
            'You\'ll get a notification here every time a trade is placed. ' +
            'Tap the inline buttons to toggle who manages each trade.\n\n' +
            'Modes:\n' +
            '  🤖 You manage  → program monitors with SL/target\n' +
            '  ✅ I\'ll manage → you take over, program stands down',
        );
      });

      // ----- /status command — list open trades -----
      this.bot.command('status', (ctx) => {
        if (ctx.from?.id !== this.allowedUserId) return;
        void ctx.reply('📊 Use the latest trade message to check status. Each trade has its own living message.');
      });

      // ----- Inline button callback handler -----
      this.bot.on('callback_query', async (ctx) => {
        await this.handleCallback(ctx);
      });

      // Launch long-polling. telegraf.handle∆ handles updates sequentially.
      await this.bot.launch();
      this.started = true;
      logger.info(
        `TradeBot: started — notifications will be sent to user ID ${this.allowedUserId}`,
      );

      // Graceful shutdown on process signals (telegraf stops polling).
      // The parent process also calls stop() during its own cleanup, but
      // this catches the case where telegraf receives the signal directly.
      const sigHandler = (sig: string) => {
        logger.info(`TradeBot: received ${sig}, stopping...`);
        this.stop();
      };
      process.once('SIGINT', () => sigHandler('SIGINT'));
      process.once('SIGTERM', () => sigHandler('SIGTERM'));

      return true;
    } catch (err) {
      logger.error('TradeBot: failed to start', { error: errToString(err) });
      this.bot = null;
      this.started = false;
      return false;
    }
  }

  /** Stop the bot. Safe to call multiple times. */
  stop(): void {
    if (this.bot) {
      try {
        this.bot.stop('TradeBot shutdown');
      } catch (err) {
        logger.warn('TradeBot: error during stop', { error: errToString(err) });
      }
      this.bot = null;
    }
    this.started = false;
    logger.info('TradeBot: stopped');
  }

  isRunning(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------------------
  // Notification sending
  // -------------------------------------------------------------------------

  /**
   * Send a "trade placed" notification with inline buttons.
   * Returns the Telegram message ID of the sent message (so the caller can
   * edit it later via editTradeMessage()).
   *
   * If the bot is not running, returns null — the caller should still
   * proceed with trade management (PROGRAM mode).
   */
  async sendTradePlaced(n: TradeNotification): Promise<number | null> {
    if (!this.bot || !this.started) {
      logger.debug('TradeBot: skipping sendTradePlaced — bot not running');
      return null;
    }

    const text = this.composeTradeMessage(n, 'PROGRAM');
    const keyboard = this.buildKeyboard(n.tradeId, 'PROGRAM');

    try {
      const msg = await this.bot.telegram.sendMessage(this.allowedUserId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      logger.info(`TradeBot: sent trade-placed notification (msg ${msg.message_id}) for trade ${n.tradeId}`);
      return msg.message_id;
    } catch (err) {
      logger.error('TradeBot: failed to send trade-placed notification', {
        error: errToString(err),
        tradeId: n.tradeId,
      });
      return null;
    }
  }

  /**
   * Edit an existing trade message to reflect a new mode.
   * Called by TradeManager after a successful toggle, or on resume.
   *
   * @param note Optional short note appended to the message (e.g. "↩️ Resumed after restart").
   */
  async editTradeMessage(
    tradeId: number,
    botMessageId: number,
    n: TradeNotification,
    newMode: TradeMode,
    note?: string,
  ): Promise<void> {
    if (!this.bot || !this.started) return;

    const text = this.composeTradeMessage(n, newMode, note);
    const keyboard = this.buildKeyboard(tradeId, newMode);

    try {
      await this.bot.telegram.editMessageText(
        this.allowedUserId,
        botMessageId,
        undefined,
        text,
        { parse_mode: 'Markdown', reply_markup: keyboard },
      );
    } catch (err) {
      // "message is not modified" is benign — happens if the user spams
      // the same button. Log at debug only.
      const e = errToString(err);
      if (e.includes('not modified')) {
        logger.debug(`TradeBot: editTradeMessage no-op (already in ${newMode}) for trade ${tradeId}`);
      } else {
        logger.error('TradeBot: failed to edit trade message', {
          error: e,
          tradeId,
          botMessageId,
        });
      }
    }
  }

  /**
   * Edit the trade message to show the final exit state (no more buttons).
   * Called by TradeManager after a trade is closed.
   */
  async editTradeMessageExited(
    tradeId: number,
    botMessageId: number,
    n: TradeNotification,
    exit: {
      reason: ExitReason;
      exitPrice: number;
      pnl: number;
      mode: TradeMode;
    },
  ): Promise<void> {
    if (!this.bot || !this.started) return;

    const text = this.composeExitedMessage(n, exit);
    // No keyboard — trade is closed, no more toggling.
    try {
      await this.bot.telegram.editMessageText(
        this.allowedUserId,
        botMessageId,
        undefined,
        text,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.error('TradeBot: failed to edit trade message (exited)', {
        error: errToString(err),
        tradeId,
        botMessageId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: callback handler
  // -------------------------------------------------------------------------

  private async handleCallback(ctx: Context<Update.CallbackQueryUpdate>): Promise<void> {
    const cb = ctx.callbackQuery;
    // Acknowledge immediately so Telegram doesn't show a spinner.
    await ctx.answerCbQuery().catch((err) => {
      logger.debug('TradeBot: answerCbQuery failed', { error: errToString(err) });
    });

    // ----- Security: only the configured user may toggle -----
    if (cb.from?.id !== this.allowedUserId) {
      logger.warn(`TradeBot: unauthorised callback from user ${cb.from?.id}`);
      return;
    }

    // cb is a union (GameQuery has no `data`). Narrow to the data-carrying variant.
    if (!('data' in cb)) {
      logger.debug('TradeBot: ignoring non-data callback (likely a game query)');
      return;
    }
    const data: string | undefined = cb.data;
    if (!data || !data.startsWith(CB_PREFIX)) {
      logger.debug(`TradeBot: ignoring callback with unexpected data "${data}"`);
      return;
    }

    // Parse "tg:<tradeId>:<P|M>"
    const parts = data.slice(CB_PREFIX.length).split(':');
    if (parts.length !== 2) {
      logger.warn(`TradeBot: malformed callback data "${data}"`);
      return;
    }
    const tradeId = parseInt(parts[0]!);
    const modeChar = parts[1];
    if (isNaN(tradeId) || (modeChar !== 'P' && modeChar !== 'M')) {
      logger.warn(`TradeBot: invalid callback data "${data}"`);
      return;
    }
    const newMode: TradeMode = modeChar === 'P' ? 'PROGRAM' : 'MANUAL';

    logger.info(`TradeBot: toggle request trade ${tradeId} → ${newMode}`);

    if (!this.onToggleCb) {
      logger.error('TradeBot: no toggle callback registered — dropping toggle');
      return;
    }

    try {
      const result = await this.onToggleCb(tradeId, newMode);
      if (!result.success) {
        // Notify the user via a short-lived reply (separate from the
        // trade message, which the manager has already edited or left
        // alone as appropriate).
        await ctx
          .reply(`⚠️ Could not toggle trade ${tradeId}: ${result.reason ?? 'unknown error'}`)
          .catch((err) => {
            logger.debug('TradeBot: reply failed', { error: errToString(err) });
          });
      }
      // On success, the TradeManager.editTradeMessage call (inside
      // onToggleCb) has already updated the message in place.
    } catch (err) {
      logger.error('TradeBot: toggle callback threw', {
        error: errToString(err),
        tradeId,
        newMode,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: message composition
  // -------------------------------------------------------------------------

  /**
   * Compose the trade message body. Same shape for all states — only the
   * status line and emoji change. Kept Markdown-parseable.
   *
   * NOTE on Markdown: we use plain `*bold*` and avoid characters that
   * need escaping (`_`, `[`, `]`, `` ` ``). Numbers and symbols in
   * option symbols (e.g. "NSE:NIFTY24N0723500CE") don't need escaping.
   */
  private composeTradeMessage(n: TradeNotification, mode: TradeMode, note?: string): string {
    const statusLine =
      mode === 'PROGRAM'
        ? '🤖 *Program is monitoring* (SL ' + n.slPoints + ' / Target ' + n.targetPoints + ')'
        : '✅ *You are managing manually* (program standing down)';

    const dryRunLine = n.dryRun ? '\n\n_⚠️ DRY RUN — no real order was placed_' : '';
    const noteLine = note ? `\n\n_${note}_` : '';

    return (
      `📊 *Trade #${n.tradeId} placed*\n` +
      `${n.underlying} ${n.strike} ${n.optionType} • SELL ${n.qty} @ ₹${n.entryPrice.toFixed(2)}\n` +
      `Symbol: \`${n.fyersSymbol}\`\n` +
      (n.fyersOrderId ? `Order ID: \`${n.fyersOrderId}\`\n` : '') +
      `\n${statusLine}${dryRunLine}${noteLine}`
    );
  }

  /**
   * Compose the final "trade exited" message (no buttons).
   */
  private composeExitedMessage(
    n: TradeNotification,
    exit: { reason: ExitReason; exitPrice: number; pnl: number; mode: TradeMode },
  ): string {
    const reasonEmoji: Record<ExitReason, string> = {
      SL: '🛑',
      TARGET: '🎯',
      EOD: '🔚',
      EXTERNAL: '🔍',
      ERROR: '⚠️',
    };
    const reasonLabel: Record<ExitReason, string> = {
      SL: 'Stop loss hit',
      TARGET: 'Target hit',
      EOD: 'EOD auto square-off',
      EXTERNAL: 'Closed externally during downtime',
      ERROR: 'Error',
    };

    const modeLabel = exit.mode === 'PROGRAM' ? 'Program' : 'Manual';

    // For EXTERNAL exits, P&L may be unknown (we couldn't find the fill price).
    // Show a different footer that prompts the user to verify in Fyers.
    if (exit.reason === 'EXTERNAL' && exit.exitPrice === 0) {
      return (
        `${reasonEmoji[exit.reason]} *Trade #${n.tradeId} — ${reasonLabel[exit.reason]}*\n` +
        `${n.underlying} ${n.strike} ${n.optionType} • SELL ${n.qty} @ ₹${n.entryPrice.toFixed(2)}\n` +
        `${modeLabel} trade • P&L: ⚠️ *Unknown — verify in Fyers app*`
      );
    }

    const pnlStr = exit.pnl >= 0 ? `+₹${exit.pnl.toFixed(2)}` : `-₹${Math.abs(exit.pnl).toFixed(2)}`;
    const pnlEmoji = exit.pnl >= 0 ? '🟢' : '🔴';

    return (
      `${reasonEmoji[exit.reason]} *Trade #${n.tradeId} closed — ${reasonLabel[exit.reason]}*\n` +
      `${n.underlying} ${n.strike} ${n.optionType} • SELL ${n.qty} @ ₹${n.entryPrice.toFixed(2)} → BUY @ ₹${exit.exitPrice.toFixed(2)}\n` +
      `${modeLabel} exit • P&L: ${pnlEmoji} *${pnlStr}*`
    );
  }

  /**
   * Build the inline keyboard. The CURRENTLY-ACTIVE mode's button is
   * shown as a "✓" checkmark to make the state obvious at a glance.
   */
  private buildKeyboard(tradeId: number, currentMode: TradeMode) {
    const manualLabel = currentMode === 'MANUAL' ? '✅ I\'ll manage (active)' : '✅ I\'ll manage';
    const programLabel = currentMode === 'PROGRAM' ? '🤖 You manage (active)' : '🤖 You manage';
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(manualLabel, `${CB_PREFIX}${tradeId}:M`),
        Markup.button.callback(programLabel, `${CB_PREFIX}${tradeId}:P`),
      ],
    ]).reply_markup;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TradeBot from env vars. Returns null if BOT_TOKEN is missing
 * (the caller proceeds in bot-less mode — program self-manages everything).
 */
export function createTradeBotFromEnv(): TradeBot | null {
  const token = process.env['BOT_TOKEN']?.trim();
  const userIdStr = process.env['TELEGRAM_USER_ID']?.trim();
  const userId = userIdStr ? parseInt(userIdStr) : NaN;

  if (!token || isNaN(userId)) {
    logger.info('TradeBot: BOT_TOKEN or TELEGRAM_USER_ID not configured — bot disabled');
    return null;
  }

  return new TradeBot(token, userId);
}
