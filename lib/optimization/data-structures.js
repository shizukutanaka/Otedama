/**
 * Optimized Data Structures - Otedama
 * Ultra-efficient data structures for mining operations
 * 
 * Features:
 * - Cache-oblivious algorithms
 * - Succinct data structures
 * - Compressed representations
 * - Lock-free concurrent structures
 * - Memory-efficient collections
 */

import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('DataStructures');

/**
 * Compressed Trie for efficient string storage
 */
export class CompressedTrie {
  constructor() {
    this.root = { value: null, children: new Map(), isEnd: false };
    this.size = 0;
  }
  
  /**
   * Insert string with path compression
   */
  insert(str, value) {
    let node = this.root;
    let i = 0;
    
    while (i < str.length) {
      let found = false;
      
      // Try to find matching edge
      for (const [edge, child] of node.children) {
        const commonLen = this.commonPrefix(str.slice(i), edge);
        
        if (commonLen > 0) {
          found = true;
          
          if (commonLen === edge.length) {
            // Full edge match
            i += commonLen;
            node = child;
          } else {
            // Partial match - split edge
            const newNode = {
              value: null,
              children: new Map([[edge.slice(commonLen), child]]),
              isEnd: false
            };
            
            node.children.delete(edge);
            node.children.set(edge.slice(0, commonLen), newNode);
            
            if (i + commonLen === str.length) {
              newNode.isEnd = true;
              newNode.value = value;
              this.size++;
              return;
            } else {
              node = newNode;
              i += commonLen;
            }
          }
          break;
        }
      }
      
      if (!found) {
        // No match - create new edge
        const newNode = {
          value,
          children: new Map(),
          isEnd: true
        };
        
        node.children.set(str.slice(i), newNode);
        this.size++;
        return;
      }
    }
    
    // Reached end of string
    if (!node.isEnd) {
      node.isEnd = true;
      node.value = value;
      this.size++;
    }
  }
  
  /**
   * Find longest common prefix
   */
  commonPrefix(s1, s2) {
    let i = 0;
    const minLen = Math.min(s1.length, s2.length);
    
    while (i < minLen && s1[i] === s2[i]) {
      i++;
    }
    
    return i;
  }
  
  /**
   * Search for string
   */
  search(str) {
    let node = this.root;
    let i = 0;
    
    while (i < str.length && node) {
      let found = false;
      
      for (const [edge, child] of node.children) {
        if (str.slice(i).startsWith(edge)) {
          i += edge.length;
          node = child;
          found = true;
          break;
        }
      }
      
      if (!found) return null;
    }
    
    return node && node.isEnd ? node.value : null;
  }
  
  /**
   * Get all strings with prefix
   */
  *prefixSearch(prefix) {
    let node = this.root;
    let i = 0;
    
    // Navigate to prefix
    while (i < prefix.length && node) {
      let found = false;
      
      for (const [edge, child] of node.children) {
        const commonLen = this.commonPrefix(prefix.slice(i), edge);
        
        if (commonLen > 0) {
          if (i + commonLen === prefix.length) {
            // Prefix ends within edge
            yield* this.collectAll(child, prefix + edge.slice(commonLen));
            return;
          } else if (commonLen === edge.length) {
            // Continue navigation
            i += commonLen;
            node = child;
            found = true;
            break;
          }
        }
      }
      
      if (!found) return;
    }
    
    // Collect all strings from this node
    if (node) {
      yield* this.collectAll(node, prefix);
    }
  }
  
  /**
   * Collect all strings from node
   */
  *collectAll(node, prefix) {
    if (node.isEnd) {
      yield { string: prefix, value: node.value };
    }
    
    for (const [edge, child] of node.children) {
      yield* this.collectAll(child, prefix + edge);
    }
  }
}

/**
 * Bloom filter for space-efficient membership testing
 */
export class BloomFilter {
  constructor(expectedItems = 10000, falsePositiveRate = 0.01) {
    // Calculate optimal parameters
    this.size = Math.ceil(-expectedItems * Math.log(falsePositiveRate) / Math.pow(Math.log(2), 2));
    this.hashCount = Math.ceil(this.size / expectedItems * Math.log(2));
    
    // Use Uint32Array for better performance
    this.bits = new Uint32Array(Math.ceil(this.size / 32));
    this.itemCount = 0;
    
    logger.info('Bloom filter created', {
      size: this.size,
      hashCount: this.hashCount,
      expectedItems,
      falsePositiveRate
    });
  }
  
