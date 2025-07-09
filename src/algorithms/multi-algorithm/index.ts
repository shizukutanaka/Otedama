/**
 * Multi-Algorithm Mining Pool Support
 * Unified support for multiple cryptocurrency mining algorithms
 * Following Pike's principle: "Make each program do one thing well"
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { Logger } from '../../logging/logger';
import { Share } from '../../domain/share';
import { getMemoryAlignmentManager } from '../../performance/memory-alignment';

const logger = new Logger('MultiAlgorithm');

// Supported mining algorithms
export enum MiningAlgorithm {
  SHA256 = 'SHA256',           // Bitcoin, Bitcoin Cash
  SCRYPT = 'SCRYPT',           // Litecoin, Dogecoin
  X11 = 'X11',                 // Dash
  EQUIHASH = 'EQUIHASH',       // Zcash
  ETHASH = 'ETHASH',           // Ethereum (legacy)
  BLAKE2B = 'BLAKE2B',         // Decred
  KECCAK = 'KECCAK',           // Maxcoin
  QUBIT = 'QUBIT',             // QubitCoin
  GROESTL = 'GROESTL',         // Groestlcoin
  SKEIN = 'SKEIN',             // Skein-based coins
  YESCRYPT = 'YESCRYPT',       // Yenten
  LYRA2REV2 = 'LYRA2REV2',     // Vertcoin
  NEOSCRYPT = 'NEOSCRYPT',     // Feathercoin
  ARGON2 = 'ARGON2',           // Argon2-based coins
  RANDOMX = 'RANDOMX'          // Monero
}

// Algorithm specifications
export interface AlgorithmSpec {
  name: MiningAlgorithm;
  hashFunction: string;
  blockTime: number;          // Target block time in seconds
  difficultyAdjustment: number; // Blocks between difficulty adjustments
  proofOfWork: 'standard' | 'memory-hard' | 'asic-resistant';
  memoryRequirement: number;   // Memory requirement in MB
  computeIntensity: 'low' | 'medium' | 'high' | 'extreme';
  coins: string[];            // List of coins using this algorithm
  deprecated: boolean;
  hardwareSuitability: {
    cpu: number;              // Efficiency rating 1-10
    gpu: number;
    fpga: number;
    asic: number;
  };
}

// Algorithm configuration
export interface AlgorithmConfig {
  algorithm: MiningAlgorithm;
  enabled: boolean;
  port: number;
  difficulty: {
    initial: number;
    minimum: number;
    maximum: number;
    retargetTime: number;     // Seconds
    variance: number;         // Allowed variance percentage
  };
  vardiff: {
    enabled: boolean;
    targetTime: number;       // Target time between shares
    retargetTime: number;     // Time between difficulty adjustments
    x2mode: boolean;          // Allow 2x difficulty changes
  };
  rewards: {
    blockReward: number;
    feeStructure: 'flat' | 'percentage' | 'tiered';
    minimumPayout: number;
  };
  network: {
    rpcUrl?: string;
    rpcUser?: string;
    rpcPassword?: string;
    chainId?: number;
  };
}

// Share validation result
export interface ValidationResult {
  valid: boolean;
  blockFound: boolean;
  difficulty: number;
  hash: Buffer;
  target: Buffer;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Abstract base class for algorithm implementations
 */
export abstract class BaseAlgorithmHandler {
  protected memoryManager = getMemoryAlignmentManager();
  
  constructor(
    public readonly spec: AlgorithmSpec,
    public readonly config: AlgorithmConfig
  ) {}

  /**
   * Hash the block header
   */
  abstract hashBlock(blockHeader: Buffer): Buffer;

  /**
   * Validate a share submission
   */
  abstract validateShare(share: Share, target: Buffer): ValidationResult;

  /**
   * Calculate difficulty from target
   */
  calculateDifficulty(target: Buffer): number {
    const maxTarget = this.getMaxTarget();
    const targetValue = BigInt('0x' + target.toString('hex'));
    const maxTargetValue = BigInt('0x' + maxTarget.toString('hex'));
    
    return Number(maxTargetValue / targetValue);
  }

  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty: number): Buffer {
    const maxTarget = this.getMaxTarget();
    const maxTargetValue = BigInt('0x' + maxTarget.toString('hex'));
    const targetValue = maxTargetValue / BigInt(Math.floor(difficulty));
    
    const target = Buffer.alloc(32);
    const hexString = targetValue.toString(16).padStart(64, '0');
    target.write(hexString, 'hex');
    
    return target;
  }

  /**
   * Get maximum target for this algorithm
   */
  abstract getMaxTarget(): Buffer;

  /**
   * Get current network statistics
   */
  abstract getNetworkStats(): Promise<{
    hashrate: number;
    difficulty: number;
    blockHeight: number;
    lastBlockTime: number;
  }>;

  /**
   * Create work template for miners
   */
  abstract createWorkTemplate(blockTemplate: any): any;
}

