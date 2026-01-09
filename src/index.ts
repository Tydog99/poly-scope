#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { AnalyzeCommand } from './commands/analyze.js';
import { InvestigateCommand } from './commands/investigate.js';
import { executeMonitor } from './commands/monitor.js';
import { CLIReporter } from './output/cli.js';
import { SlugResolver } from './api/slug.js';
import { promptMarketSelection } from './cli/prompt.js';

const program = new Command();

program
  .name('polymarket-insider')
  .description('Detect potential insider trading on Polymarket')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a market for suspicious trades')
  .requiredOption('-m, --market <slug|conditionId>', 'Market slug (e.g., "maduro-out-in-2025") or condition ID')
  .option('--all', 'Analyze all markets in an event (when slug has multiple markets)')
  .option('--after <date>', 'Only include trades after this date')
  .option('--before <date>', 'Only include trades before this date')
  .option('--outcome <YES|NO>', 'Filter to specific outcome')
  .option('--config <path>', 'Path to config file', './config.json')
  .option('--max-trades <number>', 'Max trades to fetch initially (default: 10000)', parseInt)
  .option('--top <number>', 'Number of top suspicious trades to show (default: 50)', parseInt)
  .option('--min-size <usd>', 'Override minimum trade size', parseFloat)
  .option('--threshold <score>', 'Override alert threshold', parseFloat)
  .option('--no-subgraph', 'Disable subgraph and use Data API only')
  .option('--no-cache', 'Disable account/redemption caching (cache is ON by default)')
  .option('--role <taker|maker|both>', 'Filter trades by participant role (default: taker to avoid double-counting)')
  .option('-w, --wallet <address>', 'Analyze a specific wallet\'s trades on this market (shows all trades with verbose scoring)')
  .option('--debug', 'Show detailed score breakdowns for each trade')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    // Apply CLI overrides
    if (opts.minSize) config.tradeSize.minAbsoluteUsd = opts.minSize;
    if (opts.threshold) config.alertThreshold = opts.threshold;
    if (opts.subgraph === false) config.subgraph.enabled = false;

    const command = new AnalyzeCommand(config);
    const reporter = new CLIReporter({ debug: opts.debug });
    const slugResolver = new SlugResolver();

    try {
      // Resolve slug or condition ID to market(s)
      console.log(`Resolving market: ${opts.market}...\n`);
      const markets = await slugResolver.resolve(opts.market);

      if (markets.length > 1 && !opts.all) {
        console.log(`Found ${markets.length} markets for "${opts.market}":\n`);
        markets.forEach((m, i) => {
          console.log(`  ${i + 1}. ${m.question}`);
          console.log(`     ID: ${m.conditionId}\n`);
        });

        const selectedIndex = await promptMarketSelection(markets);
        if (selectedIndex >= 0) {
          // Single market selected
          markets.splice(0, markets.length, markets[selectedIndex]);
        } else if (opts.wallet) {
          // "All" selected but -w flag is present
          console.error('Error: --wallet (-w) cannot be used when analyzing all markets');
          process.exit(1);
        }
        // If -1 (all) without -w, keep markets array as-is
      }

      // Validate -w is not used with --all flag
      if (opts.wallet && opts.all) {
        console.error('Error: --wallet (-w) cannot be used with --all flag');
        process.exit(1);
      }

      for (const market of markets) {
        console.log(`Analyzing: ${market.question}...\n`);

        const report = await command.execute({
          marketId: market.conditionId,
          after: opts.after ? new Date(opts.after) : undefined,
          // Use end of day for --before (23:59:59.999) so "before 2026-01-03" includes all of Jan 3
          before: opts.before ? new Date(new Date(opts.before).getTime() + 24 * 60 * 60 * 1000 - 1) : undefined,
          outcome: opts.outcome?.toUpperCase() as 'YES' | 'NO' | undefined,
          maxTrades: opts.maxTrades,
          topN: opts.top,
          role: opts.role as 'taker' | 'maker' | 'both' | undefined,
          wallet: opts.wallet,
        });

        // Use wallet-specific output format when -w is provided
        if (opts.wallet) {
          console.log(reporter.formatWalletAnalysis(report));
        } else {
          console.log(reporter.formatAnalysisReport(report));
        }

        if (markets.length > 1) {
          console.log('\n' + '═'.repeat(60) + '\n');
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('investigate')
  .description('Deep-dive investigation of a specific wallet')
  .requiredOption('-w, --wallet <address>', 'Wallet address to investigate')
  .option('-m, --market <conditionId>', 'Filter to a specific market (condition ID)')
  .option('--trades <number>', 'Number of recent trades to fetch (default: 500)', parseInt)
  .option('--threshold <score>', 'Override alert threshold (default: 70)', parseFloat)
  .option('--config <path>', 'Path to config file', './config.json')
  .option('--no-subgraph', 'Disable subgraph and use Data API only')
  .option('--debug', 'Show detailed score breakdowns for each trade')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    // Apply CLI overrides
    if (opts.subgraph === false) config.subgraph.enabled = false;
    if (opts.threshold) config.alertThreshold = opts.threshold;

    const command = new InvestigateCommand(config);
    const reporter = new CLIReporter({ debug: opts.debug });

    try {
      console.log(`Investigating wallet: ${opts.wallet}...\n`);

      const report = await command.execute({
        wallet: opts.wallet,
        tradeLimit: opts.trades,
        market: opts.market,
      });

      console.log(reporter.formatWalletReport(report));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('monitor')
  .description('Watch markets in real-time for suspicious activity')
  .option('-m, --market <slugs>', 'Comma-separated market slugs to watch', (val) => val.split(','))
  .option('--min-size <usd>', 'Minimum trade size to evaluate', (val) => parseInt(val, 10), 5000)
  .option('--threshold <score>', 'Alert threshold (0-100)', (val) => parseInt(val, 10), 70)
  .option('--max-reconnects <n>', 'Max reconnection attempts', (val) => parseInt(val, 10), 10)
  .option('--retry-delay <seconds>', 'Delay after max reconnects', (val) => parseInt(val, 10), 300)
  .option('--verbose', 'Show all evaluated trades', false)
  .action(async (options) => {
    await executeMonitor({
      markets: options.market || [],
      minSize: options.minSize,
      threshold: options.threshold,
      maxReconnects: options.maxReconnects,
      retryDelaySeconds: options.retryDelay,
      verbose: options.verbose,
    });
  });

// DB management commands
const dbCommand = program.command('db').description('Database management commands');

dbCommand
  .command('status')
  .description('Show database statistics')
  .action(async () => {
    const { TradeDB } = await import('./db/index.js');
    const db = new TradeDB();
    const status = db.getStatus();
    const { statSync } = await import('fs');
    const sizeMB = (statSync(status.path).size / 1024 / 1024).toFixed(2);

    console.log(`Database: ${status.path} (${sizeMB} MB)`);
    console.log(`Trades: ${status.trades.toLocaleString()}`);
    console.log(`Accounts: ${status.accounts.toLocaleString()}`);
    console.log(`Redemptions: ${status.redemptions.toLocaleString()}`);
    console.log(`Markets: ${status.markets.toLocaleString()}`);
    console.log(`Backfill queue: ${status.backfillQueue}`);
    db.close();
  });

dbCommand
  .command('wallet <address>')
  .description('Show database info for a wallet')
  .action(async (address: string) => {
    const { TradeDB } = await import('./db/index.js');
    const db = new TradeDB();
    const account = db.getAccount(address);

    if (!account) {
      console.log(`Wallet ${address} not found in database`);
      db.close();
      return;
    }

    console.log(`Wallet: ${account.wallet}`);
    console.log(`Created: ${account.creationTimestamp ? new Date(account.creationTimestamp * 1000).toISOString() : 'unknown'}`);
    console.log(`Synced: ${account.syncedFrom ? new Date(account.syncedFrom * 1000).toISOString() : 'never'} to ${account.syncedTo ? new Date(account.syncedTo * 1000).toISOString() : 'never'}`);
    console.log(`Trades in DB: ${db.getTradesForWallet(address).length}`);
    console.log(`Complete: ${account.hasFullHistory ? 'Yes' : 'No'}`);
    if (db.hasQueuedBackfill(address)) console.log(`Backfill: Queued`);
    db.close();
  });

dbCommand
  .command('import')
  .description('Import data from JSON cache files')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { importJsonCaches } = await import('./db/migrate.js');
    const db = new TradeDB();

    console.log(`Importing from ${opts.cacheDir}...`);
    const result = importJsonCaches(db, opts.cacheDir);

    console.log(`Imported ${result.trades} trades, ${result.accounts} accounts, ${result.redemptions} redemptions`);
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      result.errors.forEach(e => console.log(`  - ${e}`));
    }
    db.close();
  });

dbCommand
  .command('validate')
  .description('Validate migration from JSON cache')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { validateMigration } = await import('./db/migrate.js');
    const db = new TradeDB();

    const result = validateMigration(db, opts.cacheDir);

    console.log(`Trades:      ${result.dbCounts.trades} DB ${result.dbCounts.trades === result.jsonCounts.trades ? '==' : '!='} ${result.jsonCounts.trades} JSON`);
    console.log(`Accounts:    ${result.dbCounts.accounts} DB ${result.dbCounts.accounts === result.jsonCounts.accounts ? '==' : '!='} ${result.jsonCounts.accounts} JSON`);
    console.log(`Redemptions: ${result.dbCounts.redemptions} DB ${result.dbCounts.redemptions === result.jsonCounts.redemptions ? '==' : '!='} ${result.jsonCounts.redemptions} JSON`);
    console.log(result.valid ? '\nValidation passed' : '\nValidation failed');
    result.warnings.forEach(w => console.log(`  Warning: ${w}`));
    db.close();
    process.exit(result.valid ? 0 : 1);
  });

