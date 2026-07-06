/**
 * Option type detection — determines CE (Call) or PE (Put).
 *
 * IMPORTANT: The colored header bar is ALWAYS red in this trading app.
 * It is a masking/strikethrough overlay that hides the strike info.
 * The bar color does NOT indicate CE or PE.
 *
 * Layout (confirmed via pixel + VLM analysis):
 *   [back arrow] [RED BAR hiding: SYMBOL STRIKE CE/PE] [CE/PE] [NSE FO] [price change]
 *
 * The CE/PE text is dark (RGB ~30-90) on a white/light background,
 * positioned immediately AFTER the right edge of the red bar.
 * The text Y-position varies across screenshots.
 *
 * Detection strategy:
 *   1. Find barTop and barEnd via colored pixel scanning
 *   2. Extract full-width header band from barTop
 *   3. Preprocess: invert red→white, sharpen, threshold (Otsu), upscale
 *   4. OCR with Tesseract and parse for CE/PE
 *   5. Multiple strategies vote for robustness
 *
 * Strategy 4 (full-width narrow band) handles cases where CE/PE text
 * is not immediately adjacent to the bar, or the post-bar-only region
 * is too narrow for reliable OCR. Full-width context helps Tesseract
 * anchor the text position.
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import { clampConfidence } from './confidence.js';
import type { OptionType } from '../models/Trade.js';
import { recognizeBuffer } from './ocr.js';
import { extractBarMetrics } from './detectSymbol.js';

// ---------------------------------------------------------------------------
// Pixel classification
// ---------------------------------------------------------------------------

function isRed(r: number, g: number, b: number): boolean {
  return r > g + 20 && r > b + 20 && r > 60;
}

function isColored(r: number, g: number, b: number): boolean {
  return isRed(r, g, b) || (g > r + 20 && g > b + 20 && g > 60);
}

// ---------------------------------------------------------------------------
// Header region discovery
// ---------------------------------------------------------------------------

interface HeaderRegion {
  barTop: number;
  barEnd: number;
  headerRow: number;
  imageWidth: number;
  imageHeight: number;
  barRatio: number;
}

async function findHeaderRegion(imagePath: string): Promise<HeaderRegion> {
  const metrics = await extractBarMetrics(imagePath);

  const meta = await sharp(imagePath).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const scanH = Math.min(200, H);

  // Find barTop: first row with ≥30 colored pixels
  const scanBand = await sharp(imagePath)
    .extract({ left: 0, top: 0, width: W, height: scanH })
    .removeAlpha()
    .raw()
    .toBuffer();

  let barTop = metrics.headerRow;
  for (let y = 0; y < scanH; y++) {
    let coloredCount = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (isColored(scanBand[i]!, scanBand[i + 1]!, scanBand[i + 2]!)) {
        coloredCount++;
      }
    }
    if (coloredCount >= 30) {
      barTop = y;
      break;
    }
  }

  return {
    barTop,
    barEnd: metrics.barEnd,
    headerRow: metrics.headerRow,
    imageWidth: W,
    imageHeight: H,
    barRatio: metrics.barRatio,
  };
}

// ---------------------------------------------------------------------------
// Image preprocessing using sharp pipeline
// ---------------------------------------------------------------------------

/**
 * Preprocess a raw RGB buffer for OCR:
 *   1. Color-invert (red bar → white, keep dark text)
 *   2. Convert to grayscale
 *   3. Normalize (contrast stretch)
 *   4. Threshold (Otsu's method via sharp)
 *   5. Upscale for better small-text recognition
 */
