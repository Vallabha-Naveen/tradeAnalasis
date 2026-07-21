/**
 * Option type (CE/PE) detection using Google Cloud Vision OCR.
 *
 * Uses the text returned by Google Vision's TEXT_DETECTION to identify
 * whether the screenshot shows a CE (Call) or PE (Put) option.
 *
 * Google Vision's OCR is accurate enough that we can use simple regex
 * matching — no need for the complex whitespace analysis required by
 * Tesseract (which frequently misreads small text).
 *
 * ACCURACY
 * --------
 * Google Vision typically reads the header text with 95%+ accuracy,
 * including small 10-15px text that Tesseract struggles with. The
 * "CE" / "PE" labels are usually clearly printed in the header bar.
 *
 * MERGE-AWARE PARSING
 * -------------------
 * In small header text, Google Vision sometimes merges adjacent tokens
 * when there is no visible inter-word gap. The on-screen layout is:
 *
 *   [bar hiding: SYMBOL STRIKE CE/PE] [CE/PE] [NSE] [FO] [price]
 *
 * Common merges seen in production:
 *   "200 CENSE FO"  -> "200" + "CE NSE" merged + "FO"  (the reported bug)
 *   "200CE NSE FO"  -> strike + CE merged, NSE/FO separate
 *   "CENSEFO"       -> all three merged into one token
 *
 * We handle these by checking each word against a merge-pattern regex
 * AFTER the clean "CE" / "PE" checks fail.
 *
 * NOTE: "CE200" / "PE200" (CE before strike) is NOT a valid pattern -
 * the strike number is always to the LEFT of CE/PE on screen, never
 * the right. We deliberately do NOT match `[CP]E\d+`.
 */

import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import type { OptionType } from '../models/Trade.js';
import { ocrHeaderWithGoogleVision, type GoogleVisionOcrResult } from './googleVisionOcr.js';

// ---------------------------------------------------------------------------
// Merge-pattern regexes
// ---------------------------------------------------------------------------

/**
 * Match CE merged with adjacent tokens.
 *
 * Valid forms (left-to-right matches the on-screen layout):
 *   CE                - clean standalone (already handled by \bCE\b, kept for safety)
 *   200CE             - strike + CE       (any digit prefix)
 *   CENSE             - CE + NSE
 *   CEFO              - CE + FO
 *   CENSEFO           - CE + NSE + FO
 *   200CENSE          - strike + CE + NSE
 *   200CENSEFO        - strike + CE + NSE + FO
 *
 * INVALID (deliberately not matched):
 *   CE200, CE150, ... - CE before strike never appears on screen
 *
 * Anchored to the whole word (^...$) so substrings like "CENSUS",
 * "SUSPENSE", "REPENT" do NOT false-positive.
 *
 * Alternation order matters: NSEFO is listed BEFORE NSE so the engine
 * takes the longest match first (otherwise "CENSEFO" would match as
 * "CENSE" + leftover "FO", failing the trailing $ anchor and forcing
 * a backtrack - works either way, but explicit longest-first is faster
 * and clearer).
 */
const CE_MERGE_REGEX = /^(\d+)?CE(NSEFO|NSE|FO)?$/;
const PE_MERGE_REGEX = /^(\d+)?PE(NSEFO|NSE|FO)?$/;

/**
 * Full-text merge regex (backup when word annotations are missing).
 *
 * Same logic as CE_MERGE_REGEX but with \b word boundaries so it can
 * scan the concatenated fullText. Matches both clean "CE" and any
 * valid merge form.
 */