dbCommand
  .command('cleanup-cache')
  .description('Remove JSON cache after successful migration')
  .option('--cache-dir <path>', 'Cache directory', '.cache')
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { validateMigration } = await import('./db/migrate.js');
    const { rmSync, existsSync } = await import('fs');
    const db = new TradeDB();

    const result = validateMigration(db, opts.cacheDir);
    if (!result.valid) {
      console.error('Validation failed - cannot cleanup. Run "db validate" for details.');
      db.close();
      process.exit(1);
    }

    if (!existsSync(opts.cacheDir)) {
      console.log('Cache directory does not exist - nothing to clean up.');
      db.close();
      return;
    }

    rmSync(opts.cacheDir, { recursive: true });
    console.log(`Removed ${opts.cacheDir}`);
    db.close();
  });

dbCommand
  .command('queue')
  .description('Show pending backfill queue')
  .option('--limit <n>', 'Maximum entries to show', parseInt)
  .action(async (opts) => {
    const { TradeDB } = await import('./db/index.js');
    const db = new TradeDB();
    const queue = db.getBackfillQueue(opts.limit);

    if (queue.length === 0) {
      console.log('Backfill queue is empty');
      db.close();
      return;
    }

    console.log(`Backfill queue (${queue.length} pending):\n`);
    console.log('Priority  Wallet                                      Queued');
    console.log('--------  ------------------------------------------  -------------------');

    for (const item of queue) {
      const queuedAt = item.createdAt
        ? new Date(item.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : 'unknown';
      console.log(`${String(item.priority).padStart(8)}  ${item.wallet}  ${queuedAt}`);
    }

    db.close();
  });

dbCommand
  .command('backfill [wallet]')
  .description('Backfill trade history for queued wallets or a specific wallet')
  .option('--max <n>', 'Maximum wallets to process', parseInt)
  .action(async (wallet: string | undefined, opts) => {
    const { TradeDB } = await import('./db/index.js');
    const { createSubgraphClient } = await import('./api/subgraph.js');
    const { runBackfill, backfillWallet } = await import('./db/backfill.js');

    const db = new TradeDB();
    const subgraph = createSubgraphClient();

    if (!subgraph) {
      console.error('Error: THE_GRAPH_API_KEY environment variable is required');
      db.close();
      process.exit(1);
    }

    if (wallet) {
      console.log(`Backfilling ${wallet}...`);
      await backfillWallet(db, subgraph, wallet);
      console.log('Done');
    } else {
      const queueSize = db.getBackfillQueue().length;
      console.log(`Processing ${Math.min(opts.max ?? 10, queueSize)} of ${queueSize} queued wallets...`);
      const processed = await runBackfill(db, subgraph, { maxWallets: opts.max });
      console.log(`Processed ${processed} wallets`);
    }

    db.close();
  });

program.parse();
