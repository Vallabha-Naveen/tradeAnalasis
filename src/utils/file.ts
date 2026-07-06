/**
 * File-system utility functions.
 * All path operations use the project's download directory as the base.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Ensure a directory exists, creating it (and parents) if needed.
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug(`Created directory: ${dirPath}`);
  }
}

/**
 * Generate a safe filename from a Telegram message timestamp.
 * Format: YYYY-MM-DD_HH-mm-ss.<ext>
 *
 * @param date  - The message date
 * @param ext   - File extension without dot (default: "jpg")
 */
export function buildImageFilename(date: Date, ext = 'jpg'): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d}_${h}-${mi}-${s}.${ext}`;
}

/**
 * Build the full path for a downloaded image.
 */
export function buildImagePath(downloadDir: string, date: Date, ext?: string): string {
  const filename = buildImageFilename(date, ext);
  return path.join(downloadDir, filename);
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Write a Buffer to disk, ensuring the parent directory exists.
 * Returns the written file path.
 */
export async function writeBuffer(
  buffer: Buffer,
  filePath: string,
): Promise<string> {
  ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, buffer);
  logger.debug(`Wrote file: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

/**
 * Read a file as a Buffer.
 */
export async function readBuffer(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

/**
 * List all image files in a directory, sorted by name (oldest first).
 */
export async function listImageFiles(dir: string): Promise<string[]> {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = await fs.promises.readdir(dir);
  return files
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
}