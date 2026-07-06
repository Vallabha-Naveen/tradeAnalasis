/**
 * Trade parser — coordinates image analysis and database storage.
 *
 * For each downloaded image, the parser:
 * 1. Runs the image analyzer
 * 2. Creates a DB record with the results
 * 3. Returns the created trade
 *
 * Errors on individual images are caught and logged — never crash the batch.
 */

import { logger } from '../utils/logger.js';
import { analyzeImage } from '../analyzer/imageAnalyzer.js';
import { TradeRepository } from '../database/tradeRepository.js';
import type { Trade, CreateTradeInput, TradeAnalysis } from '../models/Trade.js';
import { config } from '../config/config.js';

/** Result of parsing a single image */
export interface ParseResult {
  success: boolean;
  trade: Trade | null;
  error?: string;
}

/**
 * Parse a single downloaded image and store the result.
 *
 * @param repo     - Trade repository instance
 * @param imagePath - Local path to the downloaded image
 * @param channelId - Telegram channel ID
 * @param messageId - Telegram message ID
 * @param messageTime - When the message was posted
 * @param caption  - Message caption text
 * @returns Parse result with success/failure and the trade record
 */
export async function parseImage(
  repo: TradeRepository,
  imagePath: string,
  channelId: string,
  messageId: number,
  messageTime: Date,
  caption: string,
): Promise<ParseResult> {
  try {
    // Check if already processed
    const existing = await repo.findByMessageId(channelId, messageId);
    if (existing) {
      logger.debug(`Skipping already-processed message ${messageId}`);
      return { success: true, trade: existing };
    }

    // Run image analysis
    const analysis: TradeAnalysis = await analyzeImage(imagePath);

    // Create the DB record
    const input: CreateTradeInput = {
      telegramMessageId: messageId,
      telegramChannelId: channelId,
      telegramMessageTime: messageTime,
      imagePath,
      caption,
      analysis,
      parserVersion: config.parser.version,
    };

    const trade = repo.create(input);

    return { success: true, trade };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Parse failed for message ${messageId}: ${errorMsg}`);
    return { success: false, trade: null, error: errorMsg };
  }
}

/**
 * Parse a batch of downloaded images.
 *
 * Processes images sequentially (to avoid overwhelming OCR/Tesseract).
 * Never stops on a single failure.
 *
 * @param repo      - Trade repository instance
 * @param downloads - Array of downloaded message metadata
 * @returns Summary of results
 */
export async function parseBatch(
  repo: TradeRepository,
  downloads: {
    messageId: number;
    channelId: string;
    messageTime: Date;
    imagePath: string;
    caption: string;
  }[],
): Promise<{
  total: number;
  success: number;
  failed: number;
  skipped: number;
  results: ParseResult[];
}> {
  const results: ParseResult[] = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < downloads.length; i++) {
    const dl = downloads[i]!;
    logger.info(`Processing ${i + 1}/${downloads.length}: message ${dl.messageId}`);

    const result = await parseImage(
      repo,
      dl.imagePath,
      dl.channelId,
      dl.messageId,
      dl.messageTime,
      dl.caption,
    );

    results.push(result);

    if (result.trade && !result.error) {
      if (result.trade.id) {
        success++;
      } else {
        skipped++;
      }
    } else {
      failed++;
    }
  }

  logger.info(
    `Batch complete: ${success} success, ${failed} failed, ${skipped} skipped (total: ${downloads.length})`,
  );

  return { total: downloads.length, success, failed, skipped, results };
}