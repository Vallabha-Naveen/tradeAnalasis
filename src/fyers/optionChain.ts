/**
 * Option chain helpers — fetch current expiry + resolve ATM option symbol.
 *
 * WHY THIS EXISTS
 * ---------------
 * Fyers API v3 requires the FULL option symbol including the expiry date
 * baked into the symbol string (e.g. `NSE:NIFTY24N0723500CE`). The format
 * varies between weekly and monthly expiries, and the single-letter month
 * code differs from the 3-letter abbreviation used by other exchanges.
 *
 * Constructing this string manually is fragile. Instead, we use the Fyers
 * option-chain API which returns the exact tradable symbol for every
 * strike + expiry + option-type combination. We then pick the ATM strike
 * for the current (nearest) expiry.
 *
 * This module always selects:
 *   - Strike: ATM (rounded to the symbol's strike interval)
 *   - Expiry: the nearest upcoming expiry returned by Fyers
 */

import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import type { FyersClient } from './client.js';
import type { OptionType } from '../models/Trade.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptionChainEntry {
  symbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  expiry: string; // ISO date
  ltp: number;
}

export interface ResolvedOption {
  /** Fully-qualified Fyers option symbol, e.g. `NSE:NIFTY24N0723500CE` */
  symbol: string;
  /** ATM strike price */
  strike: number;
  /** ISO date of current expiry */
  expiry: string;
  /** Last traded price of the option */
  ltp: number;
  /** Spot price of the underlying index */
  spotPrice: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strike interval (in index points) per underlying. */
const STRIKE_INTERVAL: Record<'NIFTY' | 'BANKNIFTY', number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
};

/**
 * Fyers index symbol names — these are the EXACT symbols Fyers expects
 * for fetching index quotes and option chains.
 *
 * IMPORTANT: Fyers uses NSE's official index names, NOT the trader-friendly
 * "NIFTY" / "BANKNIFTY" short names. The full symbols are:
 *
 *   NIFTY 50 index      → "NSE:NIFTY50-INDEX"
 *   NIFTY Bank index    → "NSE:NIFTYBANK-INDEX"
 *
 * Using "NSE:NIFTY-INDEX" or "NSE:BANKNIFTY-INDEX" returns Fyers error
 * code -300: "Please provide a valid symbol".
 */
const INDEX_SYMBOL: Record<'NIFTY' | 'BANKNIFTY', string> = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
};

/** Get the Fyers index symbol for an underlying. */
function getIndexSymbol(underlying: 'NIFTY' | 'BANKNIFTY'): string {
  return INDEX_SYMBOL[underlying];
}

// ---------------------------------------------------------------------------
// Defensive response parsing
// ---------------------------------------------------------------------------

/**
 * Extract the spot (last traded) price from a Fyers quote response.
 *
 * Fyers' quote API has changed response shapes across versions. Known shapes:
 *
 *   Shape A (old):  quote.v.lp                    — nested "v" object
 *   Shape B (new):  quote.ltp                     — flat last-traded-price
 *   Shape C (cmd):  quote.cmd.lastTradedPrice     — nested cmd object
 *   Shape D:        quote.lp                      — flat lp
 *
 * We try each path in turn and return the first numeric value found.
 */
function extractSpotPrice(quote: any): number | null {
  if (!quote || typeof quote !== 'object') return null;

  // Path A: quote.v.lp (old Fyers API)
  if (quote.v && typeof quote.v.lp === 'number') return quote.v.lp;

  // Path B: quote.ltp (flat LTP)
  if (typeof quote.ltp === 'number') return quote.ltp;

  // Path C: quote.cmd.lastTradedPrice (Fyers CMD API)
  if (quote.cmd && typeof quote.cmd.lastTradedPrice === 'number') {
    return quote.cmd.lastTradedPrice;
  }

  // Path D: quote.lp (flat lp — sometimes returned for index quotes)
  if (typeof quote.lp === 'number') return quote.lp;

  // Path E: scan for any "lp" or "ltp" or "last_price" field at any level
  // (last resort — handles unknown shapes)
  const fields = ['lp', 'ltp', 'last_traded_price', 'lastTradedPrice', 'lastPrice'];
  for (const field of fields) {
    if (typeof quote[field] === 'number') return quote[field];
    if (quote.v && typeof quote.v[field] === 'number') return quote.v[field];
    if (quote.cmd && typeof quote.cmd[field] === 'number') return quote.cmd[field];
  }

  return null;
}

/**
 * Extract the option chain list from a Fyers option-chain response.
 *
 * Known shapes (Fyers has changed this across API versions):
 *   - chain.optionsChain            (root, camelCase)
 *   - chain.options_chain           (root, snake_case)
 *   - chain.data.optionsChain       (nested under data, camelCase)
 *   - chain.data.options_chain      (nested under data, snake_case)
 *   - chain.data.optionChain        (nested, singular)
 *   - chain.data.callOptions + chain.data.putOptions (split by type)
 */
