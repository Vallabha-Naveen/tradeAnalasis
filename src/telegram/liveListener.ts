/**
 * Live listener — monitors a Telegram channel in real-time for trade signals.
 *
 * Pipeline per new photo message:
 *   1. Channel filter (by resolved channel entity — robust for public+private)
 *   2. Download photo
 *   3. Insert placeholder DB record (audit trail even if analysis fails)
 *   4. Validate screenshot (orientation, colored header bar, etc.)
 *   5. Analyze:
 *        - Symbol: whitespace-based OCR (same as offline)
 *        - Option type: VLM primary (glm-4v), OCR fallback
 *   6. Update DB record with analysis results
 *   7. If trading enabled → acquire mutex → execute SELL order
 *
 * DETECTOR CONFIG
 * ---------------
 * Controlled by OPTION_TYPE_DETECTOR env var:
 *   - "vlm"       (default) VLM primary, OCR fallback if VLM fails
 *   - "ocr"                  OCR only (no VLM dependency)
 *   - "vlm-only"             VLM only, skip trade if VLM fails
 */

import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events';
import { Api } from 'telegram';

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import { downloadMessagePhoto } from './mediaDownloader.js';
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
} from '../analyzer/detectOptionTypeVLM.js';
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
  /** Resolved numeric channel ID (as string) — used for filtering */
  channelId: string;
  /** Which option-type detector to use */
  detector: 'vlm' | 'ocr' | 'vlm-only';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start listening for new messages in the configured channel.
 *
 * @returns The trading engine (so the caller can shut it down on exit).
 */
export async function startLiveListener(
  client: TelegramClient,
  config: LiveListenerConfig,
): Promise<{ tradingEngine: TradingEngine | null }> {
  logger.info(`Starting live listener for channel: ${config.channelUsername}`);
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

  // 3. Resolve the channel entity ONCE — we'll use its ID for filtering
  //    inside the event handler. We do NOT pass the entity to NewMessage's
  //    `chats` parameter because gramJS's resolution of that parameter is
  //    unreliable across versions (it calls toString() on the entity,
  //    producing "[object Object]" and crashing).
  const normalizedUsername = config.channelUsername.replace('@', '');
  let channelId: string;
  let channelAccessHash: string | undefined;
  try {
    const channelEntity: any = await client.getEntity(normalizedUsername);
    channelId = String(channelEntity.id);
    // For channels, the access hash is on channelEntity.accessHash
    // (might be a BigInt — convert to string for logging only)
    channelAccessHash = channelEntity.accessHash
      ? String(channelEntity.accessHash)
      : undefined;
    logger.info(
      `Resolved channel @${normalizedUsername} → ID ${channelId}` +
        (channelAccessHash ? ` (accessHash: ${channelAccessHash})` : ''),
    );

    // Build the canonical InputChannel object and store it for later use.
    // gramJS's NewMessage filter expects either a string username or an
    // InputEntity. We'll use the username string for the filter (reliable)
    // and use the channelId for in-handler verification.
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
    }
  }
  logger.info(`Option-type detector: ${detector}`);

  const enrichedConfig: EnrichedConfig = { ...config, channelId, detector };

  // 5. Register the event handler.
  //
  //    We do NOT use NewMessage's `chats` filter because:
  //      a) Passing an entity object crashes in gramJS 2.26.x (it calls
  //         toString() on the entity → "[object Object]" → entity lookup fails)
  //      b) Passing the username string works but only for the FIRST resolution;
  //          if gramJS hasn't cached the entity yet, it can fail
  //      c) `incoming: true` filters out channel posts in some versions
  //
  //    Instead, we accept ALL new messages and filter inside the handler
  //    using `event.chatId` (always populated by gramJS).
  //
  //    Channel IDs in Telegram have multiple representations:
  //      - Plain ID:    1241322487
  //      - With prefix: -1001241322487
  //    We compare against both forms to be safe.
  client.addEventHandler(
    (event: any) => {
      const message = event.message;
      if (!message) return;
      handleNewMessage(event, client, enrichedConfig, tradingEngine, repo).catch(
        (err) => {
          logger.error('Error handling new message', {
            error: errToString(err),
            messageId: message?.id,
          });
        },
      );
    },
    new NewMessage({}),
  );

  logger.info('Live listener started successfully — waiting for new messages...');
  return { tradingEngine };
}

// ---------------------------------------------------------------------------
// Per-message handler
// ---------------------------------------------------------------------------