async function preprocessForOcr(
  raw: Buffer,
  width: number,
  height: number,
  scale = 6,
): Promise<Buffer> {
  // Step 1: Color-invert red/green → white
  const inverted = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i]!;
    const g = raw[i + 1]!;
    const b = raw[i + 2]!;
    if (isColored(r, g, b)) {
      inverted[i] = 255;
      inverted[i + 1] = 255;
      inverted[i + 2] = 255;
    } else {
      const brightness = (r + g + b) / 3;
      if (brightness > 235) {
        inverted[i] = 245;
        inverted[i + 1] = 245;
        inverted[i + 2] = 245;
      } else {
        inverted[i] = r;
        inverted[i + 1] = g;
        inverted[i + 2] = b;
      }
    }
  }

  // Steps 2-5: sharp pipeline
  // NOTE: Only invert colored pixels; do NOT grayscale/normalize/threshold.
  // Testing showed that raw upscale with just color inversion works
  // much better than full preprocessing for small text.
  return sharp(inverted, { raw: { width, height, channels: 3 } })
    .resize(width * scale, height * scale, { kernel: 'lanczos2' })
    .png()
    .toBuffer();
}

/**
 * Raw upscale only — no preprocessing.
 * Testing showed this works better than grayscale+normalize+threshold
 * for the small dark text in these trading screenshots.
 */
async function rawUpscale(
  raw: Buffer,
  width: number,
  height: number,
  scale = 8,
): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .resize(width * scale, height * scale, { kernel: 'lanczos2' })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// OCR result parsing
// ---------------------------------------------------------------------------

function parseOptionType(text: string, strict: boolean): OptionType | null {
  const clean = text.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  const hasCE = clean.includes('CE');
  const hasPE = clean.includes('PE');

  if (strict) {
    if (hasCE && !hasPE) {
      const nearNse = /CE\s*(?:NSE|NSF|N5E)/.test(clean) || /(?:NSE|NSF|N5E)\s*CE/.test(clean);
      const afterDigits = /\d\s*CE\b/.test(clean) || /\dCE\b/.test(clean);
      if (nearNse || afterDigits) return 'CE';
    }
    if (hasPE && !hasCE) {
      const nearNse = /PE\s*(?:NSE|NSF|N5E)/.test(clean) || /(?:NSE|NSF|N5E)\s*PE/.test(clean);
      const afterDigits = /\d\s*PE\b/.test(clean) || /\dPE\b/.test(clean);
      if (nearNse || afterDigits) return 'PE';
    }
    return null;
  }

  // Relaxed mode — accept CE/PE with basic false-positive guards
  if (hasCE && !hasPE) {
    const fp = /(?:PRICE|SINCE|ONCE|NICE|SPACE|OCEAN|CEMENT|RECEIPT|RECENT|ACCEPT|CONCE)/.test(clean);
    if (!fp) return 'CE';
  }
  if (hasPE && !hasCE) {
    const fp = /(?:PEOPLE|PEACE|PEAK|SPEAK|TYPE|SCOPE|REPEAT|HOPE|DEEP|REAP|STEP)/.test(clean);
    if (!fp) return 'PE';
  }

  // Fuzzy misreads
  if (!hasCE && !hasPE) {
    if (clean.includes('CF') && /(?:NSE|\d)\s*CF/.test(clean)) return 'PE';
    if (clean.includes('GE') && /(?:NSE|\d)\s*GE/.test(clean)) return 'CE';
  }

  return null;
}

// ---------------------------------------------------------------------------
// OCR strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Full-width inverted header band with sharp pipeline.
 * Best overall strategy — handles text adjacent to or within the bar.
 */
async function ocrInvertedFullBand(
  imagePath: string,
  region: HeaderRegion,
): Promise<OptionType | null> {
  const top = Math.max(0, region.barTop);
  const height = Math.min(80, region.imageHeight - top);

  const raw = await sharp(imagePath)
    .extract({ left: 0, top, width: region.imageWidth, height })
    .removeAlpha()
    .raw()
    .toBuffer();

  const [invPng, rawPng] = await Promise.all([
    preprocessForOcr(raw, region.imageWidth, height),
    rawUpscale(raw, region.imageWidth, height, 8),
  ]);

  const [invResult, rawResult] = await Promise.all([
    recognizeBuffer(invPng),
    recognizeBuffer(rawPng),
  ]);

  logger.debug(
    `Inverted full-band (rows ${top}-${top + height}): inv="${invResult.text.toUpperCase().slice(0, 60)}" raw="${rawResult.text.toUpperCase().slice(0, 60)}"`,
  );

  // Prefer raw result
  return parseOptionType(rawResult.text, true) ?? parseOptionType(invResult.text, true);
}

