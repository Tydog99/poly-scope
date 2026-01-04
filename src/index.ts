#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { AnalyzeCommand } from './commands/analyze.js';
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
  .option('--min-size <usd>', 'Override minimum trade size', parseFloat)
  .option('--threshold <score>', 'Override alert threshold', parseFloat)
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    // Apply CLI overrides
    if (opts.minSize) config.tradeSize.minAbsoluteUsd = opts.minSize;
    if (opts.threshold) config.alertThreshold = opts.threshold;

    const command = new AnalyzeCommand(config);
    const reporter = new CLIReporter();
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

      for (const market of markets) {
        console.log(`Analyzing: ${market.question}...\n`);

        const report = await command.execute({
          marketId: market.conditionId,
          after: opts.after ? new Date(opts.after) : undefined,
          before: opts.before ? new Date(opts.before) : undefined,
          outcome: opts.outcome?.toUpperCase() as 'YES' | 'NO' | undefined,
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

program.parse();
