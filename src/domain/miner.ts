// Simple miner entity (Uncle Bob style)
export class Miner {
  constructor(
    public id: string,
    public address: string,
    public workerName: string = 'default'
  ) {}
  
  // Track basic statistics
  public shares: number = 0;
  public lastShareTime: number = 0;
  public difficulty: number = 1;
  public hashrate: number = 0;
  
  // Simple methods only
  submitShare(): void {
    this.shares++;
    this.lastShareTime = Date.now();
  }
  
  calculateHashrate(windowSeconds: number = 600): number {
    // Simple hashrate calculation based on shares and difficulty
    const timeElapsed = (Date.now() - this.lastShareTime) / 1000;
    if (timeElapsed > windowSeconds) {
      return 0;
    }
    
    // Simplified calculation
    this.hashrate = (this.shares * this.difficulty * 4294967296) / windowSeconds;
    return this.hashrate;
  }
  
  isActive(timeoutSeconds: number = 300): boolean {
    return (Date.now() - this.lastShareTime) / 1000 < timeoutSeconds;
  }
}

// Simple collection for managing miners
export class MinerRegistry {
  private miners = new Map<string, Miner>();
  
  register(miner: Miner): void {
    this.miners.set(miner.id, miner);
  }
  
  get(id: string): Miner | undefined {
    return this.miners.get(id);
  }
  
  remove(id: string): void {
    this.miners.delete(id);
  }
  
  // Get active miners
  getActive(timeoutSeconds: number = 300): Miner[] {
    const active: Miner[] = [];
    for (const miner of this.miners.values()) {
      if (miner.isActive(timeoutSeconds)) {
        active.push(miner);
      }
    }
    return active;
  }
  
  // Cleanup inactive miners
  cleanup(timeoutSeconds: number = 3600): void {
    for (const [id, miner] of this.miners.entries()) {
      if (!miner.isActive(timeoutSeconds)) {
        this.miners.delete(id);
      }
    }
  }
}
