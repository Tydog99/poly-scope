#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { AnalyzeCommand } from './commands/analyze.js';
import { CLIReporter } from './output/cli.js';

const program = new Command();

program
  .name('polymarket-insider')
  .description('Detect potential insider trading on Polymarket')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a market for suspicious trades')
  .requiredOption('-m, --market <id>', 'Market condition ID to analyze')
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

    try {
      console.log('Fetching market data...\n');

      const report = await command.execute({
        marketId: opts.market,
        after: opts.after ? new Date(opts.after) : undefined,
        before: opts.before ? new Date(opts.before) : undefined,
        outcome: opts.outcome?.toUpperCase() as 'YES' | 'NO' | undefined,
      });

      console.log(reporter.formatAnalysisReport(report));
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
