/**
 * Core domain types for the Trade Analyzer.
 *
 * Every interface here is a pure data shape — no methods, no coupling
 * to any external library.
 */

// ---------------------------------------------------------------------------
// Enums / Union types
// ---------------------------------------------------------------------------

/** The underlying index being traded. Extensible — add new indices here. */
export type Symbol = 'NIFTY' | 'BANKNIFTY' | 'SENSEX' | 'FINNIFTY' | string | null;

/** Known symbol literals for type-safe detection. */
export type KnownSymbol = 'NIFTY' | 'BANKNIFTY';

/** Call or Put option type */
export type OptionType = 'CE' | 'PE' | null;

/** Detection method used by the analyzer */
export type DetectionMethod =
  | 'bar-width'
  | 'header-color'
  | 'header-width'
  | 'whitespace'
  | 'ce-pe-position'
  | 'nse-badge'
  | 'ocr'
  | 'color-analysis'
  | 'manual'
  | null;

// ---------------------------------------------------------------------------
// Sub-objects
// ---------------------------------------------------------------------------

/** Telegram-specific metadata for a trade screenshot message */
export interface TelegramMeta {
  /** Unique message ID within the channel */
  messageId: number;
  /** Telegram channel ID (as string, may be negative) */
  channelId: string;
  /** When the message was posted (Telegram server time) */
  messageTime: Date;
  /** Local path to the downloaded image */
  imagePath: string;
  /** Message caption text, if any */
  caption: string;
}

/** Detected trade details (many fields nullable in early versions) */
export interface TradeDetails {
  symbol: Symbol;
  optionType: OptionType;
  strike: number | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnl: number | null;
  holdingTime: number | null; // seconds
}

/** Confidence and detection metadata */
export interface DetectionInfo {
  /** 0–100 confidence score */
  confidence: number;
  /** Which detection method was used */
  method: DetectionMethod;
  /** True if a human should review this record */
  needsReview: boolean;
}

/** Processing metadata */
export interface ProcessingMeta {
  /** When analysis completed */
  processedAt: Date;
  /** When record was inserted into DB */
  insertedAt: Date;
  /** Parser version that produced this result */
  parserVersion: string;
}

// ---------------------------------------------------------------------------
// Aggregate: full trade record
// ---------------------------------------------------------------------------

/** The complete trade record as stored in the database */
export interface Trade {
  id: number;
  telegram: TelegramMeta;
  trade: TradeDetails;
  detection: DetectionInfo;
  processing: ProcessingMeta;
}

// ---------------------------------------------------------------------------
// Flat row shape (matches the SQLite table columns directly)
// ---------------------------------------------------------------------------

/** Shape of a row returned from SQLite (all flat columns) */
export interface TradeRow {
  id: number;
  telegramMessageId: number;
  telegramChannelId: string;
  telegramMessageTime: string; // ISO 8601
  symbol: Symbol;
  optionType: OptionType;
  strike: number | null;
  quantity: number | null;
  confidence: number;
  detectionMethod: DetectionMethod;
  imagePath: string;
  processedAt: string; // ISO 8601
  insertedAt: string; // ISO 8601
  parserVersion: string;
  caption: string;
}

// ---------------------------------------------------------------------------
// Converter: flat row → domain object
// ---------------------------------------------------------------------------

/**
 * Convert a flat SQLite row into the structured Trade domain object.
 */
export function rowToTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    telegram: {
      messageId: row.telegramMessageId,
      channelId: row.telegramChannelId,
      messageTime: new Date(row.telegramMessageTime),
      imagePath: row.imagePath,
      caption: row.caption,
    },
    trade: {
      symbol: row.symbol,
      optionType: row.optionType,
      strike: row.strike,
      quantity: row.quantity,
      entryPrice: null,
      exitPrice: null,
      pnl: null,
      holdingTime: null,
    },
    detection: {
      confidence: row.confidence,
      method: row.detectionMethod,
      needsReview: row.confidence < 70,
    },
    processing: {
      processedAt: new Date(row.processedAt),
      insertedAt: new Date(row.insertedAt),
      parserVersion: row.parserVersion,
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis result produced by the parser pipeline (before DB insert)
// ---------------------------------------------------------------------------

/** Output of the image analysis pipeline */
export interface TradeAnalysis {
  symbol: Symbol;
  optionType: OptionType;
  confidence: number;
  method: DetectionMethod;
}

/** Input to the trade repository for creating a new record */
export interface CreateTradeInput {
  telegramMessageId: number;
  telegramChannelId: string;
  telegramMessageTime: Date;
  imagePath: string;
  caption: string;
  analysis: TradeAnalysis;
  parserVersion: string;
}