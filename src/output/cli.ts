import chalk from 'chalk';
import type { AnalysisReport, SuspiciousTrade } from './types.js';

export class CLIReporter {
  formatAnalysisReport(report: AnalysisReport): string {
    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push(chalk.bold(`Market: "${report.market.question}"`));
    lines.push(chalk.gray(`→ Resolved ${chalk.green(report.market.winningOutcome?.toUpperCase())}`));
    lines.push('');
    lines.push(chalk.gray(`Total trades: ${report.totalTrades} | Winning side: ${report.winningTrades}`));
    lines.push('');

    if (report.suspiciousTrades.length === 0) {
      lines.push(chalk.green('No suspicious trades detected.'));
      return lines.join('\n');
    }

    lines.push(chalk.bold.red('Top Suspicious Trades:'));
    lines.push(chalk.gray('━'.repeat(50)));

    report.suspiciousTrades.forEach((st, idx) => {
      lines.push(this.formatSuspiciousTrade(st, idx + 1));
      lines.push('');
    });

    return lines.join('\n');
  }

  private formatSuspiciousTrade(st: SuspiciousTrade, rank: number): string {
    const lines: string[] = [];
    const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;

    lines.push(`#${rank}  Score: ${scoreColor.bold(`${st.score.total}/100`)}`);
    lines.push(`    Wallet: ${chalk.cyan(this.truncateWallet(st.trade.wallet))}`);
    lines.push(`    Trade: ${this.formatUsd(st.trade.valueUsd)} ${st.trade.outcome} @ ${st.trade.price.toFixed(2)}`);

    if (st.priceImpact) {
      lines.push(`    Impact: ${st.priceImpact.before.toFixed(2)} → ${st.priceImpact.after.toFixed(2)} (+${st.priceImpact.changePercent}%)`);
    }

    if (st.accountHistory) {
      const age = st.accountHistory.firstTradeDate
        ? Math.floor((Date.now() - st.accountHistory.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      lines.push(`    Account: ${st.accountHistory.totalTrades} lifetime trades, ${age} days old`);
    }

    return lines.join('\n');
  }

  truncateWallet(wallet: string): string {
    if (wallet.length <= 10) return wallet;
    return `${wallet.slice(0, 6)}...${wallet.slice(-2)}`;
  }

  formatUsd(value: number): string {
    return '$' + Math.round(value).toLocaleString('en-US');
  }
}
