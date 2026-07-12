/**
 * Live listener — polls a Telegram channel for new trade signals using a
 * two-phase pattern that respects Telegram's rate limits.
 *
 * TWO-PHASE POLLING (rate-limit friendly)
 * ---------------------------------------
 * Telegram throttles `messages.GetHistory` aggressively — calling it every
 * 250 ms triggers FloodWait errors within minutes. To stay responsive
 * without getting throttled, we use a cheap "any new messages?" check
 * before the expensive fetch:
 *
 *   Phase 1 (every 500 ms) — Call `messages.GetPeerDialogs` to read the
 *     channel's `top_message` id. This is a lightweight metadata call that
 *     Telegram caches aggressively; it's rarely rate-limited.
 *
 *   Phase 2 (only when phase 1 reports a new id) — Call `messages.GetHistory`
 *     with `minId: lastSeenMessageId` to fetch the actual new messages.
 *     On a low-volume signal channel this fires only a handful of times
 *     per hour, well within Telegram's budget.
 *
 * Result: sub-second responsiveness when signals arrive, near-zero rate-
 * limit risk during idle periods.
 *
 * FLOODWAIT BACKOFF
 * -----------------
 * gramJS auto-sleeps FloodWaits under its `floodSleepThreshold` (default
 * 60s) and retries the call transparently — we don't see the error, but
 * we observe the elapsed time. If a phase-1 or phase-2 call takes longer
 * than `FLOOD_WAIT_DETECT_MS`, we assume a FloodWait happened and back
 * off: the next `BACKOFF_POLLS` iterations use `BACKOFF_INTERVAL_MS`
 * instead of the regular `CHECK_INTERVAL_MS`. After the backoff window,
 * the loop decays back to the fast cadence. FloodWaits above the
 * threshold throw `FloodWaitError` — we catch those explicitly and apply
 * the same backoff.
 *
 * Pipeline per new photo message:
 *   1. Phase-1 check reveals new top_message id
 *   2. Phase-2 fetch returns messages with id > lastSeenMessageId
 *   3. For each new message (processed oldest-first):
 *        a. Photo-only filter (skip text/video/sticker/etc.)
 *        b. Download photo
 *        c. Insert placeholder DB record (audit trail even if analysis fails)
 *        d. Validate screenshot (orientation, colored header bar, etc.)
 *        e. Analyze:
 *             - Symbol: whitespace-based OCR (same as offline)
 *             - Option type: VLM primary (glm-4v), OCR fallback
 *        f. Update DB record with analysis results
 *        g. If trading enabled → acquire mutex → execute SELL order
 *   4. Advance lastSeenMessageId to the highest id processed in this batch
 *
 * FRESH-START POLICY
 * ------------------
 * On every startup we set the watermark to the channel's current latest
 * message id, so only photos posted AFTER this server starts are
 * processed. Anything that arrived in the channel during prior downtime
 * is intentionally ignored.
 *
 * DEDUP GUARANTEE (no photo processed twice)
 * ------------------------------------------
 *   1. Primary — the watermark only ever advances, and every phase-2
 *      fetch asks for `minId: lastSeenMessageId`. A message id that has
 *      been fetched once can never be re-fetched.
 *   2. Defense-in-depth — the `trades` table has a UNIQUE constraint on
 *      (telegram_channel_id, telegram_message_id), and
 *      `repo.insertPlaceholder()` catches the violation by returning the
 *      existing row instead of throwing.
 *
 * POLL OVERLAP SAFETY
 * -------------------
 * We use a self-scheduling `setTimeout` chain (NOT `setInterval`): the
 * next poll is scheduled only AFTER the previous one completes. If a
 * phase-2 call takes >500 ms (slow network or auto-slept FloodWait), the
 * next phase-1 check fires immediately on completion — no overlap, no
 * queue buildup.
 *
 * DETECTOR CONFIG
 * ---------------
 * Controlled by OPTION_TYPE_DETECTOR env var:
 *   - "vlm"       (default) VLM primary, OCR fallback if VLM fails
 *   - "ocr"                  OCR only (no VLM dependency)
 *   - "vlm-only"             VLM only, skip trade if VLM fails
 */

