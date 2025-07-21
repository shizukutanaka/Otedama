/**
 * Example Test Suite
 * Demonstrates testing framework usage
 */

import { describe, it } from '../lib/testing/test-framework.js';
import { mock, spy, createTestData, createPerformanceTester } from '../lib/testing/test-utils.js';

/**
 * Unit tests example
 */
export default describe('Example Test Suite', function() {
  const testData = createTestData();
  
  this.describe('Math Operations', function() {
    this.it('should add numbers correctly', ({ expect }) => {
      expect(2 + 2).toBe(4);
      expect(0.1 + 0.2).toBeGreaterThan(0.3 - 0.01);
      expect(0.1 + 0.2).toBeLessThan(0.3 + 0.01);
    });
    
    this.it('should multiply numbers', ({ expect }) => {
      expect(3 * 4).toBe(12);
      expect(-5 * 6).toBe(-30);
    });
  });
  
  this.describe('String Operations', function() {
    this.it('should concatenate strings', ({ expect }) => {
      expect('Hello' + ' ' + 'World').toBe('Hello World');
      expect('foo'.concat('bar')).toBe('foobar');
    });
    
    this.it('should check string contents', ({ expect }) => {
      const str = 'The quick brown fox';
      expect(str).toContain('quick');
      expect(str).not.toContain('slow');
      expect(str).toMatch(/quick.*fox/);
    });
  });
  
  this.describe('Array Operations', function() {
    let array;
    
    this.beforeEach(() => {
      array = [1, 2, 3, 4, 5];
    });
    
    this.it('should have correct length', ({ expect }) => {
      expect(array).toHaveLength(5);
      array.push(6);
      expect(array).toHaveLength(6);
    });
    
    this.it('should contain elements', ({ expect }) => {
      expect(array).toContain(3);
      expect(array).not.toContain(10);
    });
    
    this.it('should filter elements', ({ expect }) => {
      const evens = array.filter(n => n % 2 === 0);
      expect(evens).toEqual([2, 4]);
    });
  });
  
  this.describe('Mock Functions', function() {
    this.it('should track function calls', ({ expect }) => {
      const mockFn = mock();
      
      mockFn('arg1', 'arg2');
      mockFn(42);
      
      expect(mockFn.mock.callCount).toBe(2);
      expect(mockFn.mock.called).toBe(true);
      expect(mockFn.mock.calledWith('arg1', 'arg2')).toBe(true);
      expect(mockFn.mock.lastCall().args).toEqual([42]);
    });
    
    this.it('should mock return values', ({ expect }) => {
      const mockFn = mock()
        .mockReturnValue('default')
        .mockReturnValueOnce('first')
        .mockReturnValueOnce('second');
      
      expect(mockFn()).toBe('first');
      expect(mockFn()).toBe('second');
      expect(mockFn()).toBe('default');
      expect(mockFn()).toBe('default');
    });
    
    this.it('should mock implementations', ({ expect }) => {
      const mockFn = mock()
        .mockImplementation((x, y) => x + y);
      
      expect(mockFn(2, 3)).toBe(5);
      expect(mockFn(10, 20)).toBe(30);
    });
  });
  
  this.describe('Async Operations', function() {
    this.it('should handle promises', async ({ expect }) => {
      const promise = Promise.resolve('success');
      const result = await promise;
      
      expect(result).toBe('success');
    });
    
    this.it('should handle async errors', async ({ expect }) => {
      const asyncFn = async () => {
        throw new Error('Async error');
      };
      
      await expect(asyncFn).toThrow(Error);
    });
    
    this.it('should mock async functions', async ({ expect }) => {
      const asyncMock = mock()
        .mockResolvedValue('async result')
        .mockRejectedValueOnce(new Error('First call fails'));
      
      await expect(asyncMock).toThrow();
      expect(await asyncMock()).toBe('async result');
    });
  });
  
  this.describe('Test Data Generation', function() {
    this.it('should generate random data', ({ expect }) => {
      const str = testData.string(10);
      expect(str).toHaveLength(10);
      expect(typeof str).toBe('string');
      
      const num = testData.number(1, 100);
      expect(num).toBeGreaterThan(0);
      expect(num).toBeLessThan(101);
      
      const email = testData.email();
      expect(email).toMatch(/@.*\.com$/);
    });
    
    this.it('should generate objects', ({ expect }) => {
      const user = testData.object({
        id: () => testData.uuid(),
        name: () => testData.string(10),
        age: () => testData.number(18, 65),
        email: () => testData.email()
      });
      
      expect(user.id).toMatch(/^[0-9a-f-]+$/);
      expect(user.name).toHaveLength(10);
      expect(user.age).toBeGreaterThan(17);
      expect(user.age).toBeLessThan(66);
      expect(user.email).toContain('@');
    });
  });
  
  this.describe('Performance Testing', function() {
    const perfTester = createPerformanceTester({
      warmupRuns: 5,
      testRuns: 50
    });
    
    this.it('should measure performance', async ({ expect }) => {
      const result = await perfTester.benchmark('Array operations', async () => {
        const arr = Array(1000).fill(0).map((_, i) => i);
        return arr.filter(n => n % 2 === 0).reduce((a, b) => a + b, 0);
      });
      
      expect(result.runs).toBe(50);
      expect(result.mean).toBeGreaterThan(0);
      expect(result.ops).toBeGreaterThan(0);
    });
    
    this.it('should compare implementations', async ({ expect }) => {
      const results = await perfTester.compare({
        'Array.includes': async () => {
          const arr = Array(100).fill(0).map((_, i) => i);
          return arr.includes(50);
        },
        'Array.indexOf': async () => {
          const arr = Array(100).fill(0).map((_, i) => i);
          return arr.indexOf(50) !== -1;
        },
        'Array.find': async () => {
          const arr = Array(100).fill(0).map((_, i) => i);
          return arr.find(n => n === 50) !== undefined;
        }
      });
      
      expect(results).toHaveLength(3);
      expect(results[0].relative).toBe(1); // Fastest is baseline
    });
  });
  
  this.describe('Error Handling', function() {
    this.it('should catch and validate errors', ({ expect }) => {
      const throwError = () => {
        throw new Error('Test error');
      };
      
      expect(throwError).toThrow();
      expect(throwError).toThrow(Error);
    });
    
    this.it('should handle assertion errors', ({ expect, assert }) => {
      assert(true, 'This should pass');
      
      expect(() => {
        assert(false, 'This should fail');
      }).toThrow('This should fail');
    });
  });
  
  // Example of skipping tests
  this.skip('should skip this test', ({ expect }) => {
    expect(true).toBe(false); // This won't run
  });
  
  // Example of focusing on specific tests
  // this.only('should only run this test', ({ expect }) => {
  //   expect(true).toBe(true);
  // });
});