/**
 * Strategy 2: Post-bar focused region.
 * Extracts only the area after the red bar where CE/PE text lives.
 * Uses simple preprocess (no inversion needed — no red bar here).
 * Tries multiple Y-offsets within the header.
 */
async function ocrPostBarMultiY(
  imagePath: string,
  region: HeaderRegion,
): Promise<OptionType | null> {
  // Start right after the bar (no overlap) to avoid red bar contamination
  const left = Math.min(region.barEnd + 5, region.imageWidth - 50);
  // Narrower width (300px) — wide regions dilute OCR accuracy
  const width = Math.min(300, region.imageWidth - left);
  if (width < 50) return null;

  let ceVotes = 0;
  let peVotes = 0;

  // Try several band heights and Y-offsets
  // Use smaller bands (20-35px) to focus on the text area
  const attempts: { top: number; height: number }[] = [];
  for (const bandH of [20, 25, 30, 35]) {
    for (const dy of [0, 10, 20, 30, 45, 60]) {
      const t = Math.max(0, region.barTop + dy);
      const h = Math.min(bandH, region.imageHeight - t);
      if (h >= 12) attempts.push({ top: t, height: h });
    }
  }

  for (const { top, height } of attempts) {
    const raw = await sharp(imagePath)
      .extract({ left, top, width, height })
      .removeAlpha()
      .raw()
      .toBuffer();

    // Raw upscale only — testing showed this works best
    const rawPng = await rawUpscale(raw, width, height, 10);
    const result = await recognizeBuffer(rawPng);

    const parsed = parseOptionType(result.text, false); // relaxed
    if (parsed === 'CE') ceVotes++;
    else if (parsed === 'PE') peVotes++;
  }

  logger.debug(`Post-bar multi-Y: CE=${ceVotes} PE=${peVotes}`);
  // Low threshold: 1 hit from 24 attempts is a meaningful signal
  // since we're in a very targeted region (post-bar header)
  if (ceVotes >= 1 && ceVotes > peVotes) return 'CE';
  if (peVotes >= 1 && peVotes > ceVotes) return 'PE';
  return null;
}

/**
 * Strategy 3: Very tall inverted band (120px) for text deep in header.
 * Some screenshots have the CE/PE text 40-60px below barTop.
 */
async function ocrTallInvertedBand(
  imagePath: string,
  region: HeaderRegion,
): Promise<OptionType | null> {
  const top = Math.max(0, region.barTop);
  const height = Math.min(120, region.imageHeight - top);

  const raw = await sharp(imagePath)
    .extract({ left: 0, top, width: region.imageWidth, height })
    .removeAlpha()
    .raw()
    .toBuffer();

  // For tall band, also try raw upscale
  const [processedPng, rawPng] = await Promise.all([
    preprocessForOcr(raw, region.imageWidth, height, 4),
    rawUpscale(raw, region.imageWidth, height, 6),
  ]);

  const [procResult, rawResult] = await Promise.all([
    recognizeBuffer(processedPng),
    recognizeBuffer(rawPng),
  ]);
  logger.debug(
    `Tall inverted band (rows ${top}-${top + height}): proc="${procResult.text.toUpperCase().slice(0, 60)}" raw="${rawResult.text.toUpperCase().slice(0, 60)}"`,
  );
  // Prefer raw result (testing showed it's more accurate for small text)
  return parseOptionType(rawResult.text, true) ?? parseOptionType(procResult.text, true);
}

/**
 * Strategy 4: Full-width narrow band scanning.
 *
 * Scans the full image width in narrow (12-18px) horizontal bands
 * every 5px from barTop to barTop+80. Uses raw upscale only.
 *
 * This handles edge cases where:
 *   - CE/PE text is not immediately adjacent to the bar
 *   - The post-bar-only region is too narrow for reliable OCR
 *   - Full-width context helps Tesseract anchor text position
 *
 * Uses relaxed parsing since the wider region may include noise.
 * Requires ≥2 consistent votes to avoid false positives.
 */