import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import { downloadMessagePhotoLive } from './mediaDownloader.js';
import { validateScreenshot } from '../analyzer/validateScreenshot.js';
import { ocrHeaderOnce } from '../analyzer/unifiedHeaderOcr.js';
import {
  detectByWhitespace,
  detectByWhitespaceFromOcr,
} from '../analyzer/detectSymbolByWhitespace.js';
import {
  detectOptionTypeFromHeaderOcr,
  detectOptionTypeByOcr,
} from '../analyzer/detectOptionType.js';
import {
  detectOptionTypeByVlm,
  checkVlmAvailability,
  preInitVlm,
} from '../analyzer/detectOptionTypeVLM.js';
import { preInitOcr, shutdownOcr } from '../analyzer/ocr.js';
import { clampConfidence, type DetectionScore } from '../analyzer/confidence.js';
import { createTradingEngine, createTradeSignal } from '../fyers/tradingEngine.js';
import type { TradingEngine } from '../fyers/tradingEngine.js';
import type { OptionType } from '../models/Trade.js';
import { AsyncMutex } from '../utils/concurrency.js';
import { getDb } from '../database/db.js';
import { TradeRepository } from '../database/tradeRepository.js';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Polling configuration
// ---------------------------------------------------------------------------

/**
 * Phase-1 poll interval — call `messages.GetPeerDialogs` every 500 ms to
 * check whether the channel's `top_message` id has advanced. This is a
 * cheap metadata call that Telegram caches aggressively; it's rarely
 * rate-limited even at this cadence.
 *
 * Note: the actual cycle time is `CHECK_INTERVAL_MS` + the time phase-1
 * takes (typically 50-200 ms). On a healthy connection the effective
 * cadence is ~600-700 ms, which gives sub-second responsiveness for new
 * signals while staying far under Telegram's rate limit for this method.
 */
const CHECK_INTERVAL_MS = 500;

/**
 * Backoff interval — used for `BACKOFF_POLLS` iterations after a FloodWait
 * is detected. 5 seconds is well under Telegram's GetPeerDialogs limit
 * (~30-60/min) and gives the rate-limit counter time to decay.
 */
const BACKOFF_INTERVAL_MS = 5_000;

/**
 * Number of polls to run at the backoff cadence before decaying back to
 * `CHECK_INTERVAL_MS`. At 5s per poll, this is ~2.5 minutes of backed-off
 * polling — enough time for Telegram's per-account counter to reset.
 */
const BACKOFF_POLLS = 30;

/**
 * If a single Telegram API call (phase 1 or phase 2) takes longer than
 * this, we assume gramJS auto-slept a FloodWait for us (gramJS handles
 * FloodWaits under its `floodSleepThreshold` — default 60s — by sleeping
 * and retrying transparently, without throwing). We detect this via
 * elapsed time and trigger the same backoff as an explicit FloodWaitError.
 *
 * 3 seconds is well above normal RTT (typically 50-300 ms) and well below
 * the shortest plausible FloodWait (usually 8-15s).
 */
const FLOOD_WAIT_DETECT_MS = 3_000;

/**
 * Maximum messages to fetch per phase-2 call. 50 is plenty for a single
 * poll window — a channel would need to post >100 msgs/sec to overflow
 * this. If it ever does, the next poll picks up the rest (we advance
 * lastSeenMessageId only up to what we actually processed).
 */
const POLL_LIMIT = 50;

// ---------------------------------------------------------------------------
// Concurrency: only ONE order may be in-flight at a time.
// ---------------------------------------------------------------------------
const orderMutex = new AsyncMutex();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveListenerConfig {
  channelUsername: string;
  enableTrading: boolean;
}

