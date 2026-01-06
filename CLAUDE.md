# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript CLI tool that detects potential insider trading on Polymarket by scoring trades based on size/impact, account history, and directional conviction.

## MCP

Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.

## Git

Before each commit look to update PROJECT_STATUS.md to reflect the current state of the project.

## Commands

```bash
npm run dev            # Run CLI in development mode (tsx)
npm run build          # Compile TypeScript to dist/
npm test               # Run tests in watch mode
npm run test:run       # Run tests once

# Run a single test file
npx vitest run tests/signals/tradeSize.test.ts

# CLI usage (after build)
./dist/index.js analyze --market <slug|conditionId>
```

## Sub Agents
Use sub agents to search the Web.

## Architecture

The detection pipeline:

1. **Data Layer** (`src/api/`) - Fetches market data and trades via Polymarket APIs
   - `client.ts` - Wraps `@polymarket/clob-client` SDK
   - `trades.ts` - Fetches trade history (subgraph primary, Data API fallback)
   - `accounts.ts` - Fetches account trading history
   - `subgraph.ts` - The Graph client for on-chain data
   - `slug.ts` - Resolves market slugs to condition IDs via Gamma API

2. **Detection Engine** (`src/signals/`) - Three weighted signals produce 0-100 scores:
   - `TradeSizeSignal` (40%) - Absolute size and market impact
   - `AccountHistorySignal` (35%) - Account newness, low trade count, dormancy
   - `ConvictionSignal` (25%) - One-sided, high-conviction bets
   - `SignalAggregator` - Combines weighted signals, flags trades above threshold

3. **Commands** (`src/commands/`) - CLI command implementations
   - `analyze.ts` - Forensic analysis of historical markets
   - `investigate.ts` - Deep-dive wallet investigation

4. **Output** (`src/output/`) - Formatting and display
   - `cli.ts` - Terminal output with chalk colors

## Configuration

`config.json` at project root controls signal weights and thresholds. Defaults in `src/config.ts`. CLI flags `--min-size` and `--threshold` override config values.

## Key Types

- `Trade` - Normalized trade with wallet, side, outcome, size, price, valueUsd
- `SignalResult` - Individual signal output (name, score 0-100, weight, details)
- `AggregatedScore` - Combined score with isAlert flag
- `AnalysisReport` - Full analysis output with market info and suspicious trades

## Testing

Tests mirror src structure in `tests/`. Integration tests in `tests/integration/` use fixtures from known insider trading cases.

## The Graph Subgraph

We use The Graph subgraph (`81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC`) as the primary data source for account history and trade data.

### Schema Reference

The official Polymarket subgraph schemas are at: https://github.com/Polymarket/polymarket-subgraph

Each subdirectory contains a `schema.graphql`:

| Subgraph | Key Entities | Useful For |
|----------|--------------|------------|
| `pnl-subgraph` | `UserPosition` (avgPrice, realizedPnl, totalBought) | Per-position P&L |
| `activity-subgraph` | `Split`, `Merge`, `Redemption`, `Position` | Token activity |
| `orderbook-subgraph` | `OrderFilledEvent`, `Orderbook` (per-token stats) | Trade events |
| `fpmm-subgraph` | `FpmmTransaction`, `FixedProductMarketMaker` | AMM trades |
| `wallet-subgraph` | `Wallet` (balance, createdAt, signer, type) | Wallet metadata |
| `oi-subgraph` | `MarketOpenInterest`, `GlobalOpenInterest` | Open interest |

### Deployed Subgraph Entities

The deployed subgraph we use has additional **enriched/aggregated entities** not in individual schemas:

- `Account` - Aggregated account stats (creationTimestamp, numTrades, collateralVolume, profit)
- `EnrichedOrderFilled` - Trade with maker/taker/market references
- `MarketPosition` - User positions per market

### Key Fields

