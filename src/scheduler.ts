/**
 * Caps how many repositories may be fetching at once.
 *
 * Staggering only helps at startup. A window regaining focus, or one click of
 * "Check Upstream Now", asks every repository to check at the same moment — ten
 * simultaneous `git fetch` calls over a VPN is a visible stall. Work queues
 * here instead and runs a few at a time.
 */
export class Scheduler {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
