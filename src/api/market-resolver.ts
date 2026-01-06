/**
 * Market Resolver - Maps token IDs to human-readable market names
 *
 * Polymarket structure:
 * - Condition ID: Identifies the market question (0x...)
 * - Token ID: Identifies a specific outcome (YES/NO) - large decimal number
 *
 * This resolver fetches market data from the CLOB API and builds a lookup table.
 */

const CLOB_API = 'https://clob.polymarket.com';

interface ClobToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

interface ClobMarket {
  condition_id: string;
  question: string;
  market_slug: string;
  tokens: ClobToken[];
  closed: boolean;
}

interface ClobMarketsResponse {
  data: ClobMarket[];
  next_cursor?: string;
}

export interface ResolvedToken {
  tokenId: string;
  question: string;
  outcome: string;
  marketSlug: string;
  conditionId: string;
}

export class MarketResolver {
  private tokenLookup: Map<string, ResolvedToken> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the resolver by fetching markets from CLOB API
   * Call this before resolving tokens, or it will be called automatically
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.loadMarkets();
    await this.initPromise;
    this.initialized = true;
  }

  private async loadMarkets(): Promise<void> {
    let cursor: string | undefined;
    let totalLoaded = 0;
    const maxMarkets = 10000; // Safety limit

    try {
      while (totalLoaded < maxMarkets) {
        const url = cursor
          ? `${CLOB_API}/markets?next_cursor=${cursor}`
          : `${CLOB_API}/markets`;

        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`Failed to fetch markets: ${response.statusText}`);
          break;
        }

        const data = await response.json() as ClobMarketsResponse;

        if (!data.data || data.data.length === 0) break;

        for (const market of data.data) {
          for (const token of market.tokens) {
            if (token.token_id) {
              this.tokenLookup.set(token.token_id, {
                tokenId: token.token_id,
                question: market.question,
                outcome: token.outcome,
                marketSlug: market.market_slug,
                conditionId: market.condition_id,
              });
            }
          }
        }

        totalLoaded += data.data.length;
        cursor = data.next_cursor;

        if (!cursor) break;
      }
    } catch (error) {
      console.warn(`Error loading markets: ${error}`);
    }
  }

  /**
   * Resolve a single token ID to market info
   */
  async resolve(tokenId: string): Promise<ResolvedToken | null> {
    await this.initialize();
    return this.tokenLookup.get(tokenId) || null;
  }

  /**
   * Resolve multiple token IDs at once
   */
  async resolveBatch(tokenIds: string[]): Promise<Map<string, ResolvedToken>> {
    await this.initialize();

    const results = new Map<string, ResolvedToken>();
    for (const tokenId of tokenIds) {
      const resolved = this.tokenLookup.get(tokenId);
      if (resolved) {
        results.set(tokenId, resolved);
      }
    }
    return results;
  }

  /**
   * Get the number of markets loaded
   */
  get marketCount(): number {
    return this.tokenLookup.size / 2; // Each market has ~2 tokens
  }

  /**
   * Format a token ID for display with optional market name
   * Returns format: "Question (Outcome)" or truncated token ID if not found
   */
  formatTokenId(tokenId: string, resolved?: ResolvedToken | null): string {
    if (resolved) {
      // Truncate long questions
      const maxLen = 40;
      const question = resolved.question.length > maxLen
        ? resolved.question.slice(0, maxLen - 3) + '...'
        : resolved.question;
      return `${question} (${resolved.outcome})`;
    }

    // Fallback: truncate token ID
    if (tokenId.length > 20) {
      return tokenId.slice(0, 10) + '...' + tokenId.slice(-8);
    }
    return tokenId;
  }
}

// Singleton instance for convenience
let defaultResolver: MarketResolver | null = null;

export function getMarketResolver(): MarketResolver {
  if (!defaultResolver) {
    defaultResolver = new MarketResolver();
  }
  return defaultResolver;
}
