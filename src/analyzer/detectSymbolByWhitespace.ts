/**
 * Whitespace-based symbol detection — a separate classifier for comparison
 * with the bar-width approach in detectSymbol.ts.
 *
 * Hypothesis:
 *   NIFTY has a shorter hidden instrument name → visible text ends earlier
 *     → more remaining whitespace to the right edge
 *   BANKNIFTY has a longer hidden name → visible text shifts right
 *     → less remaining whitespace
 *
 * Detection pipeline (simple):
 *   1. Crop header (top ~100px)
 *   2. Run OCR → extract word-level bounding boxes
 *   3. Find the rightmost word (highest x1) among ALL words in the header
 *   4. remainingWhitespace = imageWidth - rightMostWord.x1
 *   5. Classify by comparing against calibrated NIFTY/BANKNIFTY distributions
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import { clampConfidence } from './confidence.js';
import { recognizeRaw } from './ocr.js';
import type { UnifiedHeaderOcrResult } from './unifiedHeaderOcr.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single OCR-detected word with its bounding box geometry */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

/** Result of measuring whitespace for one screenshot */
export interface WhitespaceMeasurement {
  imagePath: string;
  imageWidth: number;
  headerHeight: number;
  allWords: OcrWord[];
  rightMostWord: OcrWord | null;
  rightMostX: number;
  remainingWhitespace: number;
  remainingWhitespaceRatio: number;
}

/** Calibrated distribution for one symbol class */
export interface ClassDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  stddev: number;
}

/** Calibration data for both classes */
export interface WhitespaceCalibration {
  nifty: ClassDistribution;
  banknifty: ClassDistribution;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many pixels from the top to crop as the header region */
const HEADER_CROP_HEIGHT = 100;

/** Path where calibration JSON is saved/loaded from */
const CALIBRATION_PATH = path.resolve(process.cwd(), 'config', 'whitespace-calibration.json');

// ---------------------------------------------------------------------------
// Calibration state
// ---------------------------------------------------------------------------

let calibration: WhitespaceCalibration | null = null;
let calibrationLoaded = false;

/** Load calibration data from a JSON file */
export function loadCalibration(jsonPath?: string): void {
  const p = jsonPath ?? CALIBRATION_PATH;
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      calibration = JSON.parse(raw) as WhitespaceCalibration;
      calibrationLoaded = true;
      logger.info(`Loaded whitespace calibration from ${p}`);
    } catch (err) {
      logger.warn(`Failed to load whitespace calibration from ${p}: ${err}`);
    }
  }
}

/** Set calibration data programmatically */
export function setCalibration(cal: WhitespaceCalibration): void {
  calibration = cal;
  calibrationLoaded = true;
}

/** Get current calibration (for inspection) */
export function getCalibration(): WhitespaceCalibration | null {
  return calibration;
}

/** Ensure calibration is loaded from disk (called lazily) */
function ensureCalibration(): void {
  if (!calibrationLoaded) {
    loadCalibration();
    calibrationLoaded = true;
  }
}

// ---------------------------------------------------------------------------
// Header cropping + upscaling
// ---------------------------------------------------------------------------

/** Upscale factor for OCR — Tesseract needs larger text to detect small fonts */
const OCR_UPSCALE = 4;

/** Input type — accepts a file path string or an in-memory Buffer. */
export type WhitespaceInput = string | Buffer;

/**
 * Crop the header area and return BOTH the original-size crop (for geometry
 * calculations) and an upscaled version (for OCR to detect small text).
 *
 * Accepts EITHER a file path OR a Buffer. The Buffer form avoids a disk
 * read in the live listener.
 */
async function cropHeader(
  input: WhitespaceInput,
): Promise<{
  width: number;
  height: number;
  upscaledBuffer: Buffer;
}> {
  const meta = await sharp(input).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const cropH = Math.min(HEADER_CROP_HEIGHT, H);

  // Upscale the crop for better OCR detection of small text
  const upscaledBuffer = await sharp(input)
    .extract({ left: 0, top: 0, width: W, height: cropH })
    .resize(W * OCR_UPSCALE, cropH * OCR_UPSCALE, { kernel: 'lanczos2' })
    .png()
    .toBuffer();

  return { width: W, height: cropH, upscaledBuffer };
}

// ---------------------------------------------------------------------------
// OCR with word-level bounding boxes
// ---------------------------------------------------------------------------

/**
 * Run OCR on the upscaled header and extract word bounding boxes.
 *
 * IMPORTANT: We use the bounding boxes for GEOMETRY ONLY.
 * The recognized text is never used for classification.
 *
 * Bounding boxes are scaled back to original image coordinates
 * (divided by OCR_UPSCALE) so they can be used directly for
 * whitespace measurement.
 */