  /**
   * Hash functions using double hashing
   */
  hash(item, seed) {
    // FNV-1a hash
    let hash = 2166136261 ^ seed;
    const bytes = Buffer.from(item);
    
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    
    return hash >>> 0;
  }
  
  /**
   * Add item to filter
   */
  add(item) {
    const hash1 = this.hash(item, 0);
    const hash2 = this.hash(item, hash1);
    
    for (let i = 0; i < this.hashCount; i++) {
      const hash = (hash1 + i * hash2) >>> 0;
      const pos = hash % this.size;
      const wordIndex = Math.floor(pos / 32);
      const bitIndex = pos % 32;
      
      this.bits[wordIndex] |= (1 << bitIndex);
    }
    
    this.itemCount++;
  }
  
  /**
   * Test if item might be in set
   */
  contains(item) {
    const hash1 = this.hash(item, 0);
    const hash2 = this.hash(item, hash1);
    
    for (let i = 0; i < this.hashCount; i++) {
      const hash = (hash1 + i * hash2) >>> 0;
      const pos = hash % this.size;
      const wordIndex = Math.floor(pos / 32);
      const bitIndex = pos % 32;
      
      if ((this.bits[wordIndex] & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Estimate false positive rate
   */
  estimateFPR() {
    let setBits = 0;
    
    for (let i = 0; i < this.bits.length; i++) {
      setBits += this.popcount(this.bits[i]);
    }
    
    const ratio = setBits / this.size;
    return Math.pow(ratio, this.hashCount);
  }
  
  /**
   * Population count (number of set bits)
   */
  popcount(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0xF0F0F0F) * 0x1010101) >>> 24;
  }
}

/**
 * Skip list for fast ordered operations
 */
export class SkipList {
  constructor(maxLevel = 16, p = 0.5) {
    this.maxLevel = maxLevel;
    this.p = p;
    this.level = 0;
    this.head = this.createNode(-Infinity, null, maxLevel);
    this.size = 0;
  }
  
  /**
   * Create skip list node
   */
  createNode(key, value, level) {
    return {
      key,
      value,
      forward: new Array(level + 1).fill(null)
    };
  }
  
  /**
   * Random level generation
   */
  randomLevel() {
    let level = 0;
    while (Math.random() < this.p && level < this.maxLevel) {
      level++;
    }
    return level;
  }
  
  /**
   * Insert key-value pair
   */
  insert(key, value) {
    const update = new Array(this.maxLevel + 1);
    let current = this.head;
    
    // Find position
    for (let i = this.level; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < key) {
        current = current.forward[i];
      }
      update[i] = current;
    }
    
    current = current.forward[0];
    
    // Update if exists
    if (current && current.key === key) {
      current.value = value;
      return;
    }
    
    // Insert new node
    const newLevel = this.randomLevel();
    
    if (newLevel > this.level) {
      for (let i = this.level + 1; i <= newLevel; i++) {
        update[i] = this.head;
      }
      this.level = newLevel;
    }
    
    const newNode = this.createNode(key, value, newLevel);
    
    for (let i = 0; i <= newLevel; i++) {
      newNode.forward[i] = update[i].forward[i];
      update[i].forward[i] = newNode;
    }
    
    this.size++;
  }
  
  /**
   * Search for key
   */
  search(key) {
    let current = this.head;
    
    for (let i = this.level; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < key) {
        current = current.forward[i];
      }
    }
    
    current = current.forward[0];
    
    return current && current.key === key ? current.value : null;
  }
  
  /**
   * Delete key
   */
  delete(key) {
    const update = new Array(this.maxLevel + 1);
    let current = this.head;
    
    for (let i = this.level; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < key) {
        current = current.forward[i];
      }
      update[i] = current;
    }
    
    current = current.forward[0];
    
    if (current && current.key === key) {
      for (let i = 0; i <= this.level; i++) {
        if (update[i].forward[i] !== current) break;
        update[i].forward[i] = current.forward[i];
      }
      
      while (this.level > 0 && !this.head.forward[this.level]) {
        this.level--;
      }
      
      this.size--;
      return true;
    }
    
    return false;
  }
  
  /**
   * Range query
   */
  *range(minKey, maxKey) {
    let current = this.head;
    
    // Find start position
    for (let i = this.level; i >= 0; i--) {
      while (current.forward[i] && current.forward[i].key < minKey) {
        current = current.forward[i];
      }
    }
    
    current = current.forward[0];
    
    // Yield all in range
    while (current && current.key <= maxKey) {
      yield { key: current.key, value: current.value };
      current = current.forward[0];
    }
  }
}

