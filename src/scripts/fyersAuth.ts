/**
 * Fyers authentication helper script.
 *
 * This script helps users authenticate with Fyers API:
 * 1. Generates the auth URL for the user to visit
 * 2. Takes the auth code from user input
 * 3. Exchanges auth code for access token
 * 4. Saves tokens to disk for future use
 *
 * Usage: npm run fyers-auth
 */

import dotenv from 'dotenv';
import { generateAuthUrl, exchangeAuthCode, loadTokens, clearTokens } from '../fyers/auth.js';
import input from 'input';

dotenv.config();

async function main(): Promise<void> {
  console.log('=== Fyers API Authentication ===\n');

  const appId = process.env['FYERS_APP_ID'];
  const appSecret = process.env['FYERS_APP_SECRET'];
  const redirectUri = process.env['FYERS_REDIRECT_URI'] || 'http://localhost:8080';

  if (!appId || !appSecret) {
    console.error('ERROR: FYERS_APP_ID and FYERS_APP_SECRET must be set in .env file');
    process.exit(1);
  }

  const config = {
    appId,
    appSecret,
    redirectUri,
  };

  // Check if tokens already exist
  const existingTokens = loadTokens();
  if (existingTokens && existingTokens.expiresAt > Date.now()) {
    console.log('Valid access token already exists.');
    console.log('Expires at:', new Date(existingTokens.expiresAt).toISOString());
    
    const reauth = await input.text('Do you want to re-authenticate? (y/n): ');
    if (reauth.toLowerCase() !== 'y') {
      console.log('Exiting without changes.');
      process.exit(0);
    }

    // Clear existing tokens
    clearTokens();
    console.log('Cleared existing tokens.\n');
  }

  // Generate auth URL
  const authUrl = generateAuthUrl(config);
  console.log('Step 1: Visit this URL to authenticate:');
  console.log(authUrl);
  console.log();

  // Get auth code from user
  const authCode = await input.text('Step 2: Paste the auth code from the redirect URL: ');

  if (!authCode) {
    console.error('ERROR: Auth code is required');
    process.exit(1);
  }

  console.log('\nStep 3: Exchanging auth code for access token...');

  try {
    const tokenData = await exchangeAuthCode(config, authCode);

    console.log('\n=== Authentication Successful! ===');
    console.log('Access token obtained and saved to disk.');
    console.log('Expires at:', new Date(tokenData.expiresAt).toISOString());
    console.log('\nYou can now use the trading features.');
  } catch (err) {
    console.error('\n=== Authentication Failed ===');
    console.error('Error:', String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
