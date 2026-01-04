import { createHmac } from 'crypto';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
  wallet: string;
}

export function loadCredentials(): ApiCredentials {
  const key = process.env.POLY_API_KEY;
  const secret = process.env.POLY_API_SECRET;
  const passphrase = process.env.POLY_PASSPHRASE;
  const wallet = process.env.POLY_WALLET;

  if (!key || !secret || !passphrase || !wallet) {
    throw new Error(
      'Missing API credentials. Set POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE, and POLY_WALLET.\n' +
      'Run: npx tsx scripts/get-api-keys.ts --private-key 0x...'
    );
  }

  return { key, secret, passphrase, wallet };
}

export function createL2Headers(
  creds: ApiCredentials,
  method: string,
  requestPath: string,
  body?: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Build the message to sign: timestamp + method + requestPath + body
  let message = `${timestamp}${method}${requestPath}`;
  if (body) {
    message += body;
  }

  // Create HMAC-SHA256 signature with base64 secret
  const signature = createHmac('sha256', Buffer.from(creds.secret, 'base64'))
    .update(message)
    .digest('base64');

  // Convert to URL-safe base64 (+ -> -, / -> _)
  const signatureUrlSafe = signature.replace(/\+/g, '-').replace(/\//g, '_');

  return {
    'POLY_ADDRESS': creds.wallet,
    'POLY_SIGNATURE': signatureUrlSafe,
    'POLY_TIMESTAMP': `${timestamp}`,
    'POLY_API_KEY': creds.key,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}