/**
 * SHA256 Algorithm Handler (Bitcoin, Bitcoin Cash)
 */
export class SHA256Handler extends BaseAlgorithmHandler {
  hashBlock(blockHeader: Buffer): Buffer {
    // Double SHA256
    const firstHash = crypto.createHash('sha256').update(blockHeader).digest();
    return crypto.createHash('sha256').update(firstHash).digest();
  }

  validateShare(share: Share, target: Buffer): ValidationResult {
    try {
      // Reconstruct block header
      const blockHeader = this.reconstructBlockHeader(share);
      
      // Calculate hash
      const hash = this.hashBlock(blockHeader);
      
      // Check if hash meets target
      const hashValue = BigInt('0x' + hash.toString('hex'));
      const targetValue = BigInt('0x' + target.toString('hex'));
      
      const valid = hashValue <= targetValue;
      const difficulty = this.calculateDifficulty(target);
      
      // Check for block solution
      const blockTarget = this.difficultyToTarget(this.config.difficulty.minimum);
      const blockTargetValue = BigInt('0x' + blockTarget.toString('hex'));
      const blockFound = hashValue <= blockTargetValue;

      return {
        valid,
        blockFound,
        difficulty,
        hash,
        target
      };
    } catch (error) {
      return {
        valid: false,
        blockFound: false,
        difficulty: 0,
        hash: Buffer.alloc(32),
        target,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: (error as Error).message
      };
    }
  }

  getMaxTarget(): Buffer {
    // Bitcoin's maximum target
    return Buffer.from('00000000FFFF0000000000000000000000000000000000000000000000000000', 'hex');
  }

  async getNetworkStats(): Promise<any> {
    // Mock implementation - would use RPC calls
    return {
      hashrate: 200e18, // 200 EH/s
      difficulty: 25e12,
      blockHeight: 750000,
      lastBlockTime: Date.now() - 600000 // 10 minutes ago
    };
  }

  createWorkTemplate(blockTemplate: any): any {
    return {
      jobId: crypto.randomBytes(4).toString('hex'),
      version: blockTemplate.version,
      prevHash: blockTemplate.previousblockhash,
      merkleRoot: blockTemplate.merkleroot,
      timestamp: Math.floor(Date.now() / 1000),
      bits: blockTemplate.bits,
      height: blockTemplate.height,
      target: this.difficultyToTarget(this.config.difficulty.initial).toString('hex')
    };
  }

  private reconstructBlockHeader(share: Share): Buffer {
    // Simplified block header reconstruction
    const header = Buffer.allocUnsafe(80);
    
    // Version (4 bytes)
    header.writeUInt32LE(share.version || 1, 0);
    
    // Previous hash (32 bytes) - would be from job data
    Buffer.from('0'.repeat(64), 'hex').copy(header, 4);
    
    // Merkle root (32 bytes) - would be calculated from coinbase + transactions
    Buffer.from('0'.repeat(64), 'hex').copy(header, 36);
    
    // Timestamp (4 bytes)
    header.writeUInt32LE(share.timestamp, 68);
    
    // Bits (4 bytes) - difficulty target
    header.writeUInt32LE(0x1d00ffff, 72);
    
    // Nonce (4 bytes)
    header.writeUInt32LE(share.nonce, 76);
    
    return header;
  }
}

/**
 * Scrypt Algorithm Handler (Litecoin, Dogecoin)
 */
export class ScryptHandler extends BaseAlgorithmHandler {
  hashBlock(blockHeader: Buffer): Buffer {
    // Simplified Scrypt implementation
    // In production, would use proper Scrypt library
    return crypto.scrypt(blockHeader, Buffer.alloc(0), 32) as Buffer;
  }

