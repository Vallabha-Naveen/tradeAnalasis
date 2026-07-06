/**
 * Symbol detection — determines which index a screenshot belongs to.
 *
 * The instrument name in the trading app screenshots is hidden/masked
 * behind a colored bar (red for PE, green for CE). The bar width is
 * proportional to the hidden text length:
 *
 *   BANKNIFTY 24500 CE  → wider bar  (ratio ~0.50–0.58 of image width)
 *   NIFTY 24500 CE      → narrower bar (ratio ~0.38–0.48 of image width)
 *
 * Detection strategy:
 *   1. PRIMARY: Multi-row colored bar width ratio
 *   2. SECONDARY: OCR on the post-bar area for "NSE FO" landmark position
 *
 * The detector is extensible — add new symbols to KNOWN_SYMBOLS and
 * SYMBOL_PROFILES as the trader expands to other indices.
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import { clampConfidence } from './confidence.js';

// ---------------------------------------------------------------------------
// Extensible symbol registry
// ---------------------------------------------------------------------------

/** All known symbols. Add new indices here as the trader expands. */
export const KNOWN_SYMBOLS = ['NIFTY', 'BANKNIFTY'] as const;

// ---------------------------------------------------------------------------
// Calibration profiles
// ---------------------------------------------------------------------------

/**
 * Bar-width ratio profiles per symbol, calibrated against real screenshots.
 *
 * Measured values from reference screenshots (multi-row analysis):
 *   NIFTY:     ~0.444 (1723px wide image, bar=765px)
 *   NIFTY:     ~0.501 (1678px wide image, bar=841px) — longer strike/extra text
 *   BANKNIFTY: ~0.531 (1670px wide image, bar=887px)
 *
 * Boundary at 0.52 — midpoint between highest NIFTY (0.501) and
 * lowest BANKNIFTY (0.531). Generous ranges handle strike-price
 * width variation and different font rendering across app versions.
 */
interface SymbolProfile {
  /** Lower bound of bar-ratio range */
  minRatio: number;
  /** Upper bound of bar-ratio range */
  maxRatio: number;
  /** Center of expected range (for distance-based confidence) */
  center: number;
}

const SYMBOL_PROFILES: Record<string, SymbolProfile> = {
  NIFTY: { minRatio: 0.36, maxRatio: 0.52, center: 0.44 },
  BANKNIFTY: { minRatio: 0.52, maxRatio: 0.64, center: 0.58 },
};

// ---------------------------------------------------------------------------
// Pixel classification helpers
// ---------------------------------------------------------------------------

function isRed(r: number, g: number, b: number): boolean {
  return r > g + 20 && r > b + 20 && r > 60;
}

function isGreen(r: number, g: number, b: number): boolean {
  return g > r + 20 && g > b + 20 && g > 60;
}

