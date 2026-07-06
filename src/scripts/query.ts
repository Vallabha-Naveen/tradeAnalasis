/**
 * Quick query script for inspecting trades in the database.
 *
 * Usage:
 *   npx ts-node src/scripts/query.ts                 # summary
 *   npx ts-node src/scripts/query.ts review          # trades needing review
 *   npx ts-node src/scripts/query.ts csv             # export to CSV
 *   npx ts-node src/scripts/query.ts recent 20       # last N trades
 *   npx ts-node src/scripts/query.ts date 2025-06-01 # trades from a date
 *
 * Or after build:
 *   node dist/scripts/query.js review
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'database', 'trades.db');

if (!fs.existsSync(dbPath)) {
  console.error('No database found at', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const args = process.argv.slice(2);
const command = args[0] ?? 'summary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printRow(r: Record<string, string | number>, cols: string[]) {
  console.log(
    cols.map((c) => String(r[c] ?? '').padEnd(20)).join(' | '),
  );
}

function printDivider(cols: string[]) {
  console.log(cols.map(() => '-'.repeat(20)).join('-+-'));
}

function fmtDate(iso: string): string {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function summary() {
  const total = db.prepare('SELECT COUNT(*) as n FROM trades').get() as { n: number };
  const review = db.prepare('SELECT COUNT(*) as n FROM trades WHERE confidence < 70').get() as { n: number };
  const avgConf = db.prepare('SELECT ROUND(AVG(confidence),1) as a FROM trades').get() as { a: number };

  const bySymbol = db
    .prepare('SELECT symbol, COUNT(*) as cnt, ROUND(AVG(confidence),1) as avg_conf FROM trades GROUP BY symbol')
    .all() as { symbol: string; cnt: number; avg_conf: number }[];

  const byOption = db
    .prepare('SELECT option_type, COUNT(*) as cnt FROM trades GROUP BY option_type')
    .all() as { option_type: string; cnt: number }[];

  const byMethod = db
    .prepare('SELECT detection_method, COUNT(*) as cnt FROM trades GROUP BY detection_method ORDER BY cnt DESC')
    .all() as { detection_method: string; cnt: number }[];

  const dateRange = db
    .prepare('SELECT MIN(telegram_message_time) as earliest, MAX(telegram_message_time) as latest FROM trades')
    .get() as { earliest: string; latest: string };

  console.log('\n========================================');
  console.log('      TRADE DATABASE SUMMARY           ');
  console.log('========================================');
  console.log(`  Total trades:          ${total.n}`);
  console.log(`  Needs review (<70%):   ${review.n}`);
  console.log(`  Avg confidence:        ${avgConf.a}%`);
  console.log(`  Date range:            ${fmtDate(dateRange.earliest)} -> ${fmtDate(dateRange.latest)}`);

  console.log('\n  By Symbol:');
  for (const r of bySymbol) {
    console.log(`    ${(r.symbol ?? 'NULL').padEnd(14)} ${String(r.cnt).padStart(5)} trades  (avg conf: ${r.avg_conf}%)`);
  }

  console.log('\n  By Option Type:');
  for (const r of byOption) {
    console.log(`    ${(r.option_type ?? 'NULL').padEnd(14)} ${String(r.cnt).padStart(5)} trades`);
  }

  console.log('\n  By Detection Method:');
  for (const r of byMethod) {
    console.log(`    ${(r.detection_method ?? 'NULL').padEnd(20)} ${String(r.cnt).padStart(5)}`);
  }
  console.log('');
}

function review() {
  const reviewCount = (db.prepare('SELECT COUNT(*) as n FROM trades WHERE confidence < 70').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT id, telegram_message_id, telegram_message_time, symbol, option_type,
              confidence, detection_method, image_path
       FROM trades WHERE confidence < 70
       ORDER BY confidence ASC LIMIT 50`,
    )
    .all() as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log('No trades need review.');
    return;
  }

  console.log(`\nShowing ${rows.length} lowest-confidence trades (of ${reviewCount} total)\n`);

  const cols = ['id', 'msg_id', 'time', 'symbol', 'opt', 'conf%', 'method'];
  printDivider(cols);
  printRow(
    { id: 'ID', msg_id: 'MSG#', time: 'TIME', symbol: 'SYMBOL', opt: 'TYPE', 'conf%': 'CONF', method: 'METHOD' },
    cols,
  );
  printDivider(cols);

  for (const r of rows) {
    printRow(
      {
        id: r.id as number,
        msg_id: r.telegram_message_id as number,
        time: fmtDate(r.telegram_message_time as string).slice(5, 16),
        symbol: (r.symbol as string) ?? '?',
        opt: (r.option_type as string) ?? '?',
        'conf%': r.confidence as number,
        method: (r.detection_method as string) ?? '?',
      },
      cols,
    );
  }
  console.log('');
}

function recent() {
  const n = Math.min(Number(args[1]) || 20, 200);
  const rows = db
    .prepare(
      `SELECT id, telegram_message_id, telegram_message_time, symbol, option_type,
              confidence, detection_method
       FROM trades ORDER BY telegram_message_time DESC LIMIT ?`,
    )
    .all(n) as Record<string, unknown>[];

  const cols = ['id', 'msg_id', 'time', 'symbol', 'opt', 'conf%', 'method'];
  printDivider(cols);
  printRow(
    { id: 'ID', msg_id: 'MSG#', time: 'TIME', symbol: 'SYMBOL', opt: 'TYPE', 'conf%': 'CONF', method: 'METHOD' },
    cols,
  );
  printDivider(cols);

  for (const r of rows) {
    printRow(
      {
        id: r.id as number,
        msg_id: r.telegram_message_id as number,
        time: fmtDate(r.telegram_message_time as string).slice(5, 16),
        symbol: (r.symbol as string) ?? '?',
        opt: (r.option_type as string) ?? '?',
        'conf%': r.confidence as number,
        method: (r.detection_method as string) ?? '?',
      },
      cols,
    );
  }
  console.log(`\nShowing ${rows.length} most recent trades.\n`);
}

function byDate() {
  const dateStr = args[1];
  if (!dateStr) {
    console.log('Usage: npx ts-node src/scripts/query.ts date 2025-06-01');
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT id, telegram_message_id, telegram_message_time, symbol, option_type, confidence
       FROM trades WHERE date(telegram_message_time) = ?
       ORDER BY telegram_message_time ASC`,
    )
    .all(dateStr) as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log(`No trades found on ${dateStr}`);
    return;
  }

  console.log(`\n${rows.length} trades on ${dateStr}\n`);
  const cols = ['id', 'msg_id', 'time', 'symbol', 'opt', 'conf%'];
  printDivider(cols);
  printRow(
    { id: 'ID', msg_id: 'MSG#', time: 'TIME', symbol: 'SYMBOL', opt: 'TYPE', 'conf%': 'CONF' },
    cols,
  );
  printDivider(cols);

  for (const r of rows) {
    printRow(
      {
        id: r.id as number,
        msg_id: r.telegram_message_id as number,
        time: fmtDate(r.telegram_message_time as string).slice(11, 19),
        symbol: (r.symbol as string) ?? '?',
        opt: (r.option_type as string) ?? '?',
        'conf%': r.confidence as number,
      },
      cols,
    );
  }
  console.log('');
}

function csv() {
  const rows = db
    .prepare(
      `SELECT id, telegram_message_id, telegram_channel_id, telegram_message_time,
              symbol, option_type, confidence, detection_method, image_path, caption,
              processed_at, inserted_at, parser_version
       FROM trades ORDER BY telegram_message_time ASC`,
    )
    .all() as Record<string, unknown>[];

  const headers = [
    'id', 'message_id', 'channel_id', 'message_time', 'symbol', 'option_type',
    'confidence', 'detection_method', 'image_path', 'caption', 'processed_at',
    'inserted_at', 'parser_version',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    const row = [
      r.id, r.telegram_message_id, r.telegram_channel_id, r.telegram_message_time,
      r.symbol ?? '', r.option_type ?? '', r.confidence, r.detection_method ?? '',
      `"${String(r.image_path).replace(/"/g, '""')}"`,
      `"${String(r.caption).replace(/"/g, '""')}"`,
      r.processed_at, r.inserted_at, r.parser_version,
    ];
    lines.push(row.join(','));
  }

  const outPath = path.join(process.cwd(), 'downloads', 'trades_export.csv');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`Exported ${rows.length} trades to ${outPath}`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

switch (command) {
  case 'summary':
    summary();
    break;
  case 'review':
    review();
    break;
  case 'recent':
    recent();
    break;
  case 'date':
    byDate();
    break;
  case 'csv':
    csv();
    break;
  default:
    console.log('Available commands: summary, review, recent [N], date YYYY-MM-DD, csv');
}

db.close();