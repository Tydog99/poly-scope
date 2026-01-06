import chalk, { type ChalkInstance } from 'chalk';
import type { AnalysisReport, SuspiciousTrade } from './types.js';
import type { WalletReport } from '../commands/investigate.js';

// Colors for repeat wallets (excluding cyan which is for single-appearance)
const WALLET_COLORS: ChalkInstance[] = [
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
  chalk.magentaBright,
  chalk.yellowBright,
  chalk.greenBright,
  chalk.blueBright,
  chalk.redBright,
];

interface WalletStats {
  count: number;
  totalVolume: number;
  color: ChalkInstance;
}

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

    // Pre-scan wallets to find repeats and calculate stats
    const walletStats = this.calculateWalletStats(report.suspiciousTrades);

    lines.push(chalk.bold.red(`Top ${report.suspiciousTrades.length} Suspicious Trades:`));
    lines.push(chalk.gray('Weights: Size 40% | Acct 35% | Conv 25%'));
    lines.push('');

    // Table header
    const header = [
      chalk.bold('#'.padStart(3)),
      chalk.bold('Score'),
      chalk.bold('Size'),
      chalk.bold('Acct'),
      chalk.bold('Conv'),
      chalk.bold('Time'.padEnd(15)),
      chalk.bold('Wallet'),
      chalk.bold('Trade'),
      chalk.bold('Tags'),
    ].join('  ');
    lines.push(header);
    lines.push(chalk.gray('─'.repeat(120)));

    report.suspiciousTrades.forEach((st, idx) => {
      lines.push(this.formatSuspiciousTradeRow(st, idx + 1, walletStats));
    });

    // Add wallet summary footer with full addresses for easy copying
    const repeatWallets = this.getRepeatWalletsSummary(walletStats);
    if (repeatWallets.length > 0) {
      lines.push('');
      lines.push(chalk.gray('─'.repeat(120)));
      lines.push('');
      lines.push(chalk.bold('Repeat Wallets (investigate these):'));
      repeatWallets.forEach(({ wallet, stats }, idx) => {
        const arrow = idx === 0 ? chalk.red(' ← top suspect') : '';
        lines.push(
          `  ${stats.color(wallet)}  ` +
          `${String(stats.count).padStart(2)} trades  ` +
          `${this.formatUsd(stats.totalVolume).padStart(12)} total` +
          arrow
        );
      });
    }

    lines.push('');
    return lines.join('\n');
  }

  private calculateWalletStats(trades: SuspiciousTrade[]): Map<string, WalletStats> {
    const stats = new Map<string, WalletStats>();

    // First pass: count occurrences and sum volumes
    for (const st of trades) {
      const wallet = st.trade.wallet;
      const existing = stats.get(wallet);
      if (existing) {
        existing.count++;
        existing.totalVolume += st.trade.valueUsd;
      } else {
        stats.set(wallet, {
          count: 1,
          totalVolume: st.trade.valueUsd,
          color: chalk.cyan, // Default for single appearance
        });
      }
    }

    // Second pass: assign colors to repeat wallets (sorted by volume)
    const repeatWallets = [...stats.entries()]
      .filter(([, s]) => s.count >= 2)
      .sort((a, b) => b[1].totalVolume - a[1].totalVolume);

    repeatWallets.forEach(([wallet], idx) => {
      const walletStat = stats.get(wallet)!;
      walletStat.color = WALLET_COLORS[idx % WALLET_COLORS.length];
    });

    return stats;
  }

  private getRepeatWalletsSummary(stats: Map<string, WalletStats>): Array<{ wallet: string; stats: WalletStats }> {
    return [...stats.entries()]
      .filter(([, s]) => s.count >= 2)
      .sort((a, b) => b[1].totalVolume - a[1].totalVolume)
      .map(([wallet, s]) => ({ wallet, stats: s }));
  }

  private formatSuspiciousTradeRow(st: SuspiciousTrade, rank: number, walletStats: Map<string, WalletStats>): string {
    const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;

    // Get signal scores
    const getScore = (name: string) => st.score.signals.find(s => s.name === name)?.score ?? 0;
    const sizeScore = getScore('tradeSize');
    const acctScore = getScore('accountHistory');
    const convScore = getScore('conviction');

    // Get wallet color
    const walletStat = walletStats.get(st.trade.wallet);
    const walletColor = walletStat?.color ?? chalk.cyan;

    // Format classifications as compact tags
    const tags = (st.classifications || []).map(c => {
      if (c === 'WHALE') return chalk.blue('WHL');
      if (c === 'SNIPER') return chalk.red('SNP');
      if (c === 'EARLY_MOVER') return chalk.green('ERL');
      if (c === 'DUMPING') return chalk.red('DMP');
      return c.slice(0, 3).toUpperCase();
    }).join(' ');

    const cols = [
      String(rank).padStart(3),
      scoreColor(String(st.score.total).padStart(3) + '/100'),
      String(sizeScore).padStart(3) + '/100',
      String(acctScore).padStart(3) + '/100',
      String(convScore).padStart(3) + '/100',
      chalk.gray(this.formatTime(st.trade.timestamp)),
      walletColor(this.truncateWallet(st.trade.wallet).padEnd(12)),
      `${this.formatUsd(st.trade.valueUsd).padStart(10)} ${st.trade.outcome.padEnd(3)} @${st.trade.price.toFixed(2)}`,
      tags,
    ];

    return cols.join('  ');
  }

  private formatTime(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}:${seconds}`;
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

  truncateWallet(wallet: string, linkable = true): string {
    if (wallet.length <= 10) return wallet;
    const truncated = `${wallet.slice(0, 6)}...${wallet.slice(-2)}`;

    if (linkable) {
      // OSC 8 terminal hyperlink - displays truncated but copies full address
      // Format: \x1b]8;;URL\x07DISPLAYED_TEXT\x1b]8;;\x07
      return `\x1b]8;;${wallet}\x07${truncated}\x1b]8;;\x07`;
    }
    return truncated;
  }

  private truncateQuestion(question: string, maxLen: number): string {
    if (question.length <= maxLen) return question;
    return question.slice(0, maxLen - 3) + '...';
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

      // Show trade counts - fills count is from totalTrades, markets from positions
      const fillsCount = h.totalTrades;
      const marketsCount = report.positions?.length ?? 0;
      if (marketsCount > 0 && fillsCount > 0) {
        lines.push(`  Total Trades: ${marketsCount} markets (${fillsCount.toLocaleString()} fills)`);
      } else {
        lines.push(`  Total Trades: ${fillsCount.toLocaleString()}`);
      }
      lines.push(`  Total Volume: ${this.formatUsd(h.totalVolumeUsd)}`);

      if (h.profitUsd !== undefined) {
        const profitColor = h.profitUsd >= 0 ? chalk.green : chalk.red;
        const sign = h.profitUsd >= 0 ? '+' : '';

        // Show profit breakdown if we have redemption data
        if (h.redemptionPayoutsUsd !== undefined && h.tradingProfitUsd !== undefined && h.redemptionPayoutsUsd > 0) {
          const tradingSign = h.tradingProfitUsd >= 0 ? '+' : '';
          lines.push(`  Profit/Loss: ${profitColor(sign + this.formatUsd(h.profitUsd))} ` +
            chalk.gray(`(trading: ${tradingSign}${this.formatUsd(h.tradingProfitUsd)}, redemptions: +${this.formatUsd(h.redemptionPayoutsUsd)})`));
        } else {
          lines.push(`  Profit/Loss: ${profitColor(sign + this.formatUsd(h.profitUsd))}`);
        }

        // Calculate cost basis from positions (sum of valueBought) for accurate ROI
        // Cost basis = total money spent buying shares (the actual capital at risk)
        const costBasis = report.positions.reduce((sum, pos) => {
          return sum + parseFloat(pos.valueBought) / 1e6;
        }, 0);

        if (costBasis > 0) {
          const roi = (h.profitUsd / costBasis) * 100;
          lines.push(`  ROI: ${profitColor(sign + roi.toFixed(1) + '%')} ${chalk.gray(`(profit / $${Math.round(costBasis).toLocaleString()} cost basis)`)}`);
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

    // Positions with P&L breakdown
    if (report.positions.length > 0 || report.redemptions.length > 0) {
      const posCount = report.positions.length;
      const redemptionCount = report.redemptions.length;
      lines.push(chalk.bold(`Positions & Realized Gains (${posCount} positions, ${redemptionCount} redemptions):`));
      lines.push('');

      // Table header
      lines.push(
        chalk.gray('  Market                              Cost Basis    Trading P&L      Realized       Shares')
      );
      lines.push(chalk.gray('  ' + '─'.repeat(95)));

      // Track totals
      let totalCostBasis = 0;
      let totalTradingPnL = 0;
      let totalRealized = 0;

      // Build a map of redemptions by conditionId for potential matching
      const redemptionsByCondition = new Map<string, number>();
      for (const r of report.redemptions) {
        const payout = parseFloat(r.payout) / 1e6;
        redemptionsByCondition.set(r.conditionId, (redemptionsByCondition.get(r.conditionId) || 0) + payout);
        totalRealized += payout;
      }

      // Show positions
      for (const pos of report.positions.slice(0, 15)) {
        const costBasis = parseFloat(pos.valueBought) / 1e6;
        const tradingPnL = parseFloat(pos.netValue) / 1e6;
        const netQty = parseFloat(pos.netQuantity) / 1e6;

        totalCostBasis += costBasis;
        totalTradingPnL += tradingPnL;

        // Format values
        const costStr = this.formatUsd(costBasis).padStart(12);
        const pnlColor = tradingPnL >= 0 ? chalk.green : chalk.red;
        const pnlSign = tradingPnL >= 0 ? '+' : '';
        const pnlStr = pnlColor((pnlSign + this.formatUsd(tradingPnL)).padStart(12));
        const sharesStr = netQty > 0 ? `${Math.round(netQty).toLocaleString()}` : chalk.gray('closed');

        // Use resolved market name if available
        const resolved = report.resolvedMarkets?.get(pos.marketId);
        const marketDisplay = resolved
          ? this.truncateQuestion(resolved.question, 30) + chalk.gray(` (${resolved.outcome})`)
          : pos.marketId.slice(0, 16) + '...';

        lines.push(
          `  ${marketDisplay.padEnd(38)} ${costStr}    ${pnlStr}    ${chalk.gray('-'.padStart(12))}    ${sharesStr}`
        );
      }

      if (report.positions.length > 15) {
        lines.push(chalk.gray(`  ... and ${report.positions.length - 15} more positions`));
      }

      // Show redemptions section if any
      if (report.redemptions.length > 0) {
        lines.push('');
        lines.push(chalk.gray('  ' + '─'.repeat(95)));
        lines.push(chalk.bold.green('  Redemptions (resolved market payouts):'));

        for (const r of report.redemptions.slice(0, 10)) {
          const payout = parseFloat(r.payout) / 1e6;
          const date = new Date(r.timestamp * 1000);
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });

          lines.push(
            `  ${chalk.gray(dateStr.padEnd(38))} ${chalk.gray('-'.padStart(12))}    ${chalk.gray('-'.padStart(12))}    ${chalk.green(('+' + this.formatUsd(payout)).padStart(12))}    ${chalk.gray(r.conditionId.slice(0, 10) + '...')}`
          );
        }

        if (report.redemptions.length > 10) {
          lines.push(chalk.gray(`  ... and ${report.redemptions.length - 10} more redemptions`));
        }
      }

      // Summary totals
      lines.push('');
      lines.push(chalk.gray('  ' + '─'.repeat(95)));
      const totalPnL = totalTradingPnL + totalRealized;
      const totalColor = totalPnL >= 0 ? chalk.green : chalk.red;
      const totalSign = totalPnL >= 0 ? '+' : '';
      const tradingSign = totalTradingPnL >= 0 ? '+' : '';
      const tradingColor = totalTradingPnL >= 0 ? chalk.green : chalk.red;

      lines.push(
        `  ${chalk.bold('TOTALS'.padEnd(38))} ${this.formatUsd(totalCostBasis).padStart(12)}    ${tradingColor((tradingSign + this.formatUsd(totalTradingPnL)).padStart(12))}    ${chalk.green(('+' + this.formatUsd(totalRealized)).padStart(12))}    ${totalColor(chalk.bold((totalSign + this.formatUsd(totalPnL) + ' net').padStart(12)))}`
      );

      lines.push('');
    }

    // Recent Trades - grouped by market, aggregated by transaction
    if (report.recentTrades.length > 0) {
      lines.push(chalk.bold(`Recent Trades (${report.recentTrades.length} fills):`));
      lines.push('');

      // Aggregate trades by market and transaction hash
      interface AggregatedTrade {
        txHash: string;
        timestamp: number;
        buyValue: number;
        sellValue: number;
        avgBuyPrice: number;
        avgSellPrice: number;
        fillCount: number;
      }

      // Step 1: Filter complementary trades using value-based selection
      // Group by (txHash, conditionKey) and keep only the higher-value token side
      interface TxConditionGroup {
        yesFills: typeof report.recentTrades;
        noFills: typeof report.recentTrades;
      }
      const txConditionGroups = new Map<string, TxConditionGroup>();

      for (const trade of report.recentTrades) {
        const resolved = report.resolvedMarkets?.get(trade.marketId);
        if (!resolved) {
          // Can't determine YES/NO - will include later
          continue;
        }

        // Use question as the condition key (same question = same condition)
        const conditionKey = resolved.question;
        const groupKey = `${trade.transactionHash}|${conditionKey}`;

        if (!txConditionGroups.has(groupKey)) {
          txConditionGroups.set(groupKey, { yesFills: [], noFills: [] });
        }

        const group = txConditionGroups.get(groupKey)!;
        if (resolved.outcome === 'Yes') {
          group.yesFills.push(trade);
        } else {
          group.noFills.push(trade);
        }
      }

      // Build a set of token IDs the wallet has positions in
      // This helps determine which token (YES or NO) the user actually trades
      const positionTokenIds = new Set<string>();
      for (const pos of report.positions) {
        positionTokenIds.add(pos.marketId);
      }

      // Select which token side to show based on position data
      // If wallet has a position on a token, trades on that token are their intent
      const filteredTrades: typeof report.recentTrades = [];
      for (const group of txConditionGroups.values()) {
        // If only one side has trades, keep it
        if (group.yesFills.length === 0) {
          filteredTrades.push(...group.noFills);
          continue;
        }
        if (group.noFills.length === 0) {
          filteredTrades.push(...group.yesFills);
          continue;
        }

        // Both sides have trades - check which token the wallet has a position in
        const yesTokenId = group.yesFills[0]?.marketId;
        const noTokenId = group.noFills[0]?.marketId;

        const hasYesPosition = yesTokenId && positionTokenIds.has(yesTokenId);
        const hasNoPosition = noTokenId && positionTokenIds.has(noTokenId);

        if (hasYesPosition && !hasNoPosition) {
          // Wallet has YES position - show YES trades
          filteredTrades.push(...group.yesFills);
        } else if (hasNoPosition && !hasYesPosition) {
          // Wallet has NO position - show NO trades
          filteredTrades.push(...group.noFills);
        } else {
          // Either both or neither - fall back to showing the higher-value side
          const yesValue = group.yesFills.reduce((sum, t) =>
            sum + (parseFloat(t.size) / 1e6) * parseFloat(t.price), 0);
          const noValue = group.noFills.reduce((sum, t) =>
            sum + (parseFloat(t.size) / 1e6) * parseFloat(t.price), 0);

          if (yesValue >= noValue) {
            filteredTrades.push(...group.yesFills);
          } else {
            filteredTrades.push(...group.noFills);
          }
        }
      }

      // Also include unresolved trades (can't determine YES/NO)
      for (const trade of report.recentTrades) {
        if (!report.resolvedMarkets?.has(trade.marketId)) {
          filteredTrades.push(trade);
        }
      }

      const tradesByMarket = new Map<string, Map<string, AggregatedTrade>>();

      // Step 2: Aggregate filtered trades by market and transaction
      for (const trade of filteredTrades) {
        const marketId = trade.marketId || 'unknown';

        if (!tradesByMarket.has(marketId)) {
          tradesByMarket.set(marketId, new Map());
        }

        const marketTrades = tradesByMarket.get(marketId)!;
        const txHash = trade.transactionHash;

        if (!marketTrades.has(txHash)) {
          marketTrades.set(txHash, {
            txHash,
            timestamp: trade.timestamp,
            buyValue: 0,
            sellValue: 0,
            avgBuyPrice: 0,
            avgSellPrice: 0,
            fillCount: 0,
          });
        }

        const agg = marketTrades.get(txHash)!;
        const size = parseFloat(trade.size) / 1e6;  // size is USD value, not shares
        const price = parseFloat(trade.price);
        const value = size;  // size already represents USD value

        // Only include trades where wallet is MAKER on the position token
        // Taker trades are often complementary (NO token) trades from split operations
        // Polymarket shows only maker fills on the position token
        const isMaker = trade.maker.toLowerCase() === report.wallet.toLowerCase();
        if (!isMaker) {
          continue;  // Skip taker fills - they're complementary trades
        }

        // Wallet's action matches the side field when they're the maker
        const walletAction = trade.side;

        if (walletAction === 'Buy') {
          agg.avgBuyPrice = (agg.avgBuyPrice * agg.buyValue + price * value) / (agg.buyValue + value || 1);
          agg.buyValue += value;
        } else {
          agg.avgSellPrice = (agg.avgSellPrice * agg.sellValue + price * value) / (agg.sellValue + value || 1);
          agg.sellValue += value;
        }
        agg.fillCount++;
      }

      // Convert to sorted arrays, filtering out empty txs (no maker fills)
      const sortedMarkets = [...tradesByMarket.entries()]
        .map(([marketId, txMap]) => ({
          marketId,
          trades: [...txMap.values()]
            .filter(t => t.fillCount > 0)  // Only txs with maker fills
            .sort((a, b) => b.timestamp - a.timestamp),
        }))
        .filter(m => m.trades.length > 0)  // Only markets with trades
        .sort((a, b) => {
          const aLatest = Math.max(...a.trades.map(t => t.timestamp));
          const bLatest = Math.max(...b.trades.map(t => t.timestamp));
          return bLatest - aLatest;
        });

      // Count unique transactions
      const totalTxns = sortedMarkets.reduce((sum, m) => sum + m.trades.length, 0);
      lines.push(chalk.gray(`  ${totalTxns} transactions across ${sortedMarkets.length} markets`));
      lines.push('');

      // Table header
      lines.push(
        chalk.gray('  Date              Time      Side         Value       Price   Fills   TxHash')
      );
      lines.push(chalk.gray('  ' + '─'.repeat(85)));

      for (const { marketId, trades } of sortedMarkets) {
        // Market header with resolved name or truncated ID
        const resolved = report.resolvedMarkets?.get(marketId);
        const marketDisplay = resolved
          ? this.truncateQuestion(resolved.question, 45) + chalk.gray(` (${resolved.outcome})`)
          : chalk.gray(marketId.length > 20 ? marketId.slice(0, 10) + '...' + marketId.slice(-8) : marketId);
        lines.push(`  ${chalk.bold.cyan('Market:')} ${marketDisplay} ${chalk.gray(`(${trades.length} txns)`)}`);

        // Track totals for this market
        let totalBuyValue = 0;
        let totalSellValue = 0;
        let totalFills = 0;

        // Show all aggregated trades
        for (const agg of trades) {
          const date = new Date(agg.timestamp * 1000);
          const txHash = agg.txHash.slice(0, 10) + '...';

          const dateStr = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
          });
          const timeStr = date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });

          // Show buy line if there were buys
          if (agg.buyValue > 0) {
            totalBuyValue += agg.buyValue;
            totalFills += agg.fillCount;
            lines.push(
              `  ${dateStr.padEnd(14)} ${timeStr.padEnd(8)} ${chalk.green('Buy'.padEnd(6))} ` +
              `${this.formatUsd(agg.buyValue).padStart(12)}  @${agg.avgBuyPrice.toFixed(2).padStart(5)}   ` +
              `${String(agg.fillCount).padStart(3)}    ${chalk.gray(txHash)}`
            );
          }

          // Show sell line if there were sells
          if (agg.sellValue > 0) {
            totalSellValue += agg.sellValue;
            totalFills += agg.fillCount;
            lines.push(
              `  ${dateStr.padEnd(14)} ${timeStr.padEnd(8)} ${chalk.red('Sell'.padEnd(6))} ` +
              `${this.formatUsd(agg.sellValue).padStart(12)}  @${agg.avgSellPrice.toFixed(2).padStart(5)}   ` +
              `${String(agg.fillCount).padStart(3)}    ${chalk.gray(txHash)}`
            );
          }
        }

        // Show market totals
        if (totalBuyValue > 0 || totalSellValue > 0) {
          const totals: string[] = [];
          if (totalBuyValue > 0) totals.push(chalk.green(`Bought ${this.formatUsd(totalBuyValue)}`));
          if (totalSellValue > 0) totals.push(chalk.red(`Sold ${this.formatUsd(totalSellValue)}`));
          lines.push(`  ${''.padEnd(14)} ${''.padEnd(8)} ${chalk.bold('Total'.padEnd(6))} ` +
            `${totals.join(' | ')} ${chalk.gray(`(${totalFills} fills)`)}`);
        }
        lines.push('');
      }
    }

    // Suspicion Factors
    lines.push(chalk.bold('Suspicion Analysis:'));
    for (const factor of report.suspicionFactors) {
      const isNegative = factor.includes('No obvious');
      const icon = isNegative ? chalk.green('✓') : chalk.yellow('⚠');
      lines.push(`  ${icon} ${factor}`);
    }
    lines.push('');

    // Suspicious Trades Analysis
    if (report.analyzedTradeCount !== undefined) {
      lines.push(chalk.bold(`Suspicious Trade Analysis (${report.analyzedTradeCount} trades analyzed):`));
      lines.push(chalk.gray('Weights: Size 40% | Acct 35% | Conv 25%'));
      lines.push('');

      if (!report.suspiciousTrades || report.suspiciousTrades.length === 0) {
        lines.push(chalk.green('  ✓ No suspicious trades detected above threshold.'));
      } else {
        // Table header
        lines.push(
          chalk.gray('  #   Score   Size   Acct   Conv   Time             Market                              Trade')
        );
        lines.push(chalk.gray('  ' + '─'.repeat(110)));

        for (let i = 0; i < Math.min(report.suspiciousTrades.length, 20); i++) {
          const st = report.suspiciousTrades[i];
          lines.push(this.formatSuspiciousTradeForWallet(st, i + 1, report.resolvedMarkets));
        }

        if (report.suspiciousTrades.length > 20) {
          lines.push(chalk.gray(`  ... and ${report.suspiciousTrades.length - 20} more suspicious trades`));
        }

        // Summary
        lines.push('');
        const avgScore = Math.round(
          report.suspiciousTrades.reduce((sum, st) => sum + st.score.total, 0) / report.suspiciousTrades.length
        );
        const highScoreCount = report.suspiciousTrades.filter(st => st.score.total >= 80).length;
        lines.push(
          chalk.gray(`  Summary: ${report.suspiciousTrades.length} flagged trades, `) +
          chalk.yellow(`${highScoreCount} high-risk (≥80), `) +
          chalk.gray(`avg score: ${avgScore}`)
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatSuspiciousTradeForWallet(
    st: SuspiciousTrade,
    rank: number,
    resolvedMarkets?: Map<string, import('../api/market-resolver.js').ResolvedToken>
  ): string {
    const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;

    // Get signal scores
    const getScore = (name: string) => st.score.signals.find(s => s.name === name)?.score ?? 0;
    const sizeScore = getScore('tradeSize');
    const acctScore = getScore('accountHistory');
    const convScore = getScore('conviction');

    // Format time
    const timeStr = this.formatTime(st.trade.timestamp);

    // Get market name
    const resolved = resolvedMarkets?.get(st.trade.marketId);
    const marketDisplay = resolved
      ? this.truncateQuestion(resolved.question, 30) + chalk.gray(` (${resolved.outcome})`)
      : st.trade.marketId.slice(0, 16) + '...';

    const cols = [
      String(rank).padStart(3),
      scoreColor(String(st.score.total).padStart(3) + '/100'),
      String(sizeScore).padStart(3) + '/100',
      String(acctScore).padStart(3) + '/100',
      String(convScore).padStart(3) + '/100',
      chalk.gray(timeStr),
      marketDisplay.padEnd(36),
      `${this.formatUsd(st.trade.valueUsd).padStart(10)} ${st.trade.outcome.padEnd(3)} @${st.trade.price.toFixed(2)}`,
    ];

    return '  ' + cols.join('  ');
  }
}
