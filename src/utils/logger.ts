/**
 * Winston logger instance configured for the application.
 *
 * Outputs to:
 *  - Console (colored, based on LOG_LEVEL env var)
 *  - File (JSON lines, always at debug level for post-mortem analysis)
 */

import winston from 'winston';
import path from 'path';
import { config } from '../config/config.js';

const { combine, timestamp, printf, colorize, json } = winston.format;

/** Human-readable console format */
const consoleFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts as string} [${level}]${metaStr} ${message as string}`;
});

/** Ensure log directory exists */
const logDir = path.resolve(process.cwd(), 'logs');

export const logger = winston.createLogger({
  level: config.logging.level,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), json()),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

/** Add console transport in non-production */
if (config.logging.level !== 'silent') {
  logger.add(
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
    }),
  );
}