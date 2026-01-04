import { createHmac } from 'crypto';

export interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  wallet: string;
}

export function loadCredentials(): ApiCredentials {
  const apiKey = process.env.POLY_API_KEY;
  const secret = process.env.POLY_API_SECRET;
  const passphrase = process.env.POLY_PASSPHRASE;
  const wallet = process.env.POLY_WALLET;

  if (!apiKey || !secret || !passphrase || !wallet) {
    throw new Error(
      'Missing API credentials. Set POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE, and POLY_WALLET.\n' +
      'Run: PRIVATE_KEY=0x... npx tsx scripts/get-api-keys.ts'
    );
  }

  return { apiKey, secret, passphrase, wallet };
}

export function createL2Headers(
  creds: ApiCredentials,
  method: string,
  path: string,
  body?: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Build the message to sign: timestamp + method + path + body
  const message = timestamp + method + path + (body || '');

  // Create HMAC-SHA256 signature
  const signature = createHmac('sha256', Buffer.from(creds.secret, 'base64'))
    .update(message)
    .digest('base64');

  return {
    'POLY_ADDRESS': creds.wallet,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}
