/**
 * Unified header OCR — runs OCR once on the header and returns word data.
 *
 * This module provides a single OCR pass that can be reused for:
 *   - Symbol detection (via whitespace analysis of rightmost word)
 *   - Option type detection (via parsing CE/PE from header text)
 *
 * This optimization reduces OCR calls from ~46 per image to 1-2 calls.
 *
 * Accepts EITHER a file path OR a Buffer. The Buffer form avoids a disk
 * read in the live listener (where the image is already in memory from
 * the Telegram download).
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import { recognizeRaw } from './ocr.js';
import type { OcrWord } from './detectSymbolByWhitespace.js';

/** Input type — accepts a file path string or an in-memory Buffer. */
export type HeaderOcrInput = string | Buffer;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many pixels from the top to crop as the header region */
const HEADER_CROP_HEIGHT = 100;

/** Upscale factor for OCR — Tesseract needs larger text to detect small fonts */
const OCR_UPSCALE = 4;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UnifiedHeaderOcrResult {
  /** Original image width */
  imageWidth: number;
  /** Header crop height */
  headerHeight: number;
  /** All OCR-detected words with bounding boxes (scaled to original coordinates) */
  words: OcrWord[];
  /** Combined text from all words (for CE/PE parsing) */
  fullText: string;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Run a single OCR pass on the header region.
 *
 * This crops the header (top 100px), upscales it 4x for better text detection,
 * runs OCR once, and returns both the word-level bounding boxes and the full text.
 *
 * @param input - File path OR in-memory Buffer. Buffer form avoids a disk
 *                read in the live listener.
 */
export async function ocrHeaderOnce(
  input: HeaderOcrInput,
): Promise<UnifiedHeaderOcrResult> {
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

  // Run OCR once using the shared reusable worker
  const result = await recognizeRaw(upscaledBuffer);

  // Extract word-level bounding boxes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = result.data as any;
  const rawWords: Array<Record<string, unknown>> | undefined = data?.words;

  const words: OcrWord[] = [];
  if (rawWords && Array.isArray(rawWords)) {
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
  }

  // Combine all words into full text for CE/PE parsing
  const fullText = words.map(w => w.text).join(' ');

  logger.debug(
    `Unified header OCR: width=${W} height=${cropH} words=${words.length} ` +
      `text="${fullText.slice(0, 80)}${fullText.length > 80 ? '...' : ''}"`,
  );

  return {
    imageWidth: W,
    headerHeight: cropH,
    words,
    fullText,
  };
}
