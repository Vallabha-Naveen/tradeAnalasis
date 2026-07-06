/**
 * OCR module using tesseract.js.
 *
 * Provides a thin wrapper around Tesseract for recognizing text
 * in image regions. Used by other analyzer modules.
 */

import Tesseract from 'tesseract.js';
import { logger } from '../utils/logger.js';

/** Result of an OCR operation */
export interface OcrResult {
  /** Raw text extracted */
  text: string;
  /** Overall confidence (0–100) */
  confidence: number;
}

/**
 * Run OCR on a single image file.
 *
 * @param imagePath - Path to the image file
 * @param language  - Tesseract language code (default: 'eng')
 * @returns OCR result with text and confidence
 */
export async function recognizeText(
  imagePath: string,
  language = 'eng',
): Promise<OcrResult> {
  try {
    logger.debug(`Running OCR on: ${imagePath}`);
    const result = await Tesseract.recognize(imagePath, language, {
      logger: () => {}, // Suppress Tesseract's internal progress logging
    });

    const text = result.data.text.trim();
    const confidence = result.data.confidence;

    logger.debug(`OCR result: confidence=${confidence.toFixed(1)}%, text="${text.slice(0, 100)}"`);

    return { text, confidence };
  } catch (err) {
    logger.error(`OCR failed for ${imagePath}`, { error: String(err) });
    return { text: '', confidence: 0 };
  }
}

/**
 * Run OCR on a Buffer (e.g., a cropped image region).
 *
 * @param buffer   - Image data as a Buffer
 * @param language - Tesseract language code
 */
export async function recognizeBuffer(
  buffer: Buffer,
  language = 'eng',
): Promise<OcrResult> {
  try {
    const result = await Tesseract.recognize(buffer, language, {
      logger: () => {},
    });

    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
    };
  } catch (err) {
    logger.error('OCR failed on buffer', { error: String(err) });
    return { text: '', confidence: 0 };
  }
}