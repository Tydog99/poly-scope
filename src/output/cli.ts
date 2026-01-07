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

// Display limits for report sections
const MAX_POSITIONS_DISPLAY = 15;
const MAX_REDEMPTIONS_DISPLAY = 10;
const MAX_SUSPICIOUS_TRADES_DISPLAY = 20;

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
    if (report.marketSummary) {
      lines.push(`Market: ${chalk.cyan(report.marketSummary.marketName)}`);
    }
    lines.push('');

    // Account History (labeled as Global when filtering by market)
    if (report.accountHistory) {
      const h = report.accountHistory;
      const historyLabel = report.marketSummary ? 'Global Account History:' : 'Account History:';
      lines.push(chalk.bold(historyLabel));

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

    // Market Summary (shown after Account History when filtering by specific market)
    if (report.marketSummary) {
      const ms = report.marketSummary;
      lines.push(chalk.bold('Market Summary:'));
      lines.push(`  Trades: ${ms.tradeCount.toLocaleString()} fills (${this.formatUsd(ms.volumeUsd)} volume)`);
      lines.push(`  Position Value: ${this.formatUsd(ms.positionValueUsd)} (${ms.positionCount} tokens)`);

      if (ms.isRedeemed) {
        lines.push(`  Redemptions: ${chalk.green('+' + this.formatUsd(ms.redeemedUsd))}`);
      } else {
        lines.push(`  Redemptions: ${chalk.yellow('Not yet redeemed')}`);
      }
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
        chalk.gray('  Market                              Cost Basis    Trading P&L      Realized       Shares       ROI')
      );
      lines.push(chalk.gray('  ' + '─'.repeat(106)));

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
      for (const pos of report.positions.slice(0, MAX_POSITIONS_DISPLAY)) {
        const costBasis = parseFloat(pos.valueBought) / 1e6;
        const valueSold = parseFloat(pos.valueSold) / 1e6;
        const netQty = parseFloat(pos.netQuantity) / 1e6;

        // Trading P&L = what you received from TRADING (not redemptions)
        // For positions with no sales (valueSold = 0), trading P&L is 0
        // (they held to redemption or still hold - not a trading loss)
        const tradingPnL = valueSold > 0 ? valueSold - costBasis : 0;

        totalCostBasis += costBasis;
        totalTradingPnL += tradingPnL;

        // Use resolved market name if available
        const resolved = report.resolvedMarkets?.get(pos.marketId);

        // Look up redemption for this position's market
        const redemption = resolved ? (redemptionsByCondition.get(resolved.conditionId) || 0) : 0;

        // Calculate ROI: (total returns - cost) / cost * 100
        // Total returns = valueSold + redemption
        const totalReturns = valueSold + redemption;
        const roi = costBasis > 0 ? ((totalReturns - costBasis) / costBasis) * 100 : 0;

        // Format values
        const costStr = this.formatUsd(costBasis).padStart(12);
        const pnlColor = tradingPnL >= 0 ? chalk.green : chalk.red;
        const pnlSign = tradingPnL >= 0 ? '+' : '';
        // Show "held" for positions with no sales (either still holding or redeemed)
        const pnlStr = valueSold > 0
          ? pnlColor((pnlSign + this.formatUsd(tradingPnL)).padStart(12))
          : chalk.gray('held'.padStart(12));
        const sharesStr = netQty > 0 ? `${Math.round(netQty).toLocaleString()}` : chalk.gray('closed');

        // Format ROI - show "-" if position is still open (no sales, no redemption)
        let roiStr: string;
        if (totalReturns === 0) {
          roiStr = chalk.gray('-'.padStart(10));
        } else {
          const roiColor = roi >= 0 ? chalk.green : chalk.red;
          const roiSign = roi >= 0 ? '+' : '';
          roiStr = roiColor((roiSign + roi.toFixed(0) + '%').padStart(10));
        }

        const marketDisplay = resolved
          ? this.truncateQuestion(resolved.question, 30) + chalk.gray(` (${resolved.outcome})`)
          : pos.marketId.slice(0, 16) + '...';

        lines.push(
          `  ${marketDisplay.padEnd(38)} ${costStr}    ${pnlStr}    ${chalk.gray('-'.padStart(12))}    ${sharesStr.padStart(10)}  ${roiStr}`
        );
      }

      if (report.positions.length > MAX_POSITIONS_DISPLAY) {
        lines.push(chalk.gray(`  ... and ${report.positions.length - MAX_POSITIONS_DISPLAY} more positions`));
      }

      // Show redemptions section if any
      if (report.redemptions.length > 0) {
        lines.push('');
        lines.push(chalk.gray('  ' + '─'.repeat(106)));
        lines.push(chalk.bold.green('  Redemptions (resolved market payouts):'));

        for (const r of report.redemptions.slice(0, MAX_REDEMPTIONS_DISPLAY)) {
          const payout = parseFloat(r.payout) / 1e6;
          const date = new Date(r.timestamp * 1000);
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });

          lines.push(
            `  ${chalk.gray(dateStr.padEnd(38))} ${chalk.gray('-'.padStart(12))}    ${chalk.gray('-'.padStart(12))}    ${chalk.green(('+' + this.formatUsd(payout)).padStart(12))}    ${chalk.gray(r.conditionId.slice(0, 10) + '...')}`
          );
        }

        if (report.redemptions.length > MAX_REDEMPTIONS_DISPLAY) {
          lines.push(chalk.gray(`  ... and ${report.redemptions.length - MAX_REDEMPTIONS_DISPLAY} more redemptions`));
        }
      }

      // Summary totals
      lines.push('');
      lines.push(chalk.gray('  ' + '─'.repeat(106)));
      const totalPnL = totalTradingPnL + totalRealized;
      const totalColor = totalPnL >= 0 ? chalk.green : chalk.red;
      const totalSign = totalPnL >= 0 ? '+' : '';
      const tradingSign = totalTradingPnL >= 0 ? '+' : '';
      const tradingColor = totalTradingPnL >= 0 ? chalk.green : chalk.red;

      // Calculate total ROI
      const totalRoi = totalCostBasis > 0 ? ((totalPnL) / totalCostBasis) * 100 : 0;
      const totalRoiColor = totalRoi >= 0 ? chalk.green : chalk.red;
      const totalRoiSign = totalRoi >= 0 ? '+' : '';
      const totalRoiStr = totalRoiColor((totalRoiSign + totalRoi.toFixed(0) + '%').padStart(10));

      lines.push(
        `  ${chalk.bold('TOTALS'.padEnd(38))} ${this.formatUsd(totalCostBasis).padStart(12)}    ${tradingColor((tradingSign + this.formatUsd(totalTradingPnL)).padStart(12))}    ${chalk.green(('+' + this.formatUsd(totalRealized)).padStart(12))}    ${totalColor(chalk.bold((totalSign + this.formatUsd(totalPnL) + ' net').padStart(14)))}  ${totalRoiStr}`
      );

      lines.push('');
    }

    // Recent Trades - grouped by market, aggregated by transaction
    if (report.recentTrades.length > 0) {
      lines.push(chalk.bold(`Recent Trades (${report.recentTrades.length} fills):`));
      lines.push('');

      // Aggregate trades by market and transaction hash, tracking maker/taker separately
      interface RoleFills {
        buyValue: number;
        sellValue: number;
        avgBuyPrice: number;
        avgSellPrice: number;
        fillCount: number;
      }
      interface AggregatedTrade {
        txHash: string;
        timestamp: number;
        maker: RoleFills;
        taker: RoleFills;
        isComplementary: boolean;  // True if this token is opposite of wallet's main position
      }

      // Step 1: Identify complementary trades at the TRANSACTION level
      // When a single tx has trades on both YES and NO tokens, one is likely complementary

      // Build a set of token IDs the wallet has positions in
      const positionTokenIds = new Set<string>();
      for (const pos of report.positions) {
        positionTokenIds.add(pos.marketId);
      }

      // Map each token to its "sibling" token (YES<->NO for same condition)
      const tokenToQuestion = new Map<string, string>();
      const questionToTokens = new Map<string, { yes?: string; no?: string }>();
      for (const [tokenId, resolved] of report.resolvedMarkets?.entries() ?? []) {
        tokenToQuestion.set(tokenId, resolved.question);
        if (!questionToTokens.has(resolved.question)) {
          questionToTokens.set(resolved.question, {});
        }
        const pair = questionToTokens.get(resolved.question)!;
        if (resolved.outcome === 'Yes') {
          pair.yes = tokenId;
        } else {
          pair.no = tokenId;
        }
      }

      // Group trades by (txHash, question) to find transactions with both YES and NO
      interface TxQuestionGroup {
        yesTrades: typeof report.recentTrades;
        noTrades: typeof report.recentTrades;
        yesTokenId?: string;
        noTokenId?: string;
      }
      const txQuestionGroups = new Map<string, TxQuestionGroup>();

      for (const trade of report.recentTrades) {
        const resolved = report.resolvedMarkets?.get(trade.marketId);
        if (!resolved) continue;

        const groupKey = `${trade.transactionHash}|${resolved.question}`;
        if (!txQuestionGroups.has(groupKey)) {
          txQuestionGroups.set(groupKey, { yesTrades: [], noTrades: [] });
        }

        const group = txQuestionGroups.get(groupKey)!;
        if (resolved.outcome === 'Yes') {
          group.yesTrades.push(trade);
          group.yesTokenId = trade.marketId;
        } else {
          group.noTrades.push(trade);
          group.noTokenId = trade.marketId;
        }
      }

      // Build set of (txHash, tokenId) pairs that are complementary
      const complementaryTxTokens = new Set<string>();

      for (const [groupKey, group] of txQuestionGroups) {
        // Only process transactions with trades on BOTH tokens
        if (group.yesTrades.length === 0 || group.noTrades.length === 0) {
          continue;
        }

        const txHash = groupKey.split('|')[0];
        const hasYesPosition = group.yesTokenId && positionTokenIds.has(group.yesTokenId);
        const hasNoPosition = group.noTokenId && positionTokenIds.has(group.noTokenId);

        // Calculate total value for each side
        const yesValue = group.yesTrades.reduce((sum, t) => sum + parseFloat(t.size) / 1e6, 0);
        const noValue = group.noTrades.reduce((sum, t) => sum + parseFloat(t.size) / 1e6, 0);

        let complementaryTokenId: string | undefined;

        if (hasYesPosition && !hasNoPosition) {
          // Wallet has YES position only - NO trades are complementary
          complementaryTokenId = group.noTokenId;
        } else if (hasNoPosition && !hasYesPosition) {
          // Wallet has NO position only - YES trades are complementary
          complementaryTokenId = group.yesTokenId;
        } else {
          // Wallet has both or neither - SMALLER value side is complementary
          // (the larger side is the "main intent", smaller is the balancing action)
          complementaryTokenId = yesValue <= noValue ? group.yesTokenId : group.noTokenId;
        }

        if (complementaryTokenId) {
          complementaryTxTokens.add(`${txHash}|${complementaryTokenId}`);
        }
      }

      // Helper to check if a specific (txHash, tokenId) is complementary
      const isComplementaryTrade = (txHash: string, tokenId: string): boolean => {
        return complementaryTxTokens.has(`${txHash}|${tokenId}`);
      };

      const tradesByMarket = new Map<string, Map<string, AggregatedTrade>>();

      // Step 2: Aggregate ALL trades by market and transaction (both maker and taker)
      for (const trade of report.recentTrades) {
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
            maker: { buyValue: 0, sellValue: 0, avgBuyPrice: 0, avgSellPrice: 0, fillCount: 0 },
            taker: { buyValue: 0, sellValue: 0, avgBuyPrice: 0, avgSellPrice: 0, fillCount: 0 },
            isComplementary: isComplementaryTrade(txHash, marketId),
          });
        }

        const agg = marketTrades.get(txHash)!;
        const size = parseFloat(trade.size) / 1e6;  // size is USD value, not shares
        const price = parseFloat(trade.price);
        const value = size;  // size already represents USD value

        // Determine if wallet is maker or taker
        const isMaker = trade.maker.toLowerCase() === report.wallet.toLowerCase();
        const roleFills = isMaker ? agg.maker : agg.taker;

        // Determine wallet's action:
        // - Maker: side field matches their action
        // - Taker: side field is OPPOSITE (they're taking the other side)
        const walletAction = isMaker
          ? trade.side
          : (trade.side === 'Buy' ? 'Sell' : 'Buy');

        if (walletAction === 'Buy') {
          roleFills.avgBuyPrice = (roleFills.avgBuyPrice * roleFills.buyValue + price * value) / (roleFills.buyValue + value || 1);
          roleFills.buyValue += value;
        } else {
          roleFills.avgSellPrice = (roleFills.avgSellPrice * roleFills.sellValue + price * value) / (roleFills.sellValue + value || 1);
          roleFills.sellValue += value;
        }
        roleFills.fillCount++;
      }

      // Convert to sorted arrays
      const sortedMarkets = [...tradesByMarket.entries()]
        .map(([marketId, txMap]) => ({
          marketId,
          // Count how many trades are complementary vs not for sorting
          complementaryCount: [...txMap.values()].filter(t => t.isComplementary).length,
          trades: [...txMap.values()]
            .filter(t => t.maker.fillCount > 0 || t.taker.fillCount > 0)  // Any fills
            .sort((a, b) => b.timestamp - a.timestamp),
        }))
        .filter(m => m.trades.length > 0)  // Only markets with trades
        .sort((a, b) => {
          // Sort by timestamp (no special complementary ordering at market level)
          const aLatest = Math.max(...a.trades.map(t => t.timestamp));
          const bLatest = Math.max(...b.trades.map(t => t.timestamp));
          return bLatest - aLatest;
        });

      // Count unique transactions
      const totalTxns = sortedMarkets.reduce((sum, m) => sum + m.trades.length, 0);
      lines.push(chalk.gray(`  ${totalTxns} transactions across ${sortedMarkets.length} markets`));
      lines.push('');

      // Table header - Role: [M]=maker (limit order filled), [T]=taker (market order)
      lines.push(
        chalk.gray('  Date              Time      Role  Side         Value       Price   Fills   TxHash')
      );
      lines.push(chalk.gray('  ' + '─'.repeat(90)));

      // Helper to format a trade line with role indicator
      const formatTradeLine = (
        dateStr: string,
        timeStr: string,
        role: 'M' | 'T',
        side: 'Buy' | 'Sell',
        value: number,
        avgPrice: number,
        fillCount: number,
        txHash: string,
        isComplementary: boolean
      ): string => {
        const roleIndicator = role === 'M' ? chalk.blue('[M]') : chalk.yellow('[T]');
        const sideFormatted = side === 'Buy' ? chalk.green('Buy'.padEnd(6)) : chalk.red('Sell'.padEnd(6));
        const valueStr = this.formatUsd(value).padStart(12);
        const priceStr = `@${avgPrice.toFixed(2).padStart(5)}`;
        const fillsStr = String(fillCount).padStart(3);
        const txHashStr = chalk.gray(txHash.slice(0, 10) + '...');

        // Dim complementary trades
        if (isComplementary) {
          return chalk.dim(
            `  ${dateStr.padEnd(14)} ${timeStr.padEnd(8)} ${role === 'M' ? '[M]' : '[T]'}   ${side.padEnd(6)} ` +
            `${valueStr}  ${priceStr}   ${fillsStr}    ${txHash.slice(0, 10)}...` +
            chalk.dim.yellow(' [C]')
          );
        }

        return `  ${dateStr.padEnd(14)} ${timeStr.padEnd(8)} ${roleIndicator}   ${sideFormatted} ` +
          `${valueStr}  ${priceStr}   ${fillsStr}    ${txHashStr}`;
      };

      for (const { marketId, complementaryCount, trades } of sortedMarkets) {
        // Market header with resolved name or truncated ID
        const resolved = report.resolvedMarkets?.get(marketId);
        const marketDisplay = resolved
          ? this.truncateQuestion(resolved.question, 45) + chalk.gray(` (${resolved.outcome})`)
          : chalk.gray(marketId.length > 20 ? marketId.slice(0, 10) + '...' + marketId.slice(-8) : marketId);

        // Add complementary count to market header if any
        const complementaryBadge = complementaryCount > 0
          ? chalk.dim.yellow(` [${complementaryCount} complementary txs]`)
          : '';
        lines.push(`  ${chalk.bold.cyan('Market:')} ${marketDisplay} ${chalk.gray(`(${trades.length} txns)`)}${complementaryBadge}`);

        // Track totals for this market (separate maker/taker)
        let makerBuyValue = 0, makerSellValue = 0, makerFills = 0;
        let takerBuyValue = 0, takerSellValue = 0, takerFills = 0;

        // Show all aggregated trades
        for (const agg of trades) {
          const date = new Date(agg.timestamp * 1000);
          const txHash = agg.txHash;

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

          // Show maker fills first (use agg.isComplementary for per-transaction marking)
          // Only count non-complementary trades in totals (complementary are order routing artifacts)
          if (agg.maker.buyValue > 0) {
            if (!agg.isComplementary) {
              makerBuyValue += agg.maker.buyValue;
              makerFills += agg.maker.fillCount;
            }
            lines.push(formatTradeLine(dateStr, timeStr, 'M', 'Buy', agg.maker.buyValue, agg.maker.avgBuyPrice, agg.maker.fillCount, txHash, agg.isComplementary));
          }
          if (agg.maker.sellValue > 0) {
            if (!agg.isComplementary) {
              makerSellValue += agg.maker.sellValue;
              makerFills += agg.maker.fillCount;
            }
            lines.push(formatTradeLine(dateStr, timeStr, 'M', 'Sell', agg.maker.sellValue, agg.maker.avgSellPrice, agg.maker.fillCount, txHash, agg.isComplementary));
          }

          // Show taker fills
          if (agg.taker.buyValue > 0) {
            if (!agg.isComplementary) {
              takerBuyValue += agg.taker.buyValue;
              takerFills += agg.taker.fillCount;
            }
            lines.push(formatTradeLine(dateStr, timeStr, 'T', 'Buy', agg.taker.buyValue, agg.taker.avgBuyPrice, agg.taker.fillCount, txHash, agg.isComplementary));
          }
          if (agg.taker.sellValue > 0) {
            if (!agg.isComplementary) {
              takerSellValue += agg.taker.sellValue;
              takerFills += agg.taker.fillCount;
            }
            lines.push(formatTradeLine(dateStr, timeStr, 'T', 'Sell', agg.taker.sellValue, agg.taker.avgSellPrice, agg.taker.fillCount, txHash, agg.isComplementary));
          }
        }

        // Show market totals with role breakdown
        const totalBuyValue = makerBuyValue + takerBuyValue;
        const totalSellValue = makerSellValue + takerSellValue;
        const totalFills = makerFills + takerFills;

        if (totalBuyValue > 0 || totalSellValue > 0) {
          const totals: string[] = [];
          if (totalBuyValue > 0) {
            const breakdown = [];
            if (makerBuyValue > 0) breakdown.push(`M:${this.formatUsd(makerBuyValue)}`);
            if (takerBuyValue > 0) breakdown.push(`T:${this.formatUsd(takerBuyValue)}`);
            totals.push(chalk.green(`Bought ${this.formatUsd(totalBuyValue)}`) + chalk.gray(` (${breakdown.join(', ')})`));
          }
          if (totalSellValue > 0) {
            const breakdown = [];
            if (makerSellValue > 0) breakdown.push(`M:${this.formatUsd(makerSellValue)}`);
            if (takerSellValue > 0) breakdown.push(`T:${this.formatUsd(takerSellValue)}`);
            totals.push(chalk.red(`Sold ${this.formatUsd(totalSellValue)}`) + chalk.gray(` (${breakdown.join(', ')})`));
          }
          lines.push(`  ${''.padEnd(14)} ${''.padEnd(8)} ${''.padEnd(6)} ${chalk.bold('Total'.padEnd(6))} ` +
            `${totals.join(' | ')} ${chalk.gray(`(${totalFills} fills)`)}`);
        }
        lines.push('');
      }

      // Add legend
      lines.push(chalk.gray('  Legend: [M]=Maker (limit order filled) | [T]=Taker (market order) | [C]=Complementary trade'));
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

        for (let i = 0; i < Math.min(report.suspiciousTrades.length, MAX_SUSPICIOUS_TRADES_DISPLAY); i++) {
          const st = report.suspiciousTrades[i];
          lines.push(this.formatSuspiciousTradeForWallet(st, i + 1, report.resolvedMarkets));
        }

        if (report.suspiciousTrades.length > MAX_SUSPICIOUS_TRADES_DISPLAY) {
          lines.push(chalk.gray(`  ... and ${report.suspiciousTrades.length - MAX_SUSPICIOUS_TRADES_DISPLAY} more suspicious trades`));
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