function extractOptionChainList(chain: any): any[] {
  if (!chain || typeof chain !== 'object') return [];

  // Try root-level fields
  if (Array.isArray(chain.optionsChain)) return chain.optionsChain;
  if (Array.isArray(chain.options_chain)) return chain.options_chain;
  if (Array.isArray(chain.optionChain)) return chain.optionChain;

  // Try nested under `data`
  const data = chain.data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.optionsChain)) return data.optionsChain;
    if (Array.isArray(data.options_chain)) return data.options_chain;
    if (Array.isArray(data.optionChain)) return data.optionChain;
    if (Array.isArray(data.options)) return data.options;

    // Some Fyers versions split calls and puts into separate arrays
    const calls = Array.isArray(data.callOptions) ? data.callOptions :
                  Array.isArray(data.call_options) ? data.call_options : [];
    const puts = Array.isArray(data.putOptions) ? data.putOptions :
                 Array.isArray(data.put_options) ? data.put_options : [];
    if (calls.length > 0 || puts.length > 0) {
      return [...calls, ...puts];
    }
  }

  return [];
}

/**
 * Log the structure of an unknown response object — lists all keys at
 * the root and one level deep. Used for debugging when the expected
 * field name isn't found.
 */
function logResponseStructure(label: string, obj: any): void {
  if (!obj || typeof obj !== 'object') {
    logger.debug(`${label}: not an object (${typeof obj})`);
    return;
  }
  const rootKeys = Object.keys(obj);
  logger.debug(`${label} root keys: [${rootKeys.join(', ')}]`);
  if (obj.data && typeof obj.data === 'object') {
    const dataKeys = Object.keys(obj.data);
    logger.debug(`${label} data keys: [${dataKeys.join(', ')}]`);
    // Log the type/length of each data field
    for (const key of dataKeys) {
      const val = obj.data[key];
      if (Array.isArray(val)) {
        logger.debug(`${label} data.${key}: Array(${val.length})`);
      } else if (val && typeof val === 'object') {
        logger.debug(`${label} data.${key}: object with keys [${Object.keys(val).join(', ')}]`);
      } else {
        logger.debug(`${label} data.${key}: ${typeof val} = ${String(val).slice(0, 50)}`);
      }
    }
  }
}

/**
 * Extract the LTP (last traded price) from an option chain entry.
 */
