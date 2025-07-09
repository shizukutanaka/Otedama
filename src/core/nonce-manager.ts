// Nonce range management to prevent collisions (Carmack style - efficient)
export class NonceManager {
  private assignedRanges = new Map<string, NonceRange>();
  private rangeSize: number;
  private currentBase = 0;
  
  constructor(rangeSize = 0x100000) { // 1M nonces per range
    this.rangeSize = rangeSize;
  }
  
  // Assign nonce range to miner
  assignRange(minerId: string): NonceRange {
    // Check if miner already has a range
    let range = this.assignedRanges.get(minerId);
    
    if (!range || range.isExhausted()) {
      // Assign new range
      range = new NonceRange(
        this.currentBase,
        this.currentBase + this.rangeSize - 1
      );
      
      this.currentBase += this.rangeSize;
      
      // Wrap around if needed (32-bit limit)
      if (this.currentBase >= 0xFFFFFFFF) {
        this.currentBase = 0;
      }
      
      this.assignedRanges.set(minerId, range);
    }
    
    return range;
  }
  
  // Release range when miner disconnects
  releaseRange(minerId: string): void {
    this.assignedRanges.delete(minerId);
  }
  
  // Get miner's current range
  getRange(minerId: string): NonceRange | undefined {
    return this.assignedRanges.get(minerId);
  }
  
  // Reset all ranges (new block)
  reset(): void {
    this.assignedRanges.clear();
    this.currentBase = 0;
  }
}

// Nonce range with efficient checking
export class NonceRange {
  private current: number;
  
  constructor(
    private start: number,
    private end: number
  ) {
    this.current = start;
  }
  
  // Get next nonce in range
  next(): number | null {
    if (this.current > this.end) {
      return null;
    }
    return this.current++;
  }
  
  // Check if nonce is in range
  contains(nonce: number): boolean {
    return nonce >= this.start && nonce <= this.end;
  }
  
  // Check if range is exhausted
  isExhausted(): boolean {
    return this.current > this.end;
  }
  
  // Get range info
  getInfo(): { start: number, end: number, remaining: number } {
    return {
      start: this.start,
      end: this.end,
      remaining: Math.max(0, this.end - this.current + 1)
    };
  }
}

// Extra nonce management for stratum
export class ExtraNonceManager {
  private counter = 0;
  private size: number;
  private maxValue: number;
  
  constructor(size = 4) { // 4 bytes by default
    this.size = size;
    this.maxValue = Math.pow(2, size * 8) - 1;
  }
  
  // Generate unique extra nonce for connection
  generate(): Buffer {
    const extraNonce = Buffer.alloc(this.size);
    
    // Write counter value
    let value = this.counter++;
    for (let i = 0; i < this.size; i++) {
      extraNonce[i] = value & 0xFF;
      value >>= 8;
    }
    
    // Wrap around
    if (this.counter > this.maxValue) {
      this.counter = 0;
    }
    
    return extraNonce;
  }
  
  // Get size for stratum
  getSize(): number {
    return this.size;
  }
}

// Efficient nonce tracking to prevent duplicates
export class NonceTracker {
  private recentNonces: Set<string>[] = [];
  private currentSet = 0;
  private maxSets = 2;
  private setSize = 100000;
  
  constructor() {
    // Initialize rotating sets
    for (let i = 0; i < this.maxSets; i++) {
      this.recentNonces.push(new Set());
    }
  }
  
  // Check and add nonce
  checkAndAdd(jobId: string, nonce: number, extraNonce: string): boolean {
    const key = `${jobId}:${nonce}:${extraNonce}`;
    
    // Check all sets
    for (const set of this.recentNonces) {
      if (set.has(key)) {
        return false; // Duplicate
      }
    }
    
    // Add to current set
    this.recentNonces[this.currentSet].add(key);
    
    // Rotate sets if current is full
    if (this.recentNonces[this.currentSet].size >= this.setSize) {
      this.currentSet = (this.currentSet + 1) % this.maxSets;
      this.recentNonces[this.currentSet].clear();
    }
    
    return true;
  }
  
  // Clear all tracked nonces (new block)
  clear(): void {
    for (const set of this.recentNonces) {
      set.clear();
    }
  }
}

// Difficulty-based nonce assignment
export class AdaptiveNonceManager {
  private minerStats = new Map<string, MinerNonceStats>();
  
  // Adjust range size based on miner's hashrate
  calculateRangeSize(minerId: string, difficulty: number): number {
    const stats = this.minerStats.get(minerId);
    
    if (!stats) {
      // Default range for new miners
      return 0x100000; // 1M
    }
    
    // Calculate based on hashrate and target time
    const targetSeconds = 10; // Aim for 10 seconds per range
    const hashesPerRange = stats.hashrate * targetSeconds;
    
    // Round to power of 2 for efficiency
    const rangeSizeBits = Math.ceil(Math.log2(hashesPerRange));
    const rangeSize = Math.pow(2, Math.min(rangeSizeBits, 24)); // Max 16M
    
    return rangeSize;
  }
  
  // Update miner statistics
  updateStats(minerId: string, hashrate: number): void {
    let stats = this.minerStats.get(minerId);
    
    if (!stats) {
      stats = new MinerNonceStats();
      this.minerStats.set(minerId, stats);
    }
    
    stats.update(hashrate);
  }
}

class MinerNonceStats {
  hashrate = 0;
  lastUpdate = Date.now();
  
  update(hashrate: number): void {
    // Exponential moving average
    this.hashrate = this.hashrate * 0.7 + hashrate * 0.3;
    this.lastUpdate = Date.now();
  }
}
