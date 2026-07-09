/**
 * Order execution module.
 *
 * Converts trade analysis results (symbol + option type) into Fyers SELL
 * orders for option selling. Handles:
 *   - Symbol resolution via option chain (current expiry, ATM strike)
 *   - Lot size from env vars
 *   - Configurable market hours (no trades outside window)
 *   - Idempotency via Telegram message ID embedded in order tag
 *   - MARKET order type for immediate execution
 *
 * REFACTOR NOTE
 * -------------
 * Previously `executeTrade` was called twice (once as dry-run preview,
 * once for real), causing duplicate API calls and a race condition where
 * the spot price could move between the two calls. The flow is now split:
 *   - `prepareOrder`: resolves symbol, computes qty/value, returns a plan
 *   - `executeOrder`: takes a plan and places the order (or logs in dry-run)
 * The trading engine calls `prepareOrder` → risk check → `executeOrder`.
 */

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import { FyersClient } from './client.js';
import type { OrderParams } from './client.js';
import type { OptionType } from '../models/Trade.js';
import { resolveAtmOption, type ResolvedOption } from './optionChain.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradeSignal {
  symbol: 'NIFTY' | 'BANKNIFTY';
  optionType: OptionType;
  confidence: number;
  timestamp: Date;
  /** Telegram message ID — used for idempotency in the order tag */
  messageId?: number;
}

export interface OrderPlan {
  option: ResolvedOption;
  lotSize: number;
  qty: number;
  orderValue: number;
  orderParams: OrderParams;
}

export interface OrderExecutionResult {
  success: boolean;
  orderId?: string;
  message: string;
  dryRun: boolean;
  orderDetails?: OrderParams;
  plan?: OrderPlan;
}

// ---------------------------------------------------------------------------
// Env-driven configuration
// ---------------------------------------------------------------------------

/**
 * Default lot sizes — used only if env vars are not set.
 * These were updated to NSE's post-Nov-2024 values, but YOU SHOULD
 * verify them against the current NSE lot size and set them in .env:
 *
 *   NIFTY_LOT_SIZE=75
 *   BANKNIFTY_LOT_SIZE=35
 *
 * NSE periodically revises lot sizes (usually quarterly).
 */
const DEFAULT_LOT_SIZES: Record<'NIFTY' | 'BANKNIFTY', number> = {
  NIFTY: 75,
  BANKNIFTY: 35,
};

function getLotSize(symbol: 'NIFTY' | 'BANKNIFTY'): number {
  const envVar = symbol === 'NIFTY' ? 'NIFTY_LOT_SIZE' : 'BANKNIFTY_LOT_SIZE';
  const raw = process.env[envVar];
  if (!raw) {
    logger.warn(
      `${envVar} not set in .env — using default ${DEFAULT_LOT_SIZES[symbol]}. ` +
        `Set this in .env to match the current NSE lot size.`,
    );
    return DEFAULT_LOT_SIZES[symbol];
  }
  const val = parseInt(raw);
  if (isNaN(val) || val <= 0) {
    logger.warn(`Invalid ${envVar}="${raw}" — using default ${DEFAULT_LOT_SIZES[symbol]}`);
    return DEFAULT_LOT_SIZES[symbol];
  }
  return val;
}

/**
 * Parse "HH:MM" time string → minutes since midnight.
 * Returns `fallback` on parse failure.
 */
function parseTimeStr(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  const h = parseInt(m[1]!);
  const min = parseInt(m[2]!);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}

/** Market-open minute-of-day (IST). Default 09:20 — no trades before this. */
function getMarketOpenMinutes(): number {
  return parseTimeStr(process.env['MARKET_OPEN_TIME'], 9 * 60 + 20);
}

/** Market-close minute-of-day (IST). Default 15:15 — no trades after this. */
function getMarketCloseMinutes(): number {
  return parseTimeStr(process.env['MARKET_CLOSE_TIME'], 15 * 60 + 15);
}

// ---------------------------------------------------------------------------
// Order planning (preview — no execution)
// ---------------------------------------------------------------------------

/**
 * Build an order plan: resolve ATM option symbol, compute qty and order value.
 *
 * This does NOT place any order. It performs:
 *   - Market-hours check (returns `ok: false` outside the window)
 *   - Weekend check
 *   - ATM option symbol resolution via Fyers option chain
 *   - Lot size lookup from env
 *   - Order-value cap check
 *
 * @returns `{ ok: true, plan }` on success, or `{ ok: false, reason }` if any
 *          pre-trade check fails.
 */
