# Wallet Filter for Analyze Command - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `-w, --wallet` flag to the analyze command for targeted wallet analysis with verbose scoring output.

**Architecture:** When `-w` is provided, the analyze command filters trades to that wallet, fetches account data upfront, scores all trades (ignoring min-size and top-N limits), and outputs a three-part report: account header, summary table, and detailed signal breakdowns.

**Tech Stack:** TypeScript, Commander.js, Chalk

---

### Task 1: Add CLI option for wallet filter

**Files:**
- Modify: `src/index.ts:20-33`

**Step 1: Add the `-w` option after the `--role` option**

Find this line (around line 32):
```typescript
  .option('--role <taker|maker|both>', 'Filter trades by participant role (default: taker to avoid double-counting)')
```

Add after it:
```typescript
  .option('-w, --wallet <address>', 'Analyze a specific wallet\'s trades on this market (shows all trades with verbose scoring)')
```

**Step 2: Pass wallet to execute options**

Find the `command.execute()` call (around line 65-74) and add `wallet` to the options object:

```typescript
        const report = await command.execute({
          marketId: market.conditionId,
          after: opts.after ? new Date(opts.after) : undefined,
          before: opts.before ? new Date(new Date(opts.before).getTime() + 24 * 60 * 60 * 1000 - 1) : undefined,
          outcome: opts.outcome?.toUpperCase() as 'YES' | 'NO' | undefined,
          maxTrades: opts.maxTrades,
          topN: opts.top,
          role: opts.role as 'taker' | 'maker' | 'both' | undefined,
          wallet: opts.wallet,  // Add this line
        });
```

**Step 3: Add validation for incompatible flags**

Add this check right after the `if (markets.length > 1 && !opts.all)` block (around line 60):

```typescript
      // Validate -w is not used with --all
      if (opts.wallet && opts.all) {
        console.error('Error: --wallet (-w) cannot be used with --all flag');
        process.exit(1);
      }
```

**Step 4: Run build to verify no syntax errors**

Run: `npm run build`
Expected: Build succeeds (wallet option not yet used in AnalyzeCommand)

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): add -w/--wallet option to analyze command"
```

---

### Task 2: Add wallet option to AnalyzeOptions interface

**Files:**
- Modify: `src/commands/analyze.ts:11-25`

**Step 1: Add wallet to AnalyzeOptions interface**

Find the `AnalyzeOptions` interface and add the wallet property:

```typescript
export interface AnalyzeOptions {
  marketId: string;
  after?: Date;
  before?: Date;
  outcome?: 'YES' | 'NO';
  maxTrades?: number;
  topN?: number;
  /**
   * Filter trades by participant role.
   * - 'taker': Only taker trades (default, recommended for insider detection)
   * - 'maker': Only maker trades
   * - 'both': Include both (may double-count volume)
   */
  role?: 'taker' | 'maker' | 'both';
  /**
   * Filter to a specific wallet's trades.
   * When set, ignores min-size and topN limits, shows verbose scoring output.
   */
  wallet?: string;
}
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/commands/analyze.ts
git commit -m "feat(analyze): add wallet option to AnalyzeOptions interface"
```

---

### Task 3: Implement wallet filtering in execute method

**Files:**
- Modify: `src/commands/analyze.ts:67-218`

**Step 1: Add wallet filtering after trade fetch**

Find the trade filtering section (around line 82-95) and modify it to also filter by wallet when specified:

```typescript
    // 3. Filter trades
    let tradesToAnalyze: Trade[];
    if (options.outcome) {
      tradesToAnalyze = allTrades.filter(t => t.outcome === options.outcome);
    } else if (market.winningOutcome) {
      tradesToAnalyze = allTrades.filter(t =>
        t.outcome === market.winningOutcome?.toUpperCase()
      );
    } else {
      tradesToAnalyze = allTrades;
    }

    // Filter to specific wallet if requested
    if (options.wallet) {
      const walletLower = options.wallet.toLowerCase();
      tradesToAnalyze = tradesToAnalyze.filter(t =>
        t.wallet.toLowerCase() === walletLower
      );
      console.log(`Filtered to ${tradesToAnalyze.length} trades for wallet ${options.wallet.slice(0, 8)}...`);
    }
