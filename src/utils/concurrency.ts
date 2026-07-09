/**
 * Simple async mutex for serializing critical sections.
 *
 * Used by the live listener to prevent concurrent order placement
 * when multiple Telegram messages arrive simultaneously — without
 * blocking parallel image analysis.
 */

export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  /**
   * Run `fn` while holding the mutex. Concurrent callers wait in a queue.
   * Returns the same value/error `fn` would return if called directly.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const wait = this.chain;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