async function ocrFullWidthNarrowBands(
  imagePath: string,
  region: HeaderRegion,
): Promise<OptionType | null> {
  const W = region.imageWidth;
  let ceVotes = 0;
  let peVotes = 0;

  // Scan narrow bands every 5px
  for (let dy = 0; dy <= 80; dy += 5) {
    const top = Math.max(0, region.barTop + dy);
    const height = Math.min(15, region.imageHeight - top);
    if (height < 10) continue;

    const raw = await sharp(imagePath)
      .extract({ left: 0, top, width: W, height })
      .removeAlpha()
      .raw()
      .toBuffer();

    const rawPng = await rawUpscale(raw, W, height, 6);
    const result = await recognizeBuffer(rawPng);

    const parsed = parseOptionType(result.text, false); // relaxed
    if (parsed === 'CE') ceVotes++;
    else if (parsed === 'PE') peVotes++;
  }

  logger.debug(`Full-width narrow bands: CE=${ceVotes} PE=${peVotes}`);
  // Require ≥2 consistent votes from 17 attempts to avoid false positives
  if (ceVotes >= 2 && ceVotes > peVotes) return 'CE';
  if (peVotes >= 2 && peVotes > ceVotes) return 'PE';
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect CE/PE via multi-strategy OCR on the dynamically-located header.
 *
 * Strategies:
 *   1. Full-width inverted band (80px, sharp pipeline)
 *   2. Post-bar focused with multiple Y-offsets and dual preprocess
 *   3. Tall inverted band (120px) for deep text
 *   4. (Fallback) Full-width narrow bands — only if strategies 1-3 tie or fail
 *
 * Strategies 1-3 vote in parallel. Strategy 4 is only invoked as a
 * tiebreaker to avoid false positives from wider-scan noise.
 */
export async function detectOptionTypeByOcr(
  imagePath: string,
): Promise<DetectionScore<OptionType>> {
  try {
    const region = await findHeaderRegion(imagePath);
    logger.debug(
      `CE/PE detection: barTop=${region.barTop} headerRow=${region.headerRow} ` +
        `barEnd=${region.barEnd} barRatio=${region.barRatio.toFixed(4)}`,
    );

    // Phase 1: Run primary strategies in parallel
    const [bandResult, postBarResult, tallResult] = await Promise.all([
      ocrInvertedFullBand(imagePath, region),
      ocrPostBarMultiY(imagePath, region),
      ocrTallInvertedBand(imagePath, region),
    ]);

    // Count votes from primary strategies
    let ceVotes = 0;
    let peVotes = 0;
    for (const r of [bandResult, postBarResult, tallResult]) {
      if (r === 'CE') ceVotes++;
      else if (r === 'PE') peVotes++;
    }

    logger.debug(`CE/PE primary votes: CE=${ceVotes} PE=${peVotes}`);

    // Phase 2: If primary strategies have clear consensus, use it
    if (ceVotes > peVotes) {
      const confidence = 65 + ceVotes * 6 + (peVotes === 0 ? 5 : 0);
      return { value: 'CE', confidence: clampConfidence(confidence), method: 'ocr' };
    }
    if (peVotes > ceVotes) {
      const confidence = 65 + peVotes * 6 + (ceVotes === 0 ? 5 : 0);
      return { value: 'PE', confidence: clampConfidence(confidence), method: 'ocr' };
    }

    // Phase 3: Tiebreaker — run the slower full-width narrow band scan
    logger.debug('CE/PE: primary strategies tied or empty, running narrow-band tiebreaker');
    const tiebreaker = await ocrFullWidthNarrowBands(imagePath, region);

    if (tiebreaker) {
      logger.debug(`CE/PE tiebreaker resolved: ${tiebreaker}`);
      return { value: tiebreaker, confidence: 62, method: 'ocr-tiebreaker' };
    }

    // Still no detection
    logger.debug('CE/PE: no detection from any OCR strategy');
    return { value: null, confidence: 0, method: 'ocr' };
  } catch (err) {
    logger.error('OCR option type detection failed', { error: String(err) });
    return { value: null, confidence: 0, method: 'ocr' };
  }
}