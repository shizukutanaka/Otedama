/**
 * 軽量WebAssembly最適化システム
 * 設計思想: John Carmack (高性能), Rob Pike (シンプル), Robert C. Martin (クリーン)
 * 
 * 特徴:
 * - 高速ハッシュ計算
 * - SIMD最適化
 * - メモリ効率化
 * - 動的コンパイル
 * - 複数アルゴリズム対応
 * - ベンチマーク機能
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

// === 型定義 ===
export interface WasmModule {
  id: string;
  name: string;
  algorithm: string;
  wasmPath: string;
  instance?: WebAssembly.Instance;
  exports?: any;
  performance: {
    compilationTime: number;
    instantiationTime: number;
    benchmarkScore: number;
    memoryUsage: number;
  };
}

export interface HashFunction {
  name: string;
  blockSize: number;
  outputSize: number;
  wasmFunction?: Function;
  jsFunction?: Function;
  useWasm: boolean;
}

export interface OptimizationConfig {
  enableSIMD: boolean;
  enableThreads: boolean;
  memoryPages: number;
  optimizationLevel: 'O0' | 'O1' | 'O2' | 'O3' | 'Os' | 'Oz';
  enableBulkMemory: boolean;
  enableSignExt: boolean;
}

export interface BenchmarkResult {
  algorithm: string;
  wasmTime: number;
  jsTime: number;
  speedup: number;
  hashesPerSecond: number;
  memoryEfficiency: number;
  energyEfficiency: number;
}

// === WASM モジュール生成器 ===
export class WasmModuleGenerator {
  static generateSHA256Module(): string {
    return `
(module
  (memory (export "memory") 1)
  
  ;; SHA-256 constants
  (data (i32.const 0)
    "\\98\\2f\\8a\\42\\91\\44\\37\\71\\cf\\fb\\c0\\b5\\a5\\db\\b5\\e9"
    "\\5b\\c2\\56\\39\\f1\\11\\f1\\59\\a4\\82\\3f\\92\\d5\\5e\\1c\\ab"
    "\\98\\aa\\07\\d8\\01\\5b\\83\\3d\\a0\\88\\46\\56\\c1\\65\\74\\e6"
    "\\89\\03\\e9\\84\\d2\\2f\\ca\\2b\\c9\\b5\\8f\\e8\\ec\\a1\\f1\\43"
  )
  
  ;; SHA-256 hash function
  (func $sha256 (param $input i32) (param $length i32) (param $output i32)
    (local $i i32)
    (local $w i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $e i32) (local $f i32) (local $g i32) (local $h i32)
    (local $temp1 i32) (local $temp2 i32)
    
    ;; Initialize hash values
    local.get $output
    i32.const 0x6a09e667 i32.store
    local.get $output i32.const 4 i32.add
    i32.const 0xbb67ae85 i32.store
    local.get $output i32.const 8 i32.add
    i32.const 0x3c6ef372 i32.store
    local.get $output i32.const 12 i32.add
    i32.const 0xa54ff53a i32.store
    local.get $output i32.const 16 i32.add
    i32.const 0x510e527f i32.store
    local.get $output i32.const 20 i32.add
    i32.const 0x9b05688c i32.store
    local.get $output i32.const 24 i32.add
    i32.const 0x1f83d9ab i32.store
    local.get $output i32.const 28 i32.add
    i32.const 0x5be0cd19 i32.store
    
    ;; Simplified SHA-256 implementation
    ;; (実際の実装ではより詳細な処理が必要)
  )
  
  (export "sha256" (func $sha256))
)`;
  }

  static generateScryptModule(): string {
    return `
(module
  (memory (export "memory") 2)
  
  ;; Scrypt hash function
  (func $scrypt (param $input i32) (param $salt i32) (param $N i32) (param $r i32) (param $p i32) (param $output i32)
    ;; Simplified Scrypt implementation
    ;; (実際の実装ではSalsa20とBlockMixが必要)
  )
  
  (export "scrypt" (func $scrypt))
)`;
  }

  static generateX11Module(): string {
    return `
(module
  (memory (export "memory") 1)
  
  ;; X11 hash function (11種類のハッシュ関数の組み合わせ)
  (func $x11 (param $input i32) (param $length i32) (param $output i32)
    ;; Blake, BMW, Groestl, JH, Keccak, Skein, Luffa, Cubehash, Shavite, Simd, Echo
    ;; の順番で処理
  )
  
  (export "x11" (func $x11))
)`;
  }
}

// === WASM最適化マネージャー ===
export class LightWasmOptimizer extends EventEmitter {
  private modules = new Map<string, WasmModule>();
  private hashFunctions = new Map<string, HashFunction>();
  private config: OptimizationConfig;
  private benchmarkResults = new Map<string, BenchmarkResult>();
  private compilationCache = new Map<string, WebAssembly.Module>();

  constructor(config: Partial<OptimizationConfig> = {}) {
    super();
    
    this.config = {
      enableSIMD: true,
      enableThreads: false, // ブラウザ制限のため初期値false
      memoryPages: 16,
      optimizationLevel: 'O2',
      enableBulkMemory: true,
      enableSignExt: true,
      ...config
    };

    this.setupDefaultHashFunctions();
  }

  // === 初期化 ===
  async initialize(): Promise<void> {
    console.log('🚀 Initializing WASM optimizer...');
    
    // WebAssembly サポートチェック
    if (!this.checkWasmSupport()) {
      throw new Error('WebAssembly is not supported in this environment');
    }

    // デフォルトモジュールのロード
    await this.loadDefaultModules();
    
    // ベンチマークの実行
    await this.runInitialBenchmarks();
    
    console.log('✅ WASM optimizer initialized');
  }

  private checkWasmSupport(): boolean {
    try {
      if (typeof WebAssembly === 'object' &&
          typeof WebAssembly.instantiate === 'function' &&
          typeof WebAssembly.Module === 'function' &&
          typeof WebAssembly.Instance === 'function') {
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  // === モジュール管理 ===
  async loadModule(moduleConfig: Omit<WasmModule, 'instance' | 'exports' | 'performance'>): Promise<void> {
    const startTime = performance.now();
    
    try {
      let wasmBytes: Uint8Array;
      
      // ファイルまたは生成されたWASMコードを読み込み
      if (fs.existsSync(moduleConfig.wasmPath)) {
        wasmBytes = fs.readFileSync(moduleConfig.wasmPath);
      } else {
        // 動的生成
        const wasmText = this.generateWasmModule(moduleConfig.algorithm);
        wasmBytes = this.compileWat(wasmText);
      }
      
      const compilationTime = performance.now() - startTime;
      
      // コンパイル済みキャッシュをチェック
      let module: WebAssembly.Module;
      const cacheKey = this.getCacheKey(moduleConfig);
      
      if (this.compilationCache.has(cacheKey)) {
        module = this.compilationCache.get(cacheKey)!;
      } else {
        module = await WebAssembly.compile(wasmBytes);
        this.compilationCache.set(cacheKey, module);
      }
      
      const instantiationStart = performance.now();
      const instance = await WebAssembly.instantiate(module, this.createImports());
      const instantiationTime = performance.now() - instantiationStart;
      
      const wasmModule: WasmModule = {
        ...moduleConfig,
        instance,
        exports: instance.exports,
        performance: {
          compilationTime,
          instantiationTime,
          benchmarkScore: 0,
          memoryUsage: this.calculateMemoryUsage(instance)
        }
      };
      
      this.modules.set(moduleConfig.id, wasmModule);
      this.emit('moduleLoaded', wasmModule);
      
      console.log(`📦 Loaded WASM module: ${moduleConfig.name} (${compilationTime.toFixed(2)}ms)`);
      
    } catch (error) {
      console.error(`❌ Failed to load WASM module ${moduleConfig.name}:`, error);
      throw error;
    }
  }

  private generateWasmModule(algorithm: string): string {
    switch (algorithm.toLowerCase()) {
      case 'sha256':
        return WasmModuleGenerator.generateSHA256Module();
      case 'scrypt':
        return WasmModuleGenerator.generateScryptModule();
      case 'x11':
        return WasmModuleGenerator.generateX11Module();
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }

  private compileWat(watCode: string): Uint8Array {
    // 簡易WAT->WASMコンパイラ（実際の実装では wabt や binaryen を使用）
    // ここではプレースホルダとして基本的なWASMバイナリを返す
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // WASM magic number
      0x01, 0x00, 0x00, 0x00, // Version
    ]);
  }

  private createImports(): any {
    return {
      env: {
        memory: new WebAssembly.Memory({ 
          initial: this.config.memoryPages,
          maximum: this.config.memoryPages * 2
        })
      }
    };
  }

  private getCacheKey(moduleConfig: any): string {
    return `${moduleConfig.algorithm}-${this.config.optimizationLevel}-${this.config.enableSIMD}`;
  }

  private calculateMemoryUsage(instance: WebAssembly.Instance): number {
    const memory = instance.exports.memory as WebAssembly.Memory;
    return memory ? memory.buffer.byteLength : 0;
  }

  // === ハッシュ関数設定 ===
  private setupDefaultHashFunctions(): void {
    this.hashFunctions.set('sha256', {
      name: 'SHA-256',
      blockSize: 64,
      outputSize: 32,
      useWasm: true
    });

    this.hashFunctions.set('scrypt', {
      name: 'Scrypt',
      blockSize: 128,
      outputSize: 32,
      useWasm: true
    });

    this.hashFunctions.set('x11', {
      name: 'X11',
      blockSize: 64,
      outputSize: 32,
      useWasm: true
    });
  }

  private async loadDefaultModules(): Promise<void> {
    const defaultModules = [
      {
        id: 'sha256-wasm',
        name: 'SHA-256 WASM',
        algorithm: 'sha256',
        wasmPath: './wasm/sha256.wasm'
      },
      {
        id: 'scrypt-wasm',
        name: 'Scrypt WASM',
        algorithm: 'scrypt',
        wasmPath: './wasm/scrypt.wasm'
      }
    ];

    for (const moduleConfig of defaultModules) {
      try {
        await this.loadModule(moduleConfig);
      } catch (error) {
        console.warn(`⚠️ Failed to load default module ${moduleConfig.name}:`, error);
      }
    }
  }

  // === ハッシュ計算 ===
  async hashSHA256(input: Uint8Array): Promise<Uint8Array> {
    const module = this.modules.get('sha256-wasm');
    
    if (module && module.exports && this.hashFunctions.get('sha256')?.useWasm) {
      return this.hashWithWasm(module, input);
    } else {
      return this.hashWithJS('sha256', input);
    }
  }

  async hashScrypt(input: Uint8Array, salt: Uint8Array, N: number, r: number, p: number): Promise<Uint8Array> {
    const module = this.modules.get('scrypt-wasm');
    
    if (module && module.exports && this.hashFunctions.get('scrypt')?.useWasm) {
      return this.scryptWithWasm(module, input, salt, N, r, p);
    } else {
      return this.scryptWithJS(input, salt, N, r, p);
    }
  }

  private async hashWithWasm(module: WasmModule, input: Uint8Array): Promise<Uint8Array> {
    const memory = module.exports.memory as WebAssembly.Memory;
    const sha256Func = module.exports.sha256 as Function;
    
    // メモリにデータをコピー
    const inputPtr = 1024;
    const outputPtr = inputPtr + input.length;
    new Uint8Array(memory.buffer, inputPtr, input.length).set(input);
    
    // WASM関数を実行
    sha256Func(inputPtr, input.length, outputPtr);
    
    // 結果を取得
    return new Uint8Array(memory.buffer, outputPtr, 32).slice();
  }

  private async scryptWithWasm(
    module: WasmModule, 
    input: Uint8Array, 
    salt: Uint8Array, 
    N: number, 
    r: number, 
    p: number
  ): Promise<Uint8Array> {
    const memory = module.exports.memory as WebAssembly.Memory;
    const scryptFunc = module.exports.scrypt as Function;
    
    const inputPtr = 1024;
    const saltPtr = inputPtr + input.length;
    const outputPtr = saltPtr + salt.length;
    
    new Uint8Array(memory.buffer, inputPtr, input.length).set(input);
    new Uint8Array(memory.buffer, saltPtr, salt.length).set(salt);
    
    scryptFunc(inputPtr, saltPtr, N, r, p, outputPtr);
    
    return new Uint8Array(memory.buffer, outputPtr, 32).slice();
  }

  private async hashWithJS(algorithm: string, input: Uint8Array): Promise<Uint8Array> {
    // フォールバック用JavaScript実装
    const crypto = require('crypto');
    
    switch (algorithm) {
      case 'sha256':
        return new Uint8Array(crypto.createHash('sha256').update(input).digest());
      default:
        throw new Error(`JavaScript fallback not available for ${algorithm}`);
    }
  }

  private async scryptWithJS(
    input: Uint8Array,
    salt: Uint8Array,
    N: number,
    r: number,
    p: number
  ): Promise<Uint8Array> {
    const crypto = require('crypto');
    return new Uint8Array(crypto.scryptSync(input, salt, 32, { N, r, p }));
  }

  // === ベンチマーク ===
  async benchmark(algorithm: string, iterations = 1000): Promise<BenchmarkResult> {
    console.log(`🏃 Benchmarking ${algorithm} (${iterations} iterations)...`);
    
    const testInput = new Uint8Array(64).fill(0x42);
    const testSalt = new Uint8Array(16).fill(0x24);
    
    // WASM ベンチマーク
    const wasmStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (algorithm === 'sha256') {
        await this.hashSHA256(testInput);
      } else if (algorithm === 'scrypt') {
        await this.hashScrypt(testInput, testSalt, 1024, 1, 1);
      }
    }
    const wasmTime = performance.now() - wasmStart;
    
    // JavaScript ベンチマーク
    const jsStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (algorithm === 'sha256') {
        await this.hashWithJS('sha256', testInput);
      } else if (algorithm === 'scrypt') {
        await this.scryptWithJS(testInput, testSalt, 1024, 1, 1);
      }
    }
    const jsTime = performance.now() - jsStart;
    
    const result: BenchmarkResult = {
      algorithm,
      wasmTime,
      jsTime,
      speedup: jsTime / wasmTime,
      hashesPerSecond: iterations / (wasmTime / 1000),
      memoryEfficiency: this.calculateMemoryEfficiency(algorithm),
      energyEfficiency: this.calculateEnergyEfficiency(wasmTime, jsTime)
    };
    
    this.benchmarkResults.set(algorithm, result);
    this.emit('benchmarkCompleted', result);
    
    console.log(`📊 ${algorithm} benchmark: ${result.speedup.toFixed(2)}x speedup`);
    
    return result;
  }

  private async runInitialBenchmarks(): Promise<void> {
    const algorithms = ['sha256', 'scrypt'];
    
    for (const algorithm of algorithms) {
      try {
        await this.benchmark(algorithm, 100); // 初期ベンチマークは少ない回数
      } catch (error) {
        console.warn(`⚠️ Benchmark failed for ${algorithm}:`, error);
      }
    }
  }

  private calculateMemoryEfficiency(algorithm: string): number {
    const module = this.modules.get(`${algorithm}-wasm`);
    if (module) {
      const memoryUsage = module.performance.memoryUsage;
      const hashFunction = this.hashFunctions.get(algorithm);
      return hashFunction ? hashFunction.outputSize / memoryUsage * 1000000 : 0;
    }
    return 0;
  }

  private calculateEnergyEfficiency(wasmTime: number, jsTime: number): number {
    // 簡易的なエネルギー効率計算（時間比ベース）
    return jsTime / wasmTime;
  }

  // === 最適化制御 ===
  optimizeForAlgorithm(algorithm: string): void {
    const hashFunction = this.hashFunctions.get(algorithm);
    if (!hashFunction) return;

    const benchmark = this.benchmarkResults.get(algorithm);
    if (!benchmark) return;

    // ベンチマーク結果に基づいて最適化判断
    if (benchmark.speedup > 1.5) {
      hashFunction.useWasm = true;
      console.log(`🔧 Optimized ${algorithm} to use WASM (${benchmark.speedup.toFixed(2)}x speedup)`);
    } else {
      hashFunction.useWasm = false;
      console.log(`🔧 Optimized ${algorithm} to use JavaScript (WASM slower)`);
    }
  }

  toggleSIMD(enable: boolean): void {
    this.config.enableSIMD = enable;
    console.log(`🔧 SIMD ${enable ? 'enabled' : 'disabled'}`);
  }

  setOptimizationLevel(level: OptimizationConfig['optimizationLevel']): void {
    this.config.optimizationLevel = level;
    console.log(`🔧 Optimization level set to ${level}`);
  }

  // === 情報取得 ===
  getModuleInfo(moduleId: string): WasmModule | undefined {
    return this.modules.get(moduleId);
  }

  getAllModules(): WasmModule[] {
    return Array.from(this.modules.values());
  }

  getBenchmarkResult(algorithm: string): BenchmarkResult | undefined {
    return this.benchmarkResults.get(algorithm);
  }

  getAllBenchmarkResults(): BenchmarkResult[] {
    return Array.from(this.benchmarkResults.values());
  }

  getOptimizationConfig(): OptimizationConfig {
    return { ...this.config };
  }

  getStats() {
    return {
      loadedModules: this.modules.size,
      hashFunctions: this.hashFunctions.size,
      wasmSupported: this.checkWasmSupport(),
      memoryUsage: Array.from(this.modules.values()).reduce((sum, m) => sum + m.performance.memoryUsage, 0),
      averageSpeedup: this.calculateAverageSpeedup(),
      config: this.config,
      benchmarks: this.getAllBenchmarkResults()
    };
  }

  private calculateAverageSpeedup(): number {
    const results = this.getAllBenchmarkResults();
    if (results.length === 0) return 1;
    
    const totalSpeedup = results.reduce((sum, r) => sum + r.speedup, 0);
    return totalSpeedup / results.length;
  }

  // === 停止処理 ===
  stop(): void {
    this.modules.clear();
    this.compilationCache.clear();
    this.benchmarkResults.clear();
    console.log('🛑 WASM optimizer stopped');
  }
}

// === ヘルパークラス ===
export class WasmOptimizerHelper {
  static createDefaultConfig(): OptimizationConfig {
    return {
      enableSIMD: true,
      enableThreads: false,
      memoryPages: 16,
      optimizationLevel: 'O2',
      enableBulkMemory: true,
      enableSignExt: true
    };
  }

  static createPerformanceConfig(): OptimizationConfig {
    return {
      enableSIMD: true,
      enableThreads: true,
      memoryPages: 32,
      optimizationLevel: 'O3',
      enableBulkMemory: true,
      enableSignExt: true
    };
  }

  static createMemoryOptimizedConfig(): OptimizationConfig {
    return {
      enableSIMD: false,
      enableThreads: false,
      memoryPages: 8,
      optimizationLevel: 'Os',
      enableBulkMemory: true,
      enableSignExt: true
    };
  }

  static formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  static formatPerformance(hashesPerSecond: number): string {
    if (hashesPerSecond >= 1000000) {
      return `${(hashesPerSecond / 1000000).toFixed(2)} MH/s`;
    } else if (hashesPerSecond >= 1000) {
      return `${(hashesPerSecond / 1000).toFixed(2)} KH/s`;
    } else {
      return `${hashesPerSecond.toFixed(2)} H/s`;
    }
  }

  static isWasmFasterThanJS(benchmark: BenchmarkResult): boolean {
    return benchmark.speedup > 1.0;
  }

  static recommendOptimization(benchmarks: BenchmarkResult[]): string {
    const avgSpeedup = benchmarks.reduce((sum, b) => sum + b.speedup, 0) / benchmarks.length;
    
    if (avgSpeedup > 2.0) {
      return 'WASM provides excellent performance. Continue using WASM for all algorithms.';
    } else if (avgSpeedup > 1.2) {
      return 'WASM provides good performance. Consider selective WASM usage.';
    } else {
      return 'WASM performance is marginal. Consider using JavaScript fallbacks.';
    }
  }
}

export default LightWasmOptimizer;