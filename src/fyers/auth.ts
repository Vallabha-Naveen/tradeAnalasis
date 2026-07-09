/**
 * Fyers API authentication module.
 *
 * Handles OAuth2 flow for obtaining and refreshing access tokens.
 *
 * Flow:
 *   1. User visits auth URL to get auth code (`npm run fyers-auth`)
 *   2. Exchange auth code for access token + refresh token
 *   3. Use access token for API calls
 *   4. When access token expires, refresh it using the refresh token
 *
 * BUG FIX
 * -------
 * Previously `loadTokens()` returned `null` for expired tokens, which
 * made the refresh path in tradingEngine unreachable — the engine would
 * throw "Authentication required" instead of refreshing. Now
 * `loadTokens()` returns the token data regardless of expiry status so
 * the caller can decide whether to refresh.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FyersAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export interface AccessTokenResponse {
  s: string;
  code: number;
  message: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: string;
}

export interface FyersTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_FILE_PATH = path.resolve(process.cwd(), 'config', 'fyers-tokens.json');

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

/**
 * Load saved tokens from disk if available.
 *
 * Returns the token data EVEN IF EXPIRED — the caller (tradingEngine)
 * checks `expiresAt` and calls `refreshAccessToken` if needed.
 *
 * Returns `null` only when:
 *   - The token file does not exist (first run / never authenticated)
 *   - The file is corrupt or unreadable
 */
export function loadTokens(): FyersTokenData | null {
  try {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      const raw = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8');
      const data = JSON.parse(raw) as FyersTokenData;

      if (!data.accessToken) {
        logger.warn('Token file exists but accessToken is missing');
        return null;
      }

      if (data.expiresAt > Date.now()) {
        logger.info('Loaded valid Fyers tokens from disk');
      } else {
        logger.info('Fyers tokens are expired — will attempt refresh');
      }
      return data;
    }
  } catch (err) {
    logger.warn('Failed to load Fyers tokens from disk', { error: String(err) });
  }
  return null;
}

/**
 * Save tokens to disk for persistence.
 */
export function saveTokens(tokenData: FyersTokenData): void {
  try {
    const dir = path.dirname(TOKEN_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenData, null, 2));
    logger.info('Saved Fyers tokens to disk');
  } catch (err) {
    logger.error('Failed to save Fyers tokens to disk', { error: String(err) });
  }
}

/**
 * Clear saved tokens (for logout/re-auth).
 */
export function clearTokens(): void {
  try {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      fs.unlinkSync(TOKEN_FILE_PATH);
      logger.info('Cleared Fyers tokens from disk');
    }
  } catch (err) {
    logger.warn('Failed to clear Fyers tokens', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Auth URL generation
// ---------------------------------------------------------------------------

export function generateAuthUrl(config: FyersAuthConfig): string {
  const { appId, redirectUri } = config;
  const authUrl = new URL('https://api-t1.fyers.in/api/v3/generate-authcode');
  authUrl.searchParams.set('client_id', appId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', 'sample_state');
  authUrl.searchParams.set('scope', '');
  authUrl.searchParams.set('nonce', 'authorization_code');
  return authUrl.toString();
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

/**
 * Exchange auth code for access token.
 *
 * Called once by `npm run fyers-auth` after the user pastes the auth code
 * obtained from the Fyers login redirect.
 */
export async function exchangeAuthCode(
  config: FyersAuthConfig,
  authCode: string,
): Promise<FyersTokenData> {
  try {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const fyersApi = await import('fyers-api-v3');
    const fyersModel = fyersApi.fyersModel;

    const fyers = new fyersModel({
      path: path.resolve(process.cwd(), 'logs'),
      enableLogging: true,
    });

    fyers.setAppId(config.appId);
    fyers.setRedirectUrl(config.redirectUri);

    const response = await fyers.generate_access_token({
      client_id: config.appId,
      secret_key: config.appSecret,
      auth_code: authCode,
    });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';

    const tokenResponse = response as AccessTokenResponse;
    if (tokenResponse.s !== 'ok' || !tokenResponse.access_token) {
      throw new Error(`Failed to get access token: ${tokenResponse.message}`);
    }

    const expiresIn = tokenResponse.expires_in ? parseInt(tokenResponse.expires_in) : 86400;
    const expiresAt = Date.now() + expiresIn * 1000;

    const tokenData: FyersTokenData = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || '',
      expiresAt,
    };

    saveTokens(tokenData);
    logger.info('Successfully obtained Fyers access token');
    return tokenData;
  } catch (err) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    logger.error('Failed to exchange auth code for access token', { error: String(err) });
    throw err;
  }
}

/**
 * Refresh access token using refresh token.
 *
 * Called automatically by tradingEngine.initialize() when the saved
 * access token is expired.
 */
export async function refreshAccessToken(
  config: FyersAuthConfig,
  refreshToken: string,
): Promise<FyersTokenData> {
  try {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const fyersApi = await import('fyers-api-v3');
    const fyersModel = fyersApi.fyersModel;

    const fyers = new fyersModel({
      path: path.resolve(process.cwd(), 'logs'),
      enableLogging: true,
    });

    fyers.setAppId(config.appId);
    fyers.setRedirectUrl(config.redirectUri);

    // Fyers uses the refresh token in the same `auth_code` field for refresh
    const response = await fyers.generate_access_token({
      client_id: config.appId,
      secret_key: config.appSecret,
      auth_code: refreshToken,
    });
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';

    const tokenResponse = response as AccessTokenResponse;
    if (tokenResponse.s !== 'ok' || !tokenResponse.access_token) {
      throw new Error(`Failed to refresh access token: ${tokenResponse.message}`);
    }

    const expiresIn = tokenResponse.expires_in ? parseInt(tokenResponse.expires_in) : 86400;
    const expiresAt = Date.now() + expiresIn * 1000;

    const tokenData: FyersTokenData = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || refreshToken,
      expiresAt,
    };

    saveTokens(tokenData);
    logger.info('Successfully refreshed Fyers access token');
    return tokenData;
  } catch (err) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    logger.error('Failed to refresh access token', { error: String(err) });
    throw err;
  }
}
