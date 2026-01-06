/**
 * Market Resolver - Maps token IDs to human-readable market names
 *
 * Polymarket structure:
 * - Condition ID: Identifies the market question (0x...)
 * - Token ID: Identifies a specific outcome (YES/NO) - large decimal number
 *
 * This resolver uses lazy loading - it only fetches markets when needed,
 * rather than preloading thousands of markets upfront.
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  clobTokenIds: string; // JSON string: "[\"tokenId1\", \"tokenId2\"]"
  outcomes: string;     // JSON string: "[\"Yes\", \"No\"]"
  closed: boolean;
}

function parseJsonArray(jsonStr: string | undefined): string[] {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

  /**
   * Resolve a single token ID to market info
   */
  async resolve(tokenId: string): Promise<ResolvedToken | null> {
    // Check cache first
    const cached = this.tokenLookup.get(tokenId);
    if (cached) return cached;

    // Try to fetch this specific token
    const results = await this.fetchTokenIds([tokenId]);
    return results.get(tokenId) || null;
  }

  /**
   * Resolve multiple token IDs at once (efficient batch lookup)
   */
  async resolveBatch(tokenIds: string[]): Promise<Map<string, ResolvedToken>> {
    const results = new Map<string, ResolvedToken>();
    const uncached: string[] = [];

    // Check cache first
    for (const tokenId of tokenIds) {
      const cached = this.tokenLookup.get(tokenId);
      if (cached) {
        results.set(tokenId, cached);
      } else {
        uncached.push(tokenId);
      }
    }

    // Fetch uncached tokens
    if (uncached.length > 0) {
      const fetched = await this.fetchTokenIds(uncached);
      for (const [tokenId, resolved] of fetched) {
        results.set(tokenId, resolved);
      }
    }

    return results;
  }

  /**
   * Fetch specific token IDs from Gamma API
   */
  private async fetchTokenIds(tokenIds: string[]): Promise<Map<string, ResolvedToken>> {
    const results = new Map<string, ResolvedToken>();
    if (tokenIds.length === 0) return results;

    try {
      // Batch lookup with repeated clob_token_ids params
      // Format: ?clob_token_ids=X&clob_token_ids=Y (comma-separated doesn't work)
      const params = tokenIds.map(id => `clob_token_ids=${id}`).join('&');
      const url = `${GAMMA_API}/markets?${params}`;

      const response = await fetch(url);
      if (response.ok) {
        const markets = await response.json() as GammaMarket[];

        for (const market of markets) {
          const tokenIdsArr = parseJsonArray(market.clobTokenIds);
          const outcomesArr = parseJsonArray(market.outcomes);

          for (let i = 0; i < tokenIdsArr.length; i++) {
            const tokenId = tokenIdsArr[i];
            const outcome = outcomesArr[i] || `Outcome ${i}`;

            if (tokenId && tokenIds.includes(tokenId)) {
              const resolved: ResolvedToken = {
                tokenId,
                question: market.question,
                outcome,
                marketSlug: market.slug,
                conditionId: market.conditionId,
              };
              results.set(tokenId, resolved);
              this.tokenLookup.set(tokenId, resolved);
            }
          }
        }
      }

      // Markets that can't be found will show as truncated token IDs.
    } catch (error) {
      console.warn(`Error fetching token IDs: ${error}`);
    }

    return results;
  }

  /**
   * Get the number of cached tokens
   */
  get cacheSize(): number {
    return this.tokenLookup.size;
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