function extractOptionLtp(entry: any): number {
  if (!entry || typeof entry !== 'object') return 0;
  if (typeof entry.ltp === 'number') return entry.ltp;
  if (typeof entry.lp === 'number') return entry.lp;
  if (typeof entry.last_traded_price === 'number') return entry.last_traded_price;
  return 0;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Get the nearest upcoming expiry date for an underlying.
 *
 * Uses Fyers' two-step flow: first call with timestamp=0 to get the list
 * of available expiries, then pick the nearest upcoming one.
 */
export async function getCurrentExpiry(
  client: FyersClient,
  underlying: 'NIFTY' | 'BANKNIFTY',
): Promise<string | null> {
  const indexSymbol = getIndexSymbol(underlying);
  const response = await client.getOptionChain(indexSymbol, 5, 0);

  const expiryData: any[] =
    response?.data?.expiryData ??
    response?.expiryData ??
    [];

  if (expiryData.length === 0) {
    logger.error(`No expiry data returned for ${underlying} (${indexSymbol})`);
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - 86400; // Allow today's expiry

  const upcoming = expiryData
    .map((e) => ({
      date: e.date as string,
      timestamp: parseInt(String(e.expiry)),
    }))
    .filter((e) => !isNaN(e.timestamp) && e.timestamp >= cutoffSec)
    .sort((a, b) => a.timestamp - b.timestamp);

  return upcoming[0]?.date ?? null;
}

/**
 * Resolve the ATM option symbol for the current expiry + given option type.
 *
 * Steps:
 *   1. Fetch spot price from the index quote.
 *   2. Fetch the full option chain.
 *   3. Find the nearest expiry date.
 *   4. Round spot to the nearest strike interval → ATM strike.
 *   5. Look up the exact tradable symbol from the chain.
 */
export async function resolveAtmOption(
  client: FyersClient,
  underlying: 'NIFTY' | 'BANKNIFTY',
  optionType: OptionType,
): Promise<ResolvedOption | null> {
  if (!optionType) return null;

  try {
    // 1. Spot price — uses the official NSE index name
    //    (NSE:NIFTY50-INDEX for NIFTY, NSE:NIFTYBANK-INDEX for BANKNIFTY)
    const indexSymbol = getIndexSymbol(underlying);
    const quote = await client.getQuote(indexSymbol);

    // Debug-log the raw quote response so we can see its actual shape
    logger.debug(`Raw quote response for ${indexSymbol}: ${JSON.stringify(quote)?.slice(0, 500)}`);

    // Detect Fyers "invalid symbol" error response and give a helpful message
    if (quote?.v?.s === 'error' || quote?.v?.code === -300) {
      logger.error(
        `Fyers rejected the index symbol "${indexSymbol}": ${quote?.v?.errmsg || 'invalid symbol'}. ` +
          `Check INDEX_SYMBOL map in src/fyers/optionChain.ts.`,
      );
      return null;
    }

    const spotPrice = extractSpotPrice(quote);
    if (spotPrice === null) {
      logger.error(
        `Failed to get spot price for ${underlying} (symbol: ${indexSymbol}). ` +
          `Quote response shape unrecognized. Raw: ${JSON.stringify(quote)?.slice(0, 300)}`,
      );
      return null;
    }
    logger.info(`${underlying} spot price: ${spotPrice}`);

    // 2. Option chain — FYERS USES A TWO-STEP FLOW:
    //    a) First call with timestamp=0 → returns expiryData (list of
    //       available expiries, no options yet)
    //    b) Pick the nearest upcoming expiry timestamp
    //    c) Second call with that timestamp → returns the actual optionsChain

    // Step (a): Get available expiries
    const expiryListResponse = await client.getOptionChain(indexSymbol, 5, 0);

    logResponseStructure(`Option chain (expiries) for ${underlying}`, expiryListResponse);

    const expiryData: any[] =
      expiryListResponse?.data?.expiryData ??
      expiryListResponse?.expiryData ??
      [];

    if (expiryData.length === 0) {
      logger.error(
        `No expiry data returned for ${underlying} (${indexSymbol}). ` +
          `Raw response (first 2000 chars): ${JSON.stringify(expiryListResponse)?.slice(0, 2000)}`,
      );
      return null;
    }

    // Step (b): Pick the nearest upcoming expiry.
    //    Each entry in expiryData looks like:
    //      { "date": "28-07-2026", "expiry": "1785232800", "expiry_flag": "M" }
    //    `expiry` is a Unix timestamp (seconds) as a string.
    const nowSec = Math.floor(Date.now() / 1000);
    // Allow today's expiry (it remains tradable until 3:30 PM IST)
    const cutoffSec = nowSec - 86400;

    const upcomingExpiries = expiryData
      .map((e) => ({
        date: e.date as string,
        timestamp: parseInt(String(e.expiry)),
        flag: e.expiry_flag as string,
      }))
      .filter((e) => !isNaN(e.timestamp) && e.timestamp >= cutoffSec)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (upcomingExpiries.length === 0) {
      logger.error(`No upcoming expiries found for ${underlying}. expiryData: ${JSON.stringify(expiryData)}`);
      return null;
    }

    const currentExpiryEntry = upcomingExpiries[0]!;
    const currentExpiryTimestamp = currentExpiryEntry.timestamp;
    const currentExpiryDate = currentExpiryEntry.date;
    logger.info(
      `Current expiry for ${underlying}: ${currentExpiryDate} (unix: ${currentExpiryTimestamp}, flag: ${currentExpiryEntry.flag})`,
    );

    // Step (c): Get the actual option chain for this expiry
    const chainResponse = await client.getOptionChain(
      indexSymbol,
      5,
      currentExpiryTimestamp,
    );

    logResponseStructure(`Option chain (options) for ${underlying}`, chainResponse);

    const options = extractOptionChainList(chainResponse);
    if (options.length === 0) {
      logger.error(
        `Empty option chain for ${underlying} (${indexSymbol}, expiry ${currentExpiryDate}). ` +
          `Raw response (first 2000 chars): ${JSON.stringify(chainResponse)?.slice(0, 2000)}`,
      );
      return null;
    }
    logger.info(`Option chain for ${underlying}: ${options.length} entries`);

    // 3. ATM strike
    const interval = STRIKE_INTERVAL[underlying];
    const atmStrike = Math.round(spotPrice / interval) * interval;
    logger.info(`ATM strike for ${underlying}: ${atmStrike} (interval ${interval})`);

    // 4. Find the matching option in the chain.
    //    Field names may vary — try multiple variants for each field.
    const findField = (o: any, names: string[]): any => {
      for (const n of names) {
        if (o[n] !== undefined && o[n] !== null) return o[n];
      }
      return undefined;
    };

    const option = options.find((o) => {
      const oStrike = Number(findField(o, ['strike_price', 'strikePrice', 'strike']));
      const oType = String(findField(o, ['option_type', 'optionType', 'type']) || '').toUpperCase();

      return (
        oStrike === atmStrike &&
        (oType === optionType || oType === String(optionType))
      );
    });

    if (!option) {
      // Log a sample entry to help debug field-name mismatches
      const sample = options[0];
      logger.error(
        `Option not found in chain: ${underlying} ${atmStrike} ${optionType} ${currentExpiryDate}. ` +
          `Sample chain entry: ${JSON.stringify(sample)?.slice(0, 500)}`,
      );
      return null;
    }

    const ltp = extractOptionLtp(option);
    const optionSymbol = findField(option, ['symbol', 'tradingsymbol', 'trading_symbol']) as string;

    if (!optionSymbol) {
      logger.error(
        `Option found but symbol field is missing. Sample entry: ${JSON.stringify(option)?.slice(0, 500)}`,
      );
      return null;
    }

    return {
      symbol: optionSymbol,
      strike: atmStrike,
      expiry: currentExpiryDate,
      ltp,
      spotPrice,
    };
  } catch (err) {
    logger.error('Failed to resolve ATM option', {
      error: errToString(err),
      underlying,
      optionType,
    });
    return null;
  }
}