  validateShare(share: Share, target: Buffer): ValidationResult {
    try {
      const blockHeader = this.reconstructBlockHeader(share);
      const hash = this.hashBlock(blockHeader);
      
      const hashValue = BigInt('0x' + hash.toString('hex'));
      const targetValue = BigInt('0x' + target.toString('hex'));
      
      const valid = hashValue <= targetValue;
      const difficulty = this.calculateDifficulty(target);
      
      const blockTarget = this.difficultyToTarget(this.config.difficulty.minimum);
      const blockTargetValue = BigInt('0x' + blockTarget.toString('hex'));
      const blockFound = hashValue <= blockTargetValue;

      return {
        valid,
        blockFound,
        difficulty,
        hash,
        target
      };
    } catch (error) {
      return {
        valid: false,
        blockFound: false,
        difficulty: 0,
        hash: Buffer.alloc(32),
        target,
        errorCode: 'SCRYPT_VALIDATION_ERROR',
        errorMessage: (error as Error).message
      };
    }
  }

  getMaxTarget(): Buffer {
    // Litecoin's maximum target
    return Buffer.from('00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex');
  }

  async getNetworkStats(): Promise<any> {
    return {
      hashrate: 500e12, // 500 TH/s
      difficulty: 15e6,
      blockHeight: 2500000,
      lastBlockTime: Date.now() - 150000 // 2.5 minutes ago
    };
  }

  createWorkTemplate(blockTemplate: any): any {
    return {
      jobId: crypto.randomBytes(4).toString('hex'),
      version: blockTemplate.version,
      prevHash: blockTemplate.previousblockhash,
      merkleRoot: blockTemplate.merkleroot,
      timestamp: Math.floor(Date.now() / 1000),
      bits: blockTemplate.bits,
      height: blockTemplate.height,
      target: this.difficultyToTarget(this.config.difficulty.initial).toString('hex')
    };
  }

  private reconstructBlockHeader(share: Share): Buffer {
    // Similar to SHA256 but for Scrypt coins
    const header = Buffer.allocUnsafe(80);
    
    header.writeUInt32LE(share.version || 1, 0);
    Buffer.from('0'.repeat(64), 'hex').copy(header, 4);
    Buffer.from('0'.repeat(64), 'hex').copy(header, 36);
    header.writeUInt32LE(share.timestamp, 68);
    header.writeUInt32LE(0x1e0fffff, 72); // Different default difficulty
    header.writeUInt32LE(share.nonce, 76);
    
    return header;
  }
}

/**
 * X11 Algorithm Handler (Dash)
 */
export class X11Handler extends BaseAlgorithmHandler {
  private hashFunctions = [
    'blake512', 'bmw512', 'groestl512', 'jh512', 'keccak512', 'skein512',
    'luffa512', 'cubehash512', 'shavite512', 'simd512', 'echo512'
  ];

  hashBlock(blockHeader: Buffer): Buffer {
    let hash = blockHeader;
    
    // X11 uses 11 different hash functions in sequence
    // Simplified implementation using available Node.js functions
    for (let i = 0; i < 11; i++) {
      const hashName = this.getAvailableHash(i);
      hash = crypto.createHash(hashName).update(hash).digest();
    }
    
    return hash;
  }

  private getAvailableHash(index: number): string {
    // Use available hash functions as approximation
    const available = ['sha256', 'sha512', 'md5', 'sha1'];
    return available[index % available.length];
  }

  validateShare(share: Share, target: Buffer): ValidationResult {
    try {
      const blockHeader = this.reconstructBlockHeader(share);
      const hash = this.hashBlock(blockHeader);
      
      const hashValue = BigInt('0x' + hash.toString('hex'));
      const targetValue = BigInt('0x' + target.toString('hex'));
      
      const valid = hashValue <= targetValue;
      const difficulty = this.calculateDifficulty(target);
      const blockFound = valid && difficulty >= this.config.difficulty.minimum;

      return {
        valid,
        blockFound,
        difficulty,
        hash,
        target
      };
    } catch (error) {
      return {
        valid: false,
        blockFound: false,
        difficulty: 0,
        hash: Buffer.alloc(32),
        target,
        errorCode: 'X11_VALIDATION_ERROR',
        errorMessage: (error as Error).message
      };
    }
  }

  getMaxTarget(): Buffer {
    return Buffer.from('00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex');
  }

  async getNetworkStats(): Promise<any> {
    return {
      hashrate: 3e15, // 3 PH/s
      difficulty: 80e6,
      blockHeight: 1800000,
      lastBlockTime: Date.now() - 156000 // ~2.5 minutes
    };
  }

