/**
 * Google Cloud Vision OCR — singleton client + header OCR function.
 *
 * WHY GOOGLE VISION?
 * ------------------
 * Tesseract (the previous OCR engine) struggles with small text (~10-15px)
 * in the colored header bar of trading screenshots, taking 2-5s per image
 * and frequently misreading "CE" as "GE" or "PE" as "FE".
 *
 * GLM-4V (the VLM detector) is more accurate but has strict rate limits
 * (3-5 RPM on free tier) and 1-3s latency per call, causing 429 errors
 * during fast-moving markets.
 *
 * Google Cloud Vision API:
 *   - Latency: ~200-500ms per call (10x faster than Tesseract)
 *   - Rate limit: 1800 RPM default (360x higher than GLM-4V free tier)
 *   - Accuracy: industry-leading OCR, handles small text easily
 *   - Cost: $1.50 per 1000 images (very cheap for live trading)
 *
 * AUTHENTICATION
 * --------------
 * Two options (either works):
 *
 * 1. Service account JSON file (standard Google Cloud way):
 *    Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *    The file is downloaded from Google Cloud Console > IAM > Service Accounts
 *
 * 2. Inline JSON in env var (easier for deployment):
 *    Set GOOGLE_VISION_CREDENTIALS_JSON={"type":"service_account",...}
 *    (the full JSON content as a single line)
 *
 * SETUP
 * -----
 * 1. Go to https://console.cloud.google.com
 * 2. Create a project (or use existing)
 * 3. Enable the Cloud Vision API: APIs & Services > Enable APIs > "Cloud Vision API"
 * 4. Create a service account: IAM > Service Accounts > Create
 * 5. Download the JSON key
 * 6. Set GOOGLE_APPLICATION_CREDENTIALS to the path of that JSON file
 *
 * FREE TIER
 * ---------
 * Google Cloud Vision offers 1000 free calls/month. Beyond that, it's
 * $1.50 per 1000 images. For live trading (10-50 trades/day), that's
 * ~$0.15-0.75/month — negligible.
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a Google Vision OCR call on the header crop. */
export interface GoogleVisionOcrResult {
  /** Full text detected in the header (all words concatenated). */
  fullText: string;
  /** Individual words with their bounding boxes (for whitespace analysis). */
  words: Array<{
    text: string;
    /** Bounding box: [x1, y1, x2, y2] (top-left, bottom-right). */
    bbox: [number, number, number, number];
  }>;
  /** Raw response from Google Vision (for debugging). */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let visionClient: any = null;
let initError: string | null = null;

/**
 * Get the singleton Google Vision client.
 *
 * Initializes on first call. If initialization fails (missing credentials,
 * network issue), the error is cached so subsequent calls fail fast
 * instead of retrying the init every time.
 */
async function getVisionClient(): Promise<any> {
  if (visionClient) return visionClient;
  if (initError) throw new Error(initError);

  try {
    // Support inline JSON credentials via env var (alternative to file path)
    const inlineJson = process.env['GOOGLE_VISION_CREDENTIALS_JSON'];
    if (inlineJson) {
      // Write to a temp file so the Google Cloud library can read it
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const tmpPath = path.join(os.tmpdir(), `gvision-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, inlineJson, 'utf-8');
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] = tmpPath;
      logger.info('GoogleVision: using inline credentials from GOOGLE_VISION_CREDENTIALS_JSON');
    }

    const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'] || '';
    const { ImageAnnotatorClient } = await import('@google-cloud/vision');

    visionClient = new ImageAnnotatorClient(
      projectId ? { projectId } : {},
    );

    // Verify the client works with a cheap call (getProductSets is free)
    // — actually, just log success. The first real OCR call will verify.
    logger.info(
      'GoogleVision: client initialized ✓ ' +
        (projectId ? `(project: ${projectId})` : '(project auto-detected from credentials)'),
    );
    return visionClient;
  } catch (err) {
    initError =
      `GoogleVision: failed to initialize client. ${errToString(err)}\n` +
      '  → Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON file path, OR\n' +
      '  → Set GOOGLE_VISION_CREDENTIALS_JSON to the inline JSON content.\n' +
      '  → Get a key at https://console.cloud.google.com > IAM > Service Accounts';
    throw new Error(initError);
  }
}

/**
 * Check whether Google Vision is available (SDK installed + credentials configured).
 * Called at startup by the live listener to decide which detector to use.
 */
export async function checkGoogleVisionAvailability(): Promise<{
  available: boolean;
  reason?: string;
}> {
  // 1. Check if the SDK package is installed
  try {
    await import('@google-cloud/vision');
  } catch {
    return {
      available: false,
      reason: '@google-cloud/vision package is not installed. Run: npm install @google-cloud/vision',
    };
  }

  // 2. Check if credentials are configured (either file path or inline JSON)
  const credPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  const inlineJson = process.env['GOOGLE_VISION_CREDENTIALS_JSON'];

  if (!credPath && !inlineJson) {
    return {
      available: false,
      reason:
        'No Google Cloud credentials found. Set one of:\n' +
        '  - GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n' +
        '  - GOOGLE_VISION_CREDENTIALS_JSON={"type":"service_account",...}\n\n' +
        'Get a service account key at:\n' +
        '  https://console.cloud.google.com > IAM > Service Accounts > Create\n' +
        'Then download the JSON key and set the env var.',
    };
  }

  return { available: true };
}

/**
 * Pre-initialize the Google Vision client at startup so the first
 * screenshot doesn't pay the init cost (~1-2s for dynamic import +
 * credential loading).
 *
 * Safe to call multiple times — no-ops if already initialized.
 */
export async function preInitGoogleVision(): Promise<void> {
  try {
    await getVisionClient();
  } catch (err) {
    logger.warn('GoogleVision: pre-initialization failed — will retry lazily on first screenshot', {
      error: String((err as Error)?.message || err),
    });
  }
}

// ---------------------------------------------------------------------------
// Header OCR
// ---------------------------------------------------------------------------

/** How many pixels from the top to send to Google Vision as the header crop. */
const GV_HEADER_CROP_HEIGHT = 180;

/**
 * OCR the header region of a trading screenshot using Google Cloud Vision.
 *
 * Crops the top ~180px of the image (same as VLM), converts to PNG, and
 * sends to Google Vision's TEXT_DETECTION endpoint. Returns the full text
 * plus individual words with bounding boxes (for whitespace-based symbol
 * detection if needed).
 *
 * @param imageBuffer In-memory image Buffer (from Telegram download)
 * @returns GoogleVisionOcrResult with full text + word-level data
 */
export async function ocrHeaderWithGoogleVision(
  imageBuffer: Buffer,
): Promise<GoogleVisionOcrResult> {
  const client = await getVisionClient();

  // Crop the header region (same crop as VLM for consistency)
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const cropH = Math.min(GV_HEADER_CROP_HEIGHT, H);

  const pngBuffer = await sharp(imageBuffer)
    .extract({ left: 0, top: 0, width: W, height: cropH })
    .png()
    .toBuffer();

  // Call Google Vision TEXT_DETECTION
  const [result] = await client.textDetection(pngBuffer);
  const textAnnotations = result?.textAnnotations || [];

  // First annotation is the full text; subsequent are individual words
  let fullText = '';
  const words: Array<{ text: string; bbox: [number, number, number, number] }> = [];

  for (let i = 0; i < textAnnotations.length; i++) {
    const ann = textAnnotations[i];
    if (i === 0) {
      // Full text
      fullText = ann.description || '';
    } else {
      // Individual word
      const vertices = ann.boundingPoly?.vertices || [];
      const xs = vertices.map((v: any) => v?.x ?? 0);
      const ys = vertices.map((v: any) => v?.y ?? 0);
      const x1 = Math.min(...xs);
      const y1 = Math.min(...ys);
      const x2 = Math.max(...xs);
      const y2 = Math.max(...ys);
      words.push({
        text: ann.description || '',
        bbox: [x1, y1, x2, y2],
      });
    }
  }

  logger.debug(
    `GoogleVision: OCR complete — ${words.length} words, full text: "${fullText.slice(0, 120)}..."`,
  );

  return { fullText, words, raw: result };
}
