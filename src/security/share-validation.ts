// Share duplicate detection (Carmack style - fast and direct)
import * as crypto from 'crypto';
import { Share } from '../domain/share';

export class ShareDuplicateDetector {
  // Use a circular buffer for memory efficiency
  private recentHashes: string[];
  private hashSet: Set<string>;
  private index: number = 0;
  private readonly bufferSize: number;
  
  constructor(bufferSize: number = 100000) { // Store last 100k shares
    this.bufferSize = bufferSize;
    this.recentHashes = new Array(bufferSize);
    this.hashSet = new Set();
  }
  
  // Fast hash calculation for share identification
  private calculateShareHash(share: Share): string {
    // Use only essential fields for hash to detect duplicates
    const data = `${share.minerId}:${share.jobId}:${share.nonce}:${share.data.toString('hex')}`;
    
    // Use faster hash for duplicate detection (not cryptographic security)
    return crypto.createHash('sha1').update(data).digest('hex');
  }
  
  // Check if share is duplicate
  isDuplicate(share: Share): boolean {
    const hash = this.calculateShareHash(share);
    
    // Fast lookup in set
    if (this.hashSet.has(hash)) {
      return true;
    }
    
    // Add to circular buffer and set
    const oldHash = this.recentHashes[this.index];
    if (oldHash) {
      this.hashSet.delete(oldHash); // Remove old hash from set
    }
    
    this.recentHashes[this.index] = hash;
    this.hashSet.add(hash);
    this.index = (this.index + 1) % this.bufferSize;
    
    return false;
  }
  
  // Get statistics
  getStats(): { totalChecked: number; uniqueShares: number } {
    return {
      totalChecked: this.index < this.bufferSize ? this.index : this.bufferSize,
      uniqueShares: this.hashSet.size
    };
  }
  
  // Clear all data
  clear(): void {
    this.recentHashes = new Array(this.bufferSize);
    this.hashSet.clear();
    this.index = 0;
  }
}

// Time-based share validation window
export class ShareTimeValidator {
  private readonly maxShareAge: number; // milliseconds
  private readonly maxFutureTime: number; // milliseconds
  
  constructor(maxShareAge: number = 300000, maxFutureTime: number = 10000) {
    this.maxShareAge = maxShareAge; // 5 minutes default
    this.maxFutureTime = maxFutureTime; // 10 seconds into future
  }
  
  isValidTime(share: Share): boolean {
    const now = Date.now();
    const shareTime = share.timestamp;
    
    // Check if share is too old
    if (now - shareTime > this.maxShareAge) {
      return false;
    }
    
    // Check if share is from the future (clock skew)
    if (shareTime - now > this.maxFutureTime) {
      return false;
    }
    
    return true;
  }
}

// Combined share validator with all checks
export class EnhancedShareValidator {
  private duplicateDetector: ShareDuplicateDetector;
  private timeValidator: ShareTimeValidator;
  
  constructor() {
    this.duplicateDetector = new ShareDuplicateDetector();
    this.timeValidator = new ShareTimeValidator();
  }
  
  validate(share: Share): { valid: boolean; reason?: string } {
    // Basic validation
    if (!share.isValid()) {
      return { valid: false, reason: 'Invalid share format' };
    }
    
    // Time validation
    if (!this.timeValidator.isValidTime(share)) {
      return { valid: false, reason: 'Share time out of valid window' };
    }
    
    // Duplicate check
    if (this.duplicateDetector.isDuplicate(share)) {
      return { valid: false, reason: 'Duplicate share' };
    }
    
    return { valid: true };
  }
  
  getStats() {
    return {
      duplicateStats: this.duplicateDetector.getStats()
    };
  }
}