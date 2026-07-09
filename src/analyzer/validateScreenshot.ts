/**
 * Screenshot validation — reusable module.
 *
 * Extracted from scripts/analyze.ts so that BOTH the offline analyze
 * script AND the live listener can import it without triggering
 * the analyze script's `main()` side-effect.
 *
 * Validation gates:
 *   1. Portrait orientation (H > W)
 *   2. Minimum height (800px)
 *   3. Aspect ratio 0.30–0.75 (typical phone screenshot)
 *   4. Presence of a contiguous colored header bar (30%–70% of width)
 */

import sharp from 'sharp';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export async function validateScreenshot(imagePath: string): Promise<ValidationResult> {
  try {
    const meta = await sharp(imagePath).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;

    // Gate 1: Must be portrait orientation
    if (H <= W) {
      return { valid: false, reason: `landscape orientation (${W}x${H})` };
    }

    // Gate 2: Must be tall enough to be a phone screenshot
    if (H < 800) {
      return { valid: false, reason: `too short (${H}px, min 800)` };
    }

    // Gate 3: Aspect ratio check
    const ratio = W / H;
    if (ratio < 0.30 || ratio > 0.75) {
      return { valid: false, reason: `unexpected aspect ratio ${ratio.toFixed(2)} (${W}x${H})` };
    }

    // Gate 4: Multi-row contiguous colored bar detection
    const scanH = Math.min(200, H);
    const raw = await sharp(imagePath)
      .extract({ left: 0, top: 0, width: W, height: scanH })
      .removeAlpha()
      .raw()
      .toBuffer();

    function isColoredPx(r: number, g: number, b: number): boolean {
      return (r > g + 20 && r > b + 20 && r > 60) || (g > r + 20 && g > b + 20 && g > 60);
    }

    // Find the densest colored row
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

    if (bestCount < 300) {
      return { valid: false, reason: `insufficient colored pixels (${bestCount}px, min 300)` };
    }

    // Multi-row band analysis for contiguous bar
    const bandRows: number[] = [];
    for (let dy = -5; dy <= 5; dy++) {
      const y = bestRow + dy;
      if (y >= 0 && y < scanH) bandRows.push(y);
    }

    const colColorCount = new Uint8Array(W);
    for (const y of bandRows) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (isColoredPx(raw[i]!, raw[i + 1]!, raw[i + 2]!)) {
          colColorCount[x] = (colColorCount[x] ?? 0) + 1;
        }
      }
    }

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

    if (contiguousBarRatio < 0.30) {
      return {
        valid: false,
        reason: `no contiguous colored bar (${(contiguousBarRatio * 100).toFixed(1)}%, need 30%)`,
      };
    }

    if (contiguousBarRatio > 0.70) {
      return {
        valid: false,
        reason: `colored area too wide (${(contiguousBarRatio * 100).toFixed(1)}%, max 70%)`,
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `validation error: ${String(err)}` };
  }
}