async function ocrHeaderWithBoxes(upscaledBuffer: Buffer): Promise<OcrWord[]> {
  const result = await recognizeRaw(upscaledBuffer);

  // Tesseract v5: result.data.words[i].bbox = { x0, y0, x1, y1 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = result.data as any;
  const rawWords: Array<Record<string, unknown>> | undefined = data?.words;

  if (!rawWords || !Array.isArray(rawWords)) return [];

  const words: OcrWord[] = [];
  for (const w of rawWords) {
    const bbox = w['bbox'] as Record<string, number> | undefined;
    if (bbox && typeof bbox['x0'] === 'number') {
      // Scale coordinates back to original image pixels
      words.push({
        text: String(w['text'] ?? ''),
        x0: Number(bbox['x0']) / OCR_UPSCALE,
        y0: Number(bbox['y0']) / OCR_UPSCALE,
        x1: Number(bbox['x1']) / OCR_UPSCALE,
        y1: Number(bbox['y1']) / OCR_UPSCALE,
        confidence: Number(w['confidence'] ?? 0),
      });
    }
  }

  return words;
}

// ---------------------------------------------------------------------------
// Core measurement (exported for calibration script)
// ---------------------------------------------------------------------------

/**
 * Measure the remaining whitespace in the header.
 *
 * Logic:
 *   1. Crop header (top HEADER_CROP_HEIGHT px)
 *   2. OCR all words in the header
 *   3. Find the word with the highest x1 (rightmost bounding box edge)
 *   4. remainingWhitespace = imageWidth - rightMostWord.x1
 *   5. remainingWhitespaceRatio = remainingWhitespace / imageWidth
 *
 * That's it. No row grouping, no status bar filtering, no cluster analysis.
 * Just the single rightmost text in the entire header.
 */
export async function measureWhitespace(
  input: WhitespaceInput,
): Promise<WhitespaceMeasurement> {
  const meta = await sharp(input).metadata();
  const imageWidth = meta.width!;

  const { height: headerHeight, upscaledBuffer } = await cropHeader(input);
  const allWords = await ocrHeaderWithBoxes(upscaledBuffer);

  // Find the rightmost word: the one with the highest x1 value
  let rightMostWord: OcrWord | null = null;
  let rightMostX = 0;

  for (const word of allWords) {
    if (word.x1 > rightMostX) {
      rightMostX = word.x1;
      rightMostWord = word;
    }
  }

  const remainingWhitespace = imageWidth - rightMostX;
  const remainingWhitespaceRatio = imageWidth > 0 ? remainingWhitespace / imageWidth : 0;

  logger.debug(
    `Whitespace: width=${imageWidth} rightX=${rightMostX} ` +
      `ws=${remainingWhitespace}px ratio=${remainingWhitespaceRatio.toFixed(4)} ` +
      `words=${allWords.length}` +
      (rightMostWord ? ` rightWord="${rightMostWord.text}"` : ''),
  );

  return {
    imagePath: typeof input === 'string' ? input : '<Buffer>',
    imageWidth,
    headerHeight,
    allWords,
    rightMostWord,
    rightMostX,
    remainingWhitespace,
    remainingWhitespaceRatio,
  };
}

// ---------------------------------------------------------------------------
// Classification (exported for imageAnalyzer integration)
// ---------------------------------------------------------------------------

/**
 * Classify symbol based on remaining whitespace ratio using pre-computed OCR.
 *
 * This is the optimized version that accepts unified OCR results to avoid
 * running OCR multiple times.
 */
