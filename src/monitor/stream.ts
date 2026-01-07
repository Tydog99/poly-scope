import { RealTimeDataClient, ConnectionStatus } from '@polymarket/real-time-data-client';
import { EventEmitter } from 'events';
import type { RTDSTradeEvent, ConnectionState, MonitorConfig } from './types.js';

interface BackoffConfig {
  initialMs: number;
  multiplier: number;
  maxMs: number;
}

/**
 * Calculate backoff delay for reconnection attempt
 */
export function calculateBackoff(attempt: number, config: BackoffConfig): number {
  const delay = config.initialMs * Math.pow(config.multiplier, attempt);
  return Math.min(delay, config.maxMs);
}

/**
 * WebSocket stream wrapper with reconnection logic
 */
export class MonitorStream extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  private marketSlugs: string[];
  private config: MonitorConfig;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(marketSlugs: string[], config: MonitorConfig) {
    super();
    this.marketSlugs = marketSlugs;
    this.config = config;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Start the WebSocket connection
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /**
   * Stop the WebSocket connection
   */
  stop(): void {
    this.stopped = true;
    this.clearStabilityTimer();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.state = 'disconnected';
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    this.state = 'connecting';

    try {
      this.client = new RealTimeDataClient({
        autoReconnect: false, // We handle reconnection ourselves for custom backoff
        onConnect: (client) => {
          // Subscribe to trades for each market
          const subscriptions = this.marketSlugs.map(slug => ({
            topic: 'activity' as const,
            type: 'trades' as const,
            filters: JSON.stringify({ market_slug: slug }),
          }));

          client.subscribe({ subscriptions });

          this.state = 'connected';
          this.emit('connected');
          this.startStabilityTimer();
        },

        onMessage: (_client, message) => {
          if (message.topic === 'activity' && message.type === 'trades') {
            const trade = message.payload as RTDSTradeEvent;
            this.emit('trade', trade);
          }
        },

        onStatusChange: (status: ConnectionStatus) => {
          if (status === ConnectionStatus.DISCONNECTED && !this.stopped) {
            this.handleDisconnect();
          }
        },
      });

      this.client.connect();
    } catch (error) {
      this.emit('error', error as Error);
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;

    this.clearStabilityTimer();
    this.state = 'disconnected';
    this.emit('disconnected');

    this.attemptReconnect();
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopped) return;

    if (this.reconnectAttempts >= this.config.maxReconnects) {
      // Exhausted reconnects, wait for retry delay
      this.state = 'retry-wait';
      this.emit('retryWait', this.config.retryDelaySeconds);

      await this.sleep(this.config.retryDelaySeconds * 1000);

      // Check if stopped during sleep
      if (this.stopped) return;

      // Reset and try again
      this.reconnectAttempts = 0;
      await this.connect();
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts, this.config.maxReconnects);

    const backoffMs = calculateBackoff(
      this.reconnectAttempts - 1,
      this.config.backoff
    );

    this.state = 'backoff';
    await this.sleep(backoffMs);

    if (!this.stopped) {
      await this.connect();
    }
  }

  private startStabilityTimer(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      // Connection stable, reset reconnect counter
      this.reconnectAttempts = 0;
    }, this.config.stabilityThresholdSeconds * 1000);
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
