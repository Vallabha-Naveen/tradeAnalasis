/**
 * Image utility functions built on top of Sharp.
 * Provides common image operations used by the analyzer pipeline.
 */

import sharp from 'sharp';
import { logger } from './logger.js';

/** Basic image metadata extracted via Sharp */
export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  channels: number;
}

/**
 * Extract basic metadata from an image file.
 */
export async function getImageInfo(filePath: string): Promise<ImageInfo> {
  const metadata = await sharp(filePath).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format ?? 'unknown',
    channels: metadata.channels ?? 3,
  };
}

/**
 * Extract a rectangular region from an image as a raw RGBA Buffer.
 *
 * @param filePath  - Path to the source image
 * @param x         - Left coordinate (px)
 * @param y         - Top coordinate (px)
 * @param width     - Width of the region (px)
 * @param height    - Height of the region (px)
 * @returns         - Raw pixel buffer (RGBA)
 */
export async function extractRegion(
  filePath: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Buffer> {
  logger.debug(`Extracting region from ${filePath}: x=${x} y=${y} w=${width} h=${height}`);
  const { data, info } = await sharp(filePath)
    .extract({ left: x, top: y, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  logger.debug(`Region extracted: ${info.width}x${info.height}, ${data.length} bytes`);
  return data;
}

/**
 * Convert an image region to a PNG Buffer (useful for OCR input).
 */
export async function extractRegionAsPng(
  filePath: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(filePath).extract({ left: x, top: y, width, height }).png().toBuffer();
}

/**
 * Get the raw RGBA pixel data for the entire image.
 */
export async function getRawPixels(filePath: string): Promise<Buffer> {
  const { data } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  return data;
}

/**
 * Measure the average brightness of a horizontal strip of the image.
 * Returns a value between 0 (black) and 255 (white).
 *
 * Useful for detecting header boundaries, whitespace regions, etc.
 *
 * @param filePath  - Path to the source image
 * @param y         - Top of the strip
 * @param height    - Height of the strip
 */
export async function measureStripBrightness(
  filePath: string,
  y: number,
  height: number,
): Promise<number> {
  const info = await getImageInfo(filePath);
  const width = info.width;

  const stripData = await sharp(filePath)
    .extract({ left: 0, top: y, width, height })
    .raw()
    .toBuffer();

  const channelCount = info.channels;
  const pixelCount = (stripData.length / channelCount) as number;
  let totalBrightness = 0;

  for (let i = 0; i < stripData.length; i += channelCount) {
    // Average R, G, B (ignore alpha if present)
    let sum = 0;
    for (let c = 0; c < 3 && c < channelCount; c++) {
      sum += stripData[i + c]!;
    }
    totalBrightness += sum / 3;
  }

  return totalBrightness / pixelCount;
}

/**
 * Find the first row (from top) where brightness drops below a threshold.
 * Useful for detecting the bottom edge of a header bar.
 *
 * @param filePath    - Source image path
 * @param startY      - Row to start scanning from
 * @param endY        - Row to stop scanning at
 * @param threshold   - Brightness threshold (0–255)
 * @param step        - Rows to skip between samples (for performance)
 */
export async function findDarkRow(
  filePath: string,
  startY: number,
  endY: number,
  threshold: number,
  step = 1,
): Promise<number | null> {
  const info = await getImageInfo(filePath);
  const width = info.width;
  const channels = info.channels;

  for (let y = startY; y < endY; y += step) {
    const row = await sharp(filePath)
      .extract({ left: 0, top: y, width, height: 1 })
      .raw()
      .toBuffer();

    let rowBrightness = 0;
    for (let x = 0; x < row.length; x += channels) {
      rowBrightness += row[x]!;
    }
    rowBrightness /= width;

    if (rowBrightness < threshold) {
      return y;
    }
  }

  return null;
}