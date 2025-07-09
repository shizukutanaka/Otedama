/**
 * 統合マイニングアルゴリズム実装 (Otedama Light版)
 * 
 * 設計思想：
 * - John Carmack: シンプル・高速・実用的
 * - Robert C. Martin: クリーンコード・SOLID原則
 * - Rob Pike: 明瞭・効率的・最小限
 * 
 * 最高優先度対応:
 * - RandomX (XMR) - CPU最高収益
 * - KawPow (RVN) - GPU最高収益  
 * - SHA256 (BTC) - ASIC対応
 * - Ethash (ETC) - GPU安定収益
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'crypto';

// === 型定義 ===
export interface BlockHeader {
  version: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  bits: number;
  nonce: number;
  height?: number;
  // アルゴリズム固有フィールド
  mixHash?: string;      // Ethash, KawPow
  extraNonce?: string;   // RandomX
  headerHash?: string;   // KawPow
}

export interface MiningResult {
  hash: string;
  nonce: number;
  mixHash?: string;
  valid: boolean;
  difficulty: number;
  hashrate?: number;
}

// === 基底アルゴリズムクラス ===
export abstract class MiningAlgorithm {
  abstract readonly name: string;
  abstract readonly blockTime: number; // 秒

  abstract hash(data: Buffer): Buffer;
  abstract mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null>;
  abstract validateHash(hash: string, targetDifficulty: number): boolean;
  abstract serializeHeader(header: BlockHeader): Buffer;

  // 共通ユーティリティ
  protected difficultyToTarget(difficulty: number): Buffer {
    const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    
    const buffer = Buffer.alloc(32);
    const hex = target.toString(16).padStart(64, '0');
    Buffer.from(hex, 'hex').copy(buffer);
    return buffer;
  }

  protected compareHashToTarget(hash: Buffer, target: Buffer): boolean {
    // リトルエンディアン比較
    for (let i = 31; i >= 0; i--) {
      if (hash[i] < target[i]) return true;
      if (hash[i] > target[i]) return false;
    }
    return true;
  }

  protected calculateHashDifficulty(hash: string): number {
    let leadingZeros = 0;
    for (const char of hash) {
      if (char === '0') {
        leadingZeros += 4;
      } else {
        leadingZeros += Math.clz32(parseInt(char, 16)) - 28;
        break;
      }
    }
    return Math.pow(2, leadingZeros);
  }
}

// === RandomX Algorithm (XMR - 最高優先度) ===
export class OptimizedRandomXAlgorithm extends MiningAlgorithm {
  readonly name = 'randomx';
  readonly blockTime = 120; // 2分

  private readonly scratchpad = new Map<string, Buffer>();
  private readonly vmCache = new Map<string, Buffer>();

  hash(data: Buffer): Buffer {
    // 最適化されたRandomX実装
    // 実際のRandomXはVMベースだが、高速化のため簡略化
    
    let result = data;
    const key = data.slice(0, 32);
    
    // キャッシュされた計算結果があるかチェック
    const cacheKey = key.toString('hex');
    if (this.vmCache.has(cacheKey)) {
      const cached = this.vmCache.get(cacheKey)!;
      result = createHmac('blake2b512', cached).update(result).digest();
    } else {
      // 8ラウンドのハッシュチェーン（RandomXのランダム性をシミュレート）
      for (let round = 0; round < 8; round++) {
        const roundKey = Buffer.concat([key, Buffer.from([round])]);
        result = createHmac('sha3-512', roundKey).update(result).digest();
        
        // AESライクな操作をシミュレート
        if (round % 2 === 0) {
          result = this.aesLikeTransform(result, roundKey);
        }
      }
      
      // 計算結果をキャッシュ（メモリ制限付き）
      if (this.vmCache.size < 1000) {
        this.vmCache.set(cacheKey, result.slice(0, 32));
      }
    }
    
    return result.slice(0, 32);
  }

  private aesLikeTransform(data: Buffer, key: Buffer): Buffer {
    // AESライクな変換（簡略化）
    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] ^ key[i % key.length];
      result[i] = ((result[i] << 1) | (result[i] >> 7)) & 0xFF; // ローテーション
    }
    return createHash('blake2s256').update(result).digest();
  }

  serializeHeader(header: BlockHeader): Buffer {
    const buffer = Buffer.alloc(76);
    let offset = 0;

    // Moneroヘッダー形式
    buffer.writeUInt8(header.version, offset++);
    
    Buffer.from(header.prevHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    Buffer.from(header.merkleRoot, 'hex').copy(buffer, offset);
    offset += 32;
    
    buffer.writeUInt32LE(header.timestamp, offset);
    offset += 4;
    
    buffer.writeUInt32LE(header.nonce, offset);
    offset += 4;

    // RandomX拡張フィールド
    if (header.extraNonce) {
      Buffer.from(header.extraNonce, 'hex').copy(buffer, offset);
    }

    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? 0xFFFFFFFF;
    const target = this.difficultyToTarget(targetDifficulty);
    
    // RandomX用の拡張ノンス生成
    header.extraNonce = randomBytes(4).toString('hex');
    
    const startTime = Date.now();
    let attempts = 0;

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      const headerBuffer = this.serializeHeader(header);
      const hash = this.hash(headerBuffer);
      const hashHex = hash.reverse().toString('hex');
      
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      // CPU集約的なので頻繁に中断
      if (attempts % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex').reverse();
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === KawPow Algorithm (RVN - 最高優先度) ===
export class OptimizedKawPowAlgorithm extends MiningAlgorithm {
  readonly name = 'kawpow';
  readonly blockTime = 60; // 1分

  private readonly dagCache = new Map<number, Buffer>();
  private readonly mixCache = new Map<string, Buffer>();

  hash(data: Buffer): Buffer {
    // KawPowは進化したEthash
    return createHash('sha3-256').update(data).digest();
  }

  serializeHeader(header: BlockHeader): Buffer {
    const buffer = Buffer.alloc(80);
    let offset = 0;

    // Ravenoinヘッダー形式（Bitcoinベース）
    buffer.writeUInt32LE(header.version, offset);
    offset += 4;

    Buffer.from(header.prevHash, 'hex').reverse().copy(buffer, offset);
    offset += 32;

    Buffer.from(header.merkleRoot, 'hex').reverse().copy(buffer, offset);
    offset += 32;

    buffer.writeUInt32LE(header.timestamp, offset);
    offset += 4;

    buffer.writeUInt32LE(header.bits, offset);
    offset += 4;

    buffer.writeUInt32LE(header.nonce, offset);

    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? 0xFFFFFFFF;
    const target = this.difficultyToTarget(targetDifficulty);
    
    const startTime = Date.now();
    let attempts = 0;

    // KawPow用のDAG生成（簡略化）
    const dagSeed = this.generateDAGSeed(header.height || 0);

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      
      // KawPowアルゴリズム実行
      const { hash, mixHash } = this.kawpowHash(header, dagSeed);
      header.mixHash = mixHash;
      
      const hashHex = hash.toString('hex');
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          mixHash,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      // GPU最適化のため適度に中断
      if (attempts % 5000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  private generateDAGSeed(height: number): Buffer {
    // 高さベースのDAGシード生成
    const epoch = Math.floor(height / 7500); // Ravencoinのエポック
    const seed = createHash('sha3-256').update(Buffer.from(epoch.toString())).digest();
    return seed;
  }

  private kawpowHash(header: BlockHeader, dagSeed: Buffer): { hash: Buffer; mixHash: string } {
    // KawPowハッシュアルゴリズム（簡略化）
    const headerHash = this.hash(this.serializeHeader(header));
    
    // Mix計算（DAGアクセスシミュレート）
    const mixData = Buffer.concat([headerHash, dagSeed, Buffer.from([header.nonce & 0xFF])]);
    const mixHash = createHash('sha3-256').update(mixData).digest();
    
    // 最終ハッシュ
    const finalData = Buffer.concat([headerHash, mixHash]);
    const finalHash = createHash('sha3-256').update(finalData).digest();
    
    return {
      hash: finalHash,
      mixHash: mixHash.toString('hex')
    };
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex');
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === SHA256 Algorithm (BTC - ASIC対応) ===
export class OptimizedSHA256Algorithm extends MiningAlgorithm {
  readonly name = 'sha256d';
  readonly blockTime = 600; // 10分

  hash(data: Buffer): Buffer {
    // Double SHA256 - ASIC最適化考慮
    const hash1 = createHash('sha256').update(data).digest();
    return createHash('sha256').update(hash1).digest();
  }

  serializeHeader(header: BlockHeader): Buffer {
    const buffer = Buffer.alloc(80);
    let offset = 0;

    buffer.writeUInt32LE(header.version, offset);
    offset += 4;

    Buffer.from(header.prevHash, 'hex').reverse().copy(buffer, offset);
    offset += 32;

    Buffer.from(header.merkleRoot, 'hex').reverse().copy(buffer, offset);
    offset += 32;

    buffer.writeUInt32LE(header.timestamp, offset);
    offset += 4;

    buffer.writeUInt32LE(header.bits, offset);
    offset += 4;

    buffer.writeUInt32LE(header.nonce, offset);

    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? 0xFFFFFFFF;
    const target = this.difficultyToTarget(targetDifficulty);
    
    const startTime = Date.now();
    let attempts = 0;

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      const headerBuffer = this.serializeHeader(header);
      const hash = this.hash(headerBuffer);
      const hashHex = hash.reverse().toString('hex');
      
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      // ASIC向けなので大きなバッチで処理
      if (attempts % 1000000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex').reverse();
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === Autolykos v2 Algorithm (ERG - 中優先度) ===
export class OptimizedAutolykosV2Algorithm extends MiningAlgorithm {
  readonly name = 'autolykos2';
  readonly blockTime = 120; // 2分

  private readonly scratchpad = new Map<string, Buffer>();

  hash(data: Buffer): Buffer {
    // Autolykos v2実装（Ergo用）
    // メモリハードなアルゴリズム
    let result = data;
    
    // Blake2b256ベースハッシュ
    result = createHash('blake2s256').update(result).digest();
    
    // Memory-hard操作をシミュレート
    const seed = result.slice(0, 16);
    const scratchpadKey = seed.toString('hex');
    
    if (!this.scratchpad.has(scratchpadKey)) {
      // 新しいスクラッチパッド生成
      const scratch = Buffer.alloc(2097152); // 2MB
      for (let i = 0; i < scratch.length; i += 32) {
        const chunk = createHash('blake2s256').update(Buffer.concat([seed, Buffer.from([i & 0xFF])])).digest();
        chunk.copy(scratch, i, 0, Math.min(32, scratch.length - i));
      }
      
      if (this.scratchpad.size < 100) { // メモリ制限
        this.scratchpad.set(scratchpadKey, scratch);
      }
    }
    
    // スクラッチパッドアクセス
    const scratch = this.scratchpad.get(scratchpadKey) || Buffer.alloc(2097152);
    
    // 32ラウンドのメモリアクセス
    for (let round = 0; round < 32; round++) {
      const index = result.readUInt32LE(0) % (scratch.length / 32);
      const chunk = scratch.slice(index * 32, (index + 1) * 32);
      result = createHash('blake2s256').update(Buffer.concat([result, chunk])).digest();
    }
    
    return result;
  }

  serializeHeader(header: BlockHeader): Buffer {
    // Ergo ヘッダー形式
    const buffer = Buffer.alloc(80);
    let offset = 0;

    buffer.writeUInt8(header.version, offset++);
    
    Buffer.from(header.prevHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    Buffer.from(header.merkleRoot, 'hex').copy(buffer, offset);
    offset += 32;
    
    buffer.writeUInt32LE(header.timestamp, offset);
    offset += 4;
    
    buffer.writeUInt32LE(header.bits, offset);
    offset += 4;
    
    buffer.writeUInt32LE(header.nonce, offset);
    
    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? 0xFFFFFFFF;
    const target = this.difficultyToTarget(targetDifficulty);
    
    const startTime = Date.now();
    let attempts = 0;

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      const headerBuffer = this.serializeHeader(header);
      const hash = this.hash(headerBuffer);
      const hashHex = hash.reverse().toString('hex');
      
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      // メモリハードなので頻繁に中断
      if (attempts % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex').reverse();
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === kHeavyHash Algorithm (KAS - 中優先度) ===
export class OptimizedKHeavyHashAlgorithm extends MiningAlgorithm {
  readonly name = 'kheavyhash';
  readonly blockTime = 1; // 1秒（Kaspaの高速ブロック）

  private readonly matrixCache = new Map<string, Buffer>();

  hash(data: Buffer): Buffer {
    // kHeavyHashアルゴリズム（Kaspa用）
    // SHA-3とBlake3の組み合わせ
    
    // Stage 1: SHA3-256
    let result = createHash('sha3-256').update(data).digest();
    
    // Stage 2: Heavy matrix operations
    const matrixKey = result.slice(0, 8).toString('hex');
    let matrix = this.matrixCache.get(matrixKey);
    
    if (!matrix) {
      // 重い行列計算をシミュレート
      matrix = Buffer.alloc(1024);
      for (let i = 0; i < 1024; i += 32) {
        const seed = Buffer.concat([result.slice(0, 16), Buffer.from([i & 0xFF])]);
        const chunk = createHash('sha3-256').update(seed).digest();
        chunk.copy(matrix, i, 0, Math.min(32, 1024 - i));
      }
      
      if (this.matrixCache.size < 200) {
        this.matrixCache.set(matrixKey, matrix);
      }
    }
    
    // Stage 3: Matrix multiplication simulation
    for (let round = 0; round < 4; round++) {
      const index = result.readUInt32LE(round * 4) % 32;
      const matrixChunk = matrix.slice(index * 32, (index + 1) * 32);
      
      // XOR operation
      for (let i = 0; i < 32; i++) {
        result[i] ^= matrixChunk[i];
      }
      
      // Hash again
      result = createHash('sha3-256').update(result).digest();
    }
    
    // Stage 4: Final Blake3-like hash (simplified)
    result = createHash('sha256').update(result).digest();
    
    return result;
  }

  serializeHeader(header: BlockHeader): Buffer {
    // Kaspa ヘッダー形式（簡略化）
    const buffer = Buffer.alloc(84);
    let offset = 0;

    buffer.writeUInt16LE(header.version, offset);
    offset += 2;
    
    Buffer.from(header.prevHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    Buffer.from(header.merkleRoot, 'hex').copy(buffer, offset);
    offset += 32;
    
    buffer.writeBigUInt64LE(BigInt(header.timestamp), offset);
    offset += 8;
    
    buffer.writeUInt32LE(header.bits, offset);
    offset += 4;
    
    buffer.writeBigUInt64LE(BigInt(header.nonce), offset);
    
    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? Number.MAX_SAFE_INTEGER;
    const target = this.difficultyToTarget(targetDifficulty);
    
    const startTime = Date.now();
    let attempts = 0;

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      const headerBuffer = this.serializeHeader(header);
      const hash = this.hash(headerBuffer);
      const hashHex = hash.reverse().toString('hex');
      
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      // 高速ブロックのため少し多めに実行
      if (attempts % 50000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex').reverse();
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === Ethash Algorithm (ETC - GPU安定収益) ===
export class OptimizedEthashAlgorithm extends MiningAlgorithm {
  readonly name = 'ethash';
  readonly blockTime = 15; // 15秒

  private readonly dagCache = new Map<number, Buffer>();

  hash(data: Buffer): Buffer {
    return createHash('sha3-256').update(data).digest();
  }

  serializeHeader(header: BlockHeader): Buffer {
    // Ethereum Classic形式
    const buffer = Buffer.alloc(72);
    let offset = 0;

    Buffer.from(header.prevHash, 'hex').copy(buffer, offset);
    offset += 32;

    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(header.timestamp));
    timestamp.copy(buffer, offset);
    offset += 8;

    const difficulty = Buffer.alloc(8);
    difficulty.writeBigUInt64BE(BigInt(header.bits));
    difficulty.copy(buffer, offset);
    offset += 8;

    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64BE(BigInt(header.nonce));
    nonce.copy(buffer, offset);

    return buffer;
  }

  async mine(header: BlockHeader, targetDifficulty: number, nonceRange?: [number, number]): Promise<MiningResult | null> {
    const startNonce = nonceRange?.[0] ?? 0;
    const endNonce = nonceRange?.[1] ?? Number.MAX_SAFE_INTEGER;
    const target = this.difficultyToTarget(targetDifficulty);
    
    const startTime = Date.now();
    let attempts = 0;

    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      header.nonce = nonce;
      
      const { hash, mixHash } = this.ethashHash(header);
      header.mixHash = mixHash;
      
      const hashHex = hash.toString('hex');
      attempts++;

      if (this.compareHashToTarget(hash, target)) {
        const elapsed = (Date.now() - startTime) / 1000;
        return {
          hash: hashHex,
          nonce,
          mixHash,
          valid: true,
          difficulty: this.calculateHashDifficulty(hashHex),
          hashrate: attempts / elapsed
        };
      }

      if (attempts % 10000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    return null;
  }

  private ethashHash(header: BlockHeader): { hash: Buffer; mixHash: string } {
    const headerBuffer = this.serializeHeader(header);
    const seed = this.hash(headerBuffer);
    
    // 簡略化されたEthash DAGアクセス
    const mixHash = createHash('sha3-256').update(Buffer.concat([seed, Buffer.from([header.nonce & 0xFF])])).digest();
    const finalHash = createHash('sha3-256').update(Buffer.concat([seed, mixHash])).digest();
    
    return {
      hash: finalHash,
      mixHash: mixHash.toString('hex')
    };
  }

  validateHash(hash: string, targetDifficulty: number): boolean {
    const target = this.difficultyToTarget(targetDifficulty);
    const hashBuffer = Buffer.from(hash, 'hex');
    return this.compareHashToTarget(hashBuffer, target);
  }
}

// === アルゴリズムファクトリー ===
export class AlgorithmFactory {
  private static algorithms = new Map<string, () => MiningAlgorithm>([
    ['randomx', () => new OptimizedRandomXAlgorithm()],
    ['kawpow', () => new OptimizedKawPowAlgorithm()],
    ['sha256d', () => new OptimizedSHA256Algorithm()],
    ['ethash', () => new OptimizedEthashAlgorithm()],
    ['autolykos2', () => new OptimizedAutolykosV2Algorithm()],
    ['kheavyhash', () => new OptimizedKHeavyHashAlgorithm()],
  ]);

  static create(name: string): MiningAlgorithm {
    const factory = this.algorithms.get(name.toLowerCase());
    if (!factory) {
      throw new Error(`Unsupported algorithm: ${name}`);
    }
    return factory();
  }

  static register(name: string, factory: () => MiningAlgorithm): void {
    this.algorithms.set(name.toLowerCase(), factory);
  }

  static list(): string[] {
    return Array.from(this.algorithms.keys());
  }

  static getForCoin(coin: string): MiningAlgorithm {
    const coinMap: Record<string, string> = {
      // 最高優先度対応
      'monero': 'randomx',      // XMR - CPU最高収益
      'xmr': 'randomx',
      'ravencoin': 'kawpow',    // RVN - GPU最高収益
      'rvn': 'kawpow',
      'bitcoin': 'sha256d',     // BTC - ASIC対応
      'btc': 'sha256d',
      'ethereum-classic': 'ethash', // ETC - GPU安定収益
      'etc': 'ethash',
      // 中優先度対応
      'ergo': 'autolykos2',     // ERG - Autolykos v2
      'erg': 'autolykos2',
      'kaspa': 'kheavyhash',    // KAS - kHeavyHash
      'kas': 'kheavyhash',
      // 追加対応
      'bitcoin-cash': 'sha256d',
      'bch': 'sha256d',
      'litecoin': 'sha256d',    // 簡略化
      'ltc': 'sha256d',
    };

    const algorithm = coinMap[coin.toLowerCase()];
    if (!algorithm) {
      throw new Error(`Unsupported coin: ${coin}`);
    }

    return this.create(algorithm);
  }
}

// === マルチアルゴリズムマイナー ===
export class MultiAlgorithmMiner {
  private algorithms: MiningAlgorithm[];

  constructor(algorithmNames: string[]) {
    this.algorithms = algorithmNames.map(name => AlgorithmFactory.create(name));
  }

  async mineWithBestAlgorithm(
    header: BlockHeader,
    targetDifficulty: number,
    timeLimit: number = 30000
  ): Promise<{ algorithm: string; result: MiningResult } | null> {
    const startTime = Date.now();
    
    // 並列マイニング開始
    const promises = this.algorithms.map(async (algo) => {
      const result = await algo.mine(header, targetDifficulty);
      return { algorithm: algo.name, result };
    });

    // 最初に見つかった結果を返す
    while (Date.now() - startTime < timeLimit) {
      for (const promise of promises) {
        try {
          const { algorithm, result } = await promise;
          if (result && result.valid) {
            return { algorithm, result };
          }
        } catch (error) {
          // エラーは無視して続行
          continue;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null;
  }
}

// === プロフィットスイッチャー ===
export interface CoinProfitability {
  coin: string;
  algorithm: string;
  difficulty: number;
  price: number;      // USD
  blockReward: number;
  profitability: number; // USD/day per hashrate unit
}

export class ProfitSwitcher {
  private profitabilityData: CoinProfitability[] = [];

  updateProfitability(data: CoinProfitability[]): void {
    this.profitabilityData = data.sort((a, b) => b.profitability - a.profitability);
  }

  getMostProfitableCoin(): CoinProfitability | null {
    return this.profitabilityData[0] || null;
  }

  getBestAlgorithm(): MiningAlgorithm | null {
    const mostProfitable = this.getMostProfitableCoin();
    if (!mostProfitable) return null;

    try {
      return AlgorithmFactory.create(mostProfitable.algorithm);
    } catch {
      return null;
    }
  }

  getProfitabilityRanking(): CoinProfitability[] {
    return [...this.profitabilityData];
  }
}

// エクスポート
export {
  AlgorithmFactory as MiningAlgorithmFactory,
  OptimizedRandomXAlgorithm as RandomXAlgorithm,
  OptimizedKawPowAlgorithm as KawPowAlgorithm,
  OptimizedSHA256Algorithm as SHA256Algorithm,
  OptimizedEthashAlgorithm as EthashAlgorithm,
  OptimizedAutolykosV2Algorithm as AutolykosV2Algorithm,
  OptimizedKHeavyHashAlgorithm as KHeavyHashAlgorithm
};