  createWorkTemplate(blockTemplate: any): any {
    return {
      jobId: crypto.randomBytes(4).toString('hex'),
      version: blockTemplate.version,
      prevHash: blockTemplate.previousblockhash,
      merkleRoot: blockTemplate.merkleroot,
      timestamp: Math.floor(Date.now() / 1000),
      bits: blockTemplate.bits,
      height: blockTemplate.height,
      target: this.difficultyToTarget(this.config.difficulty.initial).toString('hex')
    };
  }

  private reconstructBlockHeader(share: Share): Buffer {
    const header = Buffer.allocUnsafe(80);
    
    header.writeUInt32LE(share.version || 1, 0);
    Buffer.from('0'.repeat(64), 'hex').copy(header, 4);
    Buffer.from('0'.repeat(64), 'hex').copy(header, 36);
    header.writeUInt32LE(share.timestamp, 68);
    header.writeUInt32LE(0x1e0fffff, 72);
    header.writeUInt32LE(share.nonce, 76);
    
    return header;
  }
}

/**
 * Multi-Algorithm Pool Manager
 */
export class MultiAlgorithmManager extends EventEmitter {
  private handlers = new Map<MiningAlgorithm, BaseAlgorithmHandler>();
  private algorithmConfigs = new Map<MiningAlgorithm, AlgorithmConfig>();
  private memoryManager = getMemoryAlignmentManager();
  private statistics = new Map<MiningAlgorithm, {
    totalShares: number;
    validShares: number;
    blocksFound: number;
    totalHashrate: number;
    activeMiners: number;
    lastUpdate: number;
  }>();

  constructor() {
    super();
    this.initializeAlgorithms();
    logger.info('Multi-algorithm manager initialized');
  }

  /**
   * Initialize supported algorithms
   */
  private initializeAlgorithms(): void {
    // Load algorithm specifications
    const specs = this.getAlgorithmSpecs();
    
    for (const spec of specs) {
      const config = this.getDefaultConfig(spec.name);
      if (config.enabled) {
        const handler = this.createHandler(spec, config);
        if (handler) {
          this.handlers.set(spec.name, handler);
          this.algorithmConfigs.set(spec.name, config);
          this.statistics.set(spec.name, {
            totalShares: 0,
            validShares: 0,
            blocksFound: 0,
            totalHashrate: 0,
            activeMiners: 0,
            lastUpdate: Date.now()
          });
        }
      }
    }

    logger.info('Algorithms initialized', {
      enabled: Array.from(this.handlers.keys()),
      total: specs.length
    });
  }

  /**
   * Get algorithm specifications
   */
  private getAlgorithmSpecs(): AlgorithmSpec[] {
    return [
      {
        name: MiningAlgorithm.SHA256,
        hashFunction: 'sha256d',
        blockTime: 600, // 10 minutes
        difficultyAdjustment: 2016,
        proofOfWork: 'standard',
        memoryRequirement: 1,
        computeIntensity: 'extreme',
        coins: ['BTC', 'BCH', 'BSV'],
        deprecated: false,
        hardwareSuitability: { cpu: 1, gpu: 2, fpga: 8, asic: 10 }
      },
      {
        name: MiningAlgorithm.SCRYPT,
        hashFunction: 'scrypt',
        blockTime: 150, // 2.5 minutes
        difficultyAdjustment: 2016,
        proofOfWork: 'memory-hard',
        memoryRequirement: 131,
        computeIntensity: 'high',
        coins: ['LTC', 'DOGE', 'VTC'],
        deprecated: false,
        hardwareSuitability: { cpu: 2, gpu: 6, fpga: 7, asic: 9 }
      },
      {
        name: MiningAlgorithm.X11,
        hashFunction: 'x11',
        blockTime: 150,
        difficultyAdjustment: 2016,
        proofOfWork: 'standard',
        memoryRequirement: 1,
        computeIntensity: 'high',
        coins: ['DASH'],
        deprecated: false,
        hardwareSuitability: { cpu: 2, gpu: 7, fpga: 8, asic: 9 }
      },
      {
        name: MiningAlgorithm.ETHASH,
        hashFunction: 'ethash',
        blockTime: 13,
        difficultyAdjustment: 1,
        proofOfWork: 'memory-hard',
        memoryRequirement: 4000,
        computeIntensity: 'high',
        coins: ['ETH', 'ETC'],
        deprecated: true, // Ethereum moved to PoS
        hardwareSuitability: { cpu: 1, gpu: 9, fpga: 3, asic: 6 }
      }
    ];
  }

