/**
 * Whitespace calibration script.
 *
 * Processes all labeled screenshots from the database, measures the
 * remaining whitespace feature, and produces:
 *
 *   1. CSV with per-image measurements   → downloads/whitespace-calibration.csv
 *   2. Console statistics (min/max/mean/median/stddev per class)
 *   3. Histogram PNG                     → downloads/whitespace-histogram.png
 *   4. Debug images per screenshot        → downloads/debug-whitespace/
 *   5. Calibration JSON                  → config/whitespace-calibration.json
 *
 * Usage:
 *   npm run calibrate
 *
 * The calibration JSON can then be loaded by detectSymbolByWhitespace.ts
 * for production classification.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import dotenv from 'dotenv';

import { measureWhitespace, type WhitespaceMeasurement } from '../analyzer/detectSymbolByWhitespace.js';
import type { WhitespaceCalibration, ClassDistribution } from '../analyzer/detectSymbolByWhitespace.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dbPath = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');
const outputDir = path.join(process.cwd(), 'downloads');
const debugDir = path.join(outputDir, 'debug-whitespace');
const csvPath = path.join(outputDir, 'whitespace-calibration.csv');
const histogramPath = path.join(outputDir, 'whitespace-histogram.png');
const calJsonPath = path.resolve(process.cwd(), 'config', 'whitespace-calibration.json');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  console.error('Run the main app first to download and analyze images.');
  process.exit(1);
}

const db = new Database(dbPath);

// Ensure output directories exist
fs.mkdirSync(debugDir, { recursive: true });
fs.mkdirSync(path.dirname(calJsonPath), { recursive: true });

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function computeStats(values: number[]): ClassDistribution {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, median: 0, stddev: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / values.length;

  const median =
    values.length % 2 === 0
      ? (sorted[values.length / 2 - 1]! + sorted[values.length / 2]!) / 2
      : sorted[Math.floor(values.length / 2)]!;

  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  return { min, max, mean, median, stddev };
}

function fmt(v: number, decimals = 4): string {
  return v.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

function writeCsv(measurements: Array<WhitespaceMeasurement & { label: string }>): void {
  const lines: string[] = [];
  lines.push(
    'filename,label,image_width,right_most_x,right_most_text,remaining_whitespace,remaining_whitespace_ratio',
  );

  for (const m of measurements) {
    const filename = path.basename(m.imagePath);
    lines.push(
      `${filename},${m.label},${m.imageWidth},${m.rightMostX},` +
        `"${m.rightMostWord?.text ?? ''}",` +
        `${m.remainingWhitespace},${fmt(m.remainingWhitespaceRatio)}`,
    );
  }

  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`\nCSV saved: ${csvPath}`);
}

// ---------------------------------------------------------------------------
// Histogram (SVG → PNG via sharp)
// ---------------------------------------------------------------------------

function buildHistogramSvg(
  niftyRatios: number[],
  bankniftyRatios: number[],
): string {
  const allValues = [...niftyRatios, ...bankniftyRatios];
  if (allValues.length === 0) return '';

  const dataMin = Math.min(...allValues);
  const dataMax = Math.max(...allValues);
  const pad = 0.015;
  const rangeMin = Math.max(0, dataMin - pad);
  const rangeMax = dataMax + pad;
  const rangeSpan = rangeMax - rangeMin;

  const BIN_WIDTH = 0.015;
  const numBins = Math.ceil(rangeSpan / BIN_WIDTH);

  // Build bin data
  interface Bin {
    start: number;
    end: number;
    nifty: number;
    banknifty: number;
  }
  const bins: Bin[] = [];
  for (let i = 0; i < numBins; i++) {
    const start = rangeMin + i * BIN_WIDTH;
    const end = start + BIN_WIDTH;
    bins.push({
      start,
      end,
      nifty: niftyRatios.filter((v) => v >= start && v < end).length,
      banknifty: bankniftyRatios.filter((v) => v >= start && v < end).length,
    });
  }

  const maxCount = Math.max(...bins.map((b) => Math.max(b.nifty, b.banknifty)), 1);

  // SVG layout
  const W = 820;
  const H = 460;
  const pL = 75;
  const pT = 55;
  const pR = W - 30;
  const pB = H - 70;
  const plotW = pR - pL;
  const plotH = pB - pT;

  // Helper: data X → pixel X
  function xPx(val: number): number {
    return pL + ((val - rangeMin) / rangeSpan) * plotW;
  }

  // Grid lines (horizontal)
  const yTicks = [0.25, 0.5, 0.75, 1.0];
  const gridLines = yTicks
    .map((f) => {
      const y = pB - f * plotH;
      const count = Math.round(f * maxCount);
      return (
        `<line x1="${pL}" y1="${y}" x2="${pR}" y2="${y}" stroke="#2a2a4a" stroke-width="1"/>` +
        `<text x="${pL - 8}" y="${y + 4}" text-anchor="end" fill="#888" font-size="11" font-family="sans-serif">${count}</text>`
      );
    })
    .join('\n');

  // Bars: side-by-side within each bin
  const bars = bins
    .map((bin) => {
      const x1 = xPx(bin.start);
      const x2 = xPx(bin.end);
      const groupW = x2 - x1;
      const barW = groupW / 2 - 1.5;
      const gap = 1.5;

      let svg = '';
      if (bin.nifty > 0) {
        const h = (bin.nifty / maxCount) * plotH;
        svg += `<rect x="${x1 + gap}" y="${pB - h}" width="${barW}" height="${h}" fill="#4fc3f7" opacity="0.85" rx="1"/>`;
        if (h > 14) {
          svg += `<text x="${x1 + gap + barW / 2}" y="${pB - h - 3}" text-anchor="middle" fill="#4fc3f7" font-size="9" font-family="sans-serif">${bin.nifty}</text>`;
        }
      }
      if (bin.banknifty > 0) {
        const h = (bin.banknifty / maxCount) * plotH;
        svg += `<rect x="${x1 + gap + barW + gap}" y="${pB - h}" width="${barW}" height="${h}" fill="#ff8a65" opacity="0.85" rx="1"/>`;
        if (h > 14) {
          svg += `<text x="${x1 + gap + barW + gap + barW / 2}" y="${pB - h - 3}" text-anchor="middle" fill="#ff8a65" font-size="9" font-family="sans-serif">${bin.banknifty}</text>`;
        }
      }
      return svg;
    })
    .join('\n');

  // X-axis tick labels
  const xTicks: string[] = [];
  for (let v = rangeMin; v <= rangeMax; v += 0.05) {
    const px = xPx(v);
    if (px >= pL && px <= pR) {
      xTicks.push(
        `<line x1="${px}" y1="${pB}" x2="${px}" y2="${pB + 5}" stroke="#666" stroke-width="1"/>` +
          `<text x="${px}" y="${pB + 18}" text-anchor="middle" fill="#888" font-size="10" font-family="sans-serif">${(v * 100).toFixed(1)}%</text>`,
      );
    }
  }

  // Legend
  const legendX = pR - 200;
  const legend = `
    <rect x="${legendX}" y="${pT - 10}" width="195" height="45" fill="rgba(15,15,35,0.85)" rx="4" stroke="#333" stroke-width="1"/>
    <rect x="${legendX + 10}" y="${pT - 2}" width="14" height="14" fill="#4fc3f7" rx="2"/>
    <text x="${legendX + 30}" y="${pT + 10}" fill="#ccc" font-size="12" font-family="sans-serif">NIFTY (n=${niftyRatios.length})</text>
    <rect x="${legendX + 10}" y="${pT + 18}" width="14" height="14" fill="#ff8a65" rx="2"/>
    <text x="${legendX + 30}" y="${pT + 30}" fill="#ccc" font-size="12" font-family="sans-serif">BANKNIFTY (n=${bankniftyRatios.length})</text>
  `;

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#0f0f23" rx="6"/>
  <text x="${(pL + pR) / 2}" y="32" text-anchor="middle" fill="#e0e0e0" font-size="16" font-weight="bold" font-family="sans-serif">
    Remaining Whitespace Ratio: NIFTY vs BANKNIFTY
  </text>
  ${gridLines}
  ${bars}
  ${xTicks.join('\n')}
  <line x1="${pL}" y1="${pB}" x2="${pR}" y2="${pB}" stroke="#666" stroke-width="1.5"/>
  <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pB}" stroke="#666" stroke-width="1.5"/>
  <text x="${(pL + pR) / 2}" y="${H - 18}" text-anchor="middle" fill="#aaa" font-size="13" font-family="sans-serif">Remaining Whitespace Ratio (image fraction)</text>
  <text x="18" y="${(pT + pB) / 2}" text-anchor="middle" fill="#aaa" font-size="13" font-family="sans-serif" transform="rotate(-90, 18, ${(pT + pB) / 2})">Count</text>
  ${legend}
</svg>`;
}

async function saveHistogram(niftyRatios: number[], bankniftyRatios: number[]): Promise<void> {
  if (niftyRatios.length === 0 && bankniftyRatios.length === 0) {
    console.log('No data for histogram');
    return;
  }

  const svg = buildHistogramSvg(niftyRatios, bankniftyRatios);
  if (!svg) return;

  await sharp(Buffer.from(svg)).png().toFile(histogramPath);
  console.log(`Histogram saved: ${histogramPath}`);
}

// ---------------------------------------------------------------------------
// Debug image per screenshot
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function saveDebugImage(m: WhitespaceMeasurement, predicted: string | null, confidence: number): Promise<void> {
  const meta = await sharp(m.imagePath).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const cropH = m.headerHeight;

  // Build SVG overlay for the full screenshot
  const svgParts: string[] = [];

  // Header region border
  svgParts.push(
    `<rect x="0" y="0" width="${W}" height="${cropH}" fill="none" stroke="#ffff00" stroke-width="2" stroke-dasharray="6,3"/>`,
  );

  // All OCR word boxes (green)
  for (const w of m.allWords) {
    const isRightMost = m.rightMostWord && w.x1 === m.rightMostWord.x1 && w.y0 === m.rightMostWord.y0;
    if (isRightMost) continue; // drawn separately
    svgParts.push(
      `<rect x="${w.x0}" y="${w.y0}" width="${w.x1 - w.x0}" height="${w.y1 - w.y0}" ` +
        `fill="none" stroke="#00ff00" stroke-width="2" opacity="0.8"/>`,
    );
  }

  // Right-most box (bright cyan, thick)
  if (m.rightMostWord) {
    const rw = m.rightMostWord;
    svgParts.push(
      `<rect x="${rw.x0}" y="${rw.y0}" width="${rw.x1 - rw.x0}" height="${rw.y1 - rw.y0}" ` +
        `fill="rgba(0,255,255,0.2)" stroke="#00ffff" stroke-width="3"/>`,
    );

    // Cyan dashed vertical line at rightMostX extending to bottom of header
    svgParts.push(
      `<line x1="${m.rightMostX}" y1="0" x2="${m.rightMostX}" y2="${cropH}" ` +
        `stroke="#00ffff" stroke-width="2" stroke-dasharray="4,3"/>`,
    );

    // Blue shaded whitespace region
    if (m.rightMostX < W) {
      svgParts.push(
        `<rect x="${m.rightMostX}" y="0" width="${W - m.rightMostX}" height="${cropH}" ` +
          `fill="rgba(66,133,244,0.15)" stroke="rgba(66,133,244,0.5)" stroke-width="1" stroke-dasharray="4"/>`,
      );
    }

    // Whitespace measurement annotation
    const midX = (m.rightMostX + W) / 2;
    const annY = cropH - 42;
    svgParts.push(
      `<text x="${midX}" y="${annY}" text-anchor="middle" fill="#00ffff" font-size="11" font-family="monospace">` +
        `${escapeXml(`← ${m.remainingWhitespace}px (${fmt(m.remainingWhitespaceRatio * 100, 1)}%) →`)}` +
        `</text>`,
    );
  }

  // Info bar at the bottom of the header
  const labelY = cropH - 5;
  const labelText = predicted
    ? `[v2-simple] ${predicted} (${confidence.toFixed(0)}%) | rightX=${m.rightMostX} | rightWord="${m.rightMostWord?.text ?? ''}" | words=${m.allWords.length}`
    : `[v2-simple] UNKNOWN | rightX=${m.rightMostX} | words=${m.allWords.length}`;

  svgParts.push(
    `<rect x="0" y="${labelY - 16}" width="${W}" height="22" fill="rgba(0,0,0,0.75)" rx="0"/>`,
    `<text x="8" y="${labelY}" fill="#ffffff" font-size="12" font-family="monospace">${escapeXml(labelText)}</text>`,
  );

  const svgBuffer = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('\n')}</svg>`,
  );

  const outPath = path.join(debugDir, `${path.basename(m.imagePath, path.extname(m.imagePath))}_debug.png`);
  await sharp(m.imagePath).composite([{ input: svgBuffer, top: 0, left: 0 }]).png().toFile(outPath);
}

// ---------------------------------------------------------------------------
// Main calibration flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Whitespace Calibration ===\n');
  console.log(`Database: ${dbPath}`);
  console.log(`Output:   ${outputDir}\n`);

  // Load all trades from DB
  const rows = db
    .prepare('SELECT id, image_path, symbol FROM trades ORDER BY telegram_message_time ASC')
    .all() as Array<Record<string, unknown>>;

  console.log(`Found ${rows.length} trades in database\n`);

  if (rows.length === 0) {
    console.log('No trades to calibrate. Exiting.');
    db.close();
    return;
  }

  // Measure whitespace for each image
  const measurements: Array<WhitespaceMeasurement & { label: string }> = [];
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const imagePath = row['image_path'] as string;
    const label = (row['symbol'] as string) ?? 'UNKNOWN';

    if (!fs.existsSync(imagePath)) {
      console.log(`[${i + 1}/${rows.length}] SKIP (file missing): ${imagePath}`);
      skipped++;
      continue;
    }

    try {
      const m = await measureWhitespace(imagePath);

      // Quick classification for debug image label
      let predicted: string | null = null;
      let confidence = 0;
      if (m.allWords.length > 0 && m.rightMostX > 0) {
        // Simple uncalibrated prediction for debug
        predicted = m.remainingWhitespaceRatio > 0.25 ? 'NIFTY' : 'BANKNIFTY';
        confidence = 65 + (Math.abs(m.remainingWhitespaceRatio - 0.25) / 0.25) * 25;
      }

      measurements.push({ ...m, label });

      // Save debug image
      await saveDebugImage(m, predicted, Math.min(confidence, 100));

      const matchIcon = predicted && predicted === label ? '✓' : predicted !== label ? '✗' : '?';
      console.log(
        `[${i + 1}/${rows.length}] ${matchIcon} ${path.basename(imagePath)} ` +
          `label=${label.padEnd(10)} pred=${(predicted ?? '---').padEnd(10)} ` +
          `ws=${String(m.remainingWhitespace).padStart(4)}px  ratio=${fmt(m.remainingWhitespaceRatio)} ` +
          `rightX=${m.rightMostX}  rightWord="${m.rightMostWord?.text ?? ''}"  words=${m.allWords.length}`,
      );
    } catch (err) {
      failed++;
      console.log(`[${i + 1}/${rows.length}] FAILED: ${imagePath} — ${err}`);
    }
  }

  console.log(`\nProcessed: ${measurements.length}, Skipped: ${skipped}, Failed: ${failed}\n`);

  // Separate by label
  const nifty = measurements.filter((m) => m.label === 'NIFTY');
  const banknifty = measurements.filter((m) => m.label === 'BANKNIFTY');
  const unknown = measurements.filter((m) => m.label === 'UNKNOWN');

  console.log(`NIFTY: ${nifty.length}, BANKNIFTY: ${banknifty.length}, UNKNOWN: ${unknown.length}\n`);

  // Compute statistics
  const niftyRatios = nifty.map((m) => m.remainingWhitespaceRatio);
  const bankniftyRatios = banknifty.map((m) => m.remainingWhitespaceRatio);

  const niftyStats = computeStats(niftyRatios);
  const bankniftyStats = computeStats(bankniftyRatios);

  // Print statistics
  if (niftyRatios.length > 0) {
    console.log('── NIFTY ──────────────────────────────');
    console.log(`  min:    ${fmt(niftyStats.min)}  (${(niftyStats.min * 100).toFixed(1)}%)`);
    console.log(`  max:    ${fmt(niftyStats.max)}  (${(niftyStats.max * 100).toFixed(1)}%)`);
    console.log(`  mean:   ${fmt(niftyStats.mean)}  (${(niftyStats.mean * 100).toFixed(1)}%)`);
    console.log(`  median: ${fmt(niftyStats.median)}  (${(niftyStats.median * 100).toFixed(1)}%)`);
    console.log(`  stddev: ${fmt(niftyStats.stddev)}  (${(niftyStats.stddev * 100).toFixed(1)}%)`);
    console.log('');
  } else {
    console.log('── NIFTY: no labeled samples ──\n');
  }

  if (bankniftyRatios.length > 0) {
    console.log('── BANKNIFTY ──────────────────────────');
    console.log(`  min:    ${fmt(bankniftyStats.min)}  (${(bankniftyStats.min * 100).toFixed(1)}%)`);
    console.log(`  max:    ${fmt(bankniftyStats.max)}  (${(bankniftyStats.max * 100).toFixed(1)}%)`);
    console.log(`  mean:   ${fmt(bankniftyStats.mean)}  (${(bankniftyStats.mean * 100).toFixed(1)}%)`);
    console.log(`  median: ${fmt(bankniftyStats.median)}  (${(bankniftyStats.median * 100).toFixed(1)}%)`);
    console.log(`  stddev: ${fmt(bankniftyStats.stddev)}  (${(bankniftyStats.stddev * 100).toFixed(1)}%)`);
    console.log('');
  } else {
    console.log('── BANKNIFTY: no labeled samples ──\n');
  }

  // Separation analysis
  if (niftyRatios.length > 0 && bankniftyRatios.length > 0) {
    const overlap =
      Math.max(niftyStats.min, bankniftyStats.min) < Math.min(niftyStats.max, bankniftyStats.max);
    const gap = bankniftyStats.mean - niftyStats.mean;
    const gapInStdDevs = gap / Math.sqrt(niftyStats.stddev ** 2 + bankniftyStats.stddev ** 2);

    console.log('── Separation Analysis ────────────────');
    console.log(`  NIFTY mean:     ${fmt(niftyStats.mean)}  (${(niftyStats.mean * 100).toFixed(1)}%)`);
    console.log(`  BANKNIFTY mean: ${fmt(bankniftyStats.mean)}  (${(bankniftyStats.mean * 100).toFixed(1)}%)`);
    console.log(`  Gap (B-N):      ${fmt(gap > 0 ? gap : -gap)}  (${(Math.abs(gap) * 100).toFixed(1)}%)`);
    console.log(`  Effect size:    ${fmt(gapInStdDevs)} std devs`);
    console.log(`  Overlap:        ${overlap ? 'YES — distributions overlap' : 'NO — distributions are separated'}`);
    console.log('');
  }

  // Write CSV
  writeCsv(measurements);

  // Save histogram
  await saveHistogram(niftyRatios, bankniftyRatios);

  // Save calibration JSON
  if (niftyRatios.length > 0 && bankniftyRatios.length > 0) {
    const calData: WhitespaceCalibration = {
      nifty: niftyStats,
      banknifty: bankniftyStats,
    };

    fs.writeFileSync(calJsonPath, JSON.stringify(calData, null, 2) + '\n');
    console.log(`Calibration saved: ${calJsonPath}`);
    console.log('\nThe whitespace classifier will auto-load this calibration on next run.');
  } else {
    console.log('\nCannot generate calibration — need both NIFTY and BANKNIFTY labeled samples.');
  }

  console.log(`\nDebug images: ${debugDir}/`);

  db.close();
}

main().catch((err) => {
  console.error('Calibration failed:', err);
  process.exit(1);
});