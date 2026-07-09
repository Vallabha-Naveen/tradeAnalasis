/**
 * Option type detection using ZAI Vision Language Model (VLM).
 *
 * OFFLINE BACKTEST ONLY — NOT wired into the live trading pipeline.
 *
 * WHY VLM?
 * ---------
 * The OCR-based detector (detectOptionType.ts) struggles with small text
 * (~10-15px) in the colored header bar. Tesseract frequently misreads
 * "CE" as "GE" or "PE" as "FE", and the multi-strategy voting approach
 * is slow (10-30s/image) and still produces ambiguous results.
 *
 * A vision LLM (GLM-4V via ZAI SDK) can read the small text directly
 * because it's trained on visual understanding, not pixel → character
 * matching. Expected accuracy: 95-99% vs. the OCR pipeline's ~75-85%.
 *
 * HOW IT WORKS
 * ------------
 * 1. Crop the top portion of the screenshot (header region).
 * 2. Convert to base64 PNG (best for VLM input).
 * 3. Send to ZAI Vision API with a strict prompt asking for CE/PE.
 * 4. Parse the structured response.
 *
 * The prompt asks the model to:
 *   - Identify the option type (CE = Call, PE = Put)
 *   - Report confidence (high/medium/low)
 *   - Quote the exact text it saw (for debugging)
 *
 * RATE LIMIT HANDLING
 * -------------------
 * Cloud VLM APIs typically rate-limit to 10-50 calls/min on free tiers.
 * This module:
 *   - Reuses a single ZAI SDK instance (avoid re-init per call)
 *   - Adds a configurable delay between calls (default 500ms)
 *   - Retries once on transient errors
 */

import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import type { DetectionScore } from './confidence.js';
import type { OptionType } from '../models/Trade.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many pixels from the top to send to the VLM as the header crop. */
const VLM_HEADER_CROP_HEIGHT = 180;

/** Delay between VLM calls to respect rate limits (ms). */
const VLM_CALL_DELAY_MS = parseInt(process.env['VLM_CALL_DELAY_MS'] || '500');

/** Max retries on transient VLM errors. */
const VLM_MAX_RETRIES = 2;

/**
 * Vision model to use.
 *
 * BigModel (Zhipu AI) public API supports:
 *   - glm-4v       (basic vision, fast, cheap)
 *   - glm-4v-plus  (better accuracy, slightly slower)
 *   - glm-4.5v     (newest, best accuracy)
 *
 * Override via env var VLM_MODEL in your .env file.
 */
const VLM_MODEL = process.env['VLM_MODEL'] || 'glm-4v';

// ---------------------------------------------------------------------------
// Singleton ZAI instance (avoid re-initializing on every call)
// ---------------------------------------------------------------------------

let zaiInstance: any = null;