```graphql
# Account (aggregated user stats)
account(id: $wallet) {
  id
  creationTimestamp
  lastSeenTimestamp
  collateralVolume    # 6 decimals
  numTrades
  profit              # 6 decimals, can be negative
  scaledProfit
}

# EnrichedOrderFilled (trades)
enrichedOrderFilleds(where: { market: $tokenId }) {
  id
  transactionHash
  timestamp
  maker { id }
  taker { id }
  market { id }       # Token/Orderbook ID
  side                # "Buy" or "Sell"
  size                # 6 decimals - USD VALUE of trade (NOT shares!)
  price               # 0-1 decimal (e.g., 0.08 = 8 cents per share)
}

# MarketPosition (user holdings)
marketPositions(where: { user_: { id: $wallet } }) {
  market { id }
  valueBought
  valueSold
  netValue
  netQuantity
}
```

### Potentially Useful Fields Not Yet Used

- `UserPosition.avgPrice` - Average entry price per position
- `UserPosition.realizedPnl` - Realized P&L per position
- `Orderbook` - Per-token trade counts and volume aggregates
- `FpmmTransaction.outcomeIndex` - Maps trades to YES/NO outcomes

## Polymarket Order Book (CLOB)

Polymarket uses a hybrid-decentralized Central Limit Order Book (CLOB). Orders are matched off-chain by an operator, with settlement executed on-chain via signed order messages.

### Binary Outcome Tokens

Each market condition has TWO tokens:
- **YES token** - Pays $1 if outcome is YES, $0 if NO
- **NO token** - Pays $1 if outcome is NO, $0 if YES

Token prices are complementary: `YES_price + NO_price ≈ $1.00`

Example: If YES trades at $0.08, NO trades at ~$0.92

**Token operations:**
- **Split**: $1000 USDC → 1000 YES + 1000 NO tokens
- **Merge**: 1000 YES + 1000 NO → $1000 USDC
- **Redeem**: After resolution, winning tokens → USDC (1:1)

### Order Matching & Side Field

**CRITICAL**: The `side` field in `EnrichedOrderFilled` represents the **MAKER's order side**, not the taker's action.

| Maker's Order | Taker's Action | Economic Effect for Taker |
|---------------|----------------|---------------------------|
| `side: "Sell"` on YES token | Taker BUYS YES | Betting YES will win |
| `side: "Buy"` on YES token | Taker SELLS YES | Betting NO will win |
| `side: "Sell"` on NO token | Taker BUYS NO | Betting NO will win |
| `side: "Buy"` on NO token | Taker SELLS NO | Betting YES will win |

**Economic equivalences:**
- Buying YES @ $0.08 ≡ Selling NO @ $0.92 (both bet YES wins)
- Buying NO @ $0.92 ≡ Selling YES @ $0.08 (both bet NO wins)

### Interpreting Trades for a Wallet

When analyzing trades for a specific wallet, determine their actual action:

```typescript
// Determine the wallet's actual action
function getWalletAction(trade: SubgraphTrade, walletAddress: string): 'BUY' | 'SELL' {
  const isMaker = trade.maker.toLowerCase() === walletAddress.toLowerCase();

  if (isMaker) {
    // Maker's action matches the side field
    return trade.side === 'Buy' ? 'BUY' : 'SELL';
  } else {
    // Taker's action is OPPOSITE of the side field
    return trade.side === 'Buy' ? 'SELL' : 'BUY';
  }
}
```

### Token ID to Outcome Mapping

Each condition has two token IDs. The Gamma API returns them in order: `[YES_token_id, NO_token_id]`

```bash
# Get token IDs for a market
curl "https://gamma-api.polymarket.com/markets?clob_token_ids=<token_id>" | jq '.[] | {question, tokens: .clobTokenIds}'
# Returns: {"tokens": "[\"YES_TOKEN_ID\", \"NO_TOKEN_ID\"]"}
```

To determine if a token is YES or NO:
1. Query Gamma API with the token ID
2. Compare position in the `clobTokenIds` array (index 0 = YES, index 1 = NO)

## Tool Use - API Query Reference

Copy-paste ready queries for debugging and data exploration. Always `source .env` first to load `THE_GRAPH_API_KEY`.

