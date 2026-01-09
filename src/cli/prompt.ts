import * as readline from 'readline';

export interface MarketOption {
  question: string;
  conditionId: string;
}

export interface ParseResult {
  type: 'all' | 'selection' | 'invalid';
  index?: number; // 0-indexed selection (only for type='selection')
  error?: string;
}

/**
 * Parse user input for market selection.
 * @param input - User's raw input string
 * @param marketCount - Number of available markets
 * @returns ParseResult with type and optional index/error
 */
export function parseMarketSelection(input: string, marketCount: number): ParseResult {
  const trimmed = input.trim().toLowerCase();

  // Check for "all" option
  if (trimmed === 'a' || trimmed === 'all') {
    return { type: 'all' };
  }

  // Try to parse as number
  const selection = parseInt(trimmed, 10);

  if (isNaN(selection)) {
    return {
      type: 'invalid',
      error: `Invalid selection. Please enter 1-${marketCount} or 'a' for all.`,
    };
  }

  if (selection < 1 || selection > marketCount) {
    return {
      type: 'invalid',
      error: `Invalid selection. Please enter 1-${marketCount} or 'a' for all.`,
    };
  }

  return {
    type: 'selection',
    index: selection - 1, // Convert to 0-indexed
  };
}

/**
 * Prompt user to select a market from a list.
 * @param markets - Array of market options
 * @returns Promise resolving to -1 for "all", or 0-indexed market selection
 */
export async function promptMarketSelection(markets: MarketOption[]): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`\nSelect a market (1-${markets.length}, or 'a' for all): `, (answer) => {
      rl.close();

      const result = parseMarketSelection(answer, markets.length);

      if (result.type === 'all') {
        resolve(-1);
      } else if (result.type === 'selection') {
        resolve(result.index!);
      } else {
        console.error(result.error);
        process.exit(1);
      }
    });
  });
}
