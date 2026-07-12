/**
 * Trading engine — orchestrates Fyers trading components.
 *
 * Pipeline for each trade signal:
 *   1. Validate confidence threshold
 *   2. `prepareOrder` — resolve ATM option symbol (via option chain),
 *      compute qty + order value. NO order placed yet.
 *   3. `checkRiskLimits` — using the ACTUAL order value from step 2
 *      (not a `* 100` magic-number approximation).
 *   4. `executeOrder` — place the SELL order (or log in dry-run mode).
 *
 * FIXES
 * -----
 * - Token refresh: now actually works because `loadTokens()` returns
 *   expired tokens, allowing us to call `refreshAccessToken`.
 * - No more double `executeTrade` call — preview + execution are split
 *   into `prepareOrder` + `executeOrder` to avoid race conditions and
 *   duplicate API calls.
 */

import { logger } from '../utils/logger.js';
import { errToString, isFyersTokenExpiredError } from '../utils/errors.js';
import { FyersClient } from './client.js';
import {
  generateAuthUrl,
  loadTokens,
  refreshAccessToken,
  type FyersAuthConfig,
  type FyersTokenData,
} from './auth.js';
import {
  prepareOrder,
  executeOrder,
  type TradeSignal,
  type OrderExecutionResult,
} from './orderExecutor.js';
import {
  checkRiskLimits,
  loadRiskConfig,
  loadDailyStats,
  resetDailyStats,
  updateDailyStats,
  type RiskConfig,
} from './riskManager.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradingEngineConfig {
  auth: FyersAuthConfig;
  risk: RiskConfig;
  dryRun: boolean;
}

export interface TradingEngine {
  initialize(): Promise<void>;
  processTradeSignal(signal: TradeSignal): Promise<OrderExecutionResult>;
  getAuthUrl(): string;
  shutdown(): void;
  /**
   * Return the underlying FyersClient (for use by the trade manager to
   * poll quotes and place square-off orders). Returns null if the engine
   * has not been initialized yet.
   */
  getClient(): FyersClient | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultTradingEngine implements TradingEngine {
  private config: TradingEngineConfig;
  private client: FyersClient | null = null;
  private tokenData: FyersTokenData | null = null;
  private isInitialized = false;

  constructor(config: TradingEngineConfig) {
    this.config = config;
  }

  /**
   * Initialize the trading engine.
   *
   * Token handling flow:
   *   1. Load saved tokens (even if expired locally — we'll refresh if needed).
   *   2. If no tokens at all → throw (user must run `npm run fyers-auth`).
   *   3. Create Fyers client with current access token.
   *   4. Try `getProfile()` — if it fails because Fyers rejected the token
   *      (which happens daily ~7:30 AM IST regardless of `expires_in`),
   *      attempt refresh using the refresh token, then retry.
   *   5. If refresh also fails → throw with a clear message.
   *   6. On success → load daily stats, reset if new day, mark initialized.
   *
   * BUG FIX
   * -------
   * Previously we only refreshed when our LOCAL `expiresAt` was in the past.
   * But Fyers access tokens actually expire at a fixed daily cutoff
   * (~7:30 AM IST) regardless of when they were issued. The `expires_in:
   * 86400` returned by the API is misleading. So a token issued at 13:00
   * IST yesterday with `expiresAt` = 13:00 IST today is actually rejected
   * by Fyers at 07:30 IST today. Now we detect this case and refresh.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Trading engine already initialized');
      return;
    }

    try {
      this.tokenData = loadTokens();

      if (!this.tokenData) {
        logger.info('No saved tokens found. User needs to authenticate.');
        logger.info('Visit this URL to get auth code:');
        logger.info(this.getAuthUrl());
        throw new Error(
          'Authentication required. Please run `npm run fyers-auth` first.',
        );
      }

      // Refresh proactively if our LOCAL clock says the token is expired
      if (this.tokenData.expiresAt < Date.now()) {
        logger.info('Local expiry says access token is expired — refreshing...');
        this.tokenData = await this.refreshOrFail(this.tokenData);
      }

      // Create client with current token
      this.client = new FyersClient(this.config.auth, this.tokenData);

      // Test connection. Fyers may still reject the token even though our
      // local clock says it's valid (daily cutoff). If so, refresh + retry.
      let profile = await this.safeGetProfile();
      if (!profile) {
        logger.warn(
          'Fyers rejected the access token (likely daily cutoff expired). ' +
            'Attempting refresh using the refresh token...',
        );
        this.tokenData = await this.refreshOrFail(this.tokenData);
        this.client = new FyersClient(this.config.auth, this.tokenData);
        profile = await this.safeGetProfile();
      }

      if (!profile) {
        throw new Error(
          'Failed to connect to Fyers API after refresh. ' +
            'Run `npm run fyers-auth` to re-authenticate.',
        );
      }

      logger.info('Trading engine initialized successfully');
      logger.info(`Dry-run mode: ${this.config.dryRun ? 'ENABLED' : 'DISABLED'}`);

      // Load persisted daily stats; reset if new day
      loadDailyStats();
      this.checkAndResetDailyStats();

      this.isInitialized = true;
    } catch (err) {
      logger.error('Failed to initialize trading engine', {
        error: errToString(err),
      });
      throw err;
    }
  }

  /**
   * Call `getProfile()` and treat any error (thrown or error-response)
   * as a failure. Returns null instead of throwing so the caller can
   * decide whether to refresh the token and retry.
   */
  private async safeGetProfile(): Promise<any> {
    if (!this.client) return null;
    try {
      return await this.client.getProfile();
    } catch (err) {
      logger.warn('getProfile() threw an error', { error: errToString(err) });
      return null;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * Throws a clear, actionable error if refresh is not possible.
   */
  private async refreshOrFail(tokenData: FyersTokenData): Promise<FyersTokenData> {
    if (!tokenData.refreshToken) {
      throw new Error(
        'Access token rejected by Fyers and no refresh token is saved. ' +
          'Run `npm run fyers-auth` to re-authenticate.',
      );
    }
    try {
      const fresh = await refreshAccessToken(this.config.auth, tokenData.refreshToken);
      logger.info('Access token refreshed successfully.');
      return fresh;
    } catch (err) {
      // If refresh fails because the refresh token is also expired,
      // give a clear actionable message
      if (isFyersTokenExpiredError(err)) {
        throw new Error(
          'Both access and refresh tokens have expired. ' +
            'Run `npm run fyers-auth` to re-authenticate.',
        );
      }
      throw new Error(
        `Token refresh failed: ${errToString(err)}. ` +
          'Run `npm run fyers-auth` to re-authenticate.',
      );
    }
  }

  /** Get the auth URL (for `npm run fyers-auth`). */
  getAuthUrl(): string {
    return generateAuthUrl(this.config.auth);
  }

  /**
   * Process a trade signal end-to-end.
   *
   * Steps:
   *   1. Confidence-threshold check
   *   2. `prepareOrder` — resolve symbol, qty, value (no execution)
   *   3. `checkRiskLimits` — using the real order value
   *   4. `executeOrder` — place the SELL order (or log in dry-run)
   *
   * This is now a single linear flow — no more double `executeTrade` call.
   */
  async processTradeSignal(signal: TradeSignal): Promise<OrderExecutionResult> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Trading engine not initialized. Call initialize() first.');
    }

    try {
      logger.info('Processing trade signal', {
        symbol: signal.symbol,
        optionType: signal.optionType,
        confidence: signal.confidence,
        messageId: signal.messageId,
      });

      // Step 1: Confidence threshold
      const confidenceThreshold = parseInt(
        process.env['CONFIDENCE_THRESHOLD'] || '70',
      );
      if (signal.confidence < confidenceThreshold) {
        const msg = `Signal confidence ${signal.confidence}% below threshold ${confidenceThreshold}%`;
        logger.warn(msg);
        return { success: false, message: msg, dryRun: this.config.dryRun };
      }

      // Step 2: Prepare order (resolves symbol via option chain, computes value)
      const prep = await prepareOrder(
        this.client,
        signal,
        this.config.risk.maxOrderValue,
      );
      if (!prep.ok) {
        logger.warn(`Order preparation failed: ${prep.reason}`);
        return {
          success: false,
          message: prep.reason,
          dryRun: this.config.dryRun,
        };
      }

      // Step 3: Risk check using the ACTUAL order value
      const riskCheck = await checkRiskLimits(
        this.client,
        this.config.risk,
        prep.plan.orderValue,
      );
      if (!riskCheck.allowed) {
        logger.warn(`Trade rejected by risk manager: ${riskCheck.reason}`);
        return {
          success: false,
          message: riskCheck.reason || 'Risk check failed',
          dryRun: this.config.dryRun,
        };
      }

      // Step 4: Execute order
      const result = await executeOrder(
        this.client,
        prep.plan,
        this.config.dryRun,
      );

      if (result.success) {
        // P&L is only realized on buyback for option selling — pass 0 for now.
        // TODO: Track realized P&L when exit logic is added.
        updateDailyStats(0);
      }
      return result;
    } catch (err) {
      logger.error('Failed to process trade signal', {
        error: errToString(err),
        signal,
      });
      return {
        success: false,
        message: `Processing error: ${errToString(err)}`,
        dryRun: this.config.dryRun,
      };
    }
  }

  /**
   * Check if it's a new trading day and reset stats if needed.
   */
  private checkAndResetDailyStats(): void {
    const today = new Date().toISOString().split('T')[0];
    const statePath = path.join(process.cwd(), 'config', 'trading-state.json');

    let lastTradeDate: string | null = null;
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        lastTradeDate = state.lastTradeDate || null;
      }
    } catch (err) {
      logger.warn('Failed to read trading state', { error: String(err) });
    }

