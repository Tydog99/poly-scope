#!/usr/bin/env npx tsx
/**
 * Generate Polymarket API credentials from your private key.
 *
 * Usage:
 *   npx tsx scripts/get-api-keys.ts --private-key 0x...
 *
 * This will output your API credentials which you can save to .env
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

function parseArgs(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--private-key' || args[i] === '-k') {
      return args[i + 1] || null;
    }
  }
  return null;
}

async function main() {
  const privateKey = parseArgs();

  if (!privateKey) {
    console.error('Error: --private-key flag is required');
    console.log('\nUsage:');
    console.log('  npx tsx scripts/get-api-keys.ts --private-key 0x...');
    console.log('\nYour private key can be exported from MetaMask:');
    console.log('  1. Open MetaMask');
    console.log('  2. Click the three dots menu → Account Details');
    console.log('  3. Click "Show Private Key"');
    console.log('  4. Enter your password and copy the key');
    process.exit(1);
  }

  try {
    const signer = new Wallet(privateKey);
    console.log(`\nWallet address: ${signer.address}`);

    const client = new ClobClient(HOST, CHAIN_ID, signer);

    console.log('\nDeriving API credentials...');
    const creds = await client.createOrDeriveApiKey();

    console.log('\n✓ API credentials generated!\n');
    console.log('Add these to your .env file:\n');
    console.log(`POLY_API_KEY=${creds.apiKey}`);
    console.log(`POLY_API_SECRET=${creds.secret}`);
    console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
    console.log(`POLY_WALLET=${signer.address}`);

    console.log('\n---');
    console.log('Keep your private key secure. The API credentials above');
    console.log('can be used without exposing your private key.');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