export function detectByWhitespaceFromOcr(
  ocrResult: UnifiedHeaderOcrResult,
): DetectionScore<string> {
  try {
    const { imageWidth, words } = ocrResult;

    if (words.length === 0) {
      logger.debug('Whitespace detection: no OCR words found in header');
      return { value: null, confidence: 0, method: 'whitespace' };
    }

    // Find the rightmost word: the one with the highest x1 value
    let rightMostWord: OcrWord | null = null;
    let rightMostX = 0;

    for (const word of words) {
      if (word.x1 > rightMostX) {
        rightMostX = word.x1;
        rightMostWord = word;
      }
    }

    const remainingWhitespace = imageWidth - rightMostX;
    const remainingWhitespaceRatio = imageWidth > 0 ? remainingWhitespace / imageWidth : 0;

    logger.debug(
      `Whitespace from OCR: width=${imageWidth} rightX=${rightMostX} ` +
        `ws=${remainingWhitespace}px ratio=${remainingWhitespaceRatio.toFixed(4)} ` +
        `words=${words.length}` +
        (rightMostWord ? ` rightWord="${rightMostWord.text}"` : ''),
    );

    ensureCalibration();

    if (calibration) {
      // --- Calibrated classification using z-scores ---
      const nStd = calibration.nifty.stddev || 0.01;
      const bStd = calibration.banknifty.stddev || 0.01;

      const zNifty = Math.abs(remainingWhitespaceRatio - calibration.nifty.mean) / nStd;
      const zBank = Math.abs(remainingWhitespaceRatio - calibration.banknifty.mean) / bStd;

      const predicted = zNifty <= zBank ? 'NIFTY' : 'BANKNIFTY';
      const zDiff = Math.abs(zBank - zNifty);

      // Confidence from z-score separation
      const confidence = clampConfidence(55 + 38 * (1 - Math.exp(-zDiff * 0.8)));

      logger.debug(
        `Whitespace calibrated: ratio=${remainingWhitespaceRatio.toFixed(4)} ` +
          `zN=${zNifty.toFixed(2)} zB=${zBank.toFixed(2)} diff=${zDiff.toFixed(2)} ` +
          `→ ${predicted} (${confidence}%)`,
      );

      return { value: predicted, confidence, method: 'whitespace' };
    }

    // --- Uncalibrated: use hardcoded threshold ---
    // NIFTY leaves more whitespace (>~25%), BANKNIFTY leaves less
    const THRESHOLD = 0.25;
    const predicted = remainingWhitespaceRatio > THRESHOLD ? 'NIFTY' : 'BANKNIFTY';
    const margin = Math.abs(remainingWhitespaceRatio - THRESHOLD) / THRESHOLD;
    const confidence = clampConfidence(65 + margin * 25);

    logger.debug(
      `Whitespace (no calibration): ratio=${remainingWhitespaceRatio.toFixed(4)} ` +
        `→ ${predicted} (${confidence}%)`,
    );

    return { value: predicted, confidence, method: 'whitespace' };
  } catch (err) {
    logger.error('Whitespace detection failed', { error: String(err) });
    return { value: null, confidence: 0, method: 'whitespace' };
  }
}

/**
 * Classify symbol based on remaining whitespace ratio.
 *
 * Uses calibrated Gaussian distributions when available, otherwise
 * falls back to a hardcoded threshold.
 *
 * This is the original version that runs its own OCR. Kept for backward compatibility.
 */
export async function detectByWhitespace(
  input: WhitespaceInput,
): Promise<DetectionScore<string>> {
  try {
    const m = await measureWhitespace(input);

    if (m.allWords.length === 0 || m.rightMostX === 0) {
      logger.debug('Whitespace detection: no OCR words found in header');
      return { value: null, confidence: 0, method: 'whitespace' };
    }

    ensureCalibration();

    if (calibration) {
      // --- Calibrated classification using z-scores ---
      const nStd = calibration.nifty.stddev || 0.01;
      const bStd = calibration.banknifty.stddev || 0.01;

      const zNifty = Math.abs(m.remainingWhitespaceRatio - calibration.nifty.mean) / nStd;
      const zBank = Math.abs(m.remainingWhitespaceRatio - calibration.banknifty.mean) / bStd;

      const predicted = zNifty <= zBank ? 'NIFTY' : 'BANKNIFTY';
      const zDiff = Math.abs(zBank - zNifty);

      // Confidence from z-score separation
      const confidence = clampConfidence(55 + 38 * (1 - Math.exp(-zDiff * 0.8)));

      logger.debug(
        `Whitespace calibrated: ratio=${m.remainingWhitespaceRatio.toFixed(4)} ` +
          `zN=${zNifty.toFixed(2)} zB=${zBank.toFixed(2)} diff=${zDiff.toFixed(2)} ` +
          `→ ${predicted} (${confidence}%)`,
      );

      return { value: predicted, confidence, method: 'whitespace' };
    }

    // --- Uncalibrated: use hardcoded threshold ---
    // NIFTY leaves more whitespace (>~25%), BANKNIFTY leaves less
    const THRESHOLD = 0.25;
    const predicted = m.remainingWhitespaceRatio > THRESHOLD ? 'NIFTY' : 'BANKNIFTY';
    const margin = Math.abs(m.remainingWhitespaceRatio - THRESHOLD) / THRESHOLD;
    const confidence = clampConfidence(65 + margin * 25);

    logger.debug(
      `Whitespace (no calibration): ratio=${m.remainingWhitespaceRatio.toFixed(4)} ` +
        `→ ${predicted} (${confidence}%)`,
    );

    return { value: predicted, confidence, method: 'whitespace' };
  } catch (err) {
    logger.error('Whitespace detection failed', { error: String(err) });
    return { value: null, confidence: 0, method: 'whitespace' };
  }
}