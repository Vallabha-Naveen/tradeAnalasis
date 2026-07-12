/**
 * Media downloader — downloads a single photo from a Telegram message.
 *
 * Separated from the history downloader so it can be reused
 * for live message processing later.
 *
 * PERFORMANCE NOTE
 * ----------------
 * `downloadMessagePhotoLive` returns BOTH the in-memory Buffer AND the
 * intended file path, without waiting for the disk write to complete.
 * Callers can start analysis on the Buffer immediately while the write
 * runs in the background. The disk write is for audit/reprocessing only
 * — it's not on the critical path of order placement.
 *
 * The original `downloadMessagePhoto` (awaited write, returns path only)
 * is kept for the history downloader, which needs the file on disk
 * before inserting DB records.
 */

import { TelegramClient, Api } from 'telegram';

import path from 'path';
import { logger } from '../utils/logger.js';
import { writeBuffer, buildImageFilename } from '../utils/file.js';

/** Result of a live photo download — buffer + intended path. */
export interface DownloadedPhoto {
  /** In-memory image bytes — pass to sharp/OCR/VLM directly, no disk read needed. */
  buffer: Buffer;
  /** Where the file will be (or has been) persisted. Store in DB for audit. */
  filePath: string;
  /** File size in bytes. */
  size: number;
}

/**
 * Download the photo from a single Telegram message.
 *
 * Downloads the largest available size and saves it to disk
 * using the message timestamp as the filename.
 *
 * @param client   - Authenticated Telegram client
 * @param message  - Telegram message containing a photo
 * @param downloadDir - Directory to save the file into
 * @returns The local file path of the downloaded image, or null if no photo
 */
export async function downloadMessagePhoto(
  client: TelegramClient,
  message: Api.Message,
  downloadDir: string,
): Promise<string | null> {
  // Skip messages without photo media
  if (!message.media) {
    return null;
  }

  // Check if media is a photo type
  const isPhoto =
    message.media instanceof Api.MessageMediaPhoto ||
    (message.media instanceof Api.MessageMediaDocument &&
      (message.media.document as Api.Document | undefined)?.mimeType?.startsWith('image/'));

  if (!isPhoto) {
    return null;
  }

  const msgDate = new Date((message.date as number) * 1000);

  try {
    // Download the buffer for this message's media
    const buffer = await client.downloadMedia(message);

    if (!buffer || !(buffer instanceof Buffer)) {
      logger.warn(`Failed to download photo for message ${message.id}: no buffer returned`);
      return null;
    }

    // Determine extension from mime type or default to jpg
    let ext = 'jpg';
    if (
      message.media instanceof Api.MessageMediaDocument &&
      message.media.document instanceof Api.Document
    ) {
      const mime = message.media.document.mimeType ?? '';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
    }

    // Always include message ID in filename to prevent collisions
    const baseName = buildImageFilename(msgDate, ext).replace(/\.\w+$/, '');
    const fileName = `${baseName}_${message.id}.${ext}`;
    const filePath = path.join(downloadDir, fileName);
    await writeBuffer(buffer, filePath);

    logger.info(
      `Downloaded photo: msg=${message.id} -> ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`,
    );

    return filePath;
  } catch (err) {
    logger.error(`Error downloading photo for message ${message.id}`, {
      error: String(err),
    });
    return null;
  }
}

/**
 * Download a photo for LIVE processing — returns the Buffer immediately
 * and persists to disk in the background.
 *
 * The disk write runs as a fire-and-forget promise (errors are logged but
 * do not fail the call). This means:
 *   - The caller gets the Buffer ASAP and can start analysis immediately.
 *   - The file MAY not be on disk yet when the caller proceeds. Callers
 *     that need the file to exist (e.g., for reprocessing scripts) should
 *     either await `writePromise` or use the original `downloadMessagePhoto`.
 *   - The DB record stores `filePath` regardless — the write will complete
 *     (or fail with a logged error) within a few ms.
 *
 * @returns `{ buffer, filePath, size }` or `null` if the message has no photo
 *          or the download itself failed. The write promise is attached to
 *          the returned object as `writePromise` for callers that want to
 *          await it (e.g., during graceful shutdown).
 */
export async function downloadMessagePhotoLive(
  client: TelegramClient,
  message: Api.Message,
  downloadDir: string,
): Promise<(DownloadedPhoto & { writePromise: Promise<void> }) | null> {
  // Skip messages without photo media
  if (!message.media) {
    return null;
  }

  // Check if media is a photo type
  const isPhoto =
    message.media instanceof Api.MessageMediaPhoto ||
    (message.media instanceof Api.MessageMediaDocument &&
      (message.media.document as Api.Document | undefined)?.mimeType?.startsWith('image/'));

  if (!isPhoto) {
    return null;
  }

  const msgDate = new Date((message.date as number) * 1000);

  try {
    // Download the buffer for this message's media
    const buffer = await client.downloadMedia(message);

    if (!buffer || !(buffer instanceof Buffer)) {
      logger.warn(`Failed to download photo for message ${message.id}: no buffer returned`);
      return null;
    }

    // Determine extension from mime type or default to jpg
    let ext = 'jpg';
    if (
      message.media instanceof Api.MessageMediaDocument &&
      message.media.document instanceof Api.Document
    ) {
      const mime = message.media.document.mimeType ?? '';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
    }

    // Always include message ID in filename to prevent collisions
    const baseName = buildImageFilename(msgDate, ext).replace(/\.\w+$/, '');
    const fileName = `${baseName}_${message.id}.${ext}`;
    const filePath = path.join(downloadDir, fileName);

    logger.info(
      `Downloaded photo: msg=${message.id} -> ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`,
    );

    // Fire-and-forget disk write. Errors are logged but do not fail the call.
    // The caller proceeds with the Buffer immediately.
    // `.then(() => undefined)` coerces the result to void — writeBuffer may
    // return the file path on success, but callers only need to know the
    // write completed (or failed).
    const writePromise: Promise<void> = writeBuffer(buffer, filePath)
      .then(() => undefined)
      .catch((err) => {
        logger.error(`Background disk write failed for message ${message.id}`, {
          filePath,
          error: String(err),
        });
      });

    return {
      buffer,
      filePath,
      size: buffer.length,
      writePromise,
    };
  } catch (err) {
    logger.error(`Error downloading photo for message ${message.id}`, {
      error: String(err),
    });
    return null;
  }
}
