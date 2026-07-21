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
 * - MANUAL — user tapped "Force Close" on the bot message to tell the
 *   program to stop monitoring (no BUY order placed)
 * - ERROR — exit attempt failed (logged; position may still be open)
 */
export type ExitReason = 'SL' | 'TARGET' | 'EOD' | 'EXTERNAL' | 'MANUAL' | 'ERROR';

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

/**
 * Callback signature for force-close events. The bot calls this when the
 * user taps the "Force Close" button; the TradeManager implements it and
 * marks the trade as EXITED without placing a BUY order.
 */
export type ForceCloseCallback = (tradeId: number) => Promise<{ success: boolean; reason?: string }>;

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
  private onForceCloseCb: ForceCloseCallback | null = null;

  /** Set to true after start() succeeds. */
  private started = false;

  /** Manual polling state. */
  private pollingAbort = false;
  private pollingTimer: NodeJS.Timeout | null = null;
  private pollingOffset = 0;
  private pollingInFlight = false;

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
   * Register the force-close callback. Must be called BEFORE start().
   * Called when the user taps the "Force Close" button.
   */
  onForceClose(cb: ForceCloseCallback): void {
    this.onForceCloseCb = cb;
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

      // ----- Health check: verify the token is valid BEFORE launching -----
      // This catches invalid/expired/mistyped tokens immediately. Without
      // this check, bot.launch() succeeds (it just starts a polling loop)
      // and the first failure happens silently inside telegraf's retry
      // logic — the user would never see an error, just missing messages.
      const me = await this.bot.telegram.getMe();
      logger.info(
        `TradeBot: token verified ✓ — connected as @${me.username} ` +
          `(id: ${me.id}, name: "${me.first_name}")`,
      );

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

      // ----- /close <tradeId> command — force-close a trade -----
      // Usage: /close 32
      // Marks the trade as EXITED without placing a BUY order.
      // Use when you've already closed the position manually in Fyers.
      this.bot.command('close', async (ctx) => {
        if (ctx.from?.id !== this.allowedUserId) return;

        const args = ctx.message.text.split(/\s+/).slice(1);
        if (args.length === 0) {
          void ctx.reply(
            'Usage: /close <tradeId>\n\n' +
              'Example: /close 32\n\n' +
              'Force-closes a trade — stops monitoring WITHOUT placing a BUY order.\n' +
              'Use when you\'ve already closed the position manually in Fyers.',
          );
          return;
        }

        const tradeId = parseInt(args[0]!);
        if (isNaN(tradeId)) {
          void ctx.reply(`⚠️ Invalid trade ID: "${args[0]}". Usage: /close <tradeId>`);
          return;
        }

        if (!this.onForceCloseCb) {
          void ctx.reply('⚠️ Force-close is not available (trade manager not connected).');
          return;
        }

        try {
          const result = await this.onForceCloseCb(tradeId);
          if (result.success) {
            void ctx.reply(`✋ Trade ${tradeId} force-closed — monitoring stopped.`);
          } else {
            void ctx.reply(`⚠️ Could not force-close trade ${tradeId}: ${result.reason ?? 'unknown error'}`);
          }
        } catch (err) {
          void ctx.reply(`⚠️ Error force-closing trade ${tradeId}: ${errToString(err)}`);
        }
      });

      // ----- Inline button callback handler -----
      this.bot.on('callback_query', async (ctx) => {
        await this.handleCallback(ctx);
      });

      // ----- Error handler for middleware errors (command/callback handlers) -----
      this.bot.catch((err, ctx) => {
        logger.error('TradeBot: handler error (caught by bot.catch)', {
          error: errToString(err),
          updateType: ctx?.update ? Object.keys(ctx.update)[0] ?? 'unknown' : 'unknown',
        });
      });

      // ----- Step 1: Delete any existing webhook (so we can poll) -----
      logger.info('TradeBot: clearing any existing webhook...');
      try {
        await this.withTimeout(
          this.bot.telegram.deleteWebhook({ drop_pending_updates: false }),
          10_000,
        );
        logger.info('TradeBot: webhook cleared ✓');
      } catch (err) {
        const e = errToString(err);
        if (e.includes('timed out')) {
          logger.warn(
            'TradeBot: deleteWebhook timed out (10s) — continuing anyway',
          );
        } else {
          logger.debug('TradeBot: deleteWebhook returned error (usually harmless)', { error: e });
        }
      }

      // ----- Step 2: Start MANUAL polling (bypass bot.launch entirely) -----
      // WHY: bot.launch() can hang indefinitely with no error output. Telegraf
      // swallows polling errors (409 Conflict, network failures) inside its
      // internal retry loop, so you never see the actual error. By polling
      // manually with getUpdates(), EVERY error is caught and logged with
      // the actual Telegram API error message.
      this.started = true;
      this.startManualPolling();
      logger.info(
        `TradeBot: manual polling started — notifications will be sent to user ID ${this.allowedUserId}`,
      );

      // ----- Step 3: Send a startup confirmation message -----
      // This is a direct API call (sendMessage) that does NOT require the
      // polling loop to be running. If it succeeds, you KNOW notifications
      // will work even if launch() timed out.
      if (this.bot) {
        try {
          await this.withTimeout(
            this.bot.telegram.sendMessage(
              this.allowedUserId,
              '🟢 *Trade bot online*\n\n' +
                'You will receive a notification here every time a trade is placed, ' +
                'with inline buttons to toggle who manages it.\n\n' +
                'If you see this message, notifications are working correctly.',
              { parse_mode: 'Markdown' },
            ),
            10_000,
          );
          logger.info('TradeBot: startup confirmation message sent ✓');
        } catch (err) {
          const e = errToString(err);
          if (e.includes('timed out')) {
            logger.error(
              'TradeBot: sendMessage TIMED OUT (10s) — Telegram API is unreachable!\n' +
                '  This confirms a network issue. Check:\n' +
                '    curl -s https://api.telegram.org/bot<YOUR_TOKEN>/getMe\n' +
                '  If that also hangs, fix your network/firewall/proxy and restart.',
            );
          } else {
            logger.error(
              'TradeBot: FAILED to send startup confirmation message!\n' +
                '  → Most likely cause: you have NOT sent /start to your bot yet.\n' +
                '    Bots can only send messages to users who have initiated a chat.\n' +
                '    Open Telegram, find your bot, send /start, then restart this program.\n' +
                '  → Other causes: TELEGRAM_USER_ID is wrong, or the bot was blocked.',
              { error: e, userId: this.allowedUserId },
            );
          }
          // Don't return false — trade management still works.
        }
      }

      // ----- Step 4: Register graceful shutdown (parent also calls stop()) -----
      // We use process.once so the parent's own SIGINT/SIGTERM handler
      // also fires. The parent's cleanup calls tradeBot.stop() too —
      // double-calls are safe (stopManualPolling is idempotent).
      const sigHandler = (sig: string) => {
        logger.info(`TradeBot: received ${sig}, stopping polling...`);
        this.stop();
      };
      process.once('SIGINT', () => sigHandler('SIGINT'));
      process.once('SIGTERM', () => sigHandler('SIGTERM'));

      return true;
    } catch (err) {
      logger.error(
        'TradeBot: unexpected error during start() — this is why you got no notification!',
        { error: errToString(err) },
      );
      this.bot = null;
      this.started = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Manual polling implementation
  // -------------------------------------------------------------------------
  //
  // We bypass bot.launch() entirely and implement our own polling loop
  // using bot.telegram.getUpdates(). This gives us:
  //   1. Full control over error handling — every error is caught and
  //      logged with the ACTUAL Telegram API error message
  //   2. No silent retries — if getUpdates fails, we see it immediately
  //   3. No hang — each getUpdates call has a hard timeout
  //   4. Clean shutdown — pollingAbort flag stops the loop cleanly
  //
  // Updates are fed to bot.handleUpdate() which runs the full telegraf
  // middleware chain (command handlers, callback query handlers, etc.).

  /**
   * Long-poll timeout in seconds. Telegram will hold the connection open
   * for this many seconds waiting for new updates before returning an
   * empty array. 5s is a good balance — responsive but not too chatty.
   */
  private static readonly POLL_TIMEOUT_SECONDS = 5;

  /**
   * Overall HTTP timeout for getUpdates (ms). Must be greater than
   * POLL_TIMEOUT_SECONDS * 1000 to allow for the long-poll + network RTT.
   */
  private static readonly POLL_HTTP_TIMEOUT_MS = 15_000;

  /** Delay between poll cycles when there's an error (ms). */
  private static readonly POLL_ERROR_DELAY_MS = 3_000;

  /** Small delay between successful polls (ms) — prevents tight looping. */
  private static readonly POLL_IDLE_DELAY_MS = 100;

  /**
   * Start the manual polling loop. Returns immediately — the loop runs
   * in the background via a self-scheduling setTimeout chain.
   */
  private startManualPolling(): void {
    this.pollingAbort = false;
    this.pollingOffset = 0;
    this.pollingInFlight = false;
    // Kick off the first poll
    void this.pollOnce();
  }

  /** Stop the manual polling loop. Safe to call multiple times. */
  private stopManualPolling(): void {
    this.pollingAbort = true;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /** One polling iteration. */
  private async pollOnce(): Promise<void> {
    if (this.pollingAbort || !this.bot || !this.started) return;
    if (this.pollingInFlight) return; // prevent overlap
    this.pollingInFlight = true;

    try {
      const updates = await this.withTimeout(
        this.bot.telegram.getUpdates(
          TradeBot.POLL_TIMEOUT_SECONDS,  // timeout (seconds, long-poll)
          100,                             // limit (max updates per call)
          this.pollingOffset,              // offset (only fetch updates after this id)
          ['message', 'callback_query'],   // allowedUpdates
        ),
        TradeBot.POLL_HTTP_TIMEOUT_MS,
      );

      // Process each update through the telegraf middleware chain
      for (const update of updates) {
        this.pollingOffset = update.update_id + 1;
        try {
          await this.bot.handleUpdate(update);
        } catch (err) {
          logger.error('TradeBot: error processing update', {
            error: errToString(err),
            updateId: update.update_id,
          });
        }
      }

      // Schedule next poll
      if (!this.pollingAbort) {
        this.pollingTimer = setTimeout(
          () => void this.pollOnce(),
          TradeBot.POLL_IDLE_DELAY_MS,
        );
      }
    } catch (err) {
      const e = errToString(err);

      if (e.includes('timed out')) {
        // Normal — long-poll returned no updates within the timeout window.
        // This is NOT an error; just schedule the next poll.
        logger.debug('TradeBot: getUpdates long-poll timeout (no new updates)');
      } else if (e.includes('409') || e.toLowerCase().includes('conflict')) {
        // 409 Conflict — another process is polling with the same token.
        // This is the actual error that was being swallowed by telegraf.
        logger.error(
          'TradeBot: 409 Conflict — another process is already polling with this bot token!\n' +
            '  This means:\n' +
            '    - Another instance of this program is running, OR\n' +
            '    - A previous run did not shut down cleanly, OR\n' +
            '    - You restarted within 60 seconds (Telegram keeps the old session alive)\n' +
            '  FIX:\n' +
            '    1. Kill all instances:   ps aux | grep liveTrade\n' +
            '    2. Wait 60 seconds for Telegram to release the polling lock\n' +
            '    3. Restart this program\n' +
            '  Polling will retry in 3 seconds...',
          { error: e },
        );
      } else if (e.includes('401') || e.toLowerCase().includes('unauthorized')) {
        logger.error(
          'TradeBot: 401 Unauthorized — bot token is invalid or has been revoked!\n' +
            '  FIX: Get a new token from @BotFather, update BOT_TOKEN in .env, restart.',
          { error: e },
        );
      } else {
        logger.error('TradeBot: getUpdates error', { error: e });
      }

      // Schedule retry after delay
      if (!this.pollingAbort) {
        this.pollingTimer = setTimeout(
          () => void this.pollOnce(),
          TradeBot.POLL_ERROR_DELAY_MS,
        );
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  /**
   * Run a promise with a timeout. If the promise doesn't resolve within
   * `ms` milliseconds, reject with a "timed out" error.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Stop the bot. Safe to call multiple times. */
  stop(): void {
    // Stop the manual polling loop first
    this.stopManualPolling();

    if (this.bot) {
      try {
        // Don't call bot.stop() — it's designed for bot.launch() mode and
        // can hang. Our manual polling is already stopped above.
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

    // Parse "tg:<tradeId>:<P|M|F>"
    const parts = data.slice(CB_PREFIX.length).split(':');
    if (parts.length !== 2) {
      logger.warn(`TradeBot: malformed callback data "${data}"`);
      return;
    }
    const tradeId = parseInt(parts[0]!);
    const actionChar = parts[1];
    if (isNaN(tradeId) || (actionChar !== 'P' && actionChar !== 'M' && actionChar !== 'F')) {
      logger.warn(`TradeBot: invalid callback data "${data}"`);
      return;
    }

    // ----- Force Close action -----
    if (actionChar === 'F') {
      logger.info(`TradeBot: force-close request for trade ${tradeId}`);

      if (!this.onForceCloseCb) {
        logger.error('TradeBot: no force-close callback registered — dropping request');
        await ctx
          .reply('⚠️ Force-close is not available (no callback registered).')
          .catch(() => {});
        return;
      }

      try {
        const result = await this.onForceCloseCb(tradeId);
        if (!result.success) {
          await ctx
            .reply(`⚠️ Could not force-close trade ${tradeId}: ${result.reason ?? 'unknown error'}`)
            .catch(() => {});
        } else {
          await ctx
            .reply(`✋ Trade ${tradeId} force-closed — monitoring stopped.`)
            .catch(() => {});
        }
      } catch (err) {
        logger.error('TradeBot: force-close callback threw', {
          error: errToString(err),
          tradeId,
        });
      }
      return;
    }

    // ----- Toggle mode action (P or M) -----
    const newMode: TradeMode = actionChar === 'P' ? 'PROGRAM' : 'MANUAL';

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
      MANUAL: '✋',
      ERROR: '⚠️',
    };
    const reasonLabel: Record<ExitReason, string> = {
      SL: 'Stop loss hit',
      TARGET: 'Target hit',
      EOD: 'EOD auto square-off',
      EXTERNAL: 'Closed externally during downtime',
      MANUAL: 'Force-closed by user',
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
   * shown as "(active)" to make the state obvious at a glance.
   *
   * Three buttons:
   *   Row 1: [✅ I'll manage]  [🤖 You manage]   — toggle who monitors
   *   Row 2: [🔴 Force Close]                     — stop monitoring immediately
   */
  private buildKeyboard(tradeId: number, currentMode: TradeMode) {
    const manualLabel = currentMode === 'MANUAL' ? '✅ I\'ll manage (active)' : '✅ I\'ll manage';
    const programLabel = currentMode === 'PROGRAM' ? '🤖 You manage (active)' : '🤖 You manage';
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(manualLabel, `${CB_PREFIX}${tradeId}:M`),
        Markup.button.callback(programLabel, `${CB_PREFIX}${tradeId}:P`),
      ],
      [
        Markup.button.callback('🔴 Force Close', `${CB_PREFIX}${tradeId}:F`),
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
