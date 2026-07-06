/**
 * Application configuration module.
 * Reads all config from environment variables via dotenv.
 * Validates required values at startup.
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

/** Telegram API credentials */
const API_ID = process.env['API_ID'];
const API_HASH = process.env['API_HASH'];

/** Telegram session file path for persistent auth */
const SESSION_PATH = process.env['SESSION_PATH'] ?? 'session.telegram-trade-analyzer';

/** Target channel username (with or without @) */
const CHANNEL_USERNAME = process.env['CHANNEL_USERNAME'] ?? '';

/** SQLite database file path */
const DATABASE_PATH = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');

/** Directory where downloaded raw images are stored */
const DOWNLOAD_DIRECTORY = process.env['DOWNLOAD_DIRECTORY'] ?? path.join(process.cwd(), 'downloads', 'raw');

/** Winston log level: error | warn | info | debug | verbose | silly */
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

/** Only download messages posted on or after this date (YYYY-MM-DD) */
const HISTORY_START_DATE = process.env['HISTORY_START_DATE']
  ? new Date(process.env['HISTORY_START_DATE'] + 'T00:00:00Z')
  : new Date('2025-01-01T00:00:00Z');

/** Current parser version — bump when analysis logic changes */
const PARSER_VERSION = process.env['PARSER_VERSION'] ?? '0.1.0';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const missing: string[] = [];

if (!API_ID || API_ID === 'your_api_id') {
  missing.push('API_ID');
}
if (!API_HASH || API_HASH === 'your_api_hash') {
  missing.push('API_HASH');
}
if (!CHANNEL_USERNAME || CHANNEL_USERNAME === 'your_channel_username') {
  missing.push('CHANNEL_USERNAME');
}

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. ` +
      `Please copy .env.example to .env and fill in the values.`,
  );
}

// ---------------------------------------------------------------------------
// Exported config object
// ---------------------------------------------------------------------------

export const config = {
  telegram: {
    apiId: Number(API_ID!),
    apiHash: API_HASH!,
    sessionPath: SESSION_PATH,
    channelUsername: CHANNEL_USERNAME,
  },
  paths: {
    database: DATABASE_PATH,
    downloadDir: DOWNLOAD_DIRECTORY,
  },
  logging: {
    level: LOG_LEVEL,
  },
  parser: {
    version: PARSER_VERSION,
  },
  history: {
    startDate: HISTORY_START_DATE,
  },
} as const;

export type Config = typeof config;