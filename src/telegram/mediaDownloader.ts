/**
 * Media downloader — downloads a single photo from a Telegram message.
 *
 * Separated from the history downloader so it can be reused
 * for live message processing later.
 */

import { TelegramClient, Api } from 'telegram';

import path from 'path';
import { logger } from '../utils/logger.js';
import { writeBuffer, buildImageFilename } from '../utils/file.js';

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