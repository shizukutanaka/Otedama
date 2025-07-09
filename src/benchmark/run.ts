// Performance benchmarks following Carmack's "measure first" principle
import { ShareValidator } from '../core/validator';
import { Share } from '../domain/share';
import { Channel } from '../network/channels';
import { MinerRegistry } from '../domain/miner';

interface BenchmarkResult {
  name: string;
  ops: number; // Operations per second
  avgTime: number; // Average time per operation in ms
  totalTime: number; // Total time in ms
}

class Benchmark {
  static async run(name: string, iterations: number, fn: () => Promise<void>): Promise<BenchmarkResult> {
    // Warmup
    for (let i = 0; i < Math.min(100, iterations / 10); i++) {
      await fn();
    }
    
    // Actual benchmark
    const start = process.hrtime.bigint();
    
    for (let i = 0; i < iterations; i++) {
      await fn();
    }
    
    const end = process.hrtime.bigint();
    const totalTime = Number(end - start) / 1_000_000; // Convert to ms
    const avgTime = totalTime / iterations;
    const ops = 1000 / avgTime;
    
    return { name, ops, avgTime, totalTime };
  }
  
  static async runSync(name: string, iterations: number, fn: () => void): Promise<BenchmarkResult> {
    // Warmup
    for (let i = 0; i < Math.min(100, iterations / 10); i++) {
      fn();
    }
    
    // Actual benchmark
    const start = process.hrtime.bigint();
    
    for (let i = 0; i < iterations; i++) {
      fn();
    }
    
    const end = process.hrtime.bigint();
    const totalTime = Number(end - start) / 1_000_000; // Convert to ms
    const avgTime = totalTime / iterations;
    const ops = 1000 / avgTime;
    
    return { name, ops, avgTime, totalTime };
  }
}

async function runBenchmarks() {
  console.log('Otedama Light - Performance Benchmarks');
  console.log('=====================================\n');
  
  const results: BenchmarkResult[] = [];
  
  // Share validation benchmark
  const validator = new ShareValidator();
  const share = new Share();
  share.minerId = 'benchmark';
  share.data = Buffer.from('benchmark data for testing performance');
  share.difficulty = 10;
  
  results.push(await Benchmark.runSync('Share Validation', 100000, () => {
    validator.validateDirect(share);
  }));
  
  // Channel throughput benchmark
  const channel = new Channel<number>(1000);
  let receiveCount = 0;
  
  // Start receiver
  const receiverPromise = (async () => {
    while (receiveCount < 10000) {
      await channel.receive();
      receiveCount++;
    }
  })();
  
  results.push(await Benchmark.run('Channel Send/Receive', 10000, async () => {
    await channel.send(1);
  }));
  
  await receiverPromise;
  
  // Miner registry benchmark
  const registry = new MinerRegistry();
  
  // Pre-populate registry
  for (let i = 0; i < 1000; i++) {
    registry.register({
      id: `miner${i}`,
      address: `address${i}`,
      workerName: 'worker',
      shares: 0,
      lastShareTime: Date.now(),
      difficulty: 1,
      hashrate: 0,
      submitShare: () => {},
      calculateHashrate: () => 0,
      isActive: () => true
    });
  }
  
  results.push(await Benchmark.runSync('Miner Lookup', 100000, () => {
    registry.get('miner500');
  }));
  
  results.push(await Benchmark.runSync('Active Miner Query', 1000, () => {
    registry.getActive(300);
  }));
  
  // Batch validation benchmark
  const shares: Share[] = [];
  for (let i = 0; i < 1000; i++) {
    const s = new Share();
    s.minerId = `miner${i}`;
    s.data = Buffer.from(`data${i}`);
    s.difficulty = 1;
    shares.push(s);
  }
  
  results.push(await Benchmark.runSync('Batch Validation (1000 shares)', 100, () => {
    validator.validateBatch(shares);
  }));
  
  // Print results
  console.log('Results:');
  console.log('--------');
  for (const result of results) {
    console.log(`${result.name}:`);
    console.log(`  Operations/sec: ${result.ops.toFixed(0)}`);
    console.log(`  Avg time/op: ${result.avgTime.toFixed(3)}ms`);
    console.log(`  Total time: ${result.totalTime.toFixed(0)}ms`);
    console.log('');
  }
  
  // Performance assertions
  console.log('\nPerformance Targets:');
  console.log('-------------------');
  const validationResult = results.find(r => r.name === 'Share Validation');
  console.log(`✓ Share validation < 0.1ms: ${validationResult!.avgTime < 0.1 ? 'PASS' : 'FAIL'}`);
  
  const channelResult = results.find(r => r.name === 'Channel Send/Receive');
  console.log(`✓ Channel throughput > 10k ops/sec: ${channelResult!.ops > 10000 ? 'PASS' : 'FAIL'}`);
  
  const batchResult = results.find(r => r.name === 'Batch Validation (1000 shares)');
  console.log(`✓ Batch validation < 100ms/1000 shares: ${batchResult!.avgTime < 100 ? 'PASS' : 'FAIL'}`);
}

// Run benchmarks
if (require.main === module) {
  runBenchmarks().catch(console.error);
}

export { Benchmark, runBenchmarks };
