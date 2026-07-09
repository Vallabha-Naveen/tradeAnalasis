/**
 * Analyze script — processes downloaded images using:
 *   1. Screenshot validation (reusable module)
 *   2. Whitespace-based symbol detection (NIFTY vs BANKNIFTY)
 *   3. Multi-strategy OCR for CE/PE option type
 *
 * Usage:
 *   npm run analyze
 *
 * Processes all unanalyzed trades (symbol IS NULL) from the database.
 * Updates each record with detection results.
 *
 * NOTE
 * ----
 * `validateScreenshot` is now imported from `src/analyzer/validateScreenshot.ts`
 * (a side-effect-free module). Previously it was defined inline in this file,
 * which meant importing it from `liveListener.ts` would trigger `main()` and
 * run the entire offline pipeline on every live-trade startup.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { getDb } from '../database/db.js';
import { TradeRepository } from '../database/tradeRepository.js';
import { detectByWhitespace, detectByWhitespaceFromOcr } from '../analyzer/detectSymbolByWhitespace.js';
import { detectOptionTypeByOcr, detectOptionTypeFromHeaderOcr } from '../analyzer/detectOptionType.js';
import { clampConfidence, type DetectionScore } from '../analyzer/confidence.js';
import { logger } from '../utils/logger.js';
import type { Trade } from '../models/Trade.js';
import { ocrHeaderOnce } from '../analyzer/unifiedHeaderOcr.js';
import { validateScreenshot, type ValidationResult } from '../analyzer/validateScreenshot.js';
import type { OptionType } from '../models/Trade.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dbPath = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');
const PARSER_VERSION = '1.0.0';

// Re-export so existing imports (`import { validateScreenshot } from '../scripts/analyze.js'`)
// continue to work — though new code should import directly from validateScreenshot.ts.
export { validateScreenshot };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  console.error('Run the main app first (npm start) to download images.');
  process.exit(1);
}

const db = getDb();
const repo = new TradeRepository(db);

// ---------------------------------------------------------------------------
// Analysis pipeline for a single image
// ---------------------------------------------------------------------------

interface AnalysisResult {
  symbol: string | null;
  optionType: string | null;
  confidence: number;
  method: string | null;
  skipped: boolean;
  skipReason?: string;
}

async function analyzeOne(trade: Trade): Promise<AnalysisResult> {
  const imagePath = trade.telegram.imagePath!;

  if (!fs.existsSync(imagePath)) {
    return { symbol: null, optionType: null, confidence: 0, method: null, skipped: true, skipReason: 'file missing' };
  }

  // Gate 1: Validate screenshot (imported from reusable module)
  const validation: ValidationResult = await validateScreenshot(imagePath);
  if (!validation.valid) {
    logger.info(`  Skipped (not a trade screenshot): ${validation.reason}`);
    return { symbol: null, optionType: null, confidence: 0, method: null, skipped: true, skipReason: validation.reason };
  }

  // Optimized pipeline: unified OCR → single-pass → fallbacks
  let symbolScore: DetectionScore<string>;
  let optionScore: DetectionScore<OptionType>;

  try {
    const ocrResult = await ocrHeaderOnce(imagePath);
    symbolScore = detectByWhitespaceFromOcr(ocrResult);
    optionScore = detectOptionTypeFromHeaderOcr(ocrResult);

    if (!optionScore.value) {
      logger.debug('Single-pass CE/PE failed, falling back to multi-strategy OCR');
      optionScore = await detectOptionTypeByOcr(imagePath);
    }

    if (!symbolScore.value) {
      logger.debug('Single-pass symbol detection failed, falling back to original method');
      symbolScore = await detectByWhitespace(imagePath);
    }
  } catch (err) {
    logger.warn('Unified OCR failed, falling back to original parallel detection', { error: String(err) });
    const [sScore, oScore] = await Promise.all([
      detectByWhitespace(imagePath),
      detectOptionTypeByOcr(imagePath),
    ]);
    symbolScore = sScore;
    optionScore = oScore;
  }

  const symbol = symbolScore.value;
  const optionType = optionScore.value;

  const sConf = symbolScore.confidence;
  const oConf = optionScore.confidence;

  let confidence: number;
  if (sConf === 0 && oConf === 0) {
    confidence = 0;
  } else if (sConf > 0 && oConf > 0) {
    confidence = clampConfidence(sConf * 0.6 + oConf * 0.4);
  } else {
    confidence = clampConfidence(Math.max(sConf, oConf));
  }

  let method: string | null = null;
  if (symbolScore.value && optionScore.value) {
    method = symbolScore.confidence >= optionScore.confidence ? symbolScore.method : optionScore.method;
  } else if (symbolScore.value) {
    method = symbolScore.method;
  } else if (optionScore.value) {
    method = optionScore.method;
  }

  logger.info(
    `  → symbol=${symbol ?? 'NULL'} optionType=${optionType ?? 'NULL'} confidence=${confidence.toFixed(0)}% method=${method}`,
  );

  return { symbol, optionType, confidence, method, skipped: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Analyze Downloaded Images ===\n');
  console.log(`Database: ${dbPath}\n`);

  const trades = repo.findUnanalyzed();
  console.log(`Found ${trades.length} unanalyzed trades\n`);

  if (trades.length === 0) {
    console.log('Nothing to analyze. All images have been processed.');
    db.close();
    return;
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!;
    const imgPath = trade.telegram.imagePath;

    if (!imgPath) {
      console.log(`[${i + 1}/${trades.length}] SKIPPED: no imagePath in DB (msg ${trade.telegram.messageId})`);
      repo.updateAnalysis(trade.id, {
        symbol: null,
        optionType: null,
        confidence: 0,
        method: null,
        parserVersion: PARSER_VERSION,
      });
      skipped++;
      continue;
    }

    const filename = path.basename(imgPath);
    console.log(`[${i + 1}/${trades.length}] ${filename} (msg ${trade.telegram.messageId})`);

    try {
      const result = await analyzeOne(trade);

      if (result.skipped) {
        repo.updateAnalysis(trade.id, {
          symbol: null,
          optionType: null,
          confidence: 0,
          method: null,
          parserVersion: PARSER_VERSION,
        });
        skipped++;
        console.log(`  SKIPPED: ${result.skipReason}`);
      } else {
        repo.updateAnalysis(trade.id, {
          symbol: result.symbol,
          optionType: result.optionType,
          confidence: result.confidence,
          method: result.method,
          parserVersion: PARSER_VERSION,
        });
        success++;
      }
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${err}`);
    }
  }

  const total = repo.count();
  const remaining = repo.findUnanalyzed().length;
  const bySymbol = repo.countBySymbol();
  const needsReview = repo.findNeedingReview().length;

  console.log('\n========== ANALYSIS SUMMARY ==========');
  console.log(`Processed:   ${success}`);
  console.log(`Skipped:    ${skipped}`);
  console.log(`Failed:     ${failed}`);
  console.log(`Still pending: ${remaining}`);
  console.log(`Total in DB: ${total}`);
  console.log(`Needs review (<70%): ${needsReview}`);
  console.log('\nBy symbol:');
  for (const [symbol, count] of Object.entries(bySymbol)) {
    console.log(`  ${symbol}: ${count}`);
  }
  console.log('=======================================');

  db.close();
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