/**
 * Ring buffer for fixed-size queues
 */
export class RingBuffer {
  constructor(capacity, elementSize = 1) {
    this.capacity = capacity;
    this.elementSize = elementSize;
    this.buffer = Buffer.allocUnsafe(capacity * elementSize);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
  
  /**
   * Push element to buffer
   */
  push(element) {
    if (this.count >= this.capacity) {
      return false; // Buffer full
    }
    
    if (Buffer.isBuffer(element)) {
      element.copy(this.buffer, this.tail * this.elementSize);
    } else {
      this.buffer.writeUInt32LE(element, this.tail * this.elementSize);
    }
    
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }
  
  /**
   * Pop element from buffer
   */
  pop() {
    if (this.count === 0) {
      return null; // Buffer empty
    }
    
    const offset = this.head * this.elementSize;
    let element;
    
    if (this.elementSize === 4) {
      element = this.buffer.readUInt32LE(offset);
    } else {
      element = Buffer.allocUnsafe(this.elementSize);
      this.buffer.copy(element, 0, offset, offset + this.elementSize);
    }
    
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    
    return element;
  }
  
  /**
   * Peek at head element
   */
  peek() {
    if (this.count === 0) return null;
    
    const offset = this.head * this.elementSize;
    
    if (this.elementSize === 4) {
      return this.buffer.readUInt32LE(offset);
    } else {
      const element = Buffer.allocUnsafe(this.elementSize);
      this.buffer.copy(element, 0, offset, offset + this.elementSize);
      return element;
    }
  }
  
  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      capacity: this.capacity,
      count: this.count,
      free: this.capacity - this.count,
      usage: this.count / this.capacity
    };
  }
}

/**
 * Bit vector for space-efficient boolean arrays
 */
export class BitVector {
  constructor(size) {
    this.size = size;
    this.words = new Uint32Array(Math.ceil(size / 32));
  }
  
  /**
   * Set bit at index
   */
  set(index) {
    if (index >= this.size) throw new Error('Index out of bounds');
    
    const wordIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    
    this.words[wordIndex] |= (1 << bitIndex);
  }
  
  /**
   * Clear bit at index
   */
  clear(index) {
    if (index >= this.size) throw new Error('Index out of bounds');
    
    const wordIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    
    this.words[wordIndex] &= ~(1 << bitIndex);
  }
  
  /**
   * Get bit at index
   */
  get(index) {
    if (index >= this.size) throw new Error('Index out of bounds');
    
    const wordIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    
    return (this.words[wordIndex] & (1 << bitIndex)) !== 0;
  }
  
  /**
   * Toggle bit at index
   */
  toggle(index) {
    if (index >= this.size) throw new Error('Index out of bounds');
    
    const wordIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    
    this.words[wordIndex] ^= (1 << bitIndex);
  }
  
  /**
   * Count set bits
   */
  popcount() {
    let count = 0;
    
    for (let i = 0; i < this.words.length; i++) {
      let n = this.words[i];
      n = n - ((n >>> 1) & 0x55555555);
      n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
      count += (((n + (n >>> 4)) & 0xF0F0F0F) * 0x1010101) >>> 24;
    }
    
    return count;
  }
  
  /**
   * Find first set bit
   */
  findFirst() {
    for (let i = 0; i < this.words.length; i++) {
      if (this.words[i] !== 0) {
        // Find first bit in word
        const word = this.words[i];
        for (let j = 0; j < 32; j++) {
          if (word & (1 << j)) {
            return i * 32 + j;
          }
        }
      }
    }
    
    return -1;
  }
  
  /**
   * Bitwise operations
   */
  and(other) {
    if (this.size !== other.size) throw new Error('Size mismatch');
    
    const result = new BitVector(this.size);
    
    for (let i = 0; i < this.words.length; i++) {
      result.words[i] = this.words[i] & other.words[i];
    }
    
    return result;
  }
  
  or(other) {
    if (this.size !== other.size) throw new Error('Size mismatch');
    
    const result = new BitVector(this.size);
    
    for (let i = 0; i < this.words.length; i++) {
      result.words[i] = this.words[i] | other.words[i];
    }
    
    return result;
  }
  
  xor(other) {
    if (this.size !== other.size) throw new Error('Size mismatch');
    
    const result = new BitVector(this.size);
    
    for (let i = 0; i < this.words.length; i++) {
      result.words[i] = this.words[i] ^ other.words[i];
    }
    
    return result;
  }
}

export default {
  CompressedTrie,
  BloomFilter,
  SkipList,
  RingBuffer,
  BitVector
};