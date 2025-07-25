/**
 * Block Store - Otedama
 * Storage for blockchain blocks and related data
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('BlockStore');

export class BlockStore extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxBlocks = options.maxBlocks || 1000;
    this.confirmationsRequired = options.confirmationsRequired || 6;
    
    this.blocks = new Map();
    this.blocksByHeight = new Map();
    this.pendingBlocks = new Map();
  }
  
  add(block) {
    // Validate block
    if (!block.hash || !block.height) {
      throw new Error('Invalid block: missing hash or height');
    }
    
    // Check if already exists
    if (this.blocks.has(block.hash)) {
      return false;
    }
    
    // Add to stores
    this.blocks.set(block.hash, block);
    this.blocksByHeight.set(block.height, block);
    
    // Add to pending if not confirmed
    if (block.confirmations < this.confirmationsRequired) {
      this.pendingBlocks.set(block.hash, block);
    }
    
    // Cleanup if needed
    if (this.blocks.size > this.maxBlocks) {
      this.cleanup();
    }
    
    this.emit('block:added', block);
    logger.info(`Added block ${block.height}: ${block.hash}`);
    
    return true;
  }
  
  get(hashOrHeight) {
    // Try as hash first
    let block = this.blocks.get(hashOrHeight);
    
    // Try as height if not found
    if (!block && typeof hashOrHeight === 'number') {
      block = this.blocksByHeight.get(hashOrHeight);
    }
    
    return block || null;
  }
  
  updateConfirmations(hash, confirmations) {
    const block = this.blocks.get(hash);
    if (!block) return false;
    
    const oldConfirmations = block.confirmations;
    block.confirmations = confirmations;
    
    // Check if now confirmed
    if (oldConfirmations < this.confirmationsRequired && 
        confirmations >= this.confirmationsRequired) {
      this.pendingBlocks.delete(hash);
      block.status = 'confirmed';
      this.emit('block:confirmed', block);
      logger.info(`Block ${block.height} confirmed`);
    }
    
    return true;
  }
  
  getPending() {
    return Array.from(this.pendingBlocks.values());
  }
  
  getConfirmed() {
    return Array.from(this.blocks.values()).filter(block => 
      block.confirmations >= this.confirmationsRequired
    );
  }
  
  getRecent(count = 10) {
    const heights = Array.from(this.blocksByHeight.keys())
      .sort((a, b) => b - a)
      .slice(0, count);
    
    return heights.map(height => this.blocksByHeight.get(height));
  }
  
  getStats() {
    const blocks = Array.from(this.blocks.values());
    
    const stats = {
      total: blocks.length,
      pending: this.pendingBlocks.size,
      confirmed: blocks.filter(b => b.confirmations >= this.confirmationsRequired).length,
      totalReward: blocks.reduce((sum, b) => sum + (b.reward || 0), 0),
      averageConfirmations: blocks.reduce((sum, b) => sum + b.confirmations, 0) / blocks.length || 0
    };
    
    // Calculate time between blocks
    const sortedBlocks = blocks.sort((a, b) => a.timestamp - b.timestamp);
    if (sortedBlocks.length > 1) {
      const timeDiffs = [];
      for (let i = 1; i < sortedBlocks.length; i++) {
        timeDiffs.push(sortedBlocks[i].timestamp - sortedBlocks[i - 1].timestamp);
      }
      stats.averageBlockTime = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
    }
    
    return stats;
  }
  
  cleanup() {
    // Get sorted heights
    const heights = Array.from(this.blocksByHeight.keys()).sort((a, b) => a - b);
    
    // Remove oldest blocks
    const toRemove = heights.slice(0, heights.length - this.maxBlocks);
    
    for (const height of toRemove) {
      const block = this.blocksByHeight.get(height);
      if (block) {
        this.blocks.delete(block.hash);
        this.blocksByHeight.delete(height);
        this.pendingBlocks.delete(block.hash);
      }
    }
    
    logger.debug(`Cleaned up ${toRemove.length} old blocks`);
  }
  
  clear() {
    this.blocks.clear();
    this.blocksByHeight.clear();
    this.pendingBlocks.clear();
    
    this.emit('cleared');
  }
  
  // Import/export for persistence
  
  export() {
    return {
      blocks: Array.from(this.blocks.values()),
      confirmationsRequired: this.confirmationsRequired
    };
  }
  
  import(data) {
    this.clear();
    
    if (data.confirmationsRequired) {
      this.confirmationsRequired = data.confirmationsRequired;
    }
    
    for (const block of data.blocks || []) {
      this.add(block);
    }
  }
}

export default BlockStore;
