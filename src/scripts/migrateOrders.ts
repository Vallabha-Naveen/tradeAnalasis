/**
 * Migration script to add orders and daily_stats tables.
 *
 * Run this after updating schema.ts to add the new tables.
 * Usage: npm run migrate-orders
 */

import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env['DATABASE_PATH'] ?? path.join(process.cwd(), 'database', 'trades.db');

const ORDER_MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS orders (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Link to trade signal
      telegram_message_id   INTEGER NOT NULL,
      telegram_channel_id   TEXT NOT NULL,

      -- Order details
      fyers_order_id        TEXT,
      symbol                TEXT NOT NULL,
      option_type           TEXT NOT NULL,
      strike                REAL NOT NULL,
      quantity              INTEGER NOT NULL,
      side                  TEXT NOT NULL,  -- BUY/SELL
      order_type            TEXT NOT NULL,  -- MARKET/LIMIT
      limit_price           REAL DEFAULT NULL,

      -- Execution details
      status                TEXT NOT NULL,  -- PENDING/FILLED/CANCELLED/REJECTED
      filled_quantity       INTEGER DEFAULT 0,
      filled_price          REAL DEFAULT NULL,
      rejection_reason      TEXT DEFAULT NULL,

      -- Risk management
      order_value           REAL NOT NULL,
      dry_run               BOOLEAN NOT NULL DEFAULT 0,

      -- Timestamps
      placed_at             TEXT NOT NULL,   -- ISO 8601
      updated_at            TEXT NOT NULL,   -- ISO 8601
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_orders_message
      ON orders (telegram_channel_id, telegram_message_id);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_orders_fyers_id
      ON orders (fyers_order_id);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_orders_status
      ON orders (status);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_orders_placed_at
      ON orders (placed_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS daily_stats (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      date                  TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
      total_trades          INTEGER NOT NULL DEFAULT 0,
      total_pnl             REAL NOT NULL DEFAULT 0,
      max_drawdown          REAL NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_daily_stats_date
      ON daily_stats (date);
  `,
];

function main(): void {
  console.log('Running order tables migration...\n');
  console.log(`Database: ${dbPath}\n`);

  const db = new Database(dbPath);

  try {
    for (const sql of ORDER_MIGRATIONS) {
      db.exec(sql);
    }

    console.log('Migration completed successfully!');
    console.log('Added tables: orders, daily_stats');
    console.log('Added indexes: idx_orders_message, idx_orders_fyers_id, idx_orders_status, idx_orders_placed_at, idx_daily_stats_date');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