function isColored(r: number, g: number, b: number): boolean {
  return isRed(r, g, b) || isGreen(r, g, b);
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

interface BarMetrics {
  /** Rightmost column of the colored bar (0-indexed) */
  barEnd: number;
  /** Bar width in pixels (barEnd + 1) */
  barWidth: number;
  /** barWidth / imageWidth — the key discriminant */
  barRatio: number;
  /** Image width in pixels */
  imageWidth: number;
  /** Y-coordinate of the densest colored row */
  headerRow: number;
  /** Total red-ish pixel count in the bar region */
  redPixels: number;
  /** Total green-ish pixel count in the bar region */
  greenPixels: number;
}

/**
 * Extract the colored header bar metrics using multi-row analysis.
 *
 * Scans rows 25–200 to find the densest colored row, then uses a
 * band of ±5 rows around it for robust gap-tolerant bar-end detection.
 *
 * This is much more robust than single-row analysis because single
 * rows may have anti-aliasing gaps, UI element overlaps, etc.
 */
export async function extractBarMetrics(imagePath: string): Promise<BarMetrics> {
  const meta = await sharp(imagePath).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const scanH = Math.min(200, H);

  // Extract top portion for scanning
  // NOTE: Start from row 0 (not 25) because the red header bar can begin
  // as early as row 0 on some screenshots (e.g., no status bar gap).
  const scanBand = await sharp(imagePath)
    .extract({ left: 0, top: 0, width: W, height: scanH })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Step 1: Find the densest colored row
  let bestRow = -1;
  let bestCount = 0;

  for (let y = 0; y < scanH; y++) {
    let colorCount = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (isColored(scanBand[i]!, scanBand[i + 1]!, scanBand[i + 2]!)) {
        colorCount++;
      }
    }
    if (colorCount > bestCount) {
      bestCount = colorCount;
      bestRow = y; // scan starts at row 0 now
    }
  }

  // Step 2: Multi-row band analysis (±5 rows around the densest row)
  const bandRows: number[] = [];
  for (let dy = -5; dy <= 5; dy++) {
    const y = bestRow + dy; // scan starts at row 0, so bestRow is already absolute
    if (y >= 0 && y < scanH) {
      bandRows.push(y);
    }
  }

  // For each column, count how many band rows have colored pixels
  const colColorCount = new Uint8Array(W);
  let totalRed = 0;
  let totalGreen = 0;

  for (const y of bandRows) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = scanBand[i]!;
      const g = scanBand[i + 1]!;
      const b = scanBand[i + 2]!;
      if (isColored(r, g, b)) {
        colColorCount[x] = (colColorCount[x] ?? 0) + 1;
        if (isRed(r, g, b)) totalRed++;
        else totalGreen++;
      }
    }
  }

  // Step 3: Find bar end with gap tolerance
  // A column is "in the bar" if at least half the band rows have colored pixels
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

  const barWidth = barEnd + 1;
  const barRatio = barWidth / W;

  logger.debug(
    `Bar metrics: row=${bestRow} end=${barEnd} width=${barWidth}px ` +
      `ratio=${barRatio.toFixed(4)} red=${totalRed} green=${totalGreen}`,
  );

  return {
    barEnd,
    barWidth,
    barRatio,
    imageWidth: W,
    headerRow: bestRow,
    redPixels: totalRed,
    greenPixels: totalGreen,
  };
}

// ---------------------------------------------------------------------------
// Detection methods
// ---------------------------------------------------------------------------

/**
 * PRIMARY: Classify symbol by the colored header bar width ratio.
 *
 * The hidden instrument name determines the bar width:
 *   BANKNIFTY (10+ chars) → wider bar
 *   NIFTY (5+ chars)      → narrower bar
 *
 * Calibrated thresholds:
 *   NIFTY:     center=0.43, range 0.36–0.48
 *   BANKNIFTY: center=0.54, range 0.48–0.64
 */
export async function detectByBarWidth(imagePath: string): Promise<DetectionScore<string>> {
  try {
    const m = await extractBarMetrics(imagePath);

    // Find the best-fitting symbol profile
    let bestSymbol: string | null = null;
    let bestDistance = Infinity;

    for (const [symbol, profile] of Object.entries(SYMBOL_PROFILES)) {
      const dist = Math.abs(m.barRatio - profile.center);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestSymbol = symbol;
      }
    }

    if (!bestSymbol) {
      return { value: null, confidence: 0, method: 'bar-width' };
    }

    // Confidence calculation
    const profile = SYMBOL_PROFILES[bestSymbol];
    if (!profile) {
      return { value: bestSymbol, confidence: 50, method: 'bar-width' };
    }
    const rangeHalf = (profile.maxRatio - profile.minRatio) / 2;
    const normalizedDist = rangeHalf > 0 ? bestDistance / rangeHalf : 0; // 0 at center, 1 at edge

    let confidence: number;
    if (normalizedDist <= 1) {
      // Within range: 93% at center → 68% at edge
      confidence = 93 - normalizedDist * 25;
    } else {
      // Outside range: 68% → 35% at 1.5x range
      confidence = 68 - (normalizedDist - 1) * 40;
    }

    confidence = clampConfidence(confidence);

    logger.debug(
      `Bar width detection: ratio=${m.barRatio.toFixed(4)} → ${bestSymbol} ` +
        `(${confidence.toFixed(0)}%, dist=${normalizedDist.toFixed(2)})`,
    );

    return {
      value: bestSymbol,
      confidence,
      method: 'bar-width',
    };
  } catch (err) {
    logger.error('Bar width detection failed', { error: String(err) });
    return { value: null, confidence: 0, method: 'bar-width' };
  }
}

