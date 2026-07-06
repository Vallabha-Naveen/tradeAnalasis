/**
 * Historical downloader — fetches past messages from a Telegram channel
 * and downloads every photo it finds.
 *
 * Supports **incremental downloads**: on subsequent runs, it checks the DB
 * for message IDs it already has and skips them. For first runs, it uses
 * HISTORY_START_DATE to avoid scanning the entire channel history.
 *
 * Telegram's iterMessages returns messages newest-to-oldest, so we can
 * break out of the loop once we hit messages older than our cutoff.
 */

import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl/index.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { ensureDir } from '../utils/file.js';
import { downloadMessagePhoto } from './mediaDownloader.js';
import type BetterSqlite3 from 'better-sqlite3';

/** Metadata about a single downloaded screenshot */
export interface DownloadedMessage {
  messageId: number;
  channelId: string;
  messageTime: Date;
  imagePath: string;
  caption: string;
}

/**
 * Determine the start timestamp for downloading.
 *
 * 1. If DB has trades → return 0 (we rely on message-ID dedup, not date cutoff,
 *    because we need to scan forward from the most recent to find new ones)
 * 2. If DB is empty → use HISTORY_START_DATE to avoid scanning the full history
 *
 * Returns a Unix timestamp (seconds), or 0 for no date filter.
 */
function getMinDateTimestamp(db: BetterSqlite3.Database): number {
  const count = (db.prepare('SELECT COUNT(*) as n FROM trades').get() as { n: number }).n;

  if (count > 0) {
    logger.info(`DB has ${count} existing records — using message-ID dedup (no date filter)`);
    return 0; // No date cutoff — we'll rely on ID dedup
  }

  const startDate = config.history.startDate;
  const ts = Math.floor(startDate.getTime() / 1000);
  logger.info(`Empty DB — filtering messages from ${startDate.toISOString().split('T')[0]} onward`);
  return ts;
}

/**
 * Download historical photos from the configured Telegram channel.
 *
 * On first run: downloads everything from HISTORY_START_DATE.
 * On subsequent runs: scans all messages but skips ones already in DB
 * (by message ID). Breaks early when messages are older than the cutoff
 * (only on first run when no DB records exist).
 *
 * @param client - Authenticated Telegram client
 * @param db     - Database instance (used to check existing data)
 * @returns Array of metadata for each newly downloaded image
 */
export async function downloadHistory(
  client: TelegramClient,
  db: BetterSqlite3.Database,
): Promise<DownloadedMessage[]> {
  const { channelUsername } = config.telegram;
  const downloadDir = config.paths.downloadDir;
  const minTimestamp = getMinDateTimestamp(db);

  ensureDir(downloadDir);
  logger.info(`Downloading from @${channelUsername}`);

  const normalizedUsername = channelUsername.replace('@', '');
  const results: DownloadedMessage[] = [];
  let totalMessages = 0;
  let photoMessages = 0;
  let skippedMessages = 0;
  let alreadyExists = 0;
  let tooOld = 0;

  try {
    const entity = await client.getEntity(normalizedUsername);
    const channelId = String(entity.id);
    logger.info(`Channel ID: ${channelId}`);

    // Pre-load existing message IDs for O(1) dedup
    const existingIds = new Set<number>(
      (db
        .prepare('SELECT telegram_message_id FROM trades WHERE telegram_channel_id = ?')
        .all(channelId) as { telegram_message_id: number }[]).map((r) => r.telegram_message_id),
    );

    if (existingIds.size > 0) {
      logger.info(`Skipping ${existingIds.size} messages already in DB`);
    }

    // iterMessages returns newest first, going backwards
    // No offsetDate — we filter manually
    const messageIter = client.iterMessages(entity, {
      limit: Number.MAX_SAFE_INTEGER,
    });

    for await (const message of messageIter) {
      if (!(message instanceof Api.Message)) {
        continue;
      }

      // On first run (no DB data): stop once we hit messages older than cutoff
      if (minTimestamp > 0 && (message.date as number) < minTimestamp) {
        tooOld++;
        // Since messages come newest-to-oldest, all remaining will be even older
        if (tooOld > 10) {
          logger.info(`Reached messages older than cutoff — stopping (skipped ${tooOld} old messages)`);
          break;
        }
        continue;
      }

      // Skip messages we already have
      if (existingIds.has(message.id)) {
        alreadyExists++;
        // Optimization: if we've hit many existing messages in a row,
        // we've likely caught up to what we already downloaded
        if (alreadyExists > 20 && photoMessages === 0) {
          logger.info(`Caught up to existing data — stopping (no new photos found)`);
          break;
        }
        continue;
      }

      totalMessages++;

      const imagePath = await downloadMessagePhoto(client, message, downloadDir);

      if (imagePath) {
        results.push({
          messageId: message.id,
          channelId,
          messageTime: new Date((message.date as number) * 1000),
          imagePath,
          caption: (message.message as string) ?? '',
        });
        photoMessages++;
      } else {
        skippedMessages++;
      }

      if (totalMessages % 50 === 0) {
        logger.info(
          `Progress: ${photoMessages} downloaded, ${skippedMessages} non-photo, ${totalMessages} new scanned`,
        );
      }
    }
  } catch (err) {
    logger.error('Error during historical download', { error: String(err) });
    throw err;
  }

  if (totalMessages === 0 && alreadyExists > 0) {
    logger.info(`No new messages. Database is up to date.`);
  } else {
    logger.info(
      `Download complete: ${photoMessages} photos, ${skippedMessages} non-photo, ${alreadyExists} already in DB`,
    );
  }

  return results;
}