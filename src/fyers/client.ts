/**
 * Fyers API client wrapper.
 *
 * Provides a high-level interface to Fyers API operations:
 *   - Order placement / cancellation / order book
 *   - Position queries
 *   - Fund queries
 *   - Quote queries
 *   - Profile queries
 *   - Option chain queries (NEW — needed for symbol resolution)
 *
 * NOTE ON SSL
 * -----------
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` is still toggled around each call to
 * work around the Fyers SDK's certificate handling. This is a known
 * security smell — a future fix should pin the Fyers CA bundle instead
 * of disabling verification globally. The toggle is now wrapped in
 * try/finally so it's always restored, even on error.
 */

import path from 'path';
import { logger } from '../utils/logger.js';
import { errToString } from '../utils/errors.js';
import type { FyersAuthConfig, FyersTokenData } from './auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderParams {
  symbol: string;
  qty: number;
  type: 1 | 2; // 1 = MARKET, 2 = LIMIT
  side: 1 | -1; // 1 = BUY, -1 = SELL
  productType: string;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  validity: string;
  disclosedQty?: number;
  offlineOrder: boolean;
  orderTag?: string;
}

export interface OrderResponse {
  s: string;
  code: number;
  message: string;
  id?: string;
  orderBook?: any[];
}

export interface QuoteResponse {
  s: string;
  code: number;
  message: string;
  d?: any[];
}

export interface Position {
  symbol: string;
  qty: number;
  side: string;
  pnl: number;
  avg_price: number;
}

