#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { AnalyzeCommand } from './commands/analyze.js';
import { InvestigateCommand } from './commands/investigate.js';
import { CLIReporter } from './output/cli.js';
import { SlugResolver } from './api/slug.js';

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
    if (opts.cache === false) config.subgraph.cacheAccountLookup = false;

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
        console.log('Use --all to analyze all markets, or pass a specific condition ID with -m');
        return;
      }

      // Validate -w is not used with --all
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

        console.log(reporter.formatAnalysisReport(report));

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
  .option('--analyze-limit <number>', 'Number of trades to analyze for suspicious patterns (default: 100, 0 to disable)', parseInt)
  .option('--config <path>', 'Path to config file', './config.json')
  .option('--no-subgraph', 'Disable subgraph and use Data API only')
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    // Apply CLI overrides
    if (opts.subgraph === false) config.subgraph.enabled = false;

    const command = new InvestigateCommand(config);
    const reporter = new CLIReporter();

    try {
      console.log(`Investigating wallet: ${opts.wallet}...\n`);

      const report = await command.execute({
        wallet: opts.wallet,
        tradeLimit: opts.trades,
        analyzeLimit: opts.analyzeLimit,
        market: opts.market,
      });

      console.log(reporter.formatWalletReport(report));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
