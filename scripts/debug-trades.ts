import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

async function main() {
  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    new Wallet(process.env.POLY_PRIVATE_KEY!),
    {
      key: process.env.POLY_API_KEY!,
      secret: process.env.POLY_API_SECRET!,
      passphrase: process.env.POLY_PASSPHRASE!,
    }
  );

  // Try various param combinations
  const conditionId = '0xafc235557ace53ff0b0d2e93392314a7c3f3daab26a79050e985c11282f66df7';
  const yesTokenId = '45343480653694577807177505914664405669209636932459044719445554137639656106379';

  console.log('1. Trying with market param...');
  let trades = await client.getTrades({ market: conditionId });
  console.log('   Result:', trades.length, 'trades');

  console.log('2. Trying with asset_id param...');
  trades = await client.getTrades({ asset_id: yesTokenId });
  console.log('   Result:', trades.length, 'trades');

  console.log('3. Trying with taker_address (your wallet)...');
  const wallet = new Wallet(process.env.POLY_PRIVATE_KEY!);
  trades = await client.getTrades({ taker_address: wallet.address });
  console.log('   Result:', trades.length, 'trades');

  console.log('4. Trying with no params (all trades)...');
  trades = await client.getTrades({});
  console.log('   Result:', trades.length, 'trades');
  if (trades.length > 0) {
    console.log('   First trade:', JSON.stringify(trades[0], null, 2));
  }
}

main().catch(console.error);
