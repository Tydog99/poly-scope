# Polymarket Insider Trading Detector

CLI tool for detecting potential insider trading activity on Polymarket prediction markets.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Analyze a market by slug
npm run dev -- analyze -m maduro-out-in-2025

# Analyze by specific market ID
npm run dev -- analyze -m 0x580adc1327de9bf7c179ef5aaffa3377bb5cb252b7d6390b027172d43fd6f993

# Limit trades fetched (default: 10,000)
npm run dev -- analyze -m <market> --max-trades 5000

# Filter by date range
npm run dev -- analyze -m <market> --after 2025-01-01 --before 2025-06-01

# Filter by outcome
npm run dev -- analyze -m <market> --outcome YES

# Adjust alert threshold (default: 70)
npm run dev -- analyze -m <market> --threshold 50

# Investigate a specific wallet
npm run dev -- investigate -w 0x31a56e9e690c621ed21de08cb559e9524cdb8ed9

# Show more trades in investigation
npm run dev -- investigate -w <wallet> --trades 50

# Disable subgraph (use Data API only)
npm run dev -- analyze -m <market> --no-subgraph
npm run dev -- investigate -w <wallet> --no-subgraph

# Enable account lookup caching (saves results to .cache/accounts/)
npm run dev -- analyze -m <market> --cache-account-lookup
```

## Caching

Trades are cached locally in `.cache/trades/` to avoid re-fetching on subsequent runs. The cache stores trades by market ID and only fetches new trades on subsequent runs.

## Polymarket Data API Limitations

### Trade Cap (Varies by Market)

The Polymarket Data API (`data-api.polymarket.com/trades`) has an undocumented trade limit that **varies by market**.

**Observed caps:**

| Market | API Cap | Time Coverage | Market Active Since |
|--------|---------|---------------|---------------------|
| Maduro Jan 31 | ~100,000 trades | ~3 hours | ? |
| Venezuela Invasion Jan 2026 | ~10,000 trades | ~13 hours | Dec 17 |

**Wrap-around behavior:** When requesting offsets beyond the cap, the API returns duplicate trades instead of empty results.

**Evidence (Maduro market):**
- Requesting offset 99998 returns trades: `0x9776b5...`, `0x3a11b9...`
- Requesting offset 100001 returns the **same trades**

**Evidence (Venezuela market):**
- Market has trading data since Dec 17 (visible on website chart)
- API only returns ~10k trades covering Jan 3-4
- Offsets beyond 10k wrap around to duplicate earlier results

### No Server-Side Date Filtering

The Data API does not support `before`, `after`, `start`, or `end` query parameters for filtering by timestamp. Available parameters are:

| Parameter | Description |
|-----------|-------------|
| `market` | Filter by condition ID |
| `user` | Filter by wallet address |
| `limit` | Max results per request (capped at 500) |
| `offset` | Pagination offset |
| `side` | BUY or SELL |

### Implications

Historical trades beyond the API cap are **not accessible** via the Data API. The cap appears to vary by market (possibly based on activity level or other factors).

### Alternative: CLOB API

The CLOB API (`clob.polymarket.com/data/trades`) supports `before` and `after` timestamp parameters but:
- Requires L2 authentication
- Only returns the **authenticated user's own trades**, not all market trades

## The Graph Subgraph API

An alternative to the Polymarket Data API that queries on-chain data directly from Polygon.

### Endpoint

```
https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC
```

Requires `Authorization: Bearer {API_KEY}` header. Get a free API key (100k queries/month) at [The Graph Studio](https://thegraph.com/studio/).

### Key Entities

| Entity | Description | Useful For |
|--------|-------------|------------|
| `Account` | Wallet with creation date, volume, trade count, profit | Account history signal |
| `EnrichedOrderFilled` | Trade with maker/taker, side, size, price | Trade analysis |
| `OrderFilledEvent` | Raw trade with asset IDs | Market matching |
| `MarketPosition` | User positions per market | Position tracking |
| `Condition` | Market conditions with resolution data | Market lookup |

### Account Fields

```graphql
account(id: $walletAddress) {
  id
  creationTimestamp    # When account first traded
  lastSeenTimestamp    # Most recent activity
  collateralVolume     # Total USD volume (6 decimals)
  numTrades            # Trade count
  profit               # P&L in USD (6 decimals)
}
```

### Trade Query (EnrichedOrderFilled)

```graphql
enrichedOrderFilleds(
  where: { maker_: { id: $wallet } }  # or taker_
  orderBy: timestamp
  orderDirection: desc
) {
  timestamp
  transactionHash
  maker { id }
  taker { id }
  side          # "Buy" or "Sell"
  size          # USD amount (6 decimals)
  price         # Price (6 decimals)
}
```

### Advantages Over Data API

| Feature | Data API | Subgraph |
|---------|----------|----------|
| Historical depth | Capped (~10k-100k trades) | Full history |
| Account creation date | Not available | ✓ Available |
| Account profit/loss | Not available | ✓ Available |
| Rate limits | Yes | 100k queries/month free |
| Authentication | API keys for some endpoints | Bearer token |

### Limitations

- Some indexers may timeout on large queries
- `market` field in `EnrichedOrderFilled` often returns undefined
- Asset IDs are large decimal numbers (not hex condition IDs)
- Query complexity limits apply

### Environment Variable

```bash
THE_GRAPH_API_KEY=your_api_key_here
```

## Known Cases

### Venezuela Market Insider Trading (Jan 2026)

A suspicious trading pattern was identified on the Venezuela market:

| Field | Value |
|-------|-------|
| **Wallet** | `0x31a56e9e690c621ed21de08cb559e9524cdb8ed9` |
| **Profile** | [Polymarket Profile](https://polymarket.com/@0x31a56e9E690c621eD21De08Cb559e9524Cdb8eD9-1766730765984?tab=activity) |
| **Account Created** | Dec 27, 2025 |
| **Total Volume** | $404,357 |
| **Profit/Loss** | -$28,076 |

**Suspicious Trades:**
- $6,000 Buy (Jan 2, 16:49 UTC)
- $6,000 Buy (Jan 3, 01:38 UTC) -> Moved price +4.0%
- $7,000 Buy (Jan 3, 02:15 UTC) -> Moved price +33.3%
- $7,215 Buy (Jan 3, 02:58 UTC) -> Moved price +2.3%

**Red Flags:**
- **"Sniper" Behavior**: Entering with medium size (~$7k) during extremely low liquidity periods.
- **Market Impact**: The $7k trade at 02:15 caused a massive 33% price jump.
- New account (created 6 days before trades)
- Massive one-sided buying ($381K bought vs $22K sold)

## Trade Classification System

The CLI tool automatically classifies suspicious trades based on behavior:

| Badge | Criteria | Configurable? |
|-------|----------|---------------|
| `[WHALE]` | Trade Value > $25,000 | Yes (`whaleThreshold`) |
| `[SNIPER]` | Score > 80 AND Impact > 2% AND Size < $25k | Yes (`sniper*`) |
| `[EARLY MOVER]`| Trading within first 48h of market creation | Yes (`earlyWindowHours`) |
| `[DUMPING]` | SELL trade causing > 5% price drop | Yes (`dumpImpactMin`) |

Configuration can be adjusted in `src/config.ts`.

Configuration can be adjusted in `src/config.ts`.

## Safe Bet Filtering

The tool automatically filters out "Safe Whale" trades to reduce noise. These are defined as:
- **Side**: BUY or SELL
- **Price**: > $0.95 (Configurable via `safeBetThreshold`)

These trades are typically yield farming (buying) or profit taking (selling) on near-certain outcomes and not indicative of insider information. You can disable this by setting `excludeSafeBets: false` in config.

## Signals

The detector uses three weighted signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Trade Size | 40% | Large trades relative to market |
| Account History | 35% | New/dormant accounts score higher |
| Conviction | 25% | Trades at extreme prices (near 0 or 1) |

## Future Work

Potential new signals that could improve detection accuracy:

- **Cross-Market Correlation Signal** - Detect wallets that consistently bet the same direction across related markets (e.g., multiple Venezuela-related markets), or always trade right before resolution
- **Position Concentration Signal** - Flag accounts with large positions concentrated in few markets vs. diversified across many
- **Trade Timing Signal** - Identify trades clustered right before major price moves or market resolutions
- **Whale Following Signal** - Detect accounts that consistently trade after known large accounts, suggesting information copying

These signals would use position and trade pattern data from the subgraph to identify more sophisticated insider trading behaviors.

## License

MIT