    if (lastTradeDate !== today) {
      logger.info('New trading day detected, resetting daily stats');
      resetDailyStats();

      try {
        const dir = path.dirname(statePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(
          statePath,
          JSON.stringify({ lastTradeDate: today }, null, 2),
        );
      } catch (err) {
        logger.warn('Failed to save trading state', { error: String(err) });
      }
    }
  }

  shutdown(): void {
    logger.info('Shutting down trading engine');
    this.client = null;
    this.isInitialized = false;
  }

  /** @inheritdoc */
  getClient(): FyersClient | null {
    return this.client;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTradingEngine(): TradingEngine {
  const authConfig: FyersAuthConfig = {
    appId: process.env['FYERS_APP_ID'] || '',
    appSecret: process.env['FYERS_APP_SECRET'] || '',
    redirectUri: process.env['FYERS_REDIRECT_URI'] || 'http://localhost:8080',
  };

  const riskConfig = loadRiskConfig();
  const dryRun = process.env['DRY_RUN'] !== 'false';

  const config: TradingEngineConfig = {
    auth: authConfig,
    risk: riskConfig,
    dryRun,
  };

  return new DefaultTradingEngine(config);
}

/**
 * Create a trade signal from analysis results.
 *
 * @param messageId Telegram message ID — embedded in the Fyers order tag
 *                  for idempotency (prevents duplicate orders on retry).
 */
export function createTradeSignal(
  symbol: 'NIFTY' | 'BANKNIFTY',
  optionType: 'CE' | 'PE',
  confidence: number,
  messageId?: number,
): TradeSignal {
  return {
    symbol,
    optionType,
    confidence,
    timestamp: new Date(),
    messageId,
  };
}
