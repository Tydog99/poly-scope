import chalk from 'chalk';
import type { AnalysisReport, SuspiciousTrade } from './types.js';
import type { WalletReport } from '../commands/investigate.js';

export class CLIReporter {
  formatAnalysisReport(report: AnalysisReport): string {
    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push(chalk.bold(`Market: "${report.market.question}"`));
    if (report.market.winningOutcome) {
      lines.push(chalk.gray(`→ Resolved ${chalk.green(report.market.winningOutcome.toUpperCase())}`));
    } else {
      lines.push(chalk.yellow('→ Unresolved (analyzing all trades)'));
    }
    lines.push('');
    lines.push(chalk.gray(`Total trades: ${report.totalTrades} | Analyzed: ${report.analyzedTrades}`));
    lines.push('');

    if (report.suspiciousTrades.length === 0) {
      lines.push(chalk.green('No suspicious trades detected.'));
      return lines.join('\n');
    }

    lines.push(chalk.bold.red('Top Suspicious Trades:'));
    lines.push(chalk.gray('Weights: Size 40% | Acct 35% | Conv 25%'));
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

    // Score breakdown by signal
    const breakdown = st.score.signals
      .map((s) => `${this.getSignalAbbrev(s.name)}:${s.score}/100`)
      .join(' | ');
    lines.push(`    ${chalk.gray(breakdown)}`);

    // Classifications
    if (st.classifications && st.classifications.length > 0) {
      const badges = st.classifications.map(c => {
        if (c === 'WHALE') return chalk.bgBlue.white(' WHALE ');
        if (c === 'SNIPER') return chalk.bgRed.white(' SNIPER ');
        if (c === 'EARLY_MOVER') return chalk.bgGreen.black(' EARLY MOVER ');
        if (c === 'DUMPING') return chalk.bgRed.white(' DUMPING ');
        return chalk.bgGray.white(` ${c} `);
      }).join(' ');
      lines.push(`    ${badges}`);
    }

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

  private getSignalAbbrev(name: string): string {
    const abbrevs: Record<string, string> = {
      tradeSize: 'Size',
      accountHistory: 'Acct',
      conviction: 'Conv',
    };
    return abbrevs[name] || name;
  }

  truncateWallet(wallet: string): string {
    if (wallet.length <= 10) return wallet;
    return `${wallet.slice(0, 6)}...${wallet.slice(-2)}`;
  }

  formatUsd(value: number): string {
    return '$' + Math.round(value).toLocaleString('en-US');
  }

  formatWalletReport(report: WalletReport): string {
    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push(chalk.bold('Wallet Investigation Report'));
    lines.push(chalk.gray('━'.repeat(50)));
    lines.push('');
    lines.push(`Wallet: ${chalk.cyan(report.wallet)}`);
    lines.push(`Data Source: ${chalk.gray(report.dataSource)}`);
    lines.push('');

    // Account History
    if (report.accountHistory) {
      const h = report.accountHistory;
      lines.push(chalk.bold('Account History:'));

      if (h.creationDate) {
        const ageDays = Math.floor(
          (Date.now() - h.creationDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        lines.push(`  Created: ${h.creationDate.toLocaleDateString()} (${ageDays} days ago)`);
      } else if (h.firstTradeDate) {
        const ageDays = Math.floor(
          (Date.now() - h.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        lines.push(`  First Trade: ${h.firstTradeDate.toLocaleDateString()} (${ageDays} days ago)`);
      }

      lines.push(`  Total Trades: ${h.totalTrades.toLocaleString()}`);
      lines.push(`  Total Volume: ${this.formatUsd(h.totalVolumeUsd)}`);

      if (h.profitUsd !== undefined) {
        const profitColor = h.profitUsd >= 0 ? chalk.green : chalk.red;
        const sign = h.profitUsd >= 0 ? '+' : '';
        lines.push(`  Profit/Loss: ${profitColor(sign + this.formatUsd(h.profitUsd))}`);

        if (h.totalVolumeUsd > 0) {
          const roi = (h.profitUsd / h.totalVolumeUsd) * 100;
          lines.push(`  ROI: ${profitColor(sign + roi.toFixed(1) + '%')}`);
        }
      }

      if (h.lastTradeDate) {
        const daysSince = Math.floor(
          (Date.now() - h.lastTradeDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        lines.push(`  Last Active: ${h.lastTradeDate.toLocaleDateString()} (${daysSince} days ago)`);
      }

      lines.push('');
    } else {
      lines.push(chalk.yellow('No account history found'));
      lines.push('');
    }

    // Positions
    if (report.positions.length > 0) {
      lines.push(chalk.bold(`Positions (${report.positions.length}):`));
      for (const pos of report.positions.slice(0, 10)) {
        const netValue = parseFloat(pos.netValue) / 1e6;
        const netQty = parseFloat(pos.netQuantity) / 1e6;
        const valueColor = netValue >= 0 ? chalk.green : chalk.red;
        lines.push(
          `  ${chalk.gray(pos.marketId.slice(0, 16))}... ${valueColor(this.formatUsd(netValue))} (${netQty.toFixed(0)} shares)`
        );
      }
      if (report.positions.length > 10) {
        lines.push(chalk.gray(`  ... and ${report.positions.length - 10} more`));
      }
      lines.push('');
    }

    // Recent Trades
    if (report.recentTrades.length > 0) {
      lines.push(chalk.bold(`Recent Trades (${report.recentTrades.length}):`));
      for (const trade of report.recentTrades.slice(0, 10)) {
        const size = parseFloat(trade.size) / 1e6;
        const price = parseFloat(trade.price);
        const value = size * price;
        const date = new Date(trade.timestamp * 1000);
        const sideColor = trade.side === 'Buy' ? chalk.green : chalk.red;
        lines.push(
          `  ${date.toLocaleDateString()} ${sideColor(trade.side.padEnd(4))} ${this.formatUsd(value).padStart(10)} @ ${price.toFixed(2)}`
        );
      }
      if (report.recentTrades.length > 10) {
        lines.push(chalk.gray(`  ... and ${report.recentTrades.length - 10} more`));
      }
      lines.push('');
    }

    // Suspicion Factors
    lines.push(chalk.bold('Suspicion Analysis:'));
    for (const factor of report.suspicionFactors) {
      const isNegative = factor.includes('No obvious');
      const icon = isNegative ? chalk.green('✓') : chalk.yellow('⚠');
      lines.push(`  ${icon} ${factor}`);
    }
    lines.push('');

    return lines.join('\n');
  }
}
