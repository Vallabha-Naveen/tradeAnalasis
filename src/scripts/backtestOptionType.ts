/**
 * Backtest: option-type (CE/PE) detection accuracy — dual-detector mode.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * Runs TWO detectors on every image in your `downloads/raw/` folder:
 *
 *   1. OCR detector (the existing pipeline from detectOptionType.ts)
 *   2. VLM detector (NEW — uses ZAI Vision LLM via detectOptionTypeVLM.ts)
 *
 * Outputs a CSV with both predictions side-by-side for manual review:
 *   filename, ocr_detected, ocr_confidence, vlm_detected, vlm_confidence,
 *   vlm_text_seen, vlm_reasoning, agree, valid, duration_ms
 *
 * Since you don't have ground-truth labels yet, this script does NOT
 * compute accuracy. Instead, it shows where the two detectors agree
 * (high trust) and disagree (needs your manual review).
 *
 * USAGE
 * -----
 *   # Run both detectors on all images in downloads/raw:
 *   npx ts-node src/scripts/backtestOptionType.ts
 *
 *   # OCR only (skip VLM — useful if you don't have ZAI SDK installed):
 *   npx ts-node src/scripts/backtestOptionType.ts --ocr-only
 *
 *   # VLM only (skip OCR — faster, just see VLM predictions):
 *   npx ts-node src/scripts/backtestOptionType.ts --vlm-only
 *
 *   # Limit to first 50 images (quick smoke test):
 *   npx ts-node src/scripts/backtestOptionType.ts --limit 50
 *
 *   # Custom directory + output path:
 *   npx ts-node src/scripts/backtestOptionType.ts --dir /path/to/images --output results.csv
 *
 * OUTPUT
 * ------
 *   - Console: progress + agreement summary
 *   - CSV file (default: backtest-option-type-results.csv) with per-image details
 *
 * This script does NOT touch the database, does NOT place orders, and does
 * NOT require Fyers authentication. It is purely offline.
 *
 * If --label-mode filename or --truth labels.csv is provided, the script
 * ALSO computes accuracy for each detector and shows a confusion matrix.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { validateScreenshot } from '../analyzer/validateScreenshot.js';
import { ocrHeaderOnce } from '../analyzer/unifiedHeaderOcr.js';
import {
  detectOptionTypeFromHeaderOcr,
  detectOptionTypeByOcr,
} from '../analyzer/detectOptionType.js';
import { detectOptionTypeByVlm, checkVlmAvailability } from '../analyzer/detectOptionTypeVLM.js';

dotenv.config();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  dir: string;
  truthCsv: string | null;
  labelMode: 'filename' | 'csv' | 'none';
  limit: number | null;
  outputPath: string;
  ocrOnly: boolean;
  vlmOnly: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
  };

  const dir = get('--dir') || process.env['DOWNLOAD_DIRECTORY'] || path.join(process.cwd(), 'downloads', 'raw');
  const truthCsv = get('--truth');
  const labelMode = (get('--label-mode') as 'filename' | 'csv' | 'none') || (truthCsv ? 'csv' : 'none');
  const limitStr = get('--limit');
  const limit = limitStr ? parseInt(limitStr) : null;
  const outputPath = get('--output') || path.join(process.cwd(), 'backtest-option-type-results.csv');
  const ocrOnly = args.includes('--ocr-only');
  const vlmOnly = args.includes('--vlm-only');

  return { dir, truthCsv, labelMode, limit, outputPath, ocrOnly, vlmOnly };
}

// ---------------------------------------------------------------------------
// Ground-truth loading (optional — only if user provides labels)
// ---------------------------------------------------------------------------

function loadTruthCsv(csvPath: string): Map<string, 'CE' | 'PE'> {
  const map = new Map<string, 'CE' | 'PE'>();
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const startIdx = lines[0]?.toLowerCase().includes('filename') ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i]!.split(',');
    if (parts.length < 2) continue;
    const filename = parts[0]!.trim();
    const label = parts[1]!.trim().toUpperCase();
    if (label === 'CE' || label === 'PE') {
      map.set(filename, label);
    }
  }
  console.log(`Loaded ${map.size} ground-truth labels from ${csvPath}`);
  return map;
}

function extractLabelFromFilename(filename: string): 'CE' | 'PE' | null {
  const base = path.basename(filename, path.extname(filename));
  const upper = base.toUpperCase();
  if (/(^|[_\-])CE$/.test(upper)) return 'CE';
  if (/(^|[_\-])PE$/.test(upper)) return 'PE';
  return null;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

interface OcrDetection {
  detected: 'CE' | 'PE' | 'UNKNOWN';
  confidence: number;
  method: string;
  ocrText: string;
}

interface VlmDetection {
  detected: 'CE' | 'PE' | 'UNKNOWN';
  confidence: number;
  textSeen: string;
  reasoning: string;
  skipped: boolean;
  skipReason: string;
}

async function detectWithOcr(imagePath: string): Promise<OcrDetection> {
  const validation = await validateScreenshot(imagePath);
  if (!validation.valid) {
    return {
      detected: 'UNKNOWN',
      confidence: 0,
      method: 'skipped',
      ocrText: '',
    };
  }

  try {
    const ocrResult = await ocrHeaderOnce(imagePath);
    const ocrText = ocrResult.fullText.slice(0, 120);

    let optionScore = detectOptionTypeFromHeaderOcr(ocrResult);
    if (!optionScore.value) {
      optionScore = await detectOptionTypeByOcr(imagePath);
    }

    return {
      detected: (optionScore.value as 'CE' | 'PE') || 'UNKNOWN',
      confidence: optionScore.confidence,
      method: optionScore.method,
      ocrText,
    };
  } catch (err) {
    return {
      detected: 'UNKNOWN',
      confidence: 0,
      method: 'error',
      ocrText: String(err),
    };
  }
}

async function detectWithVlm(imagePath: string): Promise<VlmDetection> {
  try {
    const result = await detectOptionTypeByVlm(imagePath);
    return {
      detected: (result.value as 'CE' | 'PE') || 'UNKNOWN',
      confidence: result.confidence,
      textSeen: (result as any).textSeen || '',
      reasoning: (result as any).reasoning || '',
      skipped: false,
      skipReason: '',
    };
  } catch (err) {
    return {
      detected: 'UNKNOWN',
      confidence: 0,
      textSeen: '',
      reasoning: '',
      skipped: true,
      skipReason: String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

interface DetectionRow {
  filename: string;
  valid: boolean;
  skipReason: string;
  ocrDetected: 'CE' | 'PE' | 'UNKNOWN';
  ocrConfidence: number;
  ocrMethod: string;
  ocrText: string;
  vlmDetected: 'CE' | 'PE' | 'UNKNOWN';
  vlmConfidence: number;
  vlmTextSeen: string;
  vlmReasoning: string;
  vlmSkipped: boolean;
  agree: boolean | null; // null if either is UNKNOWN
  truth: 'CE' | 'PE' | null;
  ocrCorrect: boolean | null;
  vlmCorrect: boolean | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface Stats {
  total: number;
  valid: number;
  skipped: number;
  ocrDetected: number;
  ocrUnknown: number;
  vlmDetected: number;
  vlmUnknown: number;
  vlmSkipped: number;
  bothAgree: number;
  bothDisagree: number;
  eitherUnknown: number;
  withTruth: number;
  ocrCorrect: number;
  vlmCorrect: number;
  // When the two detectors disagree, who was right? (only if truth provided)
  ocrRightVlmWrong: number;
  vlmRightOcrWrong: number;
  bothWrong: number;
}

function newStats(): Stats {
  return {
    total: 0,
    valid: 0,
    skipped: 0,
    ocrDetected: 0,
    ocrUnknown: 0,
    vlmDetected: 0,
    vlmUnknown: 0,
    vlmSkipped: 0,
    bothAgree: 0,
    bothDisagree: 0,
    eitherUnknown: 0,
    withTruth: 0,
    ocrCorrect: 0,
    vlmCorrect: 0,
    ocrRightVlmWrong: 0,
    vlmRightOcrWrong: 0,
    bothWrong: 0,
  };
}

function updateStats(stats: Stats, row: DetectionRow): void {
  stats.total++;
  if (!row.valid) {
    stats.skipped++;
    return;
  }
  stats.valid++;

  if (row.ocrDetected !== 'UNKNOWN') stats.ocrDetected++;
  else stats.ocrUnknown++;

  if (row.vlmSkipped) stats.vlmSkipped++;
  else if (row.vlmDetected !== 'UNKNOWN') stats.vlmDetected++;
  else stats.vlmUnknown++;

  // Agreement
  if (row.ocrDetected === 'UNKNOWN' || row.vlmDetected === 'UNKNOWN') {
    stats.eitherUnknown++;
  } else if (row.ocrDetected === row.vlmDetected) {
    stats.bothAgree++;
  } else {
    stats.bothDisagree++;
  }

  // Accuracy (only if truth provided)
  if (row.truth === null) return;
  stats.withTruth++;

  const ocrCorrect = row.ocrDetected === row.truth;
  const vlmCorrect = row.vlmDetected === row.truth;

  if (ocrCorrect) stats.ocrCorrect++;
  if (vlmCorrect) stats.vlmCorrect++;

  // When they disagreed
  if (ocrCorrect && !vlmCorrect) stats.ocrRightVlmWrong++;
  if (vlmCorrect && !ocrCorrect) stats.vlmRightOcrWrong++;
  if (!ocrCorrect && !vlmCorrect) stats.bothWrong++;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function printReport(stats: Stats): void {
  console.log('\n========== BACKTEST SUMMARY ==========');
  console.log(`Total images:           ${stats.total}`);
  console.log(`Valid screenshots:      ${stats.valid}`);
  console.log(`Skipped (invalid):      ${stats.skipped}`);
  console.log('');
  console.log('OCR detector:');
  console.log(`  Detected (CE/PE):     ${stats.ocrDetected}`);
  console.log(`  Unknown:              ${stats.ocrUnknown}`);
  console.log('');
  console.log('VLM detector:');
  console.log(`  Detected (CE/PE):     ${stats.vlmDetected}`);
  console.log(`  Unknown:              ${stats.vlmUnknown}`);
  console.log(`  Skipped (errors):     ${stats.vlmSkipped}`);
  console.log('');
  console.log('Detector agreement (on valid images):');
  console.log(`  Both agree:           ${stats.bothAgree}`);
  console.log(`  Disagree:             ${stats.bothDisagree}`);
  console.log(`  Either unknown:       ${stats.eitherUnknown}`);

  if (stats.withTruth > 0) {
    const ocrAcc = ((stats.ocrCorrect / stats.withTruth) * 100).toFixed(1);
    const vlmAcc = ((stats.vlmCorrect / stats.withTruth) * 100).toFixed(1);
    console.log('');
    console.log('===== ACCURACY (with ground truth) =====');
    console.log(`  OCR accuracy:         ${ocrAcc}%  (${stats.ocrCorrect}/${stats.withTruth})`);
    console.log(`  VLM accuracy:         ${vlmAcc}%  (${stats.vlmCorrect}/${stats.withTruth})`);
    console.log('');
    console.log('When the two detectors disagreed:');
    console.log(`  OCR right, VLM wrong: ${stats.ocrRightVlmWrong}`);
    console.log(`  VLM right, OCR wrong: ${stats.vlmRightOcrWrong}`);
    console.log(`  Both wrong:           ${stats.bothWrong}`);
  } else {
    console.log('');
    console.log('No ground truth provided.');
    console.log('Review the CSV file — focus on rows where detectors DISAGREE.');
    console.log('Once you label those rows, re-run with --truth labels.csv for accuracy.');
  }
  console.log('======================================');
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

function writeCsv(rows: DetectionRow[], outputPath: string): void {
  const header = [
    'filename',
    'valid',
    'skipReason',
    'ocrDetected',
    'ocrConfidence',
    'ocrMethod',
    'ocrText',
    'vlmDetected',
    'vlmConfidence',
    'vlmTextSeen',
    'vlmReasoning',
    'vlmSkipped',
    'agree',
    'truth',
    'ocrCorrect',
    'vlmCorrect',
    'durationMs',
  ].join(',');

  const lines = rows.map((r) =>
    [
      r.filename,
      r.valid,
      `"${r.skipReason.replace(/"/g, '""')}"`,
      r.ocrDetected,
      r.ocrConfidence,
      r.ocrMethod,
      `"${r.ocrText.replace(/"/g, '""')}"`,
      r.vlmDetected,
      r.vlmConfidence,
      `"${r.vlmTextSeen.replace(/"/g, '""')}"`,
      `"${r.vlmReasoning.replace(/"/g, '""')}"`,
      r.vlmSkipped,
      r.agree === null ? '' : r.agree,
      r.truth || '',
      r.ocrCorrect === null ? '' : r.ocrCorrect,
      r.vlmCorrect === null ? '' : r.vlmCorrect,
      r.durationMs,
    ].join(','),
  );

  fs.writeFileSync(outputPath, [header, ...lines].join('\n'));
  console.log(`\nResults written to: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backtest: Option-Type Detection (Dual Detector) ===\n');
  console.log(`Image dir:    ${args.dir}`);
  console.log(`Label mode:   ${args.labelMode}`);
  console.log(`Truth CSV:    ${args.truthCsv || '(none)'}`);
  console.log(`Limit:        ${args.limit ?? 'no limit'}`);
  console.log(`Output CSV:   ${args.outputPath}`);
  console.log(`OCR detector: ${args.vlmOnly ? 'DISABLED' : 'ENABLED'}`);
  console.log(`VLM detector: ${args.ocrOnly ? 'DISABLED' : 'ENABLED'}`);
  console.log();

  if (args.ocrOnly && args.vlmOnly) {
    console.error('ERROR: --ocr-only and --vlm-only are mutually exclusive');
    process.exit(1);
  }

  if (!fs.existsSync(args.dir)) {
    console.error(`ERROR: Directory not found: ${args.dir}`);
    process.exit(1);
  }

  // Check VLM availability (unless user disabled it)
  let vlmAvailable = false;
  if (!args.ocrOnly) {
    console.log('Checking ZAI Vision SDK availability...');
    const vlmCheck = await checkVlmAvailability();
    vlmAvailable = vlmCheck.available;
    if (!vlmAvailable) {
      console.warn('⚠️  VLM detector is NOT available:');
      console.warn('');
      // Indent each line of the reason for readability
      const reason = vlmCheck.reason || 'Unknown reason';
      for (const line of reason.split('\n')) {
        console.warn('    ' + line);
      }
      console.warn('');
      console.warn('    Continuing with OCR-only mode. VLM column will show SKIP.');
      console.warn('');
    } else {
      console.log('✓ ZAI Vision SDK available and configured.\n');
    }
  }
  const runVlm = !args.ocrOnly && vlmAvailable;
  const runOcr = !args.vlmOnly;

  // Ground truth (optional)
  let truthMap: Map<string, 'CE' | 'PE'> = new Map();
  if (args.labelMode === 'csv' && args.truthCsv) {
    truthMap = loadTruthCsv(args.truthCsv);
  }

  // List images
  const allFiles = fs
    .readdirSync(args.dir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
  const files = args.limit ? allFiles.slice(0, args.limit) : allFiles;
  console.log(`Found ${allFiles.length} images, processing ${files.length}\n`);

  const rows: DetectionRow[] = [];
  const stats = newStats();

  for (let i = 0; i < files.length; i++) {
    const filename = files[i]!;
    const fullPath = path.join(args.dir, filename);
    const progress = `[${i + 1}/${files.length}] ${filename}`;
    process.stdout.write(`${progress} ... `);

    const start = Date.now();

    // Truth (optional)
    let truth: 'CE' | 'PE' | null = null;
    if (args.labelMode === 'filename') {
      truth = extractLabelFromFilename(filename);
    } else if (args.labelMode === 'csv') {
      truth = truthMap.get(filename) || null;
    }

    // Validate screenshot (skip detectors if invalid — saves time + API calls)
    const validation = await validateScreenshot(fullPath);
    if (!validation.valid) {
      const durationMs = Date.now() - start;
      const row: DetectionRow = {
        filename,
        valid: false,
        skipReason: validation.reason || 'validation failed',
        ocrDetected: 'UNKNOWN',
        ocrConfidence: 0,
        ocrMethod: 'skipped',
        ocrText: '',
        vlmDetected: 'UNKNOWN',
        vlmConfidence: 0,
        vlmTextSeen: '',
        vlmReasoning: '',
        vlmSkipped: true,
        agree: null,
        truth,
        ocrCorrect: null,
        vlmCorrect: null,
        durationMs,
      };
      rows.push(row);
      updateStats(stats, row);
      console.log(`SKIP (${validation.reason}) ${durationMs}ms`);
      continue;
    }

    // Run detectors
    const ocrPromise = runOcr
      ? detectWithOcr(fullPath)
      : Promise.resolve<OcrDetection>({
          detected: 'UNKNOWN',
          confidence: 0,
          method: 'disabled',
          ocrText: '',
        });

    const vlmPromise = runVlm
      ? detectWithVlm(fullPath)
      : Promise.resolve<VlmDetection>({
          detected: 'UNKNOWN',
          confidence: 0,
          textSeen: '',
          reasoning: '',
          skipped: true,
          skipReason: 'disabled',
        });

    const [ocr, vlm] = await Promise.all([ocrPromise, vlmPromise]);
    const durationMs = Date.now() - start;

    // Agreement
    let agree: boolean | null;
    if (ocr.detected === 'UNKNOWN' || vlm.detected === 'UNKNOWN') {
      agree = null;
    } else {
      agree = ocr.detected === vlm.detected;
    }

    const row: DetectionRow = {
      filename,
      valid: true,
      skipReason: '',
      ocrDetected: ocr.detected,
      ocrConfidence: ocr.confidence,
      ocrMethod: ocr.method,
      ocrText: ocr.ocrText,
      vlmDetected: vlm.detected,
      vlmConfidence: vlm.confidence,
      vlmTextSeen: vlm.textSeen,
      vlmReasoning: vlm.reasoning,
      vlmSkipped: vlm.skipped,
      agree,
      truth,
      ocrCorrect:
        truth !== null && ocr.detected !== 'UNKNOWN' ? ocr.detected === truth : null,
      vlmCorrect:
        truth !== null && vlm.detected !== 'UNKNOWN' ? vlm.detected === truth : null,
      durationMs,
    };

    rows.push(row);
    updateStats(stats, row);

    // Progress line
    const ocrTag = `OCR=${ocr.detected}(${ocr.confidence}%)`;
    const vlmTag = vlm.skipped
      ? `VLM=SKIP`
      : `VLM=${vlm.detected}(${vlm.confidence}%)`;
    const agreeTag =
      agree === null ? '' : agree === true ? ' AGREE✓' : ' DISAGREE✗';
    console.log(`${ocrTag} ${vlmTag}${agreeTag} ${durationMs}ms`);
  }

  printReport(stats);
  writeCsv(rows, args.outputPath);
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
