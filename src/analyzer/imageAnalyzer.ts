/**
 * Image analyzer — orchestrates all detection modules to produce
 * a TradeAnalysis from a single screenshot.
 *
 * Detection pipeline:
 * 0. Validate: reject non-phone-screenshot images (wrong size/orientation)
 * 1. Symbol: bar-width (primary) + OCR (fallback)
 * 2. Option type: header-color (primary) + OCR (fallback)
 * 3. Confidence: weighted combination with independent scoring
 *
 * Key fix: symbol and option type confidence are now INDEPENDENT.
 * A high-confidence symbol detection doesn't require option type
 * detection to succeed, and vice versa.
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import type { TradeAnalysis, Symbol, OptionType, DetectionMethod } from '../models/Trade.js';
import { detectByBarWidth, detectByOcr } from './detectSymbol.js';
import { detectOptionTypeByOcr } from './detectOptionType.js';
import { combineScores, clampConfidence } from './confidence.js';
import type { DetectionScore } from './confidence.js';

// ---------------------------------------------------------------------------
// Screenshot validation
// ---------------------------------------------------------------------------

/** Result of validating whether an image is a phone trade screenshot */
interface ValidationResult {
  /** True if the image looks like a valid phone screenshot */
  valid: boolean;
  /** Why it was rejected (undefined if valid) */
  reason?: string;
}

/**
 * Validate that an image looks like a phone trade screenshot.
 *
 * Real phone screenshots have specific characteristics:
 *   - Portrait orientation (height > width)
 *   - Minimum height ~800px (phones are tall)
 *   - Aspect ratio (W/H) between 0.30 and 0.70
 *   - Colored header bar covers a significant CONTIGUOUS portion of width (30-70%)
 *   - Minimum absolute bar pixel count (rejects scattered colored pixels)
 *   - The colored region must be contiguous (not scattered across the row)
 *
 * Images that fail these checks are likely charts, memes, forwarded
 * photos, or other non-trade content posted in the channel.
 */
