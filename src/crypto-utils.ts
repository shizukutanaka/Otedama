/**
 * 軽量暗号化ユーティリティ
 * 設計思想: John Carmack (高速・直接的), Robert C. Martin (単一責任), Rob Pike (シンプル)
 */

import { createHash } from 'crypto';

// === 軽量SHA256実装 ===
export class LightCrypto {
  
  /**
   * シンプルなSHA256ハッシュ計算
   * @param data - ハッシュ化するデータ
   * @returns HEXエンコードされたハッシュ
   */
  static sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * ダブルSHA256ハッシュ (ビットコイン式)
   * @param data - ハッシュ化するデータ
   * @returns HEXエンコードされたハッシュ
   */
  static doubleSha256(data: string | Buffer): string {
    const first = createHash('sha256').update(data).digest();
    return createHash('sha256').update(first).digest('hex');
  }

  /**
   * ハッシュを数値として評価 (難易度計算用)
   * @param hash - HEXハッシュ文字列
   * @returns 数値としてのハッシュ値
   */
  static hashToNumber(hash: string): number {
    // 最初の8文字を使用 (32bit値)
    return parseInt(hash.substring(0, 8), 16);
  }

  /**
   * 難易度からターゲット値を計算
   * @param difficulty - 難易度
   * @returns ターゲット値
   */
  static difficultyToTarget(difficulty: number): number {
    // シンプルな計算: MAX_VALUE / difficulty
    return Math.floor(0xFFFFFFFF / Math.max(1, difficulty));
  }

  /**
   * ハッシュが指定されたターゲット以下かチェック
   * @param hash - HEXハッシュ文字列
   * @param target - ターゲット値
   * @returns 有効かどうか
   */
  static isValidHash(hash: string, target: number): boolean {
    const hashValue = this.hashToNumber(hash);
    return hashValue < target;
  }

  /**
   * ランダムなナンスを生成
   * @returns HEXエンコードされたナンス
   */
  static generateNonce(): string {
    return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
  }

  /**
   * ブロックヘッダーのハッシュを計算 (シンプル版)
   * @param blockHeader - ブロックヘッダー情報
   * @returns ハッシュ値
   */
  static calculateBlockHash(blockHeader: {
    version: string;
    previousHash: string;
    merkleRoot: string;
    timestamp: number;
    bits: string;
    nonce: string;
  }): string {
    // シンプルなブロックヘッダー構築
    const header = [
      blockHeader.version,
      blockHeader.previousHash,
      blockHeader.merkleRoot,
      blockHeader.timestamp.toString(16).padStart(8, '0'),
      blockHeader.bits,
      blockHeader.nonce
    ].join('');

    return this.doubleSha256(Buffer.from(header, 'hex'));
  }

  /**
   * Merkle Rootを計算 (基本実装)
   * @param transactions - トランザクションハッシュ配列
   * @returns Merkle Root
   */
  static calculateMerkleRoot(transactions: string[]): string {
    if (transactions.length === 0) {
      return '0'.repeat(64);
    }

    if (transactions.length === 1) {
      return transactions[0];
    }

    let level = transactions.slice();

    while (level.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left; // 奇数の場合は最後を複製

        const combined = Buffer.from(left + right, 'hex');
        const hash = this.doubleSha256(combined);
        nextLevel.push(hash);
      }

      level = nextLevel;
    }