async function getZai(): Promise<any> {
  if (zaiInstance) return zaiInstance;
  // Dynamic import — keeps the dependency optional at runtime
  // (won't crash the whole project if z-ai-web-dev-sdk isn't installed).
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    zaiInstance = await ZAI.create();
    logger.debug('ZAI VLM SDK initialized');
    return zaiInstance;
  } catch (err) {
    const errStr = String((err as Error)?.message || err);
    // Detect the specific "config not found" error and give actionable advice
    if (errStr.includes('.z-ai-config') || errStr.includes('Configuration file not found')) {
      throw new Error(
        `ZAI SDK configuration missing. The VLM detector needs a .z-ai-config file with your BigModel (Zhipu AI) API key.\n\n` +
          `To fix this:\n` +
          `  1. Sign up at https://open.bigmodel.cn (free credits on signup)\n` +
          `  2. Create an API key in the BigModel dashboard\n` +
          `  3. Create a file named ".z-ai-config" in your project root (next to package.json) with this content:\n\n` +
          `     {\n` +
          `       "baseUrl": "https://open.bigmodel.cn/api/paas/v4",\n` +
          `       "apiKey": "YOUR_API_KEY_HERE"\n` +
          `     }\n\n` +
          `  4. Re-run: npm run backtest\n\n` +
          `Original error: ${errStr}`,
      );
    }
    throw new Error(
      `Failed to load z-ai-web-dev-sdk. Run \`npm install z-ai-web-dev-sdk\` first. ` +
        `Original error: ${errStr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

/**
 * Crop the header region and convert to base64 PNG.
 *
 * We crop just the header (top ~180px) instead of sending the full
 * screenshot to:
 *   - Reduce token usage (lower cost)
 *   - Focus the model's attention on the relevant region
 *   - Avoid the model getting confused by chart content below
 */
async function cropHeaderToBase64(imagePath: string): Promise<{ base64: string; mime: string }> {
  const meta = await sharp(imagePath).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const cropH = Math.min(VLM_HEADER_CROP_HEIGHT, H);

  const pngBuffer = await sharp(imagePath)
    .extract({ left: 0, top: 0, width: W, height: cropH })
    .png()
    .toBuffer();

  return {
    base64: pngBuffer.toString('base64'),
    mime: 'image/png',
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The prompt sent to the VLM.
 *
 * Design notes:
 *   - Strict output format (JSON) → easy to parse
 *   - Ask for confidence in 3 buckets → avoids arbitrary "87%" guesses
 *   - Ask for the exact text seen → lets us debug misclassifications
 *   - Include the meaning of CE/PE in case the model doesn't know
 *   - Explicitly forbid "I don't know" — force a best guess + low confidence
 */
const VLM_PROMPT = `You are analyzing the header region of an Indian stock-options trading app screenshot.

The header contains an instrument name like "NIFTY 23500 CE" or "BANKNIFTY 48000 PE", where:
- CE = Call Option
- PE = Put Option

Your task: identify whether this screenshot shows a CE (Call) or PE (Put) option.

Look carefully at the right side of the colored header bar — the option type (CE or PE) appears there as small dark text.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation outside JSON):
{
  "option_type": "CE" | "PE",
  "confidence": "high" | "medium" | "low",
  "text_seen": "the exact text you read near CE/PE",
  "reasoning": "one short sentence explaining your choice"
}

If you cannot see any CE/PE text, make your best guess based on visual context and set confidence to "low".`;

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface VlmResult {
  optionType: 'CE' | 'PE' | 'UNKNOWN';
  confidence: number; // 0-100
  textSeen: string;
  reasoning: string;
  rawResponse: string;
}

function confidenceBucketToScore(bucket: string): number {
  switch (bucket.toLowerCase()) {
    case 'high':
      return 95;
    case 'medium':
      return 75;
    case 'low':
      return 50;
    default:
      return 50;
  }
}

/**
 * Parse the VLM's JSON response.
 *
 * The model occasionally wraps JSON in markdown fences ```json ... ```
 * or includes leading/trailing prose. We extract the first {...} block.
 */
function parseVlmResponse(raw: string): VlmResult {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }

  // Extract the first {...} block (greedy enough to handle nested)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      optionType: 'UNKNOWN',
      confidence: 0,
      textSeen: '',
      reasoning: 'No JSON found in VLM response',
      rawResponse: raw,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]!);
    const optType = String(parsed.option_type || '').toUpperCase().trim();

    let optionType: 'CE' | 'PE' | 'UNKNOWN' = 'UNKNOWN';
    if (optType === 'CE') optionType = 'CE';
    else if (optType === 'PE') optionType = 'PE';

    return {
      optionType,
      confidence: optionType === 'UNKNOWN' ? 0 : confidenceBucketToScore(parsed.confidence || 'low'),
      textSeen: String(parsed.text_seen || ''),
      reasoning: String(parsed.reasoning || ''),
      rawResponse: raw,
    };
  } catch (err) {
    // JSON parse failed — try a regex fallback on the raw response
    const upper = raw.toUpperCase();
    const hasCE = /\bCE\b/.test(upper);
    const hasPE = /\bPE\b/.test(upper);
    if (hasCE && !hasPE) {
      return {
        optionType: 'CE',
        confidence: 60,
        textSeen: '',
        reasoning: 'Parsed via regex fallback (JSON parse failed)',
        rawResponse: raw,
      };
    }
    if (hasPE && !hasCE) {
      return {
        optionType: 'PE',
        confidence: 60,
        textSeen: '',
        reasoning: 'Parsed via regex fallback (JSON parse failed)',
        rawResponse: raw,
      };
    }
    return {
      optionType: 'UNKNOWN',
      confidence: 0,
      textSeen: '',
      reasoning: `JSON parse failed: ${String(err)}`,
      rawResponse: raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

let lastCallTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < VLM_CALL_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, VLM_CALL_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect CE/PE using the ZAI Vision LLM.
 *
 * @param imagePath Path to the full screenshot
 * @returns DetectionScore<OptionType> with confidence and method='vlm'
 */
export async function detectOptionTypeByVlm(
  imagePath: string,
): Promise<DetectionScore<OptionType> & { textSeen?: string; reasoning?: string; rawResponse?: string }> {
  try {
    const zai = await getZai();
    const { base64, mime } = await cropHeaderToBase64(imagePath);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= VLM_MAX_RETRIES; attempt++) {
      try {
        await rateLimit();

        // IMPORTANT: use the standard `create()` endpoint, NOT `createVision()`.
        // The ZAI SDK's `createVision()` calls `{baseUrl}/chat/completions/vision`
        // which is a Z.ai-internal path. BigModel's public API uses the standard
        // OpenAI-compatible `/chat/completions` endpoint for BOTH text and vision
        // — you just specify a vision-capable model (e.g. glm-4v) and include
        // image_url content items in the messages.
        const response = await zai.chat.completions.create({
          model: VLM_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VLM_PROMPT },
                {
                  type: 'image_url',
                  image_url: { url: `data:${mime};base64,${base64}` },
                },
              ],
            },
          ],
          thinking: { type: 'disabled' },
        });

        const content = response?.choices?.[0]?.message?.content || '';
        const parsed = parseVlmResponse(content);

        logger.debug(
          `VLM detection: ${parsed.optionType} (${parsed.confidence}%) ` +
            `text="${parsed.textSeen}" reasoning="${parsed.reasoning.slice(0, 80)}"`,
        );

        return {
          value: parsed.optionType === 'UNKNOWN' ? null : parsed.optionType,
          confidence: parsed.confidence,
          method: 'vlm',
          textSeen: parsed.textSeen,
          reasoning: parsed.reasoning,
          rawResponse: parsed.rawResponse,
        };
      } catch (err) {
        lastError = err as Error;
        logger.warn(`VLM attempt ${attempt + 1} failed: ${String(err)}`);
        // Exponential backoff before retry
        if (attempt < VLM_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error('VLM detection failed after retries');
  } catch (err) {
    logger.error('VLM option type detection failed', { error: String(err), imagePath });
    return {
      value: null,
      confidence: 0,
      method: 'vlm',
      reasoning: String(err),
    };
  }
}

/**
 * Check whether the ZAI SDK is available AND configured.
 *
 * Verifies two things:
 *   1. The `z-ai-web-dev-sdk` package is installed
 *   2. A `.z-ai-config` file exists (in project root, home dir, or /etc/)
 *
 * Returns a descriptive object so callers can show a helpful message
 * instead of failing on every image.
 */
export async function checkVlmAvailability(): Promise<{
  available: boolean;
  reason?: string;
}> {
  // 1. Check if the SDK package is installed
  let mod: any;
  try {
    mod = await import('z-ai-web-dev-sdk');
    if (!mod?.default) {
      return {
        available: false,
        reason: 'z-ai-web-dev-sdk package is installed but has no default export.',
      };
    }
  } catch {
    return {
      available: false,
      reason:
        'z-ai-web-dev-sdk is not installed. Run: npm install z-ai-web-dev-sdk',
    };
  }

  // 2. Check if a config file exists in any of the standard locations
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const candidates = [
    path.resolve(process.cwd(), '.z-ai-config'),
    path.join(os.homedir(), '.z-ai-config'),
    '/etc/.z-ai-config',
  ];
  const configExists = candidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (!configExists) {
    return {
      available: false,
      reason:
        'No .z-ai-config file found. Create one in your project root with your BigModel API key:\n' +
        '  {\n' +
        '    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",\n' +
        '    "apiKey": "YOUR_API_KEY"\n' +
        '  }\n' +
        'Get a free API key at https://open.bigmodel.cn',
    };
  }

  return { available: true };
}

/**
 * @deprecated Use checkVlmAvailability() instead — returns more detail.
 */
export async function isVlmAvailable(): Promise<boolean> {
  const result = await checkVlmAvailability();
  return result.available;
}
