/**
 * Telegram authentication module.
 *
 * Handles initial user-authentication (not bot) and session persistence.
 * On first run, prompts for phone + OTP in the console.
 * On subsequent runs, reuses the saved session file.
 *
 * Uses gramJS (the `telegram` npm package).
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

/**
 * Connect to Telegram and authenticate.
 *
 * - If a session file exists, it is loaded and reused (no OTP required).
 * - If not, the user is prompted for phone number and OTP.
 * - The session string is saved to disk for future use.
 *
 * @returns A connected and authenticated TelegramClient
 */
export async function authenticate(): Promise<TelegramClient> {
  const { apiId, apiHash, sessionPath, channelUsername } = config.telegram;

  // Try to load an existing session string from disk
  let sessionString = '';
  const sessionFilePath = path.resolve(process.cwd(), sessionPath);

  if (fs.existsSync(sessionFilePath)) {
    sessionString = fs.readFileSync(sessionFilePath, 'utf-8').trim();
    logger.info(`Loaded existing session from: ${sessionFilePath}`);
  } else {
    logger.info('No existing session found. Will perform first-time authentication.');
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      return await input.text('Enter your phone number (with country code): ');
    },
    password: async () => {
      return await input.text('Enter your 2FA password (if enabled): ');
    },
    phoneCode: async () => {
      return await input.text('Enter the OTP code sent to your Telegram app/email: ');
    },
    onError: (err) => {
      logger.error('Authentication error', { error: String(err) });
      throw err;
    },
  });

  logger.info('Authentication successful');

  // Persist session for future use
  const newSessionString = client.session.save() as unknown as string;
  fs.writeFileSync(sessionFilePath, newSessionString, 'utf-8');
  logger.info(`Session saved to: ${sessionFilePath}`);

  // Verify access to the target channel
  try {
    const normalizedUsername = channelUsername.replace('@', '');
    const entity = await client.getEntity(normalizedUsername);
    logger.info(`Verified access to channel: @${normalizedUsername} (id: ${entity.id})`);
  } catch (err) {
    logger.error(
      `Cannot access channel @${channelUsername}. Ensure your account has access.`,
      { error: String(err) },
    );
    throw err;
  }

  return client;
}

/**
 * Disconnect the Telegram client gracefully.
 */
export async function disconnect(client: TelegramClient): Promise<void> {
  try {
    await client.disconnect();
    logger.info('Disconnected from Telegram');
  } catch (err) {
    logger.warn('Error during disconnect', { error: String(err) });
  }
}