const CE_FULL_REGEX = /\b(?:\d+)?CE(?:NSEFO|NSE|FO)?\b/g;
const PE_FULL_REGEX = /\b(?:\d+)?PE(?:NSEFO|NSE|FO)?\b/g;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse CE/PE from Google Vision OCR text.
 *
 * Strategy:
 *   1. Scan full text with merge-aware regex (catches "CE", "200CE", "CENSE", ...)
 *   2. Scan individual word annotations with merge-aware regex (more reliable
 *      when Google Vision's word segmentation is correct)
 *   3. If both CE and PE found, pick the one with the HIGHEST x-position
 *      (rightmost) - the option type label sits at the right end of the header
 *   4. If neither found, return UNKNOWN
 *
 * @returns DetectionScore with confidence and method='google-vision'
 */
export function parseOptionTypeFromText(ocrResult: GoogleVisionOcrResult): DetectionScore<OptionType> {
  const text = ocrResult.fullText.toUpperCase();

  // Find all CE/PE occurrences with their positions
  const ceMatches: number[] = [];
  const peMatches: number[] = [];

  // --- Pass 1: Full-text regex (catches clean CE/PE + merge forms) ---
  let match: RegExpExecArray | null;
  CE_FULL_REGEX.lastIndex = 0;
  PE_FULL_REGEX.lastIndex = 0;
  while ((match = CE_FULL_REGEX.exec(text)) !== null) {
    ceMatches.push(match.index);
  }
  while ((match = PE_FULL_REGEX.exec(text)) !== null) {
    peMatches.push(match.index);
  }

  // --- Pass 2: Word-level annotations (more reliable when segmentation is good) ---
  // Also catches OCR variants like "C.E", "C E", "CE."
  for (const word of ocrResult.words) {
    const w = word.text.toUpperCase().trim();
    if (w === 'CE' || w === 'C.E' || w === 'C E' || w === 'CE.') {
      ceMatches.push(word.bbox[0]);
      continue;
    }
    if (w === 'PE' || w === 'P.E' || w === 'P E' || w === 'PE.') {
      peMatches.push(word.bbox[0]);
      continue;
    }
    // Merge-aware: "200CE", "CENSE", "CENSEFO", "200CENSEFO", etc.
    if (CE_MERGE_REGEX.test(w)) {
      ceMatches.push(word.bbox[0]);
      continue;
    }
    if (PE_MERGE_REGEX.test(w)) {
      peMatches.push(word.bbox[0]);
      continue;
    }
  }

  if (ceMatches.length === 0 && peMatches.length === 0) {
    // Enhanced debug: log individual words so future merge patterns are
    // easy to spot without needing to re-run with verbose logging.
    const wordList = ocrResult.words.map(w => `"${w.text}"@[${w.bbox[0]}..${w.bbox[2]}]`).join(' ');
    logger.debug('GoogleVision CE/PE: neither CE nor PE found in text', {
      text: text.slice(0, 200),
      words: wordList,
    });
    return { value: null, confidence: 0, method: 'google-vision' };
  }

  // If both found, pick the one with the HIGHEST x-position (rightmost)
  // - the option type label is at the right end of the header bar
  if (ceMatches.length > 0 && peMatches.length > 0) {
    const lastCe = Math.max(...ceMatches);
    const lastPe = Math.max(...peMatches);
    if (lastPe > lastCe) {
      logger.debug(`GoogleVision CE/PE: both found, PE is rightmost (PE@${lastPe} > CE@${lastCe})`);
      return { value: 'PE', confidence: 95, method: 'google-vision' };
    } else {
      logger.debug(`GoogleVision CE/PE: both found, CE is rightmost (CE@${lastCe} > PE@${lastPe})`);
      return { value: 'CE', confidence: 95, method: 'google-vision' };
    }
  }

  // Only one found
  if (ceMatches.length > 0) {
    logger.debug(`GoogleVision CE/PE: CE detected (${ceMatches.length} occurrence(s))`);
    return { value: 'CE', confidence: 95, method: 'google-vision' };
  }

  logger.debug(`GoogleVision CE/PE: PE detected (${peMatches.length} occurrence(s))`);
  return { value: 'PE', confidence: 95, method: 'google-vision' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect CE/PE from an existing Google Vision OCR result (no API call).
 *
 * Use this when you already have a GoogleVisionOcrResult (e.g. from a prior
 * symbol detection call) to avoid a redundant API call. This is the
 * recommended pattern - ONE Google Vision call per screenshot, used for
 * BOTH symbol and option type detection.
 */
export function detectOptionTypeByGoogleVisionFromText(
  ocrResult: GoogleVisionOcrResult,
): DetectionScore<OptionType> {
  return parseOptionTypeFromText(ocrResult);
}

/**
 * Detect CE/PE using Google Cloud Vision OCR.
 *
 * @param imageBuffer In-memory image Buffer (from Telegram download)
 * @returns DetectionScore<OptionType> with confidence and method='google-vision'
 */
export async function detectOptionTypeByGoogleVision(
  imageBuffer: Buffer,
): Promise<DetectionScore<OptionType> & { ocrResult?: GoogleVisionOcrResult }> {
  try {
    const ocrResult = await ocrHeaderWithGoogleVision(imageBuffer);
    const score = parseOptionTypeFromText(ocrResult);

    logger.info(
      `GoogleVision option type: ${score.value ?? 'UNKNOWN'} (${score.confidence}%) ` +
        `- text: "${ocrResult.fullText.slice(0, 100)}"`,
    );

    return { ...score, ocrResult };
  } catch (err) {
    logger.error('GoogleVision: option type detection failed', {
      error: String(err),
    });
    return { value: null, confidence: 0, method: 'google-vision' };
  }
}