export interface Funds {
  equity: number;
  available_margin: number;
  used_margin: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FyersClient {
  private fyersInstance: any;
  private accessToken: string;
  private config: FyersAuthConfig;

  constructor(config: FyersAuthConfig, tokenData: FyersTokenData) {
    this.config = config;
    this.accessToken = tokenData.accessToken;
  }

  /**
   * Lazily initialize the Fyers API instance.
   */
  private async initFyers(): Promise<void> {
    if (this.fyersInstance) return;

    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const fyersApi = await import('fyers-api-v3');
      const fyersModel = fyersApi.fyersModel;

      this.fyersInstance = new fyersModel({
        path: path.resolve(process.cwd(), 'logs'),
        enableLogging: true,
      });

      this.fyersInstance.setAppId(this.config.appId);
      this.fyersInstance.setRedirectUrl(this.config.redirectUri);
      this.fyersInstance.setAccessToken(this.accessToken);

      logger.debug('Fyers API client initialized');
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  /** Update access token (e.g., after refresh). */
  updateAccessToken(newToken: string): void {
    this.accessToken = newToken;
    this.fyersInstance = null; // Force re-init on next call
    logger.info('Fyers access token updated');
  }

  // -------------------------------------------------------------------------
  // Order operations
  // -------------------------------------------------------------------------

  /**
   * Place a new order.
   *
   * PROXY HANDLING
   * --------------
   * Only this method routes through the Fixie proxy (if configured).
   * Fyers requires order placement to come from a whitelisted static IP,
   * but read-only calls (quotes, option chain, positions, etc.) work
   * from any IP. So we toggle HTTPS_PROXY on around this call and off
   * after, keeping all other Fyers calls direct.
   *
   * This is safe because order placement is serialized via the AsyncMutex
   * in liveListener — no concurrent Fyers calls happen while the proxy
   * is enabled.
   */
  async placeOrder(params: OrderParams): Promise<OrderResponse> {
    await this.initFyers();

    const fixieUrl = process.env['FIXIE_URL'];
    const proxyWasSet = !!process.env['HTTPS_PROXY'];

    try {
      // Enable proxy ONLY for this call
      if (fixieUrl) {
        process.env['HTTP_PROXY'] = fixieUrl;
        process.env['HTTPS_PROXY'] = fixieUrl;
        // axios reads these env vars when creating a request, so we must
        // force re-init of the Fyers instance so it picks up the proxy.
        // However, the Fyers SDK creates axios requests per-call, so the
        // env vars will be respected without re-init.
      }

      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.place_order(params);
      const result = response as OrderResponse;
      if (result.s === 'ok') {
        logger.info(`Order placed: ${result.id}`);
      } else {
        logger.error(`Order placement failed: ${result.message}`);
      }
      return result;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
      // Remove proxy so subsequent read calls (getQuote, getOptionChain, etc.)
      // go direct — they don't need the static IP.
      if (fixieUrl && !proxyWasSet) {
        delete process.env['HTTP_PROXY'];
        delete process.env['HTTPS_PROXY'];
      }
    }
  }

  /**
   * Get order book (all orders placed today).
   *
   * NOTE: The Fyers SDK method is `get_orders` (not `get_order_book`).
   * Response shape: { s, code, message, orderBook: [...] }
   */
  async getOrderBook(): Promise<any> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      // SDK uses get_orders (snake_case) — returns today's order book
      const response = await this.fyersInstance.get_orders({});
      logger.debug('Retrieved order book');
      return response;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  async cancelOrder(orderId: string): Promise<OrderResponse> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.cancel_order({ id: orderId });
      const result = response as OrderResponse;
      if (result.s === 'ok') {
        logger.info(`Order cancelled: ${orderId}`);
      } else {
        logger.error(`Order cancellation failed: ${result.message}`);
      }
      return result;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  // -------------------------------------------------------------------------
  // Position operations
  // -------------------------------------------------------------------------

  async getPositions(): Promise<Position[]> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.get_positions({});
      logger.debug('Retrieved positions');
      return response?.netPositions || [];
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  // -------------------------------------------------------------------------
  // Fund operations
  // -------------------------------------------------------------------------

  async getFunds(): Promise<Funds> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.get_funds({});

      // Debug-log the raw funds response so we can see its actual shape
      logger.debug(`Raw funds response: ${JSON.stringify(response)?.slice(0, 800)}`);

      // The Fyers funds API has used multiple response shapes across versions:
      //
      //   Shape A (old):  response.fund_limit[0].{equityAmount, netAvailableMargin, utilizedMargin}
      //   Shape B (v3):   response.data.fund_limit[0].{equityAmount, netAvailableMargin, utilizedMargin}
      //   Shape C (new):  response.s = "ok", response.fund_limit = {...} (object, not array)
      //   Shape D:        response.fundLimits.{availableBalance, utilizedMargin}
      //
      // We try each path defensively and pick the first one that yields a number.

      // Locate the `fund_limit` array (or object) — it may be at root or under `data`
      let fundLimit: any = response?.fund_limit ?? response?.fundLimit ?? null;
      if (!fundLimit && response?.data) {
        fundLimit = response.data.fund_limit ?? response.data.fundLimit ?? null;
      }

      // Case 1: fund_limit is an array → take the first element
      let equity = 0;
      let availableMargin = 0;
      let usedMargin = 0;

      if (Array.isArray(fundLimit) && fundLimit.length > 0) {
        const entry = fundLimit[0];
        equity = Number(entry?.equityAmount ?? 0);
        availableMargin = Number(entry?.netAvailableMargin ?? 0);
        usedMargin = Number(entry?.utilizedMargin ?? 0);
      } else if (fundLimit && typeof fundLimit === 'object') {
        // Case 2: fund_limit is an object (not array)
        equity = Number(fundLimit.equityAmount ?? fundLimit.equity ?? 0);
        availableMargin = Number(
          fundLimit.netAvailableMargin ??
          fundLimit.availableMargin ??
          fundLimit.available_balance ??
          fundLimit.availableBalance ??
          0,
        );
        usedMargin = Number(
          fundLimit.utilizedMargin ??
          fundLimit.usedMargin ??
          fundLimit.utilized_margin ??
          0,
        );
      } else {
        // Case 3: try flat fields at root or under data
        const source = response?.data && typeof response.data === 'object' ? response.data : response;
        equity = Number(source?.equityAmount ?? source?.equity ?? 0);
        availableMargin = Number(
          source?.netAvailableMargin ??
          source?.availableMargin ??
          source?.available_balance ??
          source?.availableBalance ??
          0,
        );
        usedMargin = Number(
          source?.utilizedMargin ??
          source?.usedMargin ??
          source?.utilized_margin ??
          0,
        );
      }

      // If we still have all zeros, the response shape is unrecognized — log it loudly
      if (equity === 0 && availableMargin === 0 && usedMargin === 0) {
        logger.warn(
          `Funds response shape unrecognized — all values are 0. ` +
            `This usually means the Fyers API returned a different structure than expected. ` +
            `Raw response: ${JSON.stringify(response)?.slice(0, 500)}`,
        );
      }

      const funds: Funds = {
        equity,
        available_margin: availableMargin,
        used_margin: usedMargin,
      };
      logger.debug('Parsed funds', funds);
      return funds;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  // -------------------------------------------------------------------------
  // Quote operations
  // -------------------------------------------------------------------------

  /**
   * Get quotes for symbols.
   *
   * IMPORTANT: The Fyers SDK method is `getQuotes` (camelCase, NOT
   * `get_quotes`). The argument is an ARRAY of symbol strings, e.g.:
   *
   *   await fyersInstance.getQuotes(['NSE:NIFTY50-INDEX', 'NSE:NIFTY24N0723500CE'])
   *
   * Note: For indices, Fyers uses the official NSE names:
   *   NIFTY     → "NSE:NIFTY50-INDEX"
   *   BANKNIFTY → "NSE:NIFTYBANK-INDEX"
   *
   * Response shape: { s, code, message, d: [{ n, v: { symbol, lp, ... } }] }
   */
  async getQuotes(symbols: string[]): Promise<QuoteResponse> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.getQuotes(symbols);
      logger.debug('Retrieved quotes', { symbols });
      return response as QuoteResponse;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  async getQuote(symbol: string): Promise<any> {
    const response = await this.getQuotes([symbol]);
    if (response.s === 'ok' && response.d && response.d.length > 0) {
      return response.d[0];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Option chain
  // -------------------------------------------------------------------------

  /**
   * Get the option chain for an underlying index.
   *
   * FYERS API TWO-STEP FLOW
   * -----------------------
   * Step 1: Call with `timestamp: 0` → returns ONLY `expiryData` (list of
   *         available expiries, no options array). The response message will
   *         be "Please provide valid expiry" with `s: "error"`.
   *
   * Step 2: Call again with `timestamp: <unix>` (a specific expiry timestamp
   *         from step 1's expiryData[].expiry) → returns the full
   *         `optionsChain` array for that expiry.
   *
   * @param underlyingSymbol e.g. "NSE:NIFTY50-INDEX" or "NSE:NIFTYBANK-INDEX"
   * @param strikeCount Number of strikes to return on each side of ATM
   * @param timestamp Expiry Unix timestamp (0 = list available expiries only)
   */
  async getOptionChain(
    underlyingSymbol: string,
    strikeCount: number = 5,
    timestamp: number = 0,
  ): Promise<any> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.getOptionChain({
        symbol: underlyingSymbol,
        strikecount: strikeCount,
        timestamp: timestamp,
      });
      logger.debug('Retrieved option chain', {
        underlying: underlyingSymbol,
        timestamp,
      });
      return response;
    } catch (err) {
      logger.error('Failed to get option chain', {
        error: errToString(err),
        underlying: underlyingSymbol,
      });
      throw err;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }

  // -------------------------------------------------------------------------
  // Profile operations
  // -------------------------------------------------------------------------

  async getProfile(): Promise<any> {
    await this.initFyers();
    try {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const response = await this.fyersInstance.get_profile({});
      // Detect Fyers API error responses (e.g. expired token returns
      // { s: 'error', code: -8, message: 'Your token has expired...' }).
      if (response && response.s === 'error') {
        logger.warn(`Fyers getProfile returned error: ${response.message} (code: ${response.code})`);
        return null;
      }
      logger.debug('Retrieved user profile');
      return response;
    } catch (err) {
      logger.error('Failed to get profile', { error: errToString(err) });
      throw err;
    } finally {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    }
  }
}
