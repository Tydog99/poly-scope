/**
 * Backfill Runner
 *
 * Fetches historical trade data for wallets with incomplete history.
 * Processes wallets from the backfill queue in priority order.
 */

import type { TradeDB, DBEnrichedOrderFill, DBAccount } from './index.js';
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

      // Convert SubgraphTrade[] to DBEnrichedOrderFill[]
      const dbFills = convertTradesToDBFormat(trades);
      db.saveFills(dbFills);

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
 * Convert SubgraphTrade[] to DBEnrichedOrderFill[] format
 */
function convertTradesToDBFormat(trades: SubgraphTrade[]): DBEnrichedOrderFill[] {
  return trades.map(trade => ({
    id: trade.id,
    transactionHash: trade.transactionHash,
    timestamp: trade.timestamp,
    orderHash: (trade as any).orderHash ?? trade.id,
    side: trade.side,
    size: parseInt(trade.size),
    price: Math.round(parseFloat(trade.price) * 1e6),
    maker: trade.maker.toLowerCase(),
    taker: trade.taker.toLowerCase(),
    market: trade.marketId,
  }));
}
