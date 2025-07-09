// Clean entity with minimal complexity (Uncle Bob style)
import * as crypto from 'crypto';

export class Share {
  public minerId: string = '';
  public data: Buffer = Buffer.alloc(0);
  public nonce: number = 0;
  public difficulty: number = 0;
  public timestamp: number = Date.now();
  public jobId: string = '';
  public blockHeight?: number;
  
  constructor() {}
  
  // Simple reset for object pooling
  reset(): void {
    this.minerId = '';
    this.data = Buffer.alloc(0);
    this.nonce = 0;
    this.difficulty = 0;
    this.timestamp = Date.now();
    this.jobId = '';
    this.blockHeight = undefined;
  }
  
  // Direct difficulty check
  meetsNetworkDifficulty(): boolean {
    // Simplified check - in real implementation would check actual hash
    return this.difficulty >= 240; // Example threshold
  }
  
  // Convert to block hex for submission
  toBlockHex(): string {
    // Simplified - real implementation would construct proper block
    return this.data.toString('hex');
  }
  
  // Simple validation
  isValid(): boolean {
    return this.minerId !== '' && 
           this.data.length > 0 && 
           this.nonce >= 0 &&
           this.difficulty > 0;
  }
  
  // Get share hash for duplicate detection
  getHash(): string {
    const data = `${this.minerId}:${this.jobId}:${this.nonce}:${this.data.toString('hex')}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