```

**Step 2: Skip min-size filtering for wallet mode**

Find the safe bets filter (around line 117-125) and add a condition to skip it in wallet mode:

```typescript
      // Filter out safe bets (high price buys/sells on resolved markets)
      // Skip this filter in wallet mode - we want to see all trades
      if (
        !options.wallet &&
        this.config.filters.excludeSafeBets &&
        trade.price >= this.config.filters.safeBetThreshold &&
        (trade.side === 'BUY' || trade.side === 'SELL')
      ) {
        safeBetsFiltered++;
        continue;
      }
```

**Step 3: In wallet mode, fetch account history for the target wallet upfront**

Before Phase 1 (around line 97), add:

```typescript
    // === WALLET MODE: Fetch target account upfront ===
    let targetAccountHistory: import('../signals/types.js').AccountHistory | undefined;
    if (options.wallet) {
      console.log(`Fetching account history for ${options.wallet.slice(0, 8)}...`);
      const histories = await this.accountFetcher.getAccountHistoryBatch([options.wallet]);
      targetAccountHistory = histories.get(options.wallet.toLowerCase());
    }
```

**Step 4: In wallet mode, add all wallets as candidates (not just high-scoring)**

Modify the candidate wallet collection (around line 136-141):

```typescript
      // Collect wallets from trades that might be suspicious
      // In wallet mode, we've already fetched the account, so skip candidate collection
      if (!options.wallet) {
        const candidateThreshold = Math.max(40, this.config.alertThreshold - 10);
        if (quickScore.total >= candidateThreshold) {
          candidateWallets.add(trade.wallet.toLowerCase());
        }
      }
```

**Step 5: Skip batch account fetch in wallet mode**

Modify Phase 2 (around line 147-159):

```typescript
    // === PHASE 2: Batch fetch all candidate account histories ===
    // Skip in wallet mode - we already fetched the target account
    if (!options.wallet && candidateWallets.size > 0) {
      console.log(`Phase 2: Fetching account histories for ${candidateWallets.size} wallets...`);
      // ... existing batch fetch code ...
    } else if (!options.wallet) {
      console.log(`Phase 2: No candidate wallets to fetch`);
    }
```

**Step 6: In wallet mode, use the pre-fetched account for all trades**

Modify Phase 3 account lookup (around line 174):

```typescript
      // Get account history - in wallet mode use pre-fetched, otherwise lookup from batch
      const accountHistory = options.wallet
        ? targetAccountHistory
        : accountHistories.get(trade.wallet.toLowerCase());
```

**Step 7: In wallet mode, collect ALL scored trades (not just alerts)**

Replace the alert-only collection (around line 186-203) with conditional logic:

```typescript
      // In wallet mode: collect ALL trades for verbose output
      // In normal mode: only collect alerts
      if (options.wallet || finalScore.isAlert) {
        const suspiciousTrade: SuspiciousTrade = {
          trade,
          score: finalScore,
          accountHistory,
          priceImpact: (fullResults[0].details as any)?.impactPercent ? {
            before: 0,
            after: 0,
            changePercent: (fullResults[0].details as any).impactPercent
          } : undefined
        };

        const classifications = this.classifier.classify(suspiciousTrade, finalScore, market.createdAt ? new Date(market.createdAt) : undefined);
        suspiciousTrade.classifications = classifications;

        scoredTrades.push(suspiciousTrade);
      }
```

**Step 8: In wallet mode, return ALL trades (not just topN)**

Modify the return statement (around line 215):

```typescript
    return {
      market,
      totalTrades: allTrades.length,
      analyzedTrades: tradesToAnalyze.length,
      suspiciousTrades: options.wallet
        ? scoredTrades  // Return all trades in wallet mode
        : scoredTrades.slice(0, options.topN ?? 50),
      analyzedAt: new Date(),
      // Add wallet-specific fields for output formatting
      targetWallet: options.wallet,
      targetAccountHistory: options.wallet ? targetAccountHistory : undefined,
    };
