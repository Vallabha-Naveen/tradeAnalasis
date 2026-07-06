/**
 * Timestamp detection module.
 *
 * As per the spec, we do NOT OCR the screenshot for timestamps.
 * The Telegram API provides the exact message timestamp directly.
 * This module exists to:
 * 1. Provide the interface contract for timestamp extraction
 * 2. Future-proofing if we ever need to cross-reference
 */

import type { DetectionScore } from './confidence.js';

/**
 * Get the timestamp from Telegram message metadata.
 *
 * This is trivially 100% confident since it comes from the API,
 * not from image analysis.
 *
 * @param messageTime - The Date from the Telegram API message
 * @returns A detection score with the timestamp
 */
export function getTimestampFromApi(messageTime: Date): DetectionScore<Date> {
  return {
    value: messageTime,
    confidence: 100,
    method: 'telegram-api',
  };
}