### Subgraph Queries

**Base curl command** (reuse this pattern):
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "YOUR_QUERY_HERE"}'
```

#### Get wallet's recent trades (as taker)
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ enrichedOrderFilleds(where: { taker: \"WALLET_ADDRESS\" }, orderBy: timestamp, orderDirection: desc, first: 20) { transactionHash timestamp side size price market { id } } }"}' | jq '.data.enrichedOrderFilleds'
```

#### Get wallet's trades (both maker AND taker) - use `or` filter
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ enrichedOrderFilleds(where: { or: [{taker: \"WALLET_ADDRESS\"}, {maker: \"WALLET_ADDRESS\"}] }, orderBy: timestamp, orderDirection: desc, first: 30) { transactionHash timestamp maker { id } taker { id } market { id } side size price } }"}' | jq '.data.enrichedOrderFilleds'
```

**⚠️ IMPORTANT**: Cannot mix column filters with `or` at same level. This FAILS:
```graphql
# WRONG - will error
where: { timestamp_gte: 123, or: [{taker: "..."}, {maker: "..."}] }

# CORRECT - put timestamp inside each or branch
where: { or: [{taker: "...", timestamp_gte: 123}, {maker: "...", timestamp_gte: 123}] }
```

#### Get wallet's positions (which tokens they hold/traded)
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ marketPositions(where: { user_: { id: \"WALLET_ADDRESS\" } }, first: 20, orderBy: valueBought, orderDirection: desc) { market { id } valueBought valueSold netValue netQuantity } }"}' | jq '.data.marketPositions'
```

#### Get account stats
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ account(id: \"WALLET_ADDRESS\") { id creationTimestamp numTrades collateralVolume profit } }"}' | jq '.data.account'
```

#### Get trades on a specific token/market
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ enrichedOrderFilleds(where: { market: \"TOKEN_ID\" }, orderBy: timestamp, orderDirection: desc, first: 20) { transactionHash timestamp maker { id } taker { id } side size price } }"}' | jq '.data.enrichedOrderFilleds'
```

#### Get redemptions for a wallet
```bash
source .env
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ redemptions(where: { redeemer_: { id: \"WALLET_ADDRESS\" } }, first: 20, orderBy: timestamp, orderDirection: desc) { id timestamp payout condition { id } } }"}' | jq '.data.redemptions'
```

### Gamma API Queries (Market Metadata)

#### Resolve token ID to market question (YES/NO determination)
```bash
curl -s "https://gamma-api.polymarket.com/markets?clob_token_ids=TOKEN_ID" | jq '.[] | {question, outcome: (if .clobTokenIds | fromjson | .[0] == "TOKEN_ID" then "Yes" else "No" end), clobTokenIds}'
```

#### Resolve multiple token IDs at once (use repeated params)
```bash
curl -s "https://gamma-api.polymarket.com/markets?clob_token_ids=TOKEN_ID_1&clob_token_ids=TOKEN_ID_2" | jq '.[] | {question, clobTokenIds}'
```

#### Search markets by question text
```bash
curl -s "https://gamma-api.polymarket.com/markets?closed=false&_limit=100" | jq '.[] | select(.question | test("SEARCH_TERM"; "i")) | {question, conditionId, clobTokenIds}'
```

#### Get event with all markets (by slug)
```bash
curl -s "https://gamma-api.polymarket.com/events?slug=EVENT_SLUG" | jq '.[].markets[] | {question, conditionId, clobTokenIds}'
```

### Common Pitfalls

1. **Wallet addresses must be lowercase** in subgraph queries
2. **Token IDs are large decimal numbers**, not hex condition IDs
3. **`size` and `price` fields have 6 decimal places** - divide by 1e6
4. **`side` field is MAKER's side**, not the taker's action (see CLOB section above)
5. **Positions persist after selling/redeeming** - `netQuantity=0` but record exists
6. **Each transaction can have fills on BOTH YES and NO tokens** - need to filter complementary trades
