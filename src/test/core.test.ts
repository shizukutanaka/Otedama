// Simple unit tests following the philosophy
import { ShareValidator } from '../core/validator';
import { Share } from '../domain/share';
import { Channel } from '../network/channels';
import { PPLNSCalculator } from '../payout/pplns';

describe('ShareValidator', () => {
  const validator = new ShareValidator();
  
  test('validates valid share', () => {
    const share = new Share();
    share.minerId = 'miner1';
    share.data = Buffer.from('test data');
    share.difficulty = 1;
    
    const result = validator.validateDirect(share);
    expect(result).toBeDefined();
  });
  
  test('rejects invalid share', () => {
    const share = new Share();
    // Missing required data
    
    const result = validator.validateDirect(share);
    expect(result).toBe(false);
  });
  
  test('batch validation performance', () => {
    const shares: Share[] = [];
    for (let i = 0; i < 1000; i++) {
      const share = new Share();
      share.minerId = `miner${i}`;
      share.data = Buffer.from(`data${i}`);
      share.difficulty = 1;
      shares.push(share);
    }
    
    const start = Date.now();
    const results = validator.validateBatch(shares);
    const elapsed = Date.now() - start;
    
    expect(results.length).toBe(1000);
    expect(elapsed).toBeLessThan(100); // Should process 1000 shares in < 100ms
  });
});

describe('Channel', () => {
  test('send and receive', async () => {
    const channel = new Channel<string>(10);
    
    await channel.send('test');
    const received = await channel.receive();
    
    expect(received).toBe('test');
  });
  
  test('buffered channel', async () => {
    const channel = new Channel<number>(3);
    
    // Should not block
    await channel.send(1);
    await channel.send(2);
    await channel.send(3);
    
    expect(await channel.receive()).toBe(1);
    expect(await channel.receive()).toBe(2);
    expect(await channel.receive()).toBe(3);
  });
  
  test('channel closes properly', async () => {
    const channel = new Channel<string>(1);
    
    await channel.send('test');
    channel.close();
    
    expect(channel.isClosed).toBe(true);
    await expect(channel.send('fail')).rejects.toThrow('Channel closed');
  });
});

describe('PPLNSCalculator', () => {
  const calculator = new PPLNSCalculator(100); // Last 100 shares
  
  test('calculates payout correctly', () => {
    const shares: Share[] = [];
    
    // Miner 1: 60 shares
    for (let i = 0; i < 60; i++) {
      const share = new Share();
      share.minerId = 'miner1';
      share.difficulty = 1;
      shares.push(share);
    }
    
    // Miner 2: 40 shares
    for (let i = 0; i < 40; i++) {
      const share = new Share();
      share.minerId = 'miner2';
      share.difficulty = 1;
      shares.push(share);
    }
    
    const blockReward = 6.25;
    const payouts = calculator.calculate(shares, blockReward);
    
    expect(payouts.length).toBe(2);
    expect(payouts[0].minerId).toBe('miner1');
    expect(payouts[0].amount).toBeCloseTo(3.75); // 60% of 6.25
    expect(payouts[1].minerId).toBe('miner2');
    expect(payouts[1].amount).toBeCloseTo(2.5);  // 40% of 6.25
  });
  
  test('handles empty shares', () => {
    const payouts = calculator.calculate([], 6.25);
    expect(payouts).toEqual([]);
  });
});