```

**Step 9: Update AnalysisReport type to include wallet fields**

Modify `src/output/types.ts` to add the new fields:

```typescript
export interface AnalysisReport {
  market: MarketInfo;
  totalTrades: number;
  analyzedTrades: number;
  suspiciousTrades: SuspiciousTrade[];
  analyzedAt: Date;
  // Wallet mode fields
  targetWallet?: string;
  targetAccountHistory?: import('../signals/types.js').AccountHistory;
}
```

**Step 10: Run build and tests**

Run: `npm run build && npm run test:run`
Expected: Build succeeds, tests pass

**Step 11: Commit**

```bash
git add src/commands/analyze.ts src/output/types.ts
git commit -m "feat(analyze): implement wallet filtering in execute method"
```

---

### Task 4: Add wallet analysis output function

**Files:**
- Modify: `src/output/cli.ts`

**Step 1: Add formatWalletAnalysis method to CLIReporter class**

Add this new method after `formatAnalysisReport` (around line 105):

```typescript
  /**
   * Format analysis report for wallet-targeted mode
   * Shows: account header, trades table, detailed breakdowns
   */
  formatWalletAnalysis(report: AnalysisReport): string {
    const lines: string[] = [];
    const wallet = report.targetWallet!;
    const account = report.targetAccountHistory;

    // === PART A: Account Header ===
    lines.push('');
    lines.push(chalk.bold('═'.repeat(70)));
    lines.push(chalk.bold(`Wallet Analysis: ${this.truncateWallet(wallet, false)} on "${this.truncateQuestion(report.market.question, 50)}"`));
    lines.push(chalk.bold('═'.repeat(70)));
    lines.push('');

    lines.push(chalk.bold('Account Stats:'));
    if (account) {
      if (account.creationDate) {
        const ageDays = Math.floor((Date.now() - account.creationDate.getTime()) / (1000 * 60 * 60 * 24));
        lines.push(`  Created:      ${account.creationDate.toLocaleDateString()} (${ageDays} days ago)`);
      } else if (account.firstTradeDate) {
        const ageDays = Math.floor((Date.now() - account.firstTradeDate.getTime()) / (1000 * 60 * 60 * 24));
        lines.push(`  First Trade:  ${account.firstTradeDate.toLocaleDateString()} (${ageDays} days ago)`);
      }
      lines.push(`  Total Trades: ${account.totalTrades.toLocaleString()}`);
      lines.push(`  Volume:       ${this.formatUsd(account.totalVolumeUsd)}`);
      if (account.profitUsd !== undefined) {
        const profitColor = account.profitUsd >= 0 ? chalk.green : chalk.red;
        const sign = account.profitUsd >= 0 ? '+' : '';
        const roi = account.totalVolumeUsd > 0
          ? ((account.profitUsd / account.totalVolumeUsd) * 100).toFixed(1)
          : '0.0';
        lines.push(`  Profit:       ${profitColor(sign + this.formatUsd(account.profitUsd))} (${roi}% ROI)`);
      }
    } else {
      lines.push(chalk.yellow('  No account history found'));
    }
    lines.push('');

    // === PART B: Trades Summary Table ===
    if (report.suspiciousTrades.length === 0) {
      lines.push(chalk.yellow('No trades found for this wallet on this market.'));
      return lines.join('\n');
    }

    lines.push(chalk.bold(`All Trades (${report.suspiciousTrades.length}):`));
    lines.push(chalk.gray('Weights: Size 40% | Acct 35% | Conv 25%'));
    lines.push('');

    // Table header
    lines.push(
      chalk.bold('  #'.padEnd(5)) +
      chalk.bold('Time'.padEnd(18)) +
      chalk.bold('Side'.padEnd(10)) +
      chalk.bold('Size'.padEnd(12)) +
      chalk.bold('Price'.padEnd(8)) +
      chalk.bold('Score'.padEnd(10)) +
      chalk.bold('Breakdown')
    );
    lines.push(chalk.gray('  ' + '─'.repeat(90)));

    // Table rows
    report.suspiciousTrades.forEach((st, idx) => {
      const getScore = (name: string) => st.score.signals.find(s => s.name === name)?.score ?? 0;
      const sizeScore = getScore('tradeSize');
      const acctScore = getScore('accountHistory');
      const convScore = getScore('conviction');

      const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;
      const sideStr = `${st.trade.side} ${st.trade.outcome}`;
      const sideColor = st.trade.side === 'BUY' ? chalk.green : chalk.red;

      lines.push(
        `  ${String(idx + 1).padEnd(4)}` +
        `${this.formatTime(st.trade.timestamp).padEnd(18)}` +
        `${sideColor(sideStr.padEnd(10))}` +
        `${this.formatUsd(st.trade.valueUsd).padStart(10)}  ` +
        `${st.trade.price.toFixed(2).padStart(6)}  ` +
        `${scoreColor(String(st.score.total).padStart(3))}  ` +
        chalk.gray(`Sz:${String(sizeScore).padStart(2)} Ac:${String(acctScore).padStart(2)} Cv:${String(convScore).padStart(2)}`)
      );
    });

    lines.push('');

    // === PART C: Detailed Breakdowns ===
    lines.push(chalk.bold('Detailed Signal Breakdowns:'));
    lines.push('');

    report.suspiciousTrades.forEach((st, idx) => {
      lines.push(this.formatDetailedTradeBreakdown(st, idx + 1));
      lines.push('');
    });

    return lines.join('\n');
  }

  /**
   * Format detailed breakdown for a single trade
   */
  private formatDetailedTradeBreakdown(st: SuspiciousTrade, rank: number): string {
    const lines: string[] = [];
    const scoreColor = st.score.total >= 80 ? chalk.red : st.score.total >= 60 ? chalk.yellow : chalk.white;

    // Trade header
    lines.push(chalk.bold(`Trade #${rank}: ${st.trade.side} ${st.trade.outcome} ${this.formatUsd(st.trade.valueUsd)} @ ${st.trade.price.toFixed(2)} (${this.formatTime(st.trade.timestamp)})`));
    lines.push(chalk.gray('─'.repeat(60)));

    // Signal breakdowns
    for (const signal of st.score.signals) {
      const details = signal.details as Record<string, unknown>;
      const weightPct = Math.round(signal.weight * 100);

      lines.push(`  ${chalk.bold(this.getSignalFullName(signal.name))} (${weightPct}% weight)${' '.repeat(10)}Score: ${signal.score}`);

      // Signal-specific details
      if (signal.name === 'tradeSize') {
        const valueUsd = details.valueUsd as number | undefined;
        const impactPct = details.impactPercent as number | undefined;
        const sizeScore = details.sizeScore as number | undefined;
        const impactScore = details.impactScore as number | undefined;

        lines.push(chalk.gray(`    - Absolute size: ${this.formatUsd(valueUsd || 0)} -> ${sizeScore || 0} pts`));
        if (impactPct !== undefined) {
          lines.push(chalk.gray(`    - Market impact: ${impactPct.toFixed(1)}% price move -> ${impactScore || 0} pts`));
        }
      } else if (signal.name === 'accountHistory') {
        const reason = details.reason as string | undefined;
        if (reason === 'no_history') {
          lines.push(chalk.red(`    - NEW ACCOUNT - no trading history found`));
        } else {
          const totalTrades = details.totalTrades as number | undefined;
          const ageDays = details.accountAgeDays as number | undefined;
          const dormancy = details.dormancyDays as number | undefined;
          const profitUsd = details.profitUsd as number | undefined;
          const tradeCountScore = details.tradeCountScore as number | undefined;
          const ageScore = details.ageScore as number | undefined;
          const dormancyScore = details.dormancyScore as number | undefined;
          const profitScore = details.profitScore as number | undefined;

          lines.push(chalk.gray(`    - Trade count: ${totalTrades || '?'} -> ${tradeCountScore ?? '?'} pts`));
          lines.push(chalk.gray(`    - Account age: ${ageDays || '?'} days -> ${ageScore ?? '?'} pts`));
          lines.push(chalk.gray(`    - Dormancy: ${dormancy || 0} days idle -> ${dormancyScore ?? 0} pts`));
          if (profitUsd !== undefined && profitScore !== undefined) {
            lines.push(chalk.gray(`    - Profit on new account: ${this.formatUsd(profitUsd)} -> ${profitScore} pts`));
          } else {
            lines.push(chalk.gray(`    - Profit on new account: N/A (not new)`));
          }
        }
      } else if (signal.name === 'conviction') {
        const reason = details.reason as string | undefined;
        if (reason === 'no_history') {
          lines.push(chalk.yellow(`    - PLACEHOLDER - no volume history`));
        } else {
          const tradeValue = details.tradeValueUsd as number | undefined;
          const totalVolume = details.totalVolumeUsd as number | undefined;
          const tradePct = details.tradePercent as number | undefined;

          lines.push(chalk.gray(`    - Trade concentration: ${tradePct?.toFixed(1) || '?'}% of volume -> ${signal.score} pts`));
          lines.push(chalk.gray(`      (${this.formatUsd(tradeValue || 0)} trade / ${this.formatUsd(totalVolume || 0)} total)`));
        }
      }

      lines.push('');
    }

    // Final score with alert indicator
    const alertIndicator = st.score.isAlert ? chalk.red(' !! ALERT') : '';
    lines.push(`  ${chalk.bold('FINAL SCORE:')} ${scoreColor.bold(String(st.score.total))}${alertIndicator}`);

    return lines.join('\n');
  }

  private getSignalFullName(name: string): string {
    const names: Record<string, string> = {
      tradeSize: 'Trade Size Signal',
      accountHistory: 'Account History Signal',
      conviction: 'Conviction Signal',
    };
    return names[name] || name;
  }
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/output/cli.ts
git commit -m "feat(output): add formatWalletAnalysis for verbose wallet mode"
```

---

### Task 5: Route to wallet analysis output in CLI

**Files:**
- Modify: `src/index.ts:76`

**Step 1: Use different formatter based on wallet mode**

Replace the `reporter.formatAnalysisReport(report)` call (around line 76) with:

```typescript
        // Use wallet-specific output format when -w is provided
        if (opts.wallet) {
          console.log(reporter.formatWalletAnalysis(report));
        } else {
          console.log(reporter.formatAnalysisReport(report));
        }
