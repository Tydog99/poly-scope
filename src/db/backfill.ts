/**
 * Backfill Runner
 *
 * Fetches historical trade data for wallets with incomplete history.
 * Processes wallets from the backfill queue in priority order.
 */

import type { TradeDB, DBTrade, DBAccount } from './index.js';
import type { SubgraphClient } from '../api/subgraph.js';
import type { SubgraphTrade } from '../api/types.js';

export interface BackfillOptions {
  maxWallets?: number;
  maxTimeMs?: number;
  batchSize?: number;
}

/**
 * Run backfill for queued wallets
 *
 * @param db - TradeDB instance
 * @param subgraph - SubgraphClient for fetching trades
 * @param options - Optional limits for batch processing
 * @returns Number of wallets processed
 */
export async function runBackfill(
  db: TradeDB,
  subgraph: SubgraphClient,
  options: BackfillOptions = {}
): Promise<number> {
  const queue = db.getBackfillQueue(options.maxWallets ?? 10);
  let processed = 0;
  const startTime = Date.now();

  for (const item of queue) {
    // Check time limit before processing each wallet
    if (options.maxTimeMs && Date.now() - startTime > options.maxTimeMs) {
      break;
    }

    await backfillWallet(db, subgraph, item.wallet);
    processed++;
  }

  return processed;
}

/**
 * Backfill all trades for a specific wallet
 *
 * Fetches trades from the subgraph in batches, paginating backwards
 * through time until all trades are fetched.
 *
 * @param db - TradeDB instance
 * @param subgraph - SubgraphClient for fetching trades
 * @param wallet - Wallet address to backfill
 */
export async function backfillWallet(
  db: TradeDB,
  subgraph: SubgraphClient,
  wallet: string
): Promise<void> {
  const normalizedWallet = wallet.toLowerCase();
  db.markBackfillStarted(normalizedWallet);

  try {
    // Get existing account info to determine where to start
    const account = db.getAccount(normalizedWallet);
    let cursor: number | undefined = account?.syncedFrom ?? undefined;

    // Initialize account if it doesn't exist
    if (!account) {
      const subgraphAccount = await subgraph.getAccount(normalizedWallet);
      const newAccount: DBAccount = {
        wallet: normalizedWallet,
        creationTimestamp: subgraphAccount?.creationTimestamp ?? null,
        syncedFrom: null,
        syncedTo: null,
        syncedAt: null,
        tradeCountTotal: subgraphAccount?.numTrades ?? null,
        collateralVolume: subgraphAccount ? parseInt(subgraphAccount.collateralVolume) : null,
        profit: subgraphAccount ? parseInt(subgraphAccount.profit) : null,
        hasFullHistory: false,
      };
      db.saveAccount(newAccount);
    }

    // Paginate through trades from newest to oldest
    const BATCH_SIZE = 100; // Match SubgraphClient default
    while (true) {
      const trades = await subgraph.getTradesByWallet(normalizedWallet, {
        before: cursor ? new Date(cursor * 1000) : undefined,
        limit: BATCH_SIZE,
        orderDirection: 'desc',
      });

      if (trades.length === 0) {
        break;
      }

      // Convert SubgraphTrade[] to DBTrade[]
      const dbTrades = convertTradesToDBFormat(trades, normalizedWallet);
      db.saveTrades(dbTrades);

      // Update cursor to the oldest trade timestamp for next page
      cursor = Math.min(...trades.map(t => t.timestamp));

      // If we got fewer trades than the batch size, we've reached the end
      if (trades.length < BATCH_SIZE) {
        break;
      }
    }

    // Mark wallet as complete
    db.markComplete(normalizedWallet);
    db.markBackfillComplete(normalizedWallet);
  } catch (e) {
    // Don't mark complete on error - will retry next time
    console.error(`Backfill failed for ${wallet}: ${(e as Error).message}`);
  }
}

/**
 * Convert SubgraphTrade[] to DBTrade[] format
 *
 * @param trades - Trades from subgraph
 * @param wallet - Wallet address we're backfilling
 * @returns Trades in database format
 */
function convertTradesToDBFormat(trades: SubgraphTrade[], wallet: string): DBTrade[] {
  return trades.map(trade => {
    const walletLower = wallet.toLowerCase();
    const isMaker = trade.maker.toLowerCase() === walletLower;
    const role = isMaker ? 'maker' : 'taker';

    // Determine action: taker's action is opposite of maker's side
    // If maker is selling, taker is buying (and vice versa)
    const action = isMaker
      ? (trade.side === 'Buy' ? 'BUY' : 'SELL')
      : (trade.side === 'Buy' ? 'SELL' : 'BUY');

    // Parse size and price (stored as strings with 6 decimals in subgraph)
    const sizeRaw = parseInt(trade.size);
    const priceRaw = parseFloat(trade.price); // Price is 0-1 decimal

    // For DBTrade, we store size as the USD value (already in 6 decimal format)
    // and price needs to be converted to 6 decimal integer format
    const priceInt = Math.round(priceRaw * 1e6);

    return {
      id: trade.id,
      txHash: trade.transactionHash,
      wallet: walletLower,
      marketId: trade.marketId,
      timestamp: trade.timestamp,
      side: trade.side,
      action,
      role,
      size: sizeRaw, // Already in 6 decimal format from subgraph
      price: priceInt,
      valueUsd: sizeRaw, // In subgraph, size IS the USD value
    };
  });
}
