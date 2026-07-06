/**
 * Live listener — stub for Phase 4.
 *
 * Will listen for new messages in real-time, download photos,
 * run analysis, and store results.
 *
 * NOT IMPLEMENTED in Phase 1 — this is a placeholder.
 */

import { TelegramClient } from 'telegram';

import { logger } from '../utils/logger.js';

/**
 * Start listening for new messages in the configured channel.
 *
 * @param _client - Authenticated Telegram client (unused in stub)
 */
export async function startLiveListener(_client: TelegramClient): Promise<void> {
  logger.warn('Live listener is not yet implemented (Phase 4).');
  // Future implementation will use client.addEventHandler() to listen
  // for new messages matching the target channel.
}