```

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): route to wallet analysis output when -w flag used"
```

---

### Task 6: Manual testing

**Step 1: Test wallet mode on a known market**

Run: `npm run dev -- analyze -m venezuela -w 0x1234...` (use a real wallet from previous analyze output)

Expected:
- Account header with stats
- Table of all trades (not filtered by min-size)
- Detailed breakdowns for each trade

**Step 2: Test error case: -w with --all**

Run: `npm run dev -- analyze -m venezuela --all -w 0x1234...`

Expected: Error message "Error: --wallet (-w) cannot be used with --all flag"

**Step 3: Test that normal mode still works**

Run: `npm run dev -- analyze -m venezuela`

Expected: Normal output (top suspicious trades table)

**Step 4: Commit any fixes needed**

---

### Task 7: Update PROJECT_STATUS.md

**Files:**
- Modify: `PROJECT_STATUS.md`

**Step 1: Add the new feature to the Implemented Commands section**

Under the `analyze` command description, add:
```
   - `-w/--wallet` flag for targeted wallet analysis with verbose scoring output
```

**Step 2: Add to Progress Log**

Add entry:
```
| 2026-01-06 | Added `-w/--wallet` flag to analyze command for targeted wallet analysis with verbose signal breakdowns |
```

**Step 3: Commit**

```bash
git add PROJECT_STATUS.md
git commit -m "docs: update PROJECT_STATUS.md with wallet filter feature"
```
