import 'dotenv/config';
import { createSubgraphClient } from '../src/api/subgraph.js';

async function main() {
  const client = createSubgraphClient();
  if (!client) {
    console.log('No subgraph client - missing API key');
    process.exit(1);
  }

  const wallet = process.argv[2] || '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
  console.log('=== Wallet Investigation ===');
  console.log('Wallet:', wallet);
  console.log('');

  // 1. Get account summary
  console.log('--- Account Entity ---');
  const account = await client.getAccount(wallet);
  if (account) {
    const volume = parseFloat(account.collateralVolume) / 1e6;
    const profit = parseFloat(account.profit) / 1e6;
    console.log(`  numTrades: ${account.numTrades}`);
    console.log(`  collateralVolume: $${volume.toLocaleString()}`);
    console.log(`  profit: $${profit.toLocaleString()}`);
    console.log(`  creationTimestamp: ${new Date(account.creationTimestamp * 1000).toISOString()}`);
    console.log(`  lastSeenTimestamp: ${new Date(account.lastSeenTimestamp * 1000).toISOString()}`);
  } else {
    console.log('  (not found)');
  }
  console.log('');

  // 2. Get actual trades
  console.log('--- Actual Trades (last 50) ---');
  const trades = await client.getTradesByWallet(wallet, { limit: 50 });
  console.log(`  Found ${trades.length} trades`);

  if (trades.length > 0) {
    // Summary stats
    let totalVolume = 0;
    const markets = new Set<string>();

    for (const trade of trades) {
      const size = parseFloat(trade.size) / 1e6;
      const price = parseFloat(trade.price);  // Price is already 0-1 decimal
      totalVolume += size * price;
      markets.add(trade.marketId);
    }

    console.log(`  Total volume (from trades): $${totalVolume.toLocaleString()}`);
    console.log(`  Unique markets: ${markets.size}`);
    console.log('');

    // Show first 10 trades with raw values
    console.log('  Recent trades (with raw values):');
    for (const trade of trades.slice(0, 10)) {
      const size = parseFloat(trade.size) / 1e6;
      const price = parseFloat(trade.price);  // Price is already 0-1 decimal
      const value = size * price;
      const date = new Date(trade.timestamp * 1000);
      const role = trade.maker === wallet.toLowerCase() ? 'maker' : 'taker';
      console.log(`    ${date.toISOString().slice(0, 19)} ${trade.side.padEnd(4)} $${value.toFixed(2).padStart(10)} @ ${price.toFixed(4)} (${role})`);
      console.log(`      raw: size=${trade.size}, price=${trade.price}, market=${trade.marketId.slice(0, 20)}...`);
    }

    if (trades.length > 10) {
      console.log(`    ... and ${trades.length - 10} more`);
    }
  }
  console.log('');

  // 3. Get positions
  console.log('--- Positions ---');
  const positions = await client.getPositions(wallet);
  console.log(`  Found ${positions.length} positions`);

  if (positions.length > 0) {
    let totalNetValue = 0;
    for (const pos of positions.slice(0, 5)) {
      const netValue = parseFloat(pos.netValue) / 1e6;
      totalNetValue += netValue;
      console.log(`    Market ${pos.marketId.slice(0, 16)}... netValue: $${netValue.toLocaleString()}`);
    }
    if (positions.length > 5) {
      console.log(`    ... and ${positions.length - 5} more`);
    }
    console.log(`  Total net value: $${totalNetValue.toLocaleString()}`);
  }

  // 4. Test: Get high-limit trade count (to verify actual trade activity)
  console.log('');
  console.log('--- Trade Count Test (1000 limit) ---');
  const moreTrades = await client.getTradesByWallet(wallet, { limit: 1000 });
  console.log(`  Fetched ${moreTrades.length} trades (capped at 1000)`);
  if (moreTrades.length > 0) {
    let vol = 0;
    for (const t of moreTrades) {
      vol += (parseFloat(t.size) / 1e6) * parseFloat(t.price);
    }
    console.log(`  Volume from these trades: $${vol.toLocaleString()}`);
  }
}

main().catch(console.error);
