// Direct validation without abstraction (Carmack style)
import * as crypto from 'crypto';
import { Share } from '../domain/share';

export class ShareValidator {
  // Direct validation without abstraction layers
  validateDirect(share: Share): boolean {
    if (!share || !share.data) {
      return false;
    }
    
    // Direct hash calculation, no wrappers
    const hash = crypto.createHash('sha256');
    hash.update(share.data);
    const result = hash.digest();
    
    // Direct difficulty check - simple and fast
    return this.checkDifficulty(result, share.difficulty);
  }
  
  // Inline difficulty check for performance
  private checkDifficulty(hash: Buffer, difficulty: number): boolean {
    // Count leading zeros
    let zeros = 0;
    for (let i = 0; i < hash.length; i++) {
      if (hash[i] === 0) {
        zeros += 8;
      } else {
        // Count leading zeros in byte
        let byte = hash[i];
        while ((byte & 0x80) === 0 && zeros % 8 !== 7) {
          zeros++;
          byte <<= 1;
        }
        break;
      }
    }
    
    return zeros >= difficulty;
  }
  
  // Fast batch validation for multiple shares
  validateBatch(shares: Share[]): boolean[] {
    const results: boolean[] = new Array(shares.length);
    
    // Process in chunks for CPU cache efficiency
    const chunkSize = 100;
    for (let i = 0; i < shares.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, shares.length);
      for (let j = i; j < end; j++) {
        results[j] = this.validateDirect(shares[j]);
      }
    }
    
    return results;
  }
}