async function validateScreenshot(imagePath: string): Promise<ValidationResult> {
  try {
    const meta = await sharp(imagePath).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;

    // Must be portrait orientation
    if (H <= W) {
      return { valid: false, reason: `landscape orientation (${W}x${H})` };
    }

    // Must be tall enough to be a phone screenshot
    if (H < 800) {
      return { valid: false, reason: `too short (${H}px, min 800)` };
    }

    // Aspect ratio check (W/H)
    // Max 0.75 to accommodate phones with wider screens or slight cropping.
    // Previously 0.70 rejected valid screenshots (e.g., 1794x2560 = 0.701).
    const ratio = W / H;
    if (ratio < 0.30 || ratio > 0.75) {
      return { valid: false, reason: `unexpected aspect ratio ${ratio.toFixed(2)} (${W}x${H})` };
    }

    // ------------------------------------------------------------------
    // Multi-row contiguous bar detection (matches extractBarMetrics logic)
    // ------------------------------------------------------------------
    const scanH = Math.min(200, H);
    // Scan from row 0 — the red bar can start at the very top of the image.
    const raw = await sharp(imagePath)
      .extract({ left: 0, top: 0, width: W, height: scanH })
      .removeAlpha()
      .raw()
      .toBuffer();

    function isColoredPx(r: number, g: number, b: number): boolean {
      return (r > g + 20 && r > b + 20 && r > 60) || (g > r + 20 && g > b + 20 && g > 60);
    }

    // Step 1: Find the densest colored row
    let bestRow = -1;
    let bestCount = 0;
    for (let y = 0; y < scanH; y++) {
      let count = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (isColoredPx(raw[i]!, raw[i + 1]!, raw[i + 2]!)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestRow = y;
      }
    }

    // Step 2: Minimum absolute colored pixel count on best row
    // Real trade screenshots have bars that are at least 300px wide on any phone
    if (bestCount < 300) {
      return { valid: false, reason: `insufficient colored pixels (${bestCount}px, min 300)` };
    }

    // Step 3: Multi-row band analysis for contiguous bar detection
    const bandRows: number[] = [];
    for (let dy = -5; dy <= 5; dy++) {
      const y = bestRow + dy;
      if (y >= 0 && y < scanH) bandRows.push(y);
    }

    // For each column, count how many band rows have colored pixels
    const colColorCount = new Uint8Array(W);
    for (const y of bandRows) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (isColoredPx(raw[i]!, raw[i + 1]!, raw[i + 2]!)) {
          colColorCount[x] = (colColorCount[x] ?? 0) + 1;
        }
      }
    }

    // Find the contiguous bar end (same gap-tolerance logic as extractBarMetrics)
    const minRows = Math.max(1, Math.floor(bandRows.length * 0.4));
    let barEnd = -1;
    let gap = 0;
    for (let x = 0; x < W; x++) {
      if ((colColorCount[x] ?? 0) >= minRows) {
        barEnd = x;
        gap = 0;
      } else if (barEnd >= 0) {
        gap++;
        if (gap > 10) break;
      }
    }

    const contiguousBarWidth = barEnd + 1;
    const contiguousBarRatio = contiguousBarWidth / W;

    // A valid trade bar must be contiguous and cover 30-70% of width
    if (contiguousBarRatio < 0.30) {
      return {
        valid: false,
        reason: `no contiguous colored bar (${(contiguousBarRatio * 100).toFixed(1)}% of width, need 30%)`,
      };
    }

    if (contiguousBarRatio > 0.70) {
      return {
        valid: false,
        reason: `colored area too wide (${(contiguousBarRatio * 100).toFixed(1)}% of width, max 70%)`,
      };
    }

    logger.debug(
      `Validation passed: barRatio=${contiguousBarRatio.toFixed(4)} barWidth=${contiguousBarWidth}px ` +
        `bestRow=${bestRow} bestCount=${bestCount}`,
    );

    return { valid: true };
  } catch (err) {
    logger.error(`Screenshot validation failed for ${imagePath}`, { error: String(err) });
    return { valid: false, reason: `validation error: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single screenshot image.
 *
 * @param imagePath - Path to the downloaded screenshot
 * @returns TradeAnalysis with the best-guess symbol, option type, and confidence
 */
export async function analyzeImage(imagePath: string): Promise<TradeAnalysis> {
  logger.info(`Analyzing image: ${imagePath}`);

  try {
    // Step 0: Validate that this is a phone trade screenshot
    const validation = await validateScreenshot(imagePath);
    if (!validation.valid) {
      logger.info(`Skipped (not a trade screenshot): ${validation.reason}`);
      return { symbol: null, optionType: null, confidence: 0, method: null };
    }

    // Run symbol detectors in parallel, OCR for option type
    const [barWidthScore, ocrSymbolScore, ocrOptionScore] = await Promise.all([
      detectByBarWidth(imagePath),
      detectByOcr(imagePath),
      detectOptionTypeByOcr(imagePath),
    ]);

    // --- Symbol detection ---
    const symbolScores: DetectionScore<string>[] = [];
    if (barWidthScore.value !== null) symbolScores.push(barWidthScore);
    if (ocrSymbolScore.value !== null) symbolScores.push(ocrSymbolScore);

    const symbolResult =
      symbolScores.length > 0 ? combineScores(symbolScores) : null;

    // --- Option type detection (OCR only — bar color is always red, not an indicator) ---
    const optionResult = ocrOptionScore.value !== null ? ocrOptionScore : null;

    // --- Assemble results ---
    const symbol: Symbol = symbolResult?.value ?? null;
    const optionType: OptionType = (optionResult?.value as OptionType) ?? null;
    const confidence = calculateOverallConfidence(
      symbolResult,
      optionResult as DetectionScore<string> | null,
    );
    const method = determinePrimaryMethod(
      symbolResult,
      optionResult as DetectionScore<string> | null,
    );

    const analysis: TradeAnalysis = {
      symbol,
      optionType,
      confidence,
      method,
    };

    logger.info(
      `Analysis result: symbol=${symbol ?? 'NULL'} optionType=${optionType ?? 'NULL'} ` +
        `confidence=${confidence.toFixed(0)}% method=${method}`,
    );

    return analysis;
  } catch (err) {
    logger.error(`Image analysis failed for ${imagePath}`, { error: String(err) });
    return { symbol: null, optionType: null, confidence: 0, method: null };
  }
}

/**
 * Calculate overall confidence.
 *
 * Unlike the previous version, symbol and option type are scored
 * INDEPENDENTLY. If only one is detected, we use that confidence
 * directly (no artificial 50% cap).
 */
function calculateOverallConfidence(
  symbolResult: DetectionScore<string> | null,
  optionTypeResult: DetectionScore<string> | null,
): number {
  const sConf = symbolResult?.confidence ?? 0;
  const oConf = optionTypeResult?.confidence ?? 0;

  if (sConf === 0 && oConf === 0) return 0;

  // Both detected: weighted combination
  if (sConf > 0 && oConf > 0) {
    return clampConfidence(sConf * 0.6 + oConf * 0.4);
  }

  // Only one detected: use its confidence (no penalty for missing the other)
  return clampConfidence(Math.max(sConf, oConf));
}

/**
 * Determine the primary detection method for the result.
 */
function determinePrimaryMethod(
  symbolResult: DetectionScore<string> | null,
  optionTypeResult: DetectionScore<string> | null,
): DetectionMethod {
  if (!symbolResult && !optionTypeResult) return null;
  if (!symbolResult) return (optionTypeResult?.method as DetectionMethod) ?? null;
  if (!optionTypeResult) return (symbolResult.method as DetectionMethod) ?? null;
  return symbolResult.confidence >= optionTypeResult.confidence
    ? (symbolResult.method as DetectionMethod)
    : (optionTypeResult.method as DetectionMethod);
}