  /**
   * Get default configuration for algorithm
   */
  private getDefaultConfig(algorithm: MiningAlgorithm): AlgorithmConfig {
    const basePort = 3333;
    const portOffset = Object.values(MiningAlgorithm).indexOf(algorithm);
    
    return {
      algorithm,
      enabled: process.env[`ENABLE_${algorithm}`] !== 'false',
      port: basePort + portOffset,
      difficulty: {
        initial: this.getInitialDifficulty(algorithm),
        minimum: 1,
        maximum: 1e12,
        retargetTime: 90,
        variance: 25
      },
      vardiff: {
        enabled: true,
        targetTime: 10,
        retargetTime: 90,
        x2mode: false
      },
      rewards: {
        blockReward: this.getBlockReward(algorithm),
        feeStructure: 'percentage',
        minimumPayout: 0.001
      },
      network: {
        rpcUrl: process.env[`${algorithm}_RPC_URL`],
        rpcUser: process.env[`${algorithm}_RPC_USER`],
        rpcPassword: process.env[`${algorithm}_RPC_PASSWORD`]
      }
    };
  }

  /**
   * Create algorithm handler
   */
  private createHandler(spec: AlgorithmSpec, config: AlgorithmConfig): BaseAlgorithmHandler | null {
    switch (spec.name) {
      case MiningAlgorithm.SHA256:
        return new SHA256Handler(spec, config);
      case MiningAlgorithm.SCRYPT:
        return new ScryptHandler(spec, config);
      case MiningAlgorithm.X11:
        return new X11Handler(spec, config);
      default:
        logger.warn('Algorithm handler not implemented', { algorithm: spec.name });
        return null;
    }
  }

  /**
   * Validate share for specific algorithm
   */
  async validateShare(
    algorithm: MiningAlgorithm,
    share: Share,
    target: Buffer
  ): Promise<ValidationResult> {
    const handler = this.handlers.get(algorithm);
    if (!handler) {
      return {
        valid: false,
        blockFound: false,
        difficulty: 0,
        hash: Buffer.alloc(32),
        target,
        errorCode: 'ALGORITHM_NOT_SUPPORTED',
        errorMessage: `Algorithm ${algorithm} is not supported`
      };
    }

    const result = handler.validateShare(share, target);
    
    // Update statistics
    const stats = this.statistics.get(algorithm);
    if (stats) {
      stats.totalShares++;
      if (result.valid) {
        stats.validShares++;
      }
      if (result.blockFound) {
        stats.blocksFound++;
      }
      stats.lastUpdate = Date.now();
    }

    // Emit events
    if (result.valid) {
      this.emit('validShare', algorithm, share, result);
    }
    if (result.blockFound) {
      this.emit('blockFound', algorithm, share, result);
    }

    return result;
  }

  /**
   * Get work template for algorithm
   */
  async getWorkTemplate(algorithm: MiningAlgorithm): Promise<any> {
    const handler = this.handlers.get(algorithm);
    if (!handler) {
      throw new Error(`Algorithm ${algorithm} is not supported`);
    }

    // Get block template from network
    const blockTemplate = await this.getBlockTemplate(algorithm);
    return handler.createWorkTemplate(blockTemplate);
  }

  /**
   * Get block template from network
   */
  private async getBlockTemplate(algorithm: MiningAlgorithm): Promise<any> {
    // Mock implementation - would use RPC calls to specific networks
    return {
      version: 1,
      previousblockhash: '0'.repeat(64),
      merkleroot: '0'.repeat(64),
      timestamp: Math.floor(Date.now() / 1000),
      bits: '1d00ffff',
      height: 750000 + Math.floor(Math.random() * 1000),
      transactions: []
    };
  }

  /**
   * Get algorithm by port
   */
  getAlgorithmByPort(port: number): MiningAlgorithm | null {
    for (const [algorithm, config] of this.algorithmConfigs) {
      if (config.port === port) {
        return algorithm;
      }
    }
    return null;
  }