/**
 * SECONDARY: OCR the post-bar area for text landmarks.
 *
 * Looks for "NSE FO" text which appears after the colored bar.
 * The X-position of "NSE FO" relative to the image width can
 * help distinguish symbols (further right = longer hidden name).
 *
 * Also tries to catch partial text like "BANK", "NIFTY", "BNF" in
 * the full header area.
 */
export async function detectByOcr(imagePath: string): Promise<DetectionScore<string>> {
  try {
    const m = await extractBarMetrics(imagePath);
    const W = m.imageWidth;

    // Extract the post-bar region for OCR
    const postBarWidth = Math.min(500, W - m.barEnd - 5);
    if (postBarWidth < 30) {
      return { value: null, confidence: 0, method: 'ocr' };
    }

    const postBarData = await sharp(imagePath)
      .extract({
        left: m.barEnd + 3,
        top: m.headerRow - 12,
        width: postBarWidth,
        height: 30,
      })
      .png()
      .toBuffer();

    const { recognizeBuffer } = await import('./ocr.js');
    const ocrResult = await recognizeBuffer(postBarData);
    const text = ocrResult.text.toUpperCase();

    logger.debug(`Post-bar OCR: "${text.slice(0, 80)}" (conf: ${ocrResult.confidence.toFixed(1)}%)`);

    // Check for symbol name fragments
    const bankNiftyHits = ['BANKNIFTY', 'BANK NIFTY', 'BNF', 'BANKN'];
    const niftyHits = ['NIFTY', 'NIFT'];

    const hasBN = bankNiftyHits.some((p) => text.includes(p));
    const hasN = niftyHits.some((p) => text.includes(p));

    if (hasBN && !hasN) return { value: 'BANKNIFTY', confidence: 78, method: 'ocr' };
    if (hasN && !hasBN) return { value: 'NIFTY', confidence: 75, method: 'ocr' };
    if (hasBN) return { value: 'BANKNIFTY', confidence: 50, method: 'ocr' };
    if (hasN) return { value: 'NIFTY', confidence: 50, method: 'ocr' };

    // Also check the full header area with color inversion for better OCR
    // (white text on colored bar is hard for Tesseract)
    const headerBand = await sharp(imagePath)
      .extract({ left: 0, top: m.headerRow - 12, width: W, height: 30 })
      .removeAlpha()
      .raw()
      .toBuffer();

    // Invert: colored pixels → white, everything else → keep
    const inverted = Buffer.alloc(headerBand.length);
    for (let i = 0; i < headerBand.length; i += 3) {
      const r = headerBand[i]!;
      const g = headerBand[i + 1]!;
      const b = headerBand[i + 2]!;
      if (isColored(r, g, b)) {
        inverted[i] = 255;
        inverted[i + 1] = 255;
        inverted[i + 2] = 255;
      } else {
        const brightness = (r + g + b) / 3;
        // Keep dark text as-is, lighten very bright areas slightly
        if (brightness > 230) {
          inverted[i] = 240;
          inverted[i + 1] = 240;
          inverted[i + 2] = 240;
        } else {
          inverted[i] = r;
          inverted[i + 1] = g;
          inverted[i + 2] = b;
        }
      }
    }

    const invertedPng = await sharp(inverted, {
      raw: { width: W, height: 30, channels: 3 },
    })
      .png()
      .toBuffer();

    const invOcr = await recognizeBuffer(invertedPng);
    const invText = invOcr.text.toUpperCase();

    logger.debug(`Inverted header OCR: "${invText.slice(0, 80)}" (conf: ${invOcr.confidence.toFixed(1)}%)`);

    const invHasBN = bankNiftyHits.some((p) => invText.includes(p));
    const invHasN = niftyHits.some((p) => invText.includes(p));

    if (invHasBN && !invHasN) return { value: 'BANKNIFTY', confidence: 65, method: 'ocr' };
    if (invHasN && !invHasBN) return { value: 'NIFTY', confidence: 62, method: 'ocr' };

    return { value: null, confidence: 0, method: 'ocr' };
  } catch (err) {
    logger.error('OCR symbol detection failed', { error: String(err) });
    return { value: null, confidence: 0, method: 'ocr' };
  }
}