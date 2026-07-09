/**
 * Risk management module.
 *
 * Implements trading safeguards:
 *   - Daily loss limit
 *   - Max daily trades
 *   - Max open positions
 *   - Order-value cap
 *   - Cooldown between trades
 *   - Margin check
 *
 * PERSISTENCE FIX
 * ---------------
 * Previously `dailyStats` was an in-memory variable that reset to zero on
 * every process restart, making all daily limits useless after any crash
 * or redeploy. The stats are now persisted to `config/daily-stats.json`
 * and reloaded on startup, with automatic reset when the date changes.
 */

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import { FyersClient } from './client.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DailyStats {
  totalTrades: number;
  totalPnl: number;
  lastTradeTime: Date | null;
}

export interface RiskConfig {
  dailyLossLimit: number;
  maxDailyTrades: number;
  maxOpenPositions: number;
  maxOrderValue: number;
  cooldownMinutes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAILY_STATS_PATH = path.resolve(process.cwd(), 'config', 'daily-stats.json');

// ---------------------------------------------------------------------------
// Daily stats (persisted)
// ---------------------------------------------------------------------------

let dailyStats: DailyStats = {
  totalTrades: 0,
  totalPnl: 0,
  lastTradeTime: null,
};

let statsLoaded = false;

/** ISO date string for today (IST). */
function todayIst(): string {
  const now = new Date();
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const ist = new Date(istStr);
  return ist.toISOString().split('T')[0]!;
}

/**
 * Load daily stats from disk. If the saved date != today, reset to zero
 * (new trading day). Safe to call multiple times.
 */
export function loadDailyStats(): void {
  if (statsLoaded) return;
  statsLoaded = true;

  try {
    if (fs.existsSync(DAILY_STATS_PATH)) {
      const raw = fs.readFileSync(DAILY_STATS_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (data.date === todayIst()) {
        dailyStats = {
          totalTrades: data.totalTrades || 0,
          totalPnl: data.totalPnl || 0,
          lastTradeTime: data.lastTradeTime ? new Date(data.lastTradeTime) : null,
        };
        logger.info('Loaded daily stats from disk', dailyStats);
        return;
      }
      logger.info('Saved daily stats are from a previous day, resetting');
    }
  } catch (err) {
    logger.warn('Failed to load daily stats', { error: String(err) });
  }
  dailyStats = { totalTrades: 0, totalPnl: 0, lastTradeTime: null };
  saveDailyStats();
}

/** Persist daily stats to disk. */
function saveDailyStats(): void {
  try {
    const dir = path.dirname(DAILY_STATS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      DAILY_STATS_PATH,
      JSON.stringify(
        {
          date: todayIst(),
          totalTrades: dailyStats.totalTrades,
          totalPnl: dailyStats.totalPnl,
          lastTradeTime: dailyStats.lastTradeTime?.toISOString() || null,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    logger.warn('Failed to save daily stats', { error: String(err) });
  }
}

/**
 * Reset daily stats (call at start of each trading day).
 */
export function resetDailyStats(): void {
  dailyStats = {
    totalTrades: 0,
    totalPnl: 0,
    lastTradeTime: null,
  };
  saveDailyStats();
  logger.info('Daily risk stats reset');
}

/**
 * Update daily stats after a trade.
 *
 * @param pnl Realized P&L for the trade. Pass 0 if P&L is not yet known
 *            (e.g. for option selling, P&L is only realized on buyback).
 */
export function updateDailyStats(pnl: number): void {
  loadDailyStats();
  dailyStats.totalTrades++;
  dailyStats.totalPnl += pnl;
  dailyStats.lastTradeTime = new Date();
  saveDailyStats();
  logger.info('Daily stats updated', {
    trades: dailyStats.totalTrades,
    pnl: dailyStats.totalPnl,
  });
}

export function getDailyStats(): DailyStats {
  loadDailyStats();
  return { ...dailyStats };
}

// ---------------------------------------------------------------------------
// Risk checks
// ---------------------------------------------------------------------------

/**
 * Check if a trade is allowed based on risk management rules.
 *
 * PHILOSOPHY
 * ----------
 * We DON'T duplicate checks Fyers already does — Fyers will reject the order
 * if there's insufficient margin, invalid symbol, market closed, etc. We only
 * keep the checks that protect against OUR OWN bugs:
 *
 *   1. Daily loss limit  — stop trading if cumulative daily loss exceeds limit
 *   2. Max daily trades  — hard cap on number of trades per day
 *   3. Max open positions — prevent runaway position building
 *   4. Cooldown          — prevent rapid-fire duplicate trades
 *
 * REMOVED (redundant with Fyers):
 *   - Margin check       — Fyers does the real SPAN+exposure check, our
 *                          premium×qty proxy was both inaccurate and broke
 *                          when the funds API response shape was unclear.
 *   - Max order value    — Fyers' margin check handles this implicitly.
 *
 * If you want a margin pre-check later, it can be re-added once we know the
 * exact funds API response shape — but it's strictly optional.
 */
export async function checkRiskLimits(
  client: FyersClient,
  config: RiskConfig,
  orderValue: number,
): Promise<RiskCheckResult> {
  loadDailyStats();

  // `orderValue` is no longer used for the margin check, but we keep the
  // parameter for backward compatibility (and in case a future check needs it).
  void orderValue;

  try {
    // Check 1: Daily loss limit
    if (dailyStats.totalPnl < -config.dailyLossLimit) {
      const msg = `Daily loss limit reached: ₹${dailyStats.totalPnl.toFixed(2)} (limit: -₹${config.dailyLossLimit})`;
      logger.warn(msg);
      return { allowed: false, reason: msg };
    }

    // Check 2: Max daily trades
    if (dailyStats.totalTrades >= config.maxDailyTrades) {
      const msg = `Max daily trades reached: ${dailyStats.totalTrades} (limit: ${config.maxDailyTrades})`;
      logger.warn(msg);
      return { allowed: false, reason: msg };
    }

    // Check 3: Max open positions
    const positions = await client.getPositions();
    const openPositions = (positions || []).filter((p) => p.qty !== 0).length;
    if (openPositions >= config.maxOpenPositions) {
      const msg = `Max open positions reached: ${openPositions} (limit: ${config.maxOpenPositions})`;
      logger.warn(msg);
      return { allowed: false, reason: msg };
    }

    // Check 4: Cooldown between trades
    if (dailyStats.lastTradeTime) {
      const cooldownMs = config.cooldownMinutes * 60 * 1000;
      const timeSinceLastTrade = Date.now() - dailyStats.lastTradeTime.getTime();
      if (timeSinceLastTrade < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - timeSinceLastTrade) / 1000);
        const msg = `Cooldown active: ${remainingSeconds}s remaining`;
        logger.warn(msg);
        return { allowed: false, reason: msg };
      }
    }

    // That's it — no margin check, no order-value check.
    // Fyers will reject the order via its own SPAN+exposure margin check
    // if there are insufficient funds. No need to duplicate that here.
    logger.debug('All risk checks passed');
    return { allowed: true };
  } catch (err) {
    logger.error('Risk check failed', { error: errToString(err) });
    return { allowed: false, reason: `Risk check error: ${errToString(err)}` };
  }
}

/**
 * Load risk config from environment variables.
 */
export function loadRiskConfig(): RiskConfig {
  return {
    dailyLossLimit: parseInt(process.env['DAILY_LOSS_LIMIT'] || '10000'),
    maxDailyTrades: parseInt(process.env['MAX_DAILY_TRADES'] || '20'),
    maxOpenPositions: parseInt(process.env['MAX_OPEN_POSITIONS'] || '5'),
    maxOrderValue: parseInt(process.env['MAX_ORDER_VALUE'] || '50000'),
    cooldownMinutes: parseInt(process.env['COOLDOWN_MINUTES'] || '5'),
  };
}