async function handleNewMessage(
  event: any,
  client: TelegramClient,
  config: EnrichedConfig,
  tradingEngine: TradingEngine | null,
  repo: TradeRepository,
): Promise<void> {
  const message: Api.Message = event.message;

  // 1. Channel filter — robust comparison handling multiple ID representations.
  //
  //    Telegram channel IDs can appear in 3 forms:
  //      a) event.chatId:       -1001241322487 (with -100 prefix)
  //      b) entity.id:          1241322487     (plain)
  //      c) message.peerId:     1241322487     (plain, as Channel object)
  //
  //    We normalize both sides (strip -100 prefix) and compare.
  const eventChatId = String(event.chatId ?? '');
  const expectedId = String(config.channelId);

  // Normalize: strip leading -100, leading -, leading 100
  function normalizeChatId(id: string): string {
    let s = id;
    if (s.startsWith('-100')) s = s.slice(4);
    else if (s.startsWith('-')) s = s.slice(1);
    else if (s.startsWith('100')) s = s.slice(3);
    return s;
  }

  const eventNorm = normalizeChatId(eventChatId);
  const expectedNorm = normalizeChatId(expectedId);

  // Debug log EVERY message (at debug level) — helps troubleshoot
  // when no messages are being picked up. Enable with LOG_LEVEL=debug.
  logger.debug(
    `Incoming message: msgId=${message.id} eventChatId=${eventChatId} ` +
      `normalized=${eventNorm} expected=${expectedNorm} ` +
      `hasPhoto=${!!message.photo}`,
  );

  if (eventNorm !== expectedNorm) {
    // Different chat — silently skip (this is normal, user is in other chats too)
    return;
  }

  // 2. Photo-only filter — ignore text/video/sticker/etc.
  if (!message.photo) {
    logger.debug(`Message ${message.id} has no photo, skipping`);
    return;
  }

  logger.info(`>>> New photo message received (msg ${message.id}) <<<`);

  // 3. Download photo
  const downloadDir =
    process.env['DOWNLOAD_DIRECTORY'] || path.join(process.cwd(), 'downloads', 'raw');
  const imagePath = await downloadMessagePhoto(client, message, downloadDir);
  if (!imagePath) {
    logger.error(`Failed to download photo for message ${message.id}`);
    return;
  }
  logger.info(`Photo downloaded: ${imagePath}`);

  // 4. Insert placeholder DB record (audit trail)
  const msgTime = new Date((message.date as number) * 1000);
  const caption = (message.message as string) ?? '';
  const trade = repo.insertPlaceholder({
    telegramMessageId: message.id,
    telegramChannelId: config.channelId,
    telegramMessageTime: msgTime,
    imagePath,
    caption,
  });

  // 5. Validate screenshot
  const validation = await validateScreenshot(imagePath);
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

  // 6. Analyze
  const analysisResult = await analyzeScreenshot(imagePath, config.detector);
  logger.info(
    `Analysis: symbol=${analysisResult.symbol} optionType=${analysisResult.optionType} ` +
      `confidence=${analysisResult.confidence}% method=${analysisResult.method}`,
  );

  // 7. Update DB with analysis results
  if (trade) {
    repo.updateAnalysis(trade.id, {
      symbol: analysisResult.symbol,
      optionType: analysisResult.optionType,
      confidence: analysisResult.confidence,
      method: analysisResult.method || null,
      parserVersion: 'live-1.1.0',
    });
  }

  // 8. Execute trade if enabled + analysis succeeded
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
  imagePath: string,
  detector: 'vlm' | 'ocr' | 'vlm-only',
): Promise<AnalysisResult> {
  // -----------------------------------------------------------------------
  // Phase 1: Run symbol detection and option-type detection IN PARALLEL.
  // -----------------------------------------------------------------------
  // Memoized unified OCR - runs ONCE, shared by both symbol detection and
  // option-type OCR fallback.
  const ocrPromise = ocrHeaderOnce(imagePath).catch((err) => {
    throw new Error(`Unified OCR failed: ${errToString(err)}`);
  });

  // Symbol detection: depends on unified OCR, may fall back to full re-OCR
  const symbolPromise: Promise<{
    score: DetectionScore<string>;
    ocrFailed: boolean;
  }> = ocrPromise
    .then(async (ocrResult) => {
      let score = detectByWhitespaceFromOcr(ocrResult);
      if (!score.value) {
        logger.debug('Single-pass symbol detection failed, falling back to original method');
        score = await detectByWhitespace(imagePath);
      }
      return { score, ocrFailed: false };
    })
    .catch((err) => {
      // Unified OCR failed entirely - try the standalone whitespace method
      logger.warn('Unified OCR failed for symbol detection, trying standalone method', {
        error: errToString(err),
      });
      return detectByWhitespace(imagePath).then((score) => ({ score, ocrFailed: true }));
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
          score = await detectOptionTypeByOcr(imagePath);
        }
        return score;
      } catch {
        // Unified OCR failed - fall back to multi-strategy OCR directly
        return detectOptionTypeByOcr(imagePath);
      }
    }

    // VLM mode (or vlm-only): call VLM first
    logger.info('Calling VLM for option-type detection...');
    const vlmScore = await detectOptionTypeByVlm(imagePath);
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
        score = await detectOptionTypeByOcr(imagePath);
      }
      return score;
    } catch {
      // Unified OCR also failed - last resort: multi-strategy OCR
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
