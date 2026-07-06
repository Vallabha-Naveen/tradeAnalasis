/**
 * Main application entry point — DOWNLOAD ONLY.
 *
 * Pipeline:
 * 1. Authenticate with Telegram
 * 2. Download historical screenshots
 * 3. Insert placeholder records in DB (no analysis)
 * 4. Print summary
 * 5. Disconnect gracefully
 *
 * Run `npm run analyze` separately to analyze downloaded images.
 */

import { logger } from './utils/logger.js';
import { config } from './config/config.js';
import { ensureDir } from './utils/file.js';
import { authenticate, disconnect } from './telegram/auth.js';
import { downloadHistory } from './telegram/historyDownloader.js';
import { getDb, closeDb } from './database/db.js';
import { TradeRepository } from './database/tradeRepository.js';

async function main(): Promise<void> {
  logger.info('=== Telegram Trade Analyzer — Download Mode ===');
  logger.info(`Channel: @${config.telegram.channelUsername}`);
  logger.info(`Download dir: ${config.paths.downloadDir}`);
  logger.info(`Database: ${config.paths.database}`);

  // Ensure directories exist
  ensureDir(config.paths.downloadDir);
  ensureDir('logs');

  // Initialize database
  const db = getDb();
  const repo = new TradeRepository(db);

  // Step 1: Authenticate
  logger.info('Step 1: Authenticating with Telegram...');
  const client = await authenticate();
  logger.info('Connected and authenticated');

  try {
    // Step 2: Download historical screenshots
    logger.info('Step 2: Downloading historical screenshots...');
    const downloads = await downloadHistory(client, db);

    if (downloads.length === 0) {
      logger.info('No new photos to download. Database is up to date.');
      return;
    }

    // Step 3: Insert placeholder records (no analysis)
    logger.info(`Step 3: Inserting ${downloads.length} records into database...`);
    let inserted = 0;
    let dupes = 0;

    for (const dl of downloads) {
      const trade = repo.insertPlaceholder({
        telegramMessageId: dl.messageId,
        telegramChannelId: dl.channelId,
        telegramMessageTime: dl.messageTime,
        imagePath: dl.imagePath,
        caption: dl.caption,
      });

      if (trade && trade.detection.confidence === 0) {
        inserted++;
      } else {
        dupes++;
      }
    }

    // Step 4: Print summary
    const total = repo.count();
    const unanalyzed = repo.findUnanalyzed().length;

    logger.info('');
    logger.info('========== DOWNLOAD SUMMARY ==========');
    logger.info(`New records inserted:  ${inserted}`);
    logger.info(`Duplicates skipped:    ${dupes}`);
    logger.info(`Total records in DB:   ${total}`);
    logger.info(`Unanalyzed (pending):  ${unanalyzed}`);
    logger.info('');
    logger.info('Run `npm run analyze` to process pending images.');
    logger.info('=======================================');
  } finally {
    // Step 5: Cleanup
    logger.info('Disconnecting...');
    await disconnect(client);
    closeDb();
    logger.info('Done.');
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  logger.error('Fatal error in main', { error: String(err) });
  process.exit(1);
});