interface EnrichedConfig extends LiveListenerConfig {
  /** Resolved numeric channel ID (as string) — used for DB scoping */
  channelId: string;
  /** Which option-type detector to use */
  detector: 'vlm' | 'ocr' | 'vlm-only';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start polling the configured channel every 250 ms for new messages.
 *
 * @returns The trading engine (so the caller can shut it down on exit) and
 *          a `stop()` function that cancels the polling loop on shutdown.
 */
export async function startLiveListener(
  client: TelegramClient,
  config: LiveListenerConfig,
): Promise<{ tradingEngine: TradingEngine | null; stop: () => Promise<void> }> {
  logger.info(
    `Starting live listener (phase-1 check every ${CHECK_INTERVAL_MS}ms) for channel: ${config.channelUsername}`,
  );
  logger.info(`Trading enabled: ${config.enableTrading}`);

  // 1. Initialize trading engine (if enabled)
  let tradingEngine: TradingEngine | null = null;
  if (config.enableTrading) {
    try {
      tradingEngine = createTradingEngine();
      await tradingEngine.initialize();
      logger.info('Trading engine initialized');
    } catch (err) {
      const errStr = errToString(err);
      logger.error('Failed to initialize trading engine', { error: errStr });
      if (errStr.includes('Authentication required') || errStr.includes('fyers-auth')) {
        logger.info('Run `npm run fyers-auth` to authenticate with Fyers.');
      }
      throw err;
    }
  }

  // 2. Initialize DB
  const db = getDb();
  const repo = new TradeRepository(db);

  // 3. Resolve the channel entity ONCE. We need TWO forms:
  //    - `channelEntity` (from getEntity): has `.id` for DB scoping.
  //    - `channelInputPeer` (from getInputEntity): an Api.TypeInputPeer
  //      suitable for raw API calls like `messages.GetPeerDialogs`.
  //    `client.getMessages()` accepts either form, so we use the InputPeer
  //    for both phase-1 and phase-2 calls.
  const normalizedUsername = config.channelUsername.replace('@', '');
  let channelId: string;
  let channelInputPeer: Api.TypeInputPeer;
  try {
    const channelEntity: any = await client.getEntity(normalizedUsername);
    channelId = String(channelEntity.id);
    const accessHash = (channelEntity as any).accessHash
      ? String((channelEntity as any).accessHash)
      : undefined;
    logger.info(
      `Resolved channel @${normalizedUsername} → ID ${channelId}` +
        (accessHash ? ` (accessHash: ${accessHash})` : ''),
    );

    // getInputEntity returns the InputPeer form, cached for reuse.
    channelInputPeer = await client.getInputEntity(normalizedUsername);
  } catch (err) {
    logger.error(
      `Cannot resolve channel @${config.channelUsername}. ` +
        `Make sure your Telegram account has access.`,
      { error: errToString(err) },
    );
    throw err;
  }

  // 4. Determine which detector to use
  const detectorCfg = (process.env['OPTION_TYPE_DETECTOR'] || 'vlm').toLowerCase().trim();
  let detector: 'vlm' | 'ocr' | 'vlm-only' = 'vlm';
  if (detectorCfg === 'ocr') detector = 'ocr';
  else if (detectorCfg === 'vlm-only') detector = 'vlm-only';

  if (detector !== 'ocr') {
    logger.info('Checking VLM detector availability...');
    const vlmCheck = await checkVlmAvailability();
    if (!vlmCheck.available) {
      logger.warn('VLM detector is NOT available:');
      for (const line of (vlmCheck.reason || '').split('\n')) {
        logger.warn('  ' + line);
      }
      if (detector === 'vlm-only') {
        logger.warn('Falling back to "vlm" mode (OCR fallback enabled) since VLM-only requires VLM.');
        detector = 'vlm';
      }
      logger.warn('VLM calls will fail per-image and fall back to OCR. To use VLM, fix the configuration above.');
    } else {
      logger.info('✓ VLM detector available and configured.');
      // Eagerly initialize the ZAI SDK NOW so the first screenshot doesn't
      // pay the init cost (dynamic import + config load + HTTP client
      // setup, typically 500-2000ms). If this fails, preInitVlm logs a
      // warning but does NOT throw — the first screenshot will retry
      // lazily and fall back to OCR if VLM is still broken.
      logger.info('Pre-initializing ZAI VLM SDK...');
      await preInitVlm();
    }
  }

  // Pre-initialize the Tesseract OCR worker regardless of detector mode.
  // Even in VLM mode, OCR is used for symbol detection (whitespace analysis)
  // and as a fallback when VLM fails. Pre-loading the English language data
  // at startup saves ~2-5s on the first screenshot's OCR call.
  logger.info('Pre-initializing Tesseract OCR worker...');
  await preInitOcr();

  logger.info(`Option-type detector: ${detector}`);

  const enrichedConfig: EnrichedConfig = { ...config, channelId, detector };

  // 5. Initialize the polling watermark (`lastSeenMessageId`).
  //
  //    POLICY: Only process photos posted AFTER this server starts.
  //    We deliberately do NOT consult the DB for a resume point — anything
  //    that arrived in the channel while this process was offline is
  //    intentionally ignored. The startup sequence is:
  //      a) Fetch the channel's current latest message (1 message).
  //      b) Set the watermark to its id. The first real poll then asks for
  //         `id > watermark`, so only messages posted AFTER startup are
  //         processed.
  //      c) If the channel has no messages at all, leave the watermark at 0
  //         — the first message ever posted will be the first one processed.
  //
  //    DEDUP GUARANTEE (no photo processed twice):
  //      1. Primary — the watermark only ever advances, and every poll asks
  //         for `minId: lastSeenMessageId`. A message id that has been
  //         fetched once can never be re-fetched.
  //      2. Defense-in-depth — the `trades` table has a UNIQUE constraint
  //         on (telegram_channel_id, telegram_message_id), and
  //         `repo.insertPlaceholder()` catches the violation by returning
  //         the existing row instead of throwing. So even in an MTProto
  //         edge case where the same id is returned twice, no duplicate
  //         row is created and no duplicate trade is fired.
  let lastSeenMessageId = 0;

  const latestMsgs = await client.getMessages(channelInputPeer, { limit: 1 });
  if (latestMsgs.length > 0 && latestMsgs[0] instanceof Api.Message) {
    lastSeenMessageId = latestMsgs[0].id;
    logger.info(
      `Starting from current latest message ID ${lastSeenMessageId}. ` +
        `Only photos posted AFTER this startup will be processed. ` +
        `Historical messages and anything posted during prior downtime are ignored.`,
    );
  } else {
    lastSeenMessageId = 0;
    logger.info(
      'Channel has no messages — will process the first photo posted after startup.',
    );
  }

  // 6. Start the two-phase polling loop.
  //
  //    Phase 1 (every poll): cheap `messages.GetPeerDialogs` call to read
  //    the channel's `top_message` id. If it hasn't advanced past our
  //    watermark, we're done for this tick — no expensive call made.
  //
  //    Phase 2 (only when phase 1 reports a new id): `messages.GetHistory`
  //    via `client.getMessages(minId: lastSeenMessageId)` to fetch the
  //    actual new message bodies, then run each through the handler
  //    pipeline.
  //
  //    We use a self-scheduling `setTimeout` chain (NOT `setInterval`) so
  //    a slow phase-2 call (slow network or auto-slept FloodWait) can't
  //    cause overlapping polls.
  //
  //    Backoff: if either phase takes longer than `FLOOD_WAIT_DETECT_MS`
  //    (suggesting gramJS auto-slept a FloodWait), or if a FloodWaitError
  //    is thrown (for waits above gramJS's threshold), we switch to
  //    `BACKOFF_INTERVAL_MS` for the next `BACKOFF_POLLS` iterations.
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let pollInFlight = false;
  let backoffRemaining = 0;

  /**
   * Run a Telegram API call and detect likely FloodWaits by elapsed time.
   * Returns `[result, flooded]` — `flooded` is true if the call took
   * longer than `FLOOD_WAIT_DETECT_MS` (suggesting an auto-slept
   * FloodWait) OR threw a `FloodWaitError` (for waits above gramJS's
   * threshold). On FloodWaitError we swallow the error and return
   * `undefined` result + `flooded: true`; other errors propagate.
   */
  const timedCall = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T | undefined; flooded: boolean }> => {
    const start = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      if (elapsed > FLOOD_WAIT_DETECT_MS) {
        logger.warn(
          `${label} took ${elapsed}ms (likely auto-slept FloodWait) — backing off`,
        );
        return { result, flooded: true };
      }
      return { result, flooded: false };
    } catch (err) {
      if (err instanceof FloodWaitError) {
        logger.warn(
          `${label} threw FloodWaitError (${err.seconds}s) — backing off`,
        );
        return { result: undefined, flooded: true };
      }
      throw err;
    }
  };

  const pollOnce = async (): Promise<void> => {
    if (pollInFlight || stopped) return;
    pollInFlight = true;

    // Snapshot the effective interval for THIS poll. Captured here so the
    // log message at the end of the poll reflects what was actually used,
    // even if `backoffRemaining` changes mid-poll.
    const inBackoff = backoffRemaining > 0;
    const intervalUsed = inBackoff ? BACKOFF_INTERVAL_MS : CHECK_INTERVAL_MS;

    try {
      // -----------------------------------------------------------------
      // PHASE 1: cheap "any new messages?" check via GetPeerDialogs.
      // -----------------------------------------------------------------
      const peerDialogsResult = await timedCall('GetPeerDialogs', () =>
        client.invoke(
          new Api.messages.GetPeerDialogs({
            peers: [new Api.InputDialogPeer({ peer: channelInputPeer })],
          }),
        ),
      );

      if (peerDialogsResult.flooded) {
        backoffRemaining = BACKOFF_POLLS;
        return;
      }

      // Extract top_message id from the dialog entry for our channel.
      const peerDialogs = peerDialogsResult.result;
      const topMessageId =
        peerDialogs && peerDialogs.dialogs && peerDialogs.dialogs.length > 0
          ? (peerDialogs.dialogs[0] as { topMessage?: number }).topMessage
          : undefined;

      if (topMessageId === undefined) {
        // Dialog fetch returned no entry for this channel — unusual but
        // not fatal. Skip this tick; the next poll will retry.
        logger.debug('GetPeerDialogs returned no dialog for channel');
        return;
      }

      if (topMessageId <= lastSeenMessageId) {
        // No new messages — the common case. We're done for this tick
        // without having made any expensive GetHistory call.
        return;
      }

      // -----------------------------------------------------------------
      // PHASE 2: expensive fetch of the actual new messages.
      // -----------------------------------------------------------------
      const historyResult = await timedCall('GetHistory', () =>
        client.getMessages(channelInputPeer, {
          limit: POLL_LIMIT,
          minId: lastSeenMessageId,
        }),
      );

      if (historyResult.flooded) {
        backoffRemaining = BACKOFF_POLLS;
        return;
      }

      const fetched = historyResult.result ?? [];

      if (fetched.length === 0) {
        // GetPeerDialogs said there was a new message but GetHistory
        // returned nothing — race condition between the two calls
        // (message was deleted between phase 1 and phase 2). Reset the
        // watermark defensively to topMessageId so we don't loop on this
        // stale signal forever.
        lastSeenMessageId = Math.max(lastSeenMessageId, topMessageId);
        return;
      }

      // Keep only real Api.Message instances (skip service messages etc.)
      // and dedup against the watermark defensively (some MTProto layers
      // interpret min_id as inclusive rather than exclusive).
      const msgs = fetched
        .filter((m): m is Api.Message => m instanceof Api.Message)
        .filter((m) => m.id > lastSeenMessageId)
        .sort((a, b) => a.id - b.id); // oldest-first

      if (msgs.length === 0) {
        // Same race as above — defensively advance watermark past the
        // signal we got from GetPeerDialogs.
        lastSeenMessageId = Math.max(lastSeenMessageId, topMessageId);
        return;
      }

      const firstId = msgs[0]?.id;
      const lastId = msgs[msgs.length - 1]?.id;
      logger.debug(
        `Phase-2 fetched ${msgs.length} new message(s)` +
          (firstId !== undefined && lastId !== undefined
            ? ` (ids ${firstId}..${lastId})`
            : ''),
      );

      let highestId = lastSeenMessageId;
      for (const message of msgs) {
        // Advance the watermark for THIS batch. The DB UNIQUE constraint
        // on (channel_id, message_id) protects us if we somehow re-fetch
        // the same id after a restart — `insertPlaceholder` returns the
        // existing record instead of erroring.
        highestId = Math.max(highestId, message.id);

        try {
          await handleMessage(message, client, enrichedConfig, tradingEngine, repo);
        } catch (err) {
          // Log and continue — one bad message shouldn't stop the loop.
          logger.error('Error handling polled message', {
            error: errToString(err),
            messageId: message.id,
          });
        }
      }

      // Commit the watermark for the batch only after all messages in the
      // batch have been attempted (so a mid-batch crash re-fetches the
      // unprocessed tail on restart — safely deduped by the DB).
      lastSeenMessageId = highestId;
    } catch (err) {
      // Network blip, auth error, etc. — log and keep polling. gramJS
      // handles most transient retries internally; FloodWaitErrors are
      // caught inside `timedCall`. Anything that reaches here is a
      // non-FloodWait error we want to surface without dying.
      logger.error('Poll iteration failed — will retry on next tick', {
        error: errToString(err),
      });
    } finally {
      // Decay backoff counter once per poll. When it reaches 0, the
      // next poll returns to CHECK_INTERVAL_MS.
      if (backoffRemaining > 0) {
        backoffRemaining--;
        if (backoffRemaining === 0) {
          logger.info('FloodWait backoff window expired — resuming fast cadence');
        }
      }
      pollInFlight = false;
      // Visible heartbeat every poll so the operator can see the cadence.
      logger.debug(
        `Poll complete — next in ${intervalUsed}ms` +
          (inBackoff ? ` (backoff: ${backoffRemaining} remaining)` : ''),
      );
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    const interval = backoffRemaining > 0 ? BACKOFF_INTERVAL_MS : CHECK_INTERVAL_MS;
    timer = setTimeout(async () => {
      await pollOnce();
      scheduleNext();
    }, interval);
  };

  scheduleNext();
  logger.info(
    `Live listener started — phase-1 check every ${CHECK_INTERVAL_MS}ms ` +
      `(backs off to ${BACKOFF_INTERVAL_MS}ms for ${BACKOFF_POLLS} polls on FloodWait).`,
  );

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    logger.info('Live listener stopped (polling cancelled).');
    // Terminate the Tesseract OCR worker so its worker thread doesn't
    // keep the Node.js process alive during shutdown.
    await shutdownOcr();
  };

  return { tradingEngine, stop };
}

