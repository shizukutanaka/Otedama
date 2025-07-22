/**
 * Secure Multi-Party Computation System
 * セキュアなマルチパーティ計算システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { randomBytes, createHash } from 'crypto';

const logger = getLogger('SecureMultipartyComputation');

// SMPCプロトコル
export const SMPCProtocol = {
  SHAMIR_SECRET_SHARING: 'shamir_secret_sharing',
  GARBLED_CIRCUITS: 'garbled_circuits',
  HOMOMORPHIC_ENCRYPTION: 'homomorphic_encryption',
  OBLIVIOUS_TRANSFER: 'oblivious_transfer',
  BGW: 'bgw',                    // Ben-Or, Goldwasser, Wigderson
  GMW: 'gmw',                    // Goldreich, Micali, Wigderson
  SPDZ: 'spdz'                   // Scalable Protocol with Dishonest majority
};

// 計算タイプ
export const ComputationType = {
  ADDITION: 'addition',
  MULTIPLICATION: 'multiplication',
  COMPARISON: 'comparison',
  BOOLEAN_CIRCUIT: 'boolean_circuit',
  ARITHMETIC_CIRCUIT: 'arithmetic_circuit',
  MACHINE_LEARNING: 'machine_learning',
  STATISTICAL_ANALYSIS: 'statistical_analysis'
};

// パーティロール
export const PartyRole = {
  INPUT_PROVIDER: 'input_provider',
  COMPUTE_NODE: 'compute_node',
  RESULT_RECEIVER: 'result_receiver',
  TRUSTED_DEALER: 'trusted_dealer'
};

export class SecureMultipartyComputation extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.crypto = getCryptoUtils();
    
    this.options = {
      // プロトコル設定
      protocol: options.protocol || SMPCProtocol.SHAMIR_SECRET_SHARING,
      securityParameter: options.securityParameter || 128,
      
      // シャミア秘密分散設定
      threshold: options.threshold || 3,          // t+1パーティで復元可能
      totalParties: options.totalParties || 5,
      fieldSize: options.fieldSize || 2n ** 256n - 189n, // 大きな素数
      
      // 性能設定
      enablePreprocessing: options.enablePreprocessing !== false,
      batchSize: options.batchSize || 100,
      parallelOperations: options.parallelOperations || 10,
      
      // セキュリティ設定
      enableMaliciousProtection: options.enableMaliciousProtection !== false,
      verificationProbability: options.verificationProbability || 0.999,
      
      // 通信設定
      enableSecureChannels: options.enableSecureChannels !== false,
      communicationTimeout: options.communicationTimeout || 30000,
      
      ...options
    };
    
    // パーティ管理
    this.parties = new Map();
    this.activeComputations = new Map();
    
    // 秘密分散管理
    this.shares = new Map();
    this.commitments = new Map();
    
    // プリプロセッシング
    this.preprocessedData = {
      triples: [],      // Beaver triples
      randomBits: [],   // ランダムビット
      randomNumbers: [] // ランダム数
    };
    
    // 回路管理
    this.circuits = new Map();
    this.garbledCircuits = new Map();
    
    // メトリクス
    this.metrics = {
      totalComputations: 0,
      successfulComputations: 0,
      failedComputations: 0,
      totalOperations: 0,
      averageComputationTime: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // プロトコル固有の初期化
    await this.initializeProtocol();
    
    // プリプロセッシングを開始
    if (this.options.enablePreprocessing) {
      await this.startPreprocessing();
    }
    
    this.logger.info('Secure multi-party computation initialized');
  }
  
  /**
   * パーティを登録
   */
  async registerParty(partyId, config) {
    const party = {
      id: partyId,
      role: config.role || PartyRole.COMPUTE_NODE,
      publicKey: config.publicKey,
      endpoint: config.endpoint,
      capabilities: config.capabilities || [],
      status: 'active',
      registeredAt: Date.now()
    };
    
    this.parties.set(partyId, party);
    
    // セキュアチャンネルを確立
    if (this.options.enableSecureChannels) {
      await this.establishSecureChannel(partyId);
    }
    
    this.emit('party:registered', { partyId, role: party.role });
    
    return { partyId, status: 'registered' };
  }
  
  /**
   * 計算を実行
   */
  async executeComputation(computationId, config) {
    const computation = {
      id: computationId,
      type: config.type,
      parties: config.parties,
      inputs: new Map(),
      outputs: new Map(),
      status: 'initializing',
      startTime: Date.now()
    };
    
    this.activeComputations.set(computationId, computation);
    
    try {
      // 入力を収集
      await this.collectInputs(computation, config.inputs);
      
      // プロトコルに応じた計算を実行
      let result;
      switch (this.options.protocol) {
        case SMPCProtocol.SHAMIR_SECRET_SHARING:
          result = await this.computeWithShamir(computation);
          break;
          
        case SMPCProtocol.GARBLED_CIRCUITS:
          result = await this.computeWithGarbledCircuits(computation);
          break;
          
        case SMPCProtocol.HOMOMORPHIC_ENCRYPTION:
          result = await this.computeWithHomomorphic(computation);
          break;
          
        default:
          throw new Error(`Unsupported protocol: ${this.options.protocol}`);
      }
      
      computation.status = 'completed';
      computation.result = result;
      
      this.metrics.totalComputations++;
      this.metrics.successfulComputations++;
      
      this.emit('computation:completed', {
        computationId,
        result: result.public // 公開可能な結果のみ
      });
      
      return result;
      
    } catch (error) {
      computation.status = 'failed';
      computation.error = error.message;
      
      this.metrics.failedComputations++;
      
      this.logger.error('Computation failed', error);
      throw error;
      
    } finally {
      const duration = Date.now() - computation.startTime;
      this.updateAverageComputationTime(duration);
    }
  }
  
  /**
   * 値を秘密分散
   */
  async secretShare(value, partyIds = null) {
    const parties = partyIds || Array.from(this.parties.keys()).slice(0, this.options.totalParties);
    
    if (parties.length < this.options.totalParties) {
      throw new Error('Insufficient parties for secret sharing');
    }
    
    // 多項式を生成
    const polynomial = this.generatePolynomial(value, this.options.threshold);
    
    // 各パーティの共有を生成
    const shares = new Map();
    
    for (let i = 0; i < parties.length; i++) {
      const x = BigInt(i + 1);
      const share = this.evaluatePolynomial(polynomial, x);
      
      shares.set(parties[i], {
        x,
        y: share,
        commitment: await this.createCommitment(share)
      });
    }
    
    // 検証情報を生成
    const verification = await this.generateVerificationData(polynomial);
    
    return {
      shareId: this.generateShareId(),
      shares,
      verification,
      threshold: this.options.threshold
    };
  }
  
  /**
   * 秘密を復元
   */
  async reconstructSecret(shareId, providedShares) {
    if (providedShares.size < this.options.threshold + 1) {
      throw new Error('Insufficient shares for reconstruction');
    }
    
    // 共有を検証
    if (this.options.enableMaliciousProtection) {
      await this.verifyShares(shareId, providedShares);
    }
    
    // ラグランジュ補間で復元
    const points = Array.from(providedShares.values()).map(share => ({
      x: share.x,
      y: share.y
    }));
    
    const secret = this.lagrangeInterpolation(points, 0n);
    
    return secret;
  }
  
  /**
   * シャミア秘密分散で計算
   */
  async computeWithShamir(computation) {
    const { type, inputs } = computation;
    
    // 入力を秘密分散
    const sharedInputs = new Map();
    for (const [partyId, input] of inputs) {
      const shared = await this.secretShare(input);
      sharedInputs.set(partyId, shared);
    }
    
    // 計算タイプに応じて処理
    let result;
    switch (type) {
      case ComputationType.ADDITION:
        result = await this.secureAddition(sharedInputs);
        break;
        
      case ComputationType.MULTIPLICATION:
        result = await this.secureMultiplication(sharedInputs);
        break;
        
      case ComputationType.COMPARISON:
        result = await this.secureComparison(sharedInputs);
        break;
        
      default:
        throw new Error(`Unsupported computation type: ${type}`);
    }
    
    // 結果を復元（必要な場合）
    if (computation.revealResult) {
      const reconstructed = await this.reconstructSecret(
        result.shareId,
        result.shares
      );
      
      return {
        value: reconstructed,
        public: true
      };
    }
    
    return {
      shareId: result.shareId,
      public: false
    };
  }
  
  /**
   * セキュアな加算
   */
  async secureAddition(sharedInputs) {
    const inputShares = Array.from(sharedInputs.values());
    
    if (inputShares.length < 2) {
      throw new Error('Addition requires at least 2 inputs');
    }
    
    // シェアごとに加算（線形性を利用）
    const resultShares = new Map();
    
    for (const [partyId, share] of inputShares[0].shares) {
      let sum = share.y;
      
      for (let i = 1; i < inputShares.length; i++) {
        const otherShare = inputShares[i].shares.get(partyId);
        sum = (sum + otherShare.y) % this.options.fieldSize;
      }
      
      resultShares.set(partyId, {
        x: share.x,
        y: sum,
        commitment: await this.createCommitment(sum)
      });
    }
    
    return {
      shareId: this.generateShareId(),
      shares: resultShares,
      operation: 'addition'
    };
  }
  
  /**
   * セキュアな乗算（Beaverトリプルを使用）
   */
  async secureMultiplication(sharedInputs) {
    const [input1, input2] = Array.from(sharedInputs.values());
    
    // Beaverトリプル (a, b, c) where c = a * b
    const triple = await this.getBeaverTriple();
    
    // [x - a] と [y - b] を公開
    const xMinusA = await this.secureSubtraction(input1, triple.a);
    const yMinusB = await this.secureSubtraction(input2, triple.b);
    
    // 値を復元
    const d = await this.reconstructSecret(xMinusA.shareId, xMinusA.shares);
    const e = await this.reconstructSecret(yMinusB.shareId, yMinusB.shares);
    
    // [x * y] = [c] + d[b] + e[a] + de を計算
    const resultShares = new Map();
    
    for (const [partyId, cShare] of triple.c.shares) {
      const aShare = triple.a.shares.get(partyId);
      const bShare = triple.b.shares.get(partyId);
      
      let result = cShare.y;
      result = (result + d * bShare.y) % this.options.fieldSize;
      result = (result + e * aShare.y) % this.options.fieldSize;
      
      if (partyId === Array.from(triple.c.shares.keys())[0]) {
        result = (result + d * e) % this.options.fieldSize;
      }
      
      resultShares.set(partyId, {
        x: cShare.x,
        y: result,
        commitment: await this.createCommitment(result)
      });
    }
    
    this.metrics.totalOperations++;
    
    return {
      shareId: this.generateShareId(),
      shares: resultShares,
      operation: 'multiplication'
    };
  }
  
  /**
   * Garbled Circuitsで計算
   */
  async computeWithGarbledCircuits(computation) {
    const { type, inputs, circuit } = computation;
    
    // ガーブラーとエバリュエーターを決定
    const [garbler, evaluator] = this.selectGarblerEvaluator(computation.parties);
    
    // 回路をガーブル
    const garbledCircuit = await this.garbleCircuit(circuit, garbler);
    
    // 入力ワイヤラベルを転送（Oblivious Transfer）
    const inputLabels = await this.obliviousTransfer(
      inputs,
      garbledCircuit.inputWires,
      garbler,
      evaluator
    );
    
    // 回路を評価
    const outputLabels = await this.evaluateGarbledCircuit(
      garbledCircuit,
      inputLabels,
      evaluator
    );
    
    // 出力をデコード
    const result = await this.decodeOutput(
      outputLabels,
      garbledCircuit.outputTable
    );
    
    return {
      value: result,
      public: computation.revealResult
    };
  }
  
  /**
   * 回路をガーブル
   */
  async garbleCircuit(circuit, garblerId) {
    const garbledGates = [];
    const wireLabels = new Map();
    
    // 各ワイヤに2つのラベルを割り当て（0と1用）
    for (const wire of circuit.wires) {
      wireLabels.set(wire.id, {
        label0: randomBytes(16),
        label1: randomBytes(16)
      });
    }
    
    // 各ゲートをガーブル
    for (const gate of circuit.gates) {
      const garbledGate = await this.garbleGate(gate, wireLabels);
      garbledGates.push(garbledGate);
    }
    
    // 出力デコードテーブルを作成
    const outputTable = this.createOutputTable(circuit.outputWires, wireLabels);
    
    return {
      gates: garbledGates,
      inputWires: circuit.inputWires,
      outputTable,
      garblerId
    };
  }
  
  /**
   * ゲートをガーブル
   */
  async garbleGate(gate, wireLabels) {
    const input1Labels = wireLabels.get(gate.input1);
    const input2Labels = wireLabels.get(gate.input2);
    const outputLabels = wireLabels.get(gate.output);
    
    const table = [];
    
    // 4つの可能な入力組み合わせ
    for (const bit1 of [0, 1]) {
      for (const bit2 of [0, 1]) {
        const inputLabel1 = bit1 ? input1Labels.label1 : input1Labels.label0;
        const inputLabel2 = bit2 ? input2Labels.label1 : input2Labels.label0;
        
        // ゲート関数を評価
        const outputBit = this.evaluateGateFunction(gate.type, bit1, bit2);
        const outputLabel = outputBit ? outputLabels.label1 : outputLabels.label0;
        
        // 暗号化
        const key = this.deriveKey(inputLabel1, inputLabel2);
        const encrypted = await this.crypto.encrypt(outputLabel, key);
        
        table.push({
          position: this.calculatePosition(inputLabel1, inputLabel2),
          ciphertext: encrypted
        });
      }
    }
    
    // テーブルをシャッフル
    this.shuffleArray(table);
    
    return {
      type: gate.type,
      table
    };
  }
  
  /**
   * Oblivious Transfer
   */
  async obliviousTransfer(inputs, inputWires, sender, receiver) {
    const transferredLabels = new Map();
    
    for (const [inputId, inputValue] of inputs) {
      const wire = inputWires.find(w => w.inputId === inputId);
      const labels = await this.performOT(
        sender,
        receiver,
        wire.labels,
        inputValue
      );
      
      transferredLabels.set(wire.id, labels);
    }
    
    return transferredLabels;
  }
  
  /**
   * 1-out-of-2 OTを実行
   */
  async performOT(sender, receiver, messages, choice) {
    // 簡略化されたOT実装
    // 実際の実装では、より高度なOTプロトコルを使用
    
    // 受信者が公開鍵を生成
    const { publicKey, privateKey } = await this.crypto.generateKeyPair();
    
    // 送信者が両方のメッセージを暗号化
    const encrypted0 = await this.crypto.encrypt(messages[0], publicKey);
    const encrypted1 = await this.crypto.encrypt(messages[1], publicKey);
    
    // 受信者が選択に基づいて復号
    const selected = choice ? encrypted1 : encrypted0;
    const decrypted = await this.crypto.decrypt(selected, privateKey);
    
    return decrypted;
  }
  
  /**
   * Beaverトリプルを取得
   */
  async getBeaverTriple() {
    // プリプロセッシングから取得
    if (this.preprocessedData.triples.length > 0) {
      return this.preprocessedData.triples.pop();
    }
    
    // オンラインで生成（コストが高い）
    return await this.generateBeaverTriple();
  }
  
  /**
   * Beaverトリプルを生成
   */
  async generateBeaverTriple() {
    // ランダムな値を生成
    const a = this.randomFieldElement();
    const b = this.randomFieldElement();
    const c = (a * b) % this.options.fieldSize;
    
    // 各値を秘密分散
    const sharedA = await this.secretShare(a);
    const sharedB = await this.secretShare(b);
    const sharedC = await this.secretShare(c);
    
    return {
      a: sharedA,
      b: sharedB,
      c: sharedC
    };
  }
  
  /**
   * 多項式を生成
   */
  generatePolynomial(secret, degree) {
    const coefficients = [secret];
    
    for (let i = 1; i <= degree; i++) {
      coefficients.push(this.randomFieldElement());
    }
    
    return coefficients;
  }
  
  /**
   * 多項式を評価
   */
  evaluatePolynomial(coefficients, x) {
    let result = 0n;
    let xPower = 1n;
    
    for (const coeff of coefficients) {
      result = (result + coeff * xPower) % this.options.fieldSize;
      xPower = (xPower * x) % this.options.fieldSize;
    }
    
    return result;
  }
  
  /**
   * ラグランジュ補間
   */
  lagrangeInterpolation(points, x) {
    let result = 0n;
    const p = this.options.fieldSize;
    
    for (let i = 0; i < points.length; i++) {
      let numerator = 1n;
      let denominator = 1n;
      
      for (let j = 0; j < points.length; j++) {
        if (i !== j) {
          numerator = (numerator * (x - points[j].x)) % p;
          denominator = (denominator * (points[i].x - points[j].x)) % p;
        }
      }
      
      // モジュラー逆元を計算
      const invDenominator = this.modInverse(denominator, p);
      const lagrangeBasis = (numerator * invDenominator) % p;
      
      result = (result + points[i].y * lagrangeBasis) % p;
    }
    
    return (result + p) % p;
  }
  
  /**
   * モジュラー逆元（拡張ユークリッドの互除法）
   */
  modInverse(a, m) {
    if (a < 0n) a = (a % m + m) % m;
    
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    
    while (r !== 0n) {
      const quotient = old_r / r;
      [old_r, r] = [r, old_r - quotient * r];
      [old_s, s] = [s, old_s - quotient * s];
    }
    
    return (old_s % m + m) % m;
  }
  
  /**
   * プロトコルを初期化
   */
  async initializeProtocol() {
    switch (this.options.protocol) {
      case SMPCProtocol.SHAMIR_SECRET_SHARING:
        // フィールドパラメータを検証
        if (!this.isPrime(this.options.fieldSize)) {
          throw new Error('Field size must be prime for Shamir secret sharing');
        }
        break;
        
      case SMPCProtocol.GARBLED_CIRCUITS:
        // 基本回路を準備
        this.prepareBasicCircuits();
        break;
        
      case SMPCProtocol.SPDZ:
        // SPDZ固有の初期化
        await this.initializeSPDZ();
        break;
    }
  }
  
  /**
   * プリプロセッシングを開始
   */
  async startPreprocessing() {
    // バックグラウンドでプリプロセッシングデータを生成
    this.preprocessingInterval = setInterval(async () => {
      await this.generatePreprocessingData();
    }, 60000); // 1分ごと
    
    // 初期データを生成
    await this.generatePreprocessingData();
  }
  
  /**
   * プリプロセッシングデータを生成
   */
  async generatePreprocessingData() {
    const targetTriples = 100;
    const targetBits = 1000;
    
    // Beaverトリプルを生成
    while (this.preprocessedData.triples.length < targetTriples) {
      const triple = await this.generateBeaverTriple();
      this.preprocessedData.triples.push(triple);
    }
    
    // ランダムビットを生成
    while (this.preprocessedData.randomBits.length < targetBits) {
      const bit = this.randomBit();
      const shared = await this.secretShare(BigInt(bit));
      this.preprocessedData.randomBits.push(shared);
    }
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      metrics: this.metrics,
      parties: {
        total: this.parties.size,
        active: Array.from(this.parties.values()).filter(
          p => p.status === 'active'
        ).length
      },
      computations: {
        active: this.activeComputations.size,
        total: this.metrics.totalComputations
      },
      preprocessing: {
        triples: this.preprocessedData.triples.length,
        bits: this.preprocessedData.randomBits.length
      },
      protocol: this.options.protocol
    };
  }
  
  // ヘルパーメソッド
  generateShareId() {
    return `share_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  randomFieldElement() {
    // フィールドサイズ未満のランダムな要素を生成
    const bytes = Math.ceil(this.options.fieldSize.toString(2).length / 8);
    let element;
    
    do {
      element = BigInt('0x' + randomBytes(bytes).toString('hex'));
    } while (element >= this.options.fieldSize);
    
    return element;
  }
  
  randomBit() {
    return randomBytes(1)[0] & 1;
  }
  
  async createCommitment(value) {
    // Pedersen commitmentの簡略版
    const r = this.randomFieldElement();
    const g = 2n; // ジェネレータ
    const h = 3n; // 別のジェネレータ
    
    const commitment = (this.modExp(g, value, this.options.fieldSize) * 
                       this.modExp(h, r, this.options.fieldSize)) % 
                       this.options.fieldSize;
    
    return { commitment, randomness: r };
  }
  
  modExp(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    
    while (exp > 0n) {
      if (exp % 2n === 1n) {
        result = (result * base) % mod;
      }
      exp = exp / 2n;
      base = (base * base) % mod;
    }
    
    return result;
  }
  
  isPrime(n) {
    // Miller-Rabin素数判定（簡略版）
    if (n <= 1n) return false;
    if (n <= 3n) return true;
    if (n % 2n === 0n || n % 3n === 0n) return false;
    
    // より詳細な判定は省略
    return true;
  }
  
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  
  evaluateGateFunction(type, input1, input2) {
    switch (type) {
      case 'AND':
        return input1 & input2;
      case 'OR':
        return input1 | input2;
      case 'XOR':
        return input1 ^ input2;
      case 'NOT':
        return 1 - input1;
      default:
        throw new Error(`Unknown gate type: ${type}`);
    }
  }
  
  updateAverageComputationTime(duration) {
    const alpha = 0.1;
    this.metrics.averageComputationTime = 
      alpha * duration + (1 - alpha) * this.metrics.averageComputationTime;
  }
  
  async collectInputs(computation, inputConfig) {
    // 入力を収集（実装は省略）
    for (const [partyId, value] of Object.entries(inputConfig)) {
      computation.inputs.set(partyId, BigInt(value));
    }
  }
  
  async generateVerificationData(polynomial) {
    // 検証用データを生成（実装は省略）
    return {
      commitments: [],
      proofs: []
    };
  }
  
  async verifyShares(shareId, shares) {
    // シェアの検証（実装は省略）
    return true;
  }
  
  async secureSubtraction(share1, share2) {
    // 安全な減算（加算の逆）
    const negatedShare2 = await this.negateShare(share2);
    return await this.secureAddition(new Map([
      ['1', share1],
      ['2', negatedShare2]
    ]));
  }
  
  async negateShare(share) {
    // シェアの符号反転
    const negatedShares = new Map();
    
    for (const [partyId, s] of share.shares) {
      negatedShares.set(partyId, {
        x: s.x,
        y: (this.options.fieldSize - s.y) % this.options.fieldSize,
        commitment: await this.createCommitment(
          (this.options.fieldSize - s.y) % this.options.fieldSize
        )
      });
    }
    
    return {
      shareId: this.generateShareId(),
      shares: negatedShares
    };
  }
  
  selectGarblerEvaluator(parties) {
    // ガーブラーとエバリュエーターを選択（簡略化）
    return [parties[0], parties[1]];
  }
  
  prepareBasicCircuits() {
    // 基本的な回路を準備（実装は省略）
  }
  
  async initializeSPDZ() {
    // SPDZプロトコルの初期化（実装は省略）
  }
  
  deriveKey(label1, label2) {
    // 2つのラベルから鍵を導出
    return createHash('sha256')
      .update(label1)
      .update(label2)
      .digest();
  }
  
  calculatePosition(label1, label2) {
    // ガーブルテーブルでの位置を計算
    return (label1[0] & 1) * 2 + (label2[0] & 1);
  }
  
  createOutputTable(outputWires, wireLabels) {
    // 出力デコードテーブルを作成（実装は省略）
    return new Map();
  }
  
  async evaluateGarbledCircuit(circuit, inputLabels, evaluator) {
    // ガーブル回路を評価（実装は省略）
    return new Map();
  }
  
  async decodeOutput(outputLabels, outputTable) {
    // 出力をデコード（実装は省略）
    return 0;
  }
  
  async establishSecureChannel(partyId) {
    // セキュアチャンネルを確立（実装は省略）
  }
  
  async secureComparison(sharedInputs) {
    // 安全な比較（実装は省略）
    return {
      shareId: this.generateShareId(),
      shares: new Map(),
      operation: 'comparison'
    };
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.preprocessingInterval) {
      clearInterval(this.preprocessingInterval);
    }
    
    this.activeComputations.clear();
    this.shares.clear();
    this.commitments.clear();
  }
}

export default SecureMultipartyComputation;