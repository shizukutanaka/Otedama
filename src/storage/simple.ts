// Simple key-value storage (Carmack style - direct and fast)
import * as fs from 'fs/promises';
import * as path from 'path';
import { Share } from '../domain/share';
import { Miner } from '../domain/miner';

// Simple file-based storage for MVP
// In production, replace with Redis or similar
export class SimpleStorage {
  private dataDir: string;
  private shareBuffer: Share[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  
  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
  }
  
  async init(): Promise<void> {
    // Create data directory if not exists
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'shares'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'miners'), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, 'blocks'), { recursive: true });
    
    // Start periodic flush
    this.flushInterval = setInterval(() => {
      this.flushShares().catch(console.error);
    }, 5000); // Flush every 5 seconds
  }
  
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flushShares();
  }
  
  // Direct share storage - batch for performance
  async saveShare(share: Share): Promise<void> {
    this.shareBuffer.push(share);
    
    // Flush if buffer is large
    if (this.shareBuffer.length >= 1000) {
      await this.flushShares();
    }
  }
  
  private async flushShares(): Promise<void> {
    if (this.shareBuffer.length === 0) return;
    
    const shares = this.shareBuffer.splice(0);
    const timestamp = Date.now();
    const filename = path.join(this.dataDir, 'shares', `${timestamp}.json`);
    
    // Simple JSON storage
    await fs.writeFile(filename, JSON.stringify(shares));
  }
  
  // Get recent shares for PPLNS
  async getRecentShares(count: number): Promise<Share[]> {
    const files = await fs.readdir(path.join(this.dataDir, 'shares'));
    files.sort().reverse(); // Most recent first
    
    const shares: Share[] = [];
    
    for (const file of files) {
      if (shares.length >= count) break;
      
      const content = await fs.readFile(
        path.join(this.dataDir, 'shares', file),
        'utf-8'
      );
      const fileShares = JSON.parse(content) as Share[];
      shares.push(...fileShares);
    }
    
    return shares.slice(0, count);
  }
  
  // Simple miner storage
  async saveMiner(miner: Miner): Promise<void> {
    const filename = path.join(this.dataDir, 'miners', `${miner.id}.json`);
    await fs.writeFile(filename, JSON.stringify(miner));
  }
  
  async getMiner(id: string): Promise<Miner | null> {
    try {
      const filename = path.join(this.dataDir, 'miners', `${id}.json`);
      const content = await fs.readFile(filename, 'utf-8');
      return JSON.parse(content) as Miner;
    } catch {
      return null;
    }
  }
  
  // Block storage
  async saveBlock(blockData: any): Promise<void> {
    const timestamp = Date.now();
    const filename = path.join(this.dataDir, 'blocks', `${timestamp}.json`);
    await fs.writeFile(filename, JSON.stringify(blockData));
  }
  
  // Simple statistics
  async getPoolStats(): Promise<{
    totalShares: number;
    activeMiners: number;
    blocksFound: number;
  }> {
    const shareFiles = await fs.readdir(path.join(this.dataDir, 'shares'));
    const minerFiles = await fs.readdir(path.join(this.dataDir, 'miners'));
    const blockFiles = await fs.readdir(path.join(this.dataDir, 'blocks'));
    
    // Count shares
    let totalShares = this.shareBuffer.length;
    for (const file of shareFiles.slice(0, 10)) { // Sample recent files
      try {
        const content = await fs.readFile(
          path.join(this.dataDir, 'shares', file),
          'utf-8'
        );
        const shares = JSON.parse(content) as Share[];
        totalShares += shares.length;
      } catch {}
    }
    
    return {
      totalShares,
      activeMiners: minerFiles.length,
      blocksFound: blockFiles.length
    };
  }
}

// In-memory cache for hot data (Carmack style)
export class MemoryCache {
  private miners = new Map<string, Miner>();
  private recentShares: Share[] = [];
  private maxShares = 1000000; // Keep last 1M shares in memory
  
  addShare(share: Share): void {
    this.recentShares.push(share);
    if (this.recentShares.length > this.maxShares) {
      this.recentShares.shift(); // Remove oldest
    }
  }
  
  getRecentShares(count: number): Share[] {
    return this.recentShares.slice(-count);
  }
  
  setMiner(miner: Miner): void {
    this.miners.set(miner.id, miner);
  }
  
  getMiner(id: string): Miner | undefined {
    return this.miners.get(id);
  }
  
  clear(): void {
    this.miners.clear();
    this.recentShares = [];
  }
}