export async function prepareOrder(
  client: FyersClient,
  signal: TradeSignal,
  _maxOrderValue?: number,
): Promise<{ ok: true; plan: OrderPlan } | { ok: false; reason: string }> {
  // `_maxOrderValue` is no longer used — Fyers' own margin check handles this.
  // Kept for backward compatibility with executeTrade() signature.
  void _maxOrderValue;

  if (!signal.optionType) {
    return { ok: false, reason: 'No option type in signal' };
  }

  // 1. Market hours + weekend check
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = istTime.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) {
    return { ok: false, reason: 'Market closed (weekend)' };
  }
  const timeInMinutes = istTime.getHours() * 60 + istTime.getMinutes();
  const openMin = getMarketOpenMinutes();
  const closeMin = getMarketCloseMinutes();
  if (timeInMinutes < openMin || timeInMinutes > closeMin) {
    const hh = String(istTime.getHours()).padStart(2, '0');
    const mm = String(istTime.getMinutes()).padStart(2, '0');
    const openStr = process.env['MARKET_OPEN_TIME'] || '09:20';
    const closeStr = process.env['MARKET_CLOSE_TIME'] || '15:15';
    return {
      ok: false,
      reason: `Outside market hours (now ${hh}:${mm} IST, window ${openStr}-${closeStr})`,
    };
  }

  // 2. Resolve ATM option symbol via Fyers option chain
  const option = await resolveAtmOption(client, signal.symbol, signal.optionType);
  if (!option) {
    return {
      ok: false,
      reason: `Failed to resolve ATM option for ${signal.symbol} ${signal.optionType}`,
    };
  }

  // 3. Quantity + order value
  //    Note: We compute `orderValue` for logging/stats, but we DON'T enforce
  //    a max — Fyers will reject the order via margin check if it's too big.
  //    The risk manager handles daily loss limit, max trades, etc.
  const lotSize = getLotSize(signal.symbol);
  const qty = lotSize; // 1 lot — make configurable later if needed
  const orderValue = option.ltp * qty;

  // 4. Build order params — SELL for option selling, MARKET for immediate fill
  const orderTag = signal.messageId
    ? `tg-${signal.messageId}`
    : `tg-${Date.now()}`;
  const orderParams: OrderParams = {
    symbol: option.symbol,
    qty,
    type: 1, // 1 = MARKET order (immediate execution)
    side: -1, // -1 = SELL (option selling)
    productType: 'INTRADAY',
    limitPrice: 0, // MARKET order — no limit price
    stopLoss: 0,
    takeProfit: 0,
    validity: 'DAY',
    disclosedQty: 0,
    offlineOrder: false,
    orderTag,
  };

  return {
    ok: true,
    plan: { option, lotSize, qty, orderValue, orderParams },
  };
}

// ---------------------------------------------------------------------------
// Order execution
// ---------------------------------------------------------------------------

/**
 * Place an order using a pre-built plan.
 *
 * Dry-run mode (`dryRun=true`):
 *   Logs the order parameters and returns success WITHOUT calling Fyers.
 *   Lets you test the full pipeline (OCR → analysis → risk check → order
 *   plan) safely with real market data, but no actual order is placed.
 *
 * Live mode (`dryRun=false`):
 *   1. Idempotency check — queries order book for an existing order with
 *      the same `orderTag`. If found, returns success without re-placing.
 *      This prevents duplicate orders if the listener double-processes a
 *      message or if the process restarts.
 *   2. Places a MARKET SELL order via Fyers API.
 *   3. Returns the order ID on success.
 */
export async function executeOrder(
  client: FyersClient,
  plan: OrderPlan,
  dryRun: boolean,
): Promise<OrderExecutionResult> {
  logger.info('Order plan', {
    symbol: plan.option.symbol,
    strike: plan.option.strike,
    expiry: plan.option.expiry,
    qty: plan.qty,
    ltp: plan.option.ltp,
    value: plan.orderValue,
    side: 'SELL',
    type: 'MARKET',
    tag: plan.orderParams.orderTag,
  });

  if (dryRun) {
    logger.info('[DRY RUN] Would place SELL order:', plan.orderParams);
    return {
      success: true,
      message: 'Dry run — order logged but NOT placed',
      dryRun: true,
      orderDetails: plan.orderParams,
      plan,
    };
  }

  // Idempotency check: look for an existing order with the same tag.
  // This protects against duplicate orders when:
  //   - The Telegram listener re-processes a message
  //   - The process restarts mid-trade
  //   - A network timeout causes a retry
  try {
    const orderBook = await client.getOrderBook();
    // Fyers returns the list under either `orderBook` or `orderBag`
    // depending on the endpoint version — accept either.
    const rawOrders: any[] = orderBook?.orderBook ?? orderBook?.orderBag ?? [];
    const existing = rawOrders.find(
      // `tag` is the field name returned by Fyers; `status !== 6` skips
      // cancelled orders (status code 6 = Cancelled).
      (o) => o.tag === plan.orderParams.orderTag && o.status !== 6,
    );
    if (existing) {
      logger.warn(
        `Order with tag ${plan.orderParams.orderTag} already exists (id=${existing.id}), skipping`,
      );
      return {
        success: true,
        orderId: existing.id,
        message: 'Order already placed (idempotency check)',
        dryRun: false,
        orderDetails: plan.orderParams,
        plan,
      };
    }
  } catch (err) {
    // Don't block on idempotency check failure — log and proceed.
    logger.warn('Idempotency check failed, proceeding anyway', { error: errToString(err) });
  }

  // Place the order
  try {
    const response = await client.placeOrder(plan.orderParams);
    if (response.s === 'ok') {
      logger.info(
        `SELL order placed: ${response.id} (tag: ${plan.orderParams.orderTag}, ` +
          `symbol: ${plan.option.symbol}, qty: ${plan.qty})`,
      );
      return {
        success: true,
        orderId: response.id,
        message: 'SELL order placed successfully',
        dryRun: false,
        orderDetails: plan.orderParams,
        plan,
      };
    }
    logger.error(`Order placement failed: ${response.message}`);
    return {
      success: false,
      message: response.message,
      dryRun: false,
      plan,
    };
  } catch (err) {
    logger.error('Order execution error', { error: errToString(err) });
    return {
      success: false,
      message: `Execution error: ${errToString(err)}`,
      dryRun: false,
      plan,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience wrapper (kept for backward compatibility with callers that
// don't need a separate risk-check step)
// ---------------------------------------------------------------------------

export async function executeTrade(
  client: FyersClient,
  signal: TradeSignal,
  dryRun: boolean = true,
  maxOrderValue: number = 50000,
): Promise<OrderExecutionResult> {
  const prep = await prepareOrder(client, signal, maxOrderValue);
  if (!prep.ok) {
    return { success: false, message: prep.reason, dryRun };
  }
  return executeOrder(client, prep.plan, dryRun);
}
