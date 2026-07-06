/**
 * Reprocess script — re-analyze existing images with the current parser.
 *
 * This is the key workflow for parser improvements:
 *   1. Bump PARSER_VERSION in .env (or edit below)
 *   2. Run: npm run reprocess
 *   3. All images get re-analyzed with the new detector
 *   4. Old results are updated in-place (same row, new analysis)
 *
 * Usage:
 *   npm run reprocess            # reprocess all
 *   npm run reprocess review     # reprocess only those needing review (<70%)
 *   npm run reprocess symbol     # reprocess only where symbol is NULL
 *   npm run reprocess nifty      # reprocess only NIFTY trades
 *   npm run reprocess banknifty  # reprocess only BANKNIFTY trades
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { analyzeImage } from '../analyzer/imageAnalyzer.js';
import { TradeRepository } from '../database/tradeRepository.js';

// Import logger (sets up winston)
import '../utils/logger.js';

// Read config without requiring Telegram credentials
// Use dotenv directly to get PARSER_VERSION and DATABASE_PATH
import dotenv from 'dotenv';
dotenv.config();

const PARSER_VERSION = process.env['PARSER_VERSION'] ?? '0.3.0';
const dbPath = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  console.error('Run the main app first to download and analyze images.');
  process.exit(1);
}

const db = new Database(dbPath);
const repo = new TradeRepository(db);

const args = process.argv.slice(2);
const filter = args[0] ?? 'all';

console.log(`Parser version: ${PARSER_VERSION}`);
console.log(`Database: ${dbPath}`);
console.log(`Filter: ${filter}\n`);

// ---------------------------------------------------------------------------
// Filter modes
// ---------------------------------------------------------------------------

async function reprocessAll() {
  const trades = repo.findAll();
  await reprocessTrades(trades, 'all');
}

async function reprocessReview() {
  const trades = repo.findNeedingReview();
  await reprocessTrades(trades, 'needs-review');
}

async function reprocessWhereSymbol(symbol: string | null) {
  if (symbol) {
    const trades = repo.findBySymbol(symbol);
    await reprocessTrades(trades, `symbol=${symbol}`);
  } else {
    const rows = db
      .prepare('SELECT * FROM trades WHERE symbol IS NULL ORDER BY telegram_message_time ASC')
      .all() as Record<string, unknown>[];
    const trades = rows.map((r) => ({
      id: r.id as number,
      telegram: {
        messageId: r.telegram_message_id as number,
        channelId: r.telegram_channel_id as string,
        messageTime: new Date(r.telegram_message_time as string),
        imagePath: r.image_path as string,
        caption: r.caption as string,
      },
      trade: {
        symbol: null,
        optionType: null,
        strike: null,
        quantity: null,
        entryPrice: null,
        exitPrice: null,
        pnl: null,
        holdingTime: null,
      },
      detection: { confidence: 0, method: null, needsReview: true },
      processing: {
        processedAt: new Date(r.processed_at as string),
        insertedAt: new Date(r.inserted_at as string),
        parserVersion: r.parser_version as string,
      },
    }));
    await reprocessTrades(trades, 'symbol=NULL');
  }
}

// ---------------------------------------------------------------------------
// Core reprocessing loop
// ---------------------------------------------------------------------------

async function reprocessTrades(
  trades: { id: number; telegram: { imagePath: string } }[],
  label: string,
) {
  console.log(`Reprocessing ${trades.length} trades (filter: ${label})\n`);

  let updated = 0;
  let failed = 0;
  let unchanged = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!;
    const imagePath = trade.telegram.imagePath;

    if (!fs.existsSync(imagePath)) {
      console.log(`[${i + 1}/${trades.length}] SKIP (file missing): ${imagePath}`);
      failed++;
      continue;
    }

    try {
      const analysis = await analyzeImage(imagePath);

      repo.updateAnalysis(trade.id, {
        symbol: analysis.symbol,
        optionType: analysis.optionType,
        confidence: analysis.confidence,
        method: analysis.method,
        parserVersion: PARSER_VERSION,
      });

      if (analysis.symbol || analysis.optionType) {
        updated++;
        const sym = analysis.symbol ?? '?';
        const opt = analysis.optionType ?? '?';
        const conf = analysis.confidence.toFixed(0);
        const meth = analysis.method ?? '?';
        console.log(
          `[${i + 1}/${trades.length}] UPDATED id=${trade.id}: ${sym} ${opt} (${conf}% ${meth})`,
        );
      } else {
        unchanged++;
      }
    } catch (err) {
      failed++;
      console.log(`[${i + 1}/${trades.length}] FAILED id=${trade.id}: ${err}`);
    }
  }

  console.log(`\nDone: ${updated} updated, ${unchanged} unchanged, ${failed} failed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

switch (filter) {
  case 'review':
    reprocessReview();
    break;
  case 'symbol':
    reprocessWhereSymbol(null);
    break;
  case 'nifty':
    reprocessWhereSymbol('NIFTY');
    break;
  case 'banknifty':
    reprocessWhereSymbol('BANKNIFTY');
    break;
  default:
    reprocessAll();
}

db.close();