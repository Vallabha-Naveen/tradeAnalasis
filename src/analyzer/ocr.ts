/**
 * OCR module using tesseract.js.
 *
 * Provides a thin wrapper around Tesseract for recognizing text
 * in image regions. Used by other analyzer modules.
 *
 * SHARED WORKER (performance optimization)
 * -----------------------------------------
 * Tesseract's `recognize()` convenience API creates a new worker,
 * downloads/loads the English language data (~2-5s), runs recognition,
 * and terminates the worker — ON EVERY CALL. This is extremely wasteful.
 *
 * This module creates a SINGLE reusable worker via `createWorker('eng')`
 * at startup (or lazily on first use). The worker loads the language data
 * once and is reused for all subsequent OCR calls. This:
 *   - Eliminates the 2-5s language data load on every call
 *   - Eliminates the ~200-500ms worker creation/termination overhead per call
 *   - Reduces memory (one worker vs. many)
 *
 * CONCURRENT CALLS
 * ----------------
 * The worker processes one recognition at a time (messages queue
 * internally via postMessage). Concurrent `recognize()` calls on the
 * same worker serialize automatically — no mutex needed. In the live
 * listener's common path (VLM succeeds), only ONE OCR call is made per
 * screenshot, so there's no contention. In the rare multi-strategy
 * fallback path (detectOptionTypeByOcr), calls serialize but that's
 * acceptable — the path is already slow (10-30s) and rarely invoked.
 *
 * FALLBACK
 * --------
 * If worker creation fails (e.g., language data download fails, or the
 * createWorker API changes in a future tesseract.js version), every
 * recognize function falls back to the old `Tesseract.recognize()` per-call
 * behavior. This ensures the refactoring never breaks existing behavior.
 *
 * LIFECYCLE
 * ---------
 * - `preInitOcr()` — call at startup to warm the worker before the first
 *   screenshot arrives.
 * - `shutdownOcr()` — call on process exit to terminate the worker thread.
 *   If not called, the worker thread keeps the Node.js process alive.
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

// ---------------------------------------------------------------------------
// Shared worker singleton
// ---------------------------------------------------------------------------

let worker: Tesseract.Worker | null = null;
let workerInitPromise: Promise<Tesseract.Worker> | null = null;
let workerFailed = false;

/**
 * Get the shared Tesseract worker, creating it if necessary.
 *
 * Returns `null` if the worker failed to initialize (after which all
 * callers fall back to `Tesseract.recognize()` per-call). The failure
 * is cached so we don't retry on every call — call `preInitOcr()` to
 * reset and retry.
 */
async function getWorker(): Promise<Tesseract.Worker | null> {
  if (worker) return worker;
  if (workerFailed) return null;
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    logger.info('Initializing Tesseract OCR worker (loading English language data)...');
    // createWorker(langs, oem, options) — v5+ API.
    //   langs: 'eng' loads English language data immediately.
    //   oem: 1 = LSTM_ONLY (fastest, most accurate for modern text).
    //   options.logger: suppress progress spam.
    const w = await Tesseract.createWorker('eng', 1, {
      logger: () => {},
    });
    worker = w;
    logger.info('Tesseract OCR worker initialized');
    return w;
  })();

  try {
    return await workerInitPromise;
  } catch (err) {
    // Cache the failure so we don't retry on every call.
    workerFailed = true;
    workerInitPromise = null;
    logger.warn(
      'Tesseract worker initialization failed — falling back to per-call Tesseract.recognize()',
      { error: String((err as Error)?.message || err) },
    );
    return null;
  }
}

/**
 * Pre-initialize the OCR worker at startup so the first screenshot doesn't
 * pay the language data load cost (~2-5s).
 *
 * Safe to call multiple times — no-ops if already initialized.
 * If init fails, logs a warning but does NOT throw — the recognize
 * functions will fall back to per-call Tesseract.recognize().
 */
export async function preInitOcr(): Promise<void> {
  await getWorker();
}

/**
 * Terminate the shared OCR worker. Call on process exit to ensure the
 * worker thread doesn't keep the Node.js process alive.
 *
 * Safe to call multiple times — no-ops if already terminated.
 * After shutdown, the next recognize call will lazily re-create the worker.
 */
export async function shutdownOcr(): Promise<void> {
  if (worker) {
    try {
      await worker.terminate();
      logger.info('Tesseract OCR worker terminated');
    } catch (err) {
      logger.warn('Error terminating OCR worker', { error: String(err) });
    }
    worker = null;
    workerInitPromise = null;
    workerFailed = false;
  }
}

// ---------------------------------------------------------------------------
// Public API — OCR functions (all use the shared worker with fallback)
// ---------------------------------------------------------------------------

/**
 * Run OCR on a single image file.
 *
 * @param imagePath - Path to the image file
 * @param language  - Tesseract language code (default: 'eng').
 *                    NOTE: the shared worker is pre-loaded with 'eng' only.
 *                    If a different language is requested, we fall back to
 *                    per-call Tesseract.recognize().
 * @returns OCR result with text and confidence
 */
export async function recognizeText(
  imagePath: string,
  language = 'eng',
): Promise<OcrResult> {
  // Only use the shared worker for English (the only pre-loaded language).
  if (language === 'eng') {
    const w = await getWorker();
    if (w) {
      try {
        const result = await w.recognize(imagePath);
        return {
          text: result.data.text.trim(),
          confidence: result.data.confidence,
        };
      } catch (err) {
        logger.warn('Worker recognize() failed, falling back to per-call', {
          error: String(err),
        });
      }
    }
  }

  // Fallback: per-call Tesseract.recognize() (the old behavior)
  try {
    logger.debug(`Running OCR (fallback) on: ${imagePath}`);
    const result = await Tesseract.recognize(imagePath, language, {
      logger: () => {},
    });
    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
    };
  } catch (err) {
    logger.error(`OCR failed for ${imagePath}`, { error: String(err) });
    return { text: '', confidence: 0 };
  }
}

/**
 * Run OCR on a Buffer (e.g., a cropped image region).
 *
 * @param buffer   - Image data as a Buffer
 * @param language - Tesseract language code (default: 'eng').
 *                    NOTE: the shared worker is pre-loaded with 'eng' only.
 *                    If a different language is requested, we fall back to
 *                    per-call Tesseract.recognize().
 */
export async function recognizeBuffer(
  buffer: Buffer,
  language = 'eng',
): Promise<OcrResult> {
  // Only use the shared worker for English.
  if (language === 'eng') {
    const w = await getWorker();
    if (w) {
      try {
        const result = await w.recognize(buffer);
        return {
          text: result.data.text.trim(),
          confidence: result.data.confidence,
        };
      } catch (err) {
        logger.warn('Worker recognize() failed, falling back to per-call', {
          error: String(err),
        });
      }
    }
  }

  // Fallback: per-call Tesseract.recognize() (the old behavior)
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

/**
 * Run OCR on a Buffer and return the FULL Tesseract result (including
 * word-level bounding boxes).
 *
 * Used by `unifiedHeaderOcr.ts` and `detectSymbolByWhitespace.ts` which
 * need `result.data.words` for geometry analysis.
 *
 * @param buffer - Image data as a Buffer
 * @returns The raw Tesseract RecognizeResult (same type as
 *          `Tesseract.recognize()` returns)
 */
export async function recognizeRaw(
  buffer: Buffer,
): Promise<Tesseract.RecognizeResult> {
  const w = await getWorker();
  if (w) {
    try {
      return await w.recognize(buffer);
    } catch (err) {
      logger.warn('Worker recognize() failed, falling back to per-call', {
        error: String(err),
      });
    }
  }

  // Fallback: per-call Tesseract.recognize() (the old behavior)
  return Tesseract.recognize(buffer, 'eng', {
    logger: () => {},
  });
}
