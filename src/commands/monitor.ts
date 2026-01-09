import chalk from 'chalk';
import { MonitorStream } from '../monitor/stream.js';
import { MonitorEvaluator } from '../monitor/evaluator.js';
import { AccountFetcher } from '../api/accounts.js';
import { createSubgraphClient, type SubgraphClient } from '../api/subgraph.js';
import { SlugResolver } from '../api/slug.js';
import { loadConfig } from '../config.js';
import { formatMonitorBanner, formatMonitorTrade, formatMonitorAlert } from '../output/cli.js';
import type { MonitorOptions } from '../monitor/types.js';
import type { TradeDB } from '../db/index.js';

/**
 * Run opportunistic backfill during idle periods
 * Drains up to 3 wallets from the queue when monitor is idle
 */
async function runIdleBackfill(
  subgraphClient: SubgraphClient | null,
  db: TradeDB | null
): Promise<void> {
  if (!subgraphClient || !db) return;

  try {
    const queue = db.getBackfillQueue(3);
    if (queue.length === 0) return;

    const { runBackfill } = await import('../db/backfill.js');
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.dim(`[${time}] Idle - backfilling ${queue.length} wallet(s)...`));

    await runBackfill(db, subgraphClient, { maxWallets: 3, maxTimeMs: 10000 });
  } catch (e) {
    // Don't interrupt monitoring if backfill fails
  }
}

/**
 * Execute the monitor command
 */
export async function executeMonitor(options: MonitorOptions): Promise<void> {
  const config = loadConfig();

  // Merge CLI markets with config watchlist
  const allMarkets = [...new Set([...options.markets, ...config.watchlist])];

  if (allMarkets.length === 0) {
    console.error(chalk.red('Error: No markets specified. Use -m or add to config watchlist.'));
    process.exit(1);
  }

  // Resolve market slugs to verify they exist
  console.log('Resolving markets...');
  const slugResolver = new SlugResolver();
  const resolvedMarkets: Array<{ slug: string; question: string }> = [];

  for (const market of allMarkets) {
    try {
      const resolved = await slugResolver.resolve(market);
      // Take the first market's question (events may have multiple markets)
      const question = resolved[0]?.question || market;
      resolvedMarkets.push({ slug: market, question });
    } catch (error) {
      console.error(chalk.yellow(`Warning: Could not resolve market "${market}", skipping`));
    }
  }

  if (resolvedMarkets.length === 0) {
    console.error(chalk.red('Error: No valid markets found.'));
    process.exit(1);
  }

  // Initialize components
  const subgraphClient = createSubgraphClient({
    timeout: config.subgraph.timeout,
    retries: config.subgraph.retries,
  });

  const accountFetcher = new AccountFetcher({
    subgraphClient,
  });

  const evaluator = new MonitorEvaluator({
    minSize: options.minSize,
    threshold: options.threshold,
    config,
  });

  const streamConfig = {
    maxReconnects: options.maxReconnects,
    retryDelaySeconds: options.retryDelaySeconds,
    stabilityThresholdSeconds: config.monitor.stabilityThresholdSeconds,
    backoff: config.monitor.backoff,
  };

  const stream = new MonitorStream(
    resolvedMarkets.map(m => m.slug),
    streamConfig
  );

  // Market slug to question map for alerts
  const marketQuestions = new Map(resolvedMarkets.map(m => [m.slug, m.question]));

  // Idle backfill timer - triggers after 30s with no trades
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let db: TradeDB | null = null;
  const IDLE_BACKFILL_DELAY_MS = 30000; // 30 seconds

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
      await runIdleBackfill(subgraphClient, db);
    }, IDLE_BACKFILL_DELAY_MS);
  };

  // Initialize database for idle backfill
  try {
    const { TradeDB } = await import('../db/index.js');
    db = new TradeDB();
  } catch (e) {
    // DB not available, skip idle backfill
    if (options.verbose) {
      console.log(chalk.dim('Database not available, skipping idle backfill'));
    }
  }

  // Display startup banner
  console.log(formatMonitorBanner(
    resolvedMarkets.map(m => m.slug),
    options.threshold,
    options.minSize
  ));
  console.log();

  // Set up event handlers
  stream.on('connected', () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.green(`[${time}] Connected to WebSocket`));
    console.log(chalk.dim(`[${time}] Subscribed to: ${resolvedMarkets.map(m => m.slug).join(', ')}`));
    console.log();
    console.log('Monitoring... (Ctrl+C to stop)');
    console.log();
    // Start idle timer on connection
    resetIdleTimer();
  });

  stream.on('disconnected', () => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.yellow(`[${time}] Connection lost`));
  });

  stream.on('reconnecting', (attempt: number, max: number) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.yellow(`[${time}] Reconnecting (${attempt}/${max})...`));
  });

  stream.on('retryWait', (seconds: number) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(chalk.red(`[${time}] Max reconnections reached. Retrying in ${seconds}s...`));
  });

  stream.on('error', (error: Error) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.error(chalk.red(`[${time}] Error: ${error.message}`));
  });

  stream.on('trade', async (event) => {
    // Reset idle timer on each trade
    resetIdleTimer();

    // Quick filter by size
    if (!evaluator.shouldEvaluate(event)) {
      return;
    }

    // Get account history (from cache or fetch)
    let account = evaluator.getCached(event.proxyWallet);

    if (!account) {
      try {
        account = await accountFetcher.getAccountHistory(event.proxyWallet);
        if (account) {
          evaluator.cacheAccount(event.proxyWallet, account);
        }
      } catch (error) {
        // Log in verbose mode, continue without account data
        if (options.verbose) {
          const time = new Date().toLocaleTimeString('en-US', { hour12: false });
          const walletShort = `${event.proxyWallet.slice(0, 6)}...${event.proxyWallet.slice(-4)}`;
          const errMsg = error instanceof Error ? error.message : 'unknown error';
          console.error(chalk.yellow(`[${time}] Failed to fetch account for ${walletShort}: ${errMsg}`));
        }
      }
    }

    // Evaluate the trade
    const evaluated = await evaluator.evaluate(event, account ?? undefined);

    // Output based on mode
    if (evaluated.isAlert) {
      const question = marketQuestions.get(event.slug) || event.slug;
      console.log(formatMonitorAlert(evaluated, question));
    } else if (options.verbose) {
      console.log(formatMonitorTrade(evaluated));
    }
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log();
    console.log(chalk.dim('Stopping monitor...'));
    // Clean up idle timer
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    // Close database
    if (db) {
      db.close();
    }
    stream.stop();
    process.exit(0);
  });

  // Start the stream
  await stream.start();
}