    return level[0];
  }

  /**
   * 簡単な難易度調整計算
   * @param currentDifficulty - 現在の難易度
   * @param actualTime - 実際にかかった時間(秒)
   * @param targetTime - 目標時間(秒)
   * @param maxChange - 最大変更率 (デフォルト 4倍/0.25倍)
   * @returns 新しい難易度
   */
  static adjustDifficulty(
    currentDifficulty: number,
    actualTime: number,
    targetTime: number,
    maxChange: number = 4
  ): number {
    const ratio = actualTime / targetTime;
    let newDifficulty = currentDifficulty / ratio;

    // 最大変更率を制限
    const maxDifficulty = currentDifficulty * maxChange;
    const minDifficulty = currentDifficulty / maxChange;

    newDifficulty = Math.max(minDifficulty, Math.min(maxDifficulty, newDifficulty));

    return Math.max(1, Math.floor(newDifficulty));
  }

  /**
   * シンプルなワーク生成
   * @param previousHash - 前のブロックハッシュ
   * @param merkleRoot - マークルルート
   * @param timestamp - タイムスタンプ
   * @param bits - ビット数
   * @returns ワーク情報
   */
  static generateWork(
    previousHash: string,
    merkleRoot: string = '0'.repeat(64),
    timestamp: number = Math.floor(Date.now() / 1000),
    bits: string = '1d00ffff'
  ) {
    return {
      version: '20000000',
      previousHash,
      merkleRoot,
      timestamp,
      bits,
      nonce: '00000000',
      target: this.bitsToTarget(bits)
    };
  }

  /**
   * Bitsからターゲットを計算
   * @param bits - HEXエンコードされたbits
   * @returns ターゲット値
   */
  static bitsToTarget(bits: string): number {
    // シンプルな実装: 実際のビットコインではより複雑
    const bitsInt = parseInt(bits, 16);
    const exponent = bitsInt >> 24;
    const mantissa = bitsInt & 0xFFFFFF;
    
    if (exponent <= 3) {
      return mantissa >> (8 * (3 - exponent));
    } else {
      return mantissa << (8 * (exponent - 3));
    }
  }

  /**
   * ハッシュレートを推定
   * @param difficulty - 難易度
   * @param timeSeconds - 時間(秒)
   * @returns 推定ハッシュレート (H/s)
   */
  static estimateHashrate(difficulty: number, timeSeconds: number): number {
    // シンプルな推定: difficulty * 2^32 / time
    return (difficulty * 0x100000000) / timeSeconds;
  }

  /**
   * 人間が読みやすいハッシュレート表示
   * @param hashrate - ハッシュレート (H/s)
   * @returns フォーマットされた文字列
   */
  static formatHashrate(hashrate: number): string {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let value = hashrate;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * ブロック報酬を計算 (Bitcoin準拠)
   * @param blockHeight - ブロック高
   * @returns ブロック報酬 (Satoshi)
   */
  static calculateBlockReward(blockHeight: number): number {
    const halvingInterval = 210000; // 21万ブロックごと
    const initialReward = 50 * 100000000; // 50 BTC in satoshis
    
    const halvings = Math.floor(blockHeight / halvingInterval);
    
    if (halvings >= 64) {
      return 0; // 64回半減後は報酬なし
    }
    
    return Math.floor(initialReward / Math.pow(2, halvings));
  }

  /**
   * 手数料を計算
   * @param amount - 金額 (Satoshi)
   * @param feePercent - 手数料率 (%)
   * @returns 手数料 (Satoshi)
   */
  static calculateFee(amount: number, feePercent: number): number {
    return Math.floor(amount * feePercent / 100);
  }

  /**
   * シンプルなアドレス検証 (基本的なフォーマットチェック)
   * @param address - ビットコインアドレス
   * @returns 有効かどうか
   */
  static isValidBitcoinAddress(address: string): boolean {
    // 基本的なフォーマットチェック
    if (!address || address.length < 26 || address.length > 62) {
      return false;
    }

    // Legacy address (1で始まる)
    if (address.startsWith('1')) {
      return /^[1][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address);
    }

    // P2SH address (3で始まる)  
    if (address.startsWith('3')) {
      return /^[3][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address);
    }

    // Bech32 address (bc1で始まる)
    if (address.startsWith('bc1')) {
      return /^bc1[a-z0-9]{39,59}$/.test(address.toLowerCase());
    }

    return false;
  }

  /**
   * デバッグ用: ハッシュの詳細情報を表示
   * @param hash - HEXハッシュ文字列  
   * @param difficulty - 難易度
   * @returns デバッグ情報
   */
  static debugHash(hash: string, difficulty: number) {
    const hashValue = this.hashToNumber(hash);
    const target = this.difficultyToTarget(difficulty);
    const isValid = hashValue < target;

    return {
      hash,
      hashValue,
      difficulty,
      target,
      isValid,
      leading_zeros: hash.match(/^0*/)?.[0].length || 0
    };
  }
}

// === 使用例とテスト用ヘルパー ===
export class CryptoTestHelper {
  
  /**
   * テスト用のダミーワークを生成
   */
  static generateTestWork() {
    return LightCrypto.generateWork(
      '0'.repeat(64),
      LightCrypto.calculateMerkleRoot(['test_transaction_hash']),
      Math.floor(Date.now() / 1000),
      '1d00ffff'
    );
  }

  /**
   * テスト用のシェア検証
   */
  static testShareValidation() {
    const work = this.generateTestWork();
    const nonce = LightCrypto.generateNonce();
    
    const blockHeader = {
      version: work.version,
      previousHash: work.previousHash,
      merkleRoot: work.merkleRoot,
      timestamp: work.timestamp,
      bits: work.bits,
      nonce
    };

    const hash = LightCrypto.calculateBlockHash(blockHeader);
    const isValid = LightCrypto.isValidHash(hash, work.target);

    return {
      work,
      nonce,
      hash,
      isValid,
      debug: LightCrypto.debugHash(hash, 1)
    };
  }

  /**
   * パフォーマンステスト
   */
  static performanceTest(iterations: number = 1000) {
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      const data = `test_data_${i}`;
      LightCrypto.sha256(data);
    }
    
    const end = Date.now();
    const duration = end - start;
    const hashesPerSecond = iterations / (duration / 1000);

    return {
      iterations,
      duration,
      hashesPerSecond: Math.floor(hashesPerSecond),
      formatted: LightCrypto.formatHashrate(hashesPerSecond)
    };
  }
}
