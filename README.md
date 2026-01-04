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

# Analyze by condition ID
npm run dev -- analyze -m 0x580adc1327de9bf7c179ef5aaffa3377bb5cb252b7d6390b027172d43fd6f993

# Limit trades fetched (default: 10,000)
npm run dev -- analyze -m <market> --max-trades 5000

# Filter by date range
npm run dev -- analyze -m <market> --after 2025-01-01 --before 2025-06-01

# Filter by outcome
npm run dev -- analyze -m <market> --outcome YES

# Adjust alert threshold (default: 70)
npm run dev -- analyze -m <market> --threshold 50
```

## Caching

Trades are cached locally in `.cache/trades/` to avoid re-fetching on subsequent runs. The cache stores trades by market ID and only fetches new trades on subsequent runs.

## Polymarket Data API Limitations

### 100,000 Trade Cap

The Polymarket Data API (`data-api.polymarket.com/trades`) has an undocumented limit of **100,000 trades per market**.

**Evidence:**
- Requesting offset 99998 returns trades: `0x9776b5...`, `0x3a11b9...`, `0x3d03e4...`
- Requesting offset 100001 returns the **same trades**: `0x9776b5...`, `0x3a11b9...`, `0x3d03e4...`
- The API wraps around and repeats data beyond offset ~100,000

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

For highly active markets, the 100k trade cap may only cover a few hours of activity. For example:

| Market | Trades | Time Window |
|--------|--------|-------------|
| Maduro Jan 31 | 100,000 | ~3 hours |

Historical trades beyond this window are **not accessible** via the Data API.

### Alternative: CLOB API

The CLOB API (`clob.polymarket.com/data/trades`) supports `before` and `after` timestamp parameters but:
- Requires L2 authentication
- Only returns the **authenticated user's own trades**, not all market trades

## Signals

The detector uses three weighted signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Trade Size | 40% | Large trades relative to market |
| Account History | 35% | New/dormant accounts score higher |
| Conviction | 25% | Trades at extreme prices (near 0 or 1) |

## License

MIT
