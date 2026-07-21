/**
 * Symbol (NIFTY/BANKNIFTY) detection using Google Cloud Vision OCR.
 *
 * Uses the text returned by Google Vision's TEXT_DETECTION to identify
 * whether the screenshot is for NIFTY or BANKNIFTY.
 *
 * Google Vision's OCR is accurate enough that simple text matching works
 * reliably — no need for the whitespace analysis required by Tesseract.
 */

import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import { ocrHeaderWithGoogleVision, type GoogleVisionOcrResult } from './googleVisionOcr.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse NIFTY/BANKNIFTY from Google Vision OCR text.
 *
 * Strategy:
 *   1. Look for "BANKNIFTY" first (it contains "NIFTY" as a substring,
 *      so we must check the longer match first to avoid false positives)
 *   2. Then look for "NIFTY" as a standalone word
 *   3. Also check "BANK NIFTY" (two words) and "NIFTY BANK" (reversed)
 *   4. If neither found, return null
 */
export function detectSymbolFromGoogleVisionText(
  ocrResult: GoogleVisionOcrResult,
): DetectionScore<string> {
  const text = ocrResult.fullText.toUpperCase();

  // Check for BANKNIFTY (check this FIRST — "NIFTY" is a substring)
  // Match "BANKNIFTY", "BANK NIFTY", "BANK-NIFTY", "NIFTYBANK", "NIFTY BANK"
  const bankNiftyPatterns = [
    /\bBANK[\s\-]?NIFTY\b/,
    /\bNIFTY[\s\-]?BANK\b/,
    /\bBANKNIFTY\b/,
  ];
  for (const pattern of bankNiftyPatterns) {
    if (pattern.test(text)) {
      logger.debug('GoogleVision symbol: BANKNIFTY detected');
      return { value: 'BANKNIFTY', confidence: 95, method: 'google-vision' };
    }
  }

  // Check for NIFTY (but NOT "BANKNIFTY" — already checked above)
  // \b ensures we match "NIFTY" as a standalone word
  if (/\bNIFTY\b/.test(text)) {
    logger.debug('GoogleVision symbol: NIFTY detected');
    return { value: 'NIFTY', confidence: 95, method: 'google-vision' };
  }

  // Also check word annotations for robustness
  for (const word of ocrResult.words) {
    const w = word.text.toUpperCase().trim();
    if (w === 'BANKNIFTY' || w === 'BANK-NIFTY') {
      return { value: 'BANKNIFTY', confidence: 95, method: 'google-vision' };
    }
    if (w === 'NIFTY') {
      return { value: 'NIFTY', confidence: 95, method: 'google-vision' };
    }
  }

  logger.debug('GoogleVision symbol: neither NIFTY nor BANKNIFTY found', {
    text: text.slice(0, 200),
  });
  return { value: null, confidence: 0, method: 'google-vision' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect NIFTY/BANKNIFTY using Google Cloud Vision OCR.
 *
 * If you already have a GoogleVisionOcrResult (e.g. from a prior option-type
 * detection call), pass it in to avoid a redundant API call. This is the
 * recommended pattern — ONE Google Vision call per screenshot, used for
 * BOTH symbol and option type detection.
 */
export async function detectSymbolByGoogleVision(
  imageBuffer: Buffer,
  existingOcrResult?: GoogleVisionOcrResult,
): Promise<DetectionScore<string>> {
  try {
    const ocrResult = existingOcrResult ?? (await ocrHeaderWithGoogleVision(imageBuffer));
    const score = detectSymbolFromGoogleVisionText(ocrResult);

    logger.info(
      `GoogleVision symbol: ${score.value ?? 'UNKNOWN'} (${score.confidence}%) ` +
        `— text: "${ocrResult.fullText.slice(0, 100)}"`,
    );

    return score;
  } catch (err) {
    logger.error('GoogleVision: symbol detection failed', {
      error: String(err),
    });
    return { value: null, confidence: 0, method: 'google-vision' };
  }
}
