/**
 * Analyze script — processes downloaded images using:
 *   1. Screenshot validation (3-gate: orientation, size, colored bar)
 *   2. Whitespace-based symbol detection (NIFTY vs BANKNIFTY)
 *   3. Multi-strategy OCR for CE/PE option type
 *
 * Usage:
 *   npm run analyze
 *
 * Processes all unanalyzed trades (symbol IS NULL) from the database.
 * Updates each record with detection results.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import dotenv from 'dotenv';

import { getDb } from '../database/db.js';
import { TradeRepository } from '../database/tradeRepository.js';
import { detectByWhitespace, loadCalibration } from '../analyzer/detectSymbolByWhitespace.js';
import { detectOptionTypeByOcr } from '../analyzer/detectOptionType.js';
import { clampConfidence } from '../analyzer/confidence.js';
import { logger } from '../utils/logger.js';
import type { Trade } from '../models/Trade.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dbPath = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');
const PARSER_VERSION = '1.0.0';

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

// Load whitespace calibration if available
loadCalibration();

// ---------------------------------------------------------------------------
// Screenshot validation (extracted from imageAnalyzer.ts)
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

async function validateScreenshot(imagePath: string): Promise<ValidationResult> {
  try {
    const meta = await sharp(imagePath).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;

    // Must be portrait orientation
    if (H <= W) {
      return { valid: false, reason: `landscape orientation (${W}x${H})` };
    }

    // Must be tall enough to be a phone screenshot
    if (H < 800) {
      return { valid: false, reason: `too short (${H}px, min 800)` };
    }

    // Aspect ratio check
    const ratio = W / H;
    if (ratio < 0.30 || ratio > 0.75) {
      return { valid: false, reason: `unexpected aspect ratio ${ratio.toFixed(2)} (${W}x${H})` };
    }

    // Multi-row contiguous bar detection
    const scanH = Math.min(200, H);
    const raw = await sharp(imagePath)
      .extract({ left: 0, top: 0, width: W, height: scanH })
      .removeAlpha()
      .raw()
      .toBuffer();

    function isColoredPx(r: number, g: number, b: number): boolean {
      return (r > g + 20 && r > b + 20 && r > 60) || (g > r + 20 && g > b + 20 && g > 60);
    }

    // Find the densest colored row
    let bestRow = -1;
    let bestCount = 0;
    for (let y = 0; y < scanH; y++) {
      let count = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (isColoredPx(raw[i]!, raw[i + 1]!, raw[i + 2]!)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestRow = y;
      }
    }

    if (bestCount < 300) {
      return { valid: false, reason: `insufficient colored pixels (${bestCount}px, min 300)` };
    }

    // Multi-row band analysis for contiguous bar
    const bandRows: number[] = [];
    for (let dy = -5; dy <= 5; dy++) {
      const y = bestRow + dy;
      if (y >= 0 && y < scanH) bandRows.push(y);
    }

    const colColorCount = new Uint8Array(W);
    for (const y of bandRows) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (isColoredPx(raw[i]!, raw[i + 1]!, raw[i + 2]!)) {
          colColorCount[x] = (colColorCount[x] ?? 0) + 1;
        }
      }
    }

    const minRows = Math.max(1, Math.floor(bandRows.length * 0.4));
    let barEnd = -1;
    let gap = 0;
    for (let x = 0; x < W; x++) {
      if ((colColorCount[x] ?? 0) >= minRows) {
        barEnd = x;
        gap = 0;
      } else if (barEnd >= 0) {
        gap++;
        if (gap > 10) break;
      }
    }

    const contiguousBarWidth = barEnd + 1;
    const contiguousBarRatio = contiguousBarWidth / W;

    if (contiguousBarRatio < 0.30) {
      return {
        valid: false,
        reason: `no contiguous colored bar (${(contiguousBarRatio * 100).toFixed(1)}%, need 30%)`,
      };
    }

    if (contiguousBarRatio > 0.70) {
      return {
        valid: false,
        reason: `colored area too wide (${(contiguousBarRatio * 100).toFixed(1)}%, max 70%)`,
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `validation error: ${String(err)}` };
  }
}

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
  const imagePath = trade.telegram.imagePath!; // guaranteed non-null by caller

  // Check file exists
  if (!fs.existsSync(imagePath)) {
    return { symbol: null, optionType: null, confidence: 0, method: null, skipped: true, skipReason: 'file missing' };
  }

  // Gate 1: Validate screenshot
  const validation = await validateScreenshot(imagePath);
  if (!validation.valid) {
    logger.info(`  Skipped (not a trade screenshot): ${validation.reason}`);
    return { symbol: null, optionType: null, confidence: 0, method: null, skipped: true, skipReason: validation.reason };
  }

  // Gate 2 & 3: Detect symbol (whitespace) and CE/PE (multi-strategy OCR) in parallel
  const [symbolScore, optionScore] = await Promise.all([
    detectByWhitespace(imagePath),
    detectOptionTypeByOcr(imagePath),
  ]);

  // Combine results
  const symbol = symbolScore.value;
  const optionType = optionScore.value;

  // Calculate overall confidence
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

  // Determine primary method
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

    // Safety: skip if imagePath is missing (DB schema issue)
    if (!imgPath) {
      console.log(`[${i + 1}/${trades.length}] SKIPPED: no imagePath in DB (msg ${trade.telegram.messageId})`);
      // Mark as analyzed so we don't keep retrying
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
        // Mark as analyzed with NULL results so we don't reprocess
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

  // Print summary
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