// ---------------------------------------------------------------------------
// Per-message handler
// ---------------------------------------------------------------------------

/**
 * Process a single polled photo message end-to-end.
 *
 * Identical pipeline to the previous event-listener version — only the
 * delivery mechanism (poll vs push) has changed.
 */
async function handleMessage(
  message: Api.Message,
  client: TelegramClient,
  config: EnrichedConfig,
  tradingEngine: TradingEngine | null,
  repo: TradeRepository,
): Promise<void> {
  // 1. Photo-only filter — ignore text/video/sticker/etc.
  //    (Channel filtering is unnecessary here: we polled this specific
  //    channel entity, so every message we receive is from it.)
  if (!message.photo) {
    logger.debug(`Message ${message.id} has no photo, skipping`);
    return;
  }

  logger.info(`>>> New photo message detected (msg ${message.id}) <<<`);

  // 2. Download photo — returns Buffer immediately, persists to disk in
  //    the background. The Buffer is used for all analysis to avoid
  //    redundant disk reads. The disk write is for audit/reprocessing only.
  const downloadDir =
    process.env['DOWNLOAD_DIRECTORY'] || path.join(process.cwd(), 'downloads', 'raw');
  const downloaded = await downloadMessagePhotoLive(client, message, downloadDir);
  if (!downloaded) {
    logger.error(`Failed to download photo for message ${message.id}`);
    return;
  }
  const { buffer: imageBuffer, filePath: imagePath, writePromise } = downloaded;

  // 3. Insert placeholder DB record (audit trail)
  //    We store `imagePath` even though the file may not be on disk yet —
  //    the background write will complete (or log an error) within a few ms.
  const msgTime = new Date((message.date as number) * 1000);
  const caption = (message.message as string) ?? '';
  const trade = repo.insertPlaceholder({
    telegramMessageId: message.id,
    telegramChannelId: config.channelId,
    telegramMessageTime: msgTime,
    imagePath,
    caption,
  });

  // 4. Validate screenshot — pass the Buffer, no disk read needed.
  const validation = await validateScreenshot(imageBuffer);
  if (!validation.valid) {
    logger.info(`Screenshot validation failed: ${validation.reason}`);
    if (trade) {
      repo.updateAnalysis(trade.id, {
        symbol: null,
        optionType: null,
        confidence: 0,
        method: null,
        parserVersion: 'live-1.1.0',
      });
    }
    return;
  }
  logger.info('Screenshot validation passed');

  // 5. Analyze — pass the Buffer + writePromise. The Buffer is used for
  //    all hot-path analysis (VLM, single-pass OCR, whitespace fallback).
  //    The writePromise is only awaited if the rare multi-strategy OCR
  //    fallback is invoked (it needs a path on disk).
  const analysisResult = await analyzeScreenshot(
    imageBuffer,
    imagePath,
    writePromise,
    config.detector,
  );
  logger.info(
    `Analysis: symbol=${analysisResult.symbol} optionType=${analysisResult.optionType} ` +
      `confidence=${analysisResult.confidence}% method=${analysisResult.method}`,
  );

  // 6. Update DB with analysis results
  if (trade) {
    repo.updateAnalysis(trade.id, {
      symbol: analysisResult.symbol,
      optionType: analysisResult.optionType,
      confidence: analysisResult.confidence,
      method: analysisResult.method || null,
      parserVersion: 'live-1.1.0',
    });
  }

  // 7. Execute trade if enabled + analysis succeeded
  if (!analysisResult.symbol || !analysisResult.optionType) {
    logger.warn('Analysis incomplete — skipping trade');
    return;
  }

  if (!config.enableTrading || !tradingEngine) {
    logger.info('Trading disabled, skipping order execution');
    return;
  }

  // Serialize order placement
  const result = await orderMutex.run(async () => {
    const signal = createTradeSignal(
      analysisResult.symbol as 'NIFTY' | 'BANKNIFTY',
      analysisResult.optionType as 'CE' | 'PE',
      analysisResult.confidence,
      message.id,
    );
    logger.info(`Executing trade for message ${message.id} (serialized)...`);
    return tradingEngine!.processTradeSignal(signal);
  });

  if (result.success) {
    logger.info(`Trade executed: ${result.orderId || 'dry-run'}`);
  } else {
    logger.warn(`Trade execution failed: ${result.message}`);
  }
}

