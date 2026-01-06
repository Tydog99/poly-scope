---
description: Query a wallet's trades (maker + taker) from The Graph subgraph
argument-hint: <wallet-address> [count] [--format table|json]
allowed-tools: Bash(source:*), Bash(curl:*)
---

# Wallet Trades Query

Query recent trades for a wallet from the Polymarket subgraph (both maker and taker roles).

## Arguments

- `$1` - Wallet address (required, will be lowercased)
- `$2` - Number of trades to fetch (optional, default: 20)
- `--format table` - Display as formatted table (default: raw JSON)

## Execute Query

Parse the arguments:
- First argument (`$1`): wallet address - lowercase it
- Second argument (`$2`): count - use 20 if not provided or if it's a flag like `--format`

Run this bash command (substitute WALLET_ADDRESS and COUNT with actual values):

```bash
source .env && \
curl -s "https://gateway.thegraph.com/api/subgraphs/id/81Dm16JjuFSrqz813HysXoUPvzTwE7fsfPk2RTf66nyC" \
  -H "Authorization: Bearer $THE_GRAPH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ enrichedOrderFilleds(where: { or: [{taker: \"WALLET_ADDRESS\"}, {maker: \"WALLET_ADDRESS\"}] }, orderBy: timestamp, orderDirection: desc, first: COUNT) { id transactionHash timestamp maker { id } taker { id } market { id } side size price } }"}'
```

Replace in the command:
- `WALLET_ADDRESS` with the lowercased wallet from $1
- `COUNT` with the numeric count from $2 (default: 20)

## Output Format Instructions

After executing the query, present the results based on the format requested:

### If `--format table` or user asks for table:

Display a formatted table with these columns:
| Time | Role | Side | Size (USD) | Price | Market ID | Tx Hash |

Where:
- **Time**: Convert Unix timestamp to readable format (YYYY-MM-DD HH:MM:SS)
- **Role**: "Maker" if wallet matches maker.id, "Taker" if wallet matches taker.id
- **Side**: The side field ("Buy" or "Sell") - note this is the MAKER's side
- **Size (USD)**: Divide `size` by 1,000,000 (6 decimals), format as $X,XXX.XX
- **Price**: The price field (0-1 range, represents probability)
- **Market ID**: Truncate to first 8 chars + "..."
- **Tx Hash**: Truncate to first 8 chars + "..."

### If `--format json` or raw output requested:

Return the raw JSON response from the API.

## Example Usage

```
/wallet-trades 0x1234567890abcdef1234567890abcdef12345678
/wallet-trades 0x1234567890abcdef1234567890abcdef12345678 50
/wallet-trades 0x1234567890abcdef1234567890abcdef12345678 30 --format table
```

## Important Notes

- Wallet addresses are automatically lowercased (subgraph requirement)
- The `side` field represents the MAKER's order side, not the taker's action
- `size` field is in 6-decimal format (divide by 1e6 for USD)
- Results are ordered by timestamp descending (most recent first)