  /**
   * Get enabled algorithms
   */
  getEnabledAlgorithms(): MiningAlgorithm[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get algorithm configuration
   */
  getAlgorithmConfig(algorithm: MiningAlgorithm): AlgorithmConfig | undefined {
    return this.algorithmConfigs.get(algorithm);
  }

  /**
   * Get algorithm handler
   */
  getAlgorithmHandler(algorithm: MiningAlgorithm): BaseAlgorithmHandler | undefined {
    return this.handlers.get(algorithm);
  }

  /**
   * Get algorithm statistics
   */
  getAlgorithmStats(algorithm: MiningAlgorithm): any {
    const stats = this.statistics.get(algorithm);
    const config = this.algorithmConfigs.get(algorithm);
    const handler = this.handlers.get(algorithm);
    
    if (!stats || !config || !handler) {
      return null;
    }

    return {
      algorithm,
      enabled: config.enabled,
      port: config.port,
      shares: {
        total: stats.totalShares,
        valid: stats.validShares,
        invalid: stats.totalShares - stats.validShares,
        acceptanceRate: stats.totalShares > 0 ? stats.validShares / stats.totalShares : 0
      },
      blocks: {
        found: stats.blocksFound
      },
      miners: {
        active: stats.activeMiners,
        totalHashrate: stats.totalHashrate
      },
      difficulty: {
        current: config.difficulty.initial,
        minimum: config.difficulty.minimum,
        maximum: config.difficulty.maximum
      },
      lastUpdate: stats.lastUpdate
    };
  }

  /**
   * Get comprehensive statistics for all algorithms
   */
  getAllStats(): { [algorithm: string]: any } {
    const allStats: { [algorithm: string]: any } = {};
    
    for (const algorithm of this.getEnabledAlgorithms()) {
      allStats[algorithm] = this.getAlgorithmStats(algorithm);
    }
    
    return allStats;
  }

  /**
   * Update miner count for algorithm
   */
  updateMinerCount(algorithm: MiningAlgorithm, count: number): void {
    const stats = this.statistics.get(algorithm);
    if (stats) {
      stats.activeMiners = count;
    }
  }

  /**
   * Update hashrate for algorithm
   */
  updateHashrate(algorithm: MiningAlgorithm, hashrate: number): void {
    const stats = this.statistics.get(algorithm);
    if (stats) {
      stats.totalHashrate = hashrate;
    }
  }

  private getInitialDifficulty(algorithm: MiningAlgorithm): number {
    const difficulties: { [key in MiningAlgorithm]: number } = {
      [MiningAlgorithm.SHA256]: 1000000,
      [MiningAlgorithm.SCRYPT]: 1000,
      [MiningAlgorithm.X11]: 10000,
      [MiningAlgorithm.EQUIHASH]: 1000,
      [MiningAlgorithm.ETHASH]: 1000000000,
      [MiningAlgorithm.BLAKE2B]: 100000,
      [MiningAlgorithm.KECCAK]: 1000,
      [MiningAlgorithm.QUBIT]: 1000,
      [MiningAlgorithm.GROESTL]: 1000,
      [MiningAlgorithm.SKEIN]: 1000,
      [MiningAlgorithm.YESCRYPT]: 1000,
      [MiningAlgorithm.LYRA2REV2]: 1000,
      [MiningAlgorithm.NEOSCRYPT]: 1000,
      [MiningAlgorithm.ARGON2]: 1000,
      [MiningAlgorithm.RANDOMX]: 1000
    };
    
    return difficulties[algorithm] || 1000;
  }

  private getBlockReward(algorithm: MiningAlgorithm): number {
    const rewards: { [key in MiningAlgorithm]: number } = {
      [MiningAlgorithm.SHA256]: 6.25,      // Bitcoin
      [MiningAlgorithm.SCRYPT]: 12.5,      // Litecoin
      [MiningAlgorithm.X11]: 2.884,        // Dash
      [MiningAlgorithm.EQUIHASH]: 10,      // Zcash
      [MiningAlgorithm.ETHASH]: 2.0,       // Ethereum
      [MiningAlgorithm.BLAKE2B]: 13.1,     // Decred
      [MiningAlgorithm.KECCAK]: 1000,      // Maxcoin
      [MiningAlgorithm.QUBIT]: 100,        // QubitCoin
      [MiningAlgorithm.GROESTL]: 5,        // Groestlcoin
      [MiningAlgorithm.SKEIN]: 100,        // Skein-based
      [MiningAlgorithm.YESCRYPT]: 50,      // Yenten
      [MiningAlgorithm.LYRA2REV2]: 25,     // Vertcoin
      [MiningAlgorithm.NEOSCRYPT]: 80,     // Feathercoin
      [MiningAlgorithm.ARGON2]: 100,       // Argon2-based
      [MiningAlgorithm.RANDOMX]: 0.6       // Monero
    };
    
    return rewards[algorithm] || 1.0;
  }
}

export {
  MiningAlgorithm,
  AlgorithmSpec,
  AlgorithmConfig,
  ValidationResult,
  BaseAlgorithmHandler,
  SHA256Handler,
  ScryptHandler,
  X11Handler
};