// ---------------------------------------------------------------------------
// Analysis pipeline
// ---------------------------------------------------------------------------

interface AnalysisResult {
  symbol: string | null;
  optionType: OptionType | null;
  confidence: number;
  method: string | null;
}

/**
 * Run the analysis pipeline on a single screenshot.
 *
 * PARALLEL EXECUTION
 * ------------------
 * Symbol detection (OCR) and option-type detection (VLM or OCR) run in
 * PARALLEL because they don't depend on each other. This cuts end-to-end
 * latency roughly in half vs. serial execution.
 *
 * Concretely, in `vlm` mode the timeline looks like:
 *
 *   t=0      -+- OCR (unified header)  --> symbolScore (whitespace)
 *              +- VLM API call          --> optionScore
 *   t=max(ocr,vlm)
 *
 * If the symbol's single-pass OCR fails, the fallback (full OCR re-run)
 * only starts AFTER the parallel phase completes - but that's rare and
 * the option-type result is already known by then.
 *
 * Option-type detection strategy:
 *   - "vlm":       VLM primary, OCR fallback if VLM fails
 *   - "ocr":       OCR only
 *   - "vlm-only":  VLM only (returns null if VLM fails)
 */
async function analyzeScreenshot(
  imageBuffer: Buffer,
  imagePath: string,
  writePromise: Promise<void>,
  detector: 'vlm' | 'ocr' | 'vlm-only',
): Promise<AnalysisResult> {
  // -----------------------------------------------------------------------
  // Phase 1: Run symbol detection and option-type detection IN PARALLEL.
  // -----------------------------------------------------------------------
  // Memoized unified OCR - runs ONCE, shared by both symbol detection and
  // option-type OCR fallback. Uses the in-memory Buffer (no disk read).
  const ocrPromise = ocrHeaderOnce(imageBuffer).catch((err) => {
    throw new Error(`Unified OCR failed: ${errToString(err)}`);
  });

  // Symbol detection: depends on unified OCR, may fall back to full re-OCR.
  // Both paths use the Buffer — no disk read needed.
  const symbolPromise: Promise<{
    score: DetectionScore<string>;
    ocrFailed: boolean;
  }> = ocrPromise
    .then(async (ocrResult) => {
      let score = detectByWhitespaceFromOcr(ocrResult);
      if (!score.value) {
        logger.debug('Single-pass symbol detection failed, falling back to original method');
        score = await detectByWhitespace(imageBuffer);
      }
      return { score, ocrFailed: false };
    })
    .catch((err) => {
      // Unified OCR failed entirely - try the standalone whitespace method
      logger.warn('Unified OCR failed for symbol detection, trying standalone method', {
        error: errToString(err),
      });
      return detectByWhitespace(imageBuffer).then((score) => ({ score, ocrFailed: true }));
    });

  // Option-type detection
  const optionPromise: Promise<DetectionScore<OptionType>> = (async () => {
    if (detector === 'ocr') {
      // OCR-only mode: use the shared unified OCR result
      try {
        const ocrResult = await ocrPromise;
        let score = detectOptionTypeFromHeaderOcr(ocrResult);
        if (!score.value) {
          logger.debug('Single-pass CE/PE failed, falling back to multi-strategy OCR');
          // Multi-strategy OCR needs a file path. Await the background write
          // to ensure the file exists on disk before invoking it.
          await writePromise;
          score = await detectOptionTypeByOcr(imagePath);
        }
        return score;
      } catch {
        // Unified OCR failed - fall back to multi-strategy OCR directly
        await writePromise;
        return detectOptionTypeByOcr(imagePath);
      }
    }

    // VLM mode (or vlm-only): call VLM first. Uses the Buffer — no disk read.
    logger.info('Calling VLM for option-type detection...');
    const vlmScore = await detectOptionTypeByVlm(imageBuffer);
    if (vlmScore.value) {
      logger.info(`VLM detected: ${vlmScore.value} (${vlmScore.confidence}%)`);
      return vlmScore;
    }

    // VLM failed
    if (detector === 'vlm-only') {
      logger.warn('VLM failed in vlm-only mode, no fallback - option type unknown');
      return vlmScore; // null value
    }

    // vlm mode: fall back to OCR using the shared unified OCR result
    logger.warn('VLM detection failed or returned UNKNOWN, falling back to OCR');
    try {
      const ocrResult = await ocrPromise;
      let score = detectOptionTypeFromHeaderOcr(ocrResult);
      if (!score.value) {
        // Multi-strategy OCR needs a file path. Await the background write.
        await writePromise;
        score = await detectOptionTypeByOcr(imagePath);
      }
      return score;
    } catch {
      // Unified OCR also failed - last resort: multi-strategy OCR
      await writePromise;
      return detectOptionTypeByOcr(imagePath);
    }
  })();

  // -----------------------------------------------------------------------
  // Phase 2: Await both results in parallel (they're already running).
  // -----------------------------------------------------------------------
  const [symbolResult, optionScore] = await Promise.all([symbolPromise, optionPromise]);
  const symbolScore = symbolResult.score;

  const symbol = symbolScore.value;
  const optionType = optionScore.value;
  const sConf = symbolScore.confidence;
  const oConf = optionScore.confidence;

  // Confidence blend - matches analyze.ts
  let confidence: number;
  if (sConf === 0 && oConf === 0) {
    confidence = 0;
  } else if (sConf > 0 && oConf > 0) {
    confidence = clampConfidence(sConf * 0.6 + oConf * 0.4);
  } else {
    confidence = clampConfidence(Math.max(sConf, oConf));
  }

  let method: string | null = null;
  if (symbolScore.value && optionScore.value) {
    method =
      symbolScore.confidence >= optionScore.confidence
        ? symbolScore.method
        : optionScore.method;
  } else if (symbolScore.value) {
    method = symbolScore.method;
  } else if (optionScore.value) {
    method = optionScore.method;
  }

  return { symbol, optionType, confidence, method };
}
