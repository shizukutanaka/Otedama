// Tests for type guards
// Following the principle: "Test behavior, not implementation"

import {
  isMiner,
  isShare,
  isPayment,
  isBlock,
  isArray,
  isNotNull,
  isDefined,
  isPresent,
  isString,
  isNumber,
  isBoolean,
  isObject,
  isFunction,
  isPromise,
  isError,
  assertDefined,
  assert,
  Result,
  ok,
  err,
  isOk,
  isErr,
  unwrapOr,
  mapResult,
  tryAsync,
  toBitcoinAddress,
  toTransactionId,
} from '../guards';
import { createMockMiner, createMockShare, createMockBlock } from '../../test/test-utils';

describe('Type Guards', () => {
  describe('Domain type guards', () => {
    test('isMiner should correctly identify miner objects', () => {
      const miner = createMockMiner();
      expect(isMiner(miner)).toBe(true);
      expect(isMiner({ id: '123' })).toBe(false);
      expect(isMiner({ id: '123', address: 123 })).toBe(false);
      expect(isMiner(null)).toBe(false);
      expect(isMiner(undefined)).toBe(false);
    });

    test('isShare should correctly identify share objects', () => {
      const share = createMockShare();
      expect(isShare(share)).toBe(true);
      expect(isShare({ id: '123' })).toBe(false);
      expect(isShare(null)).toBe(false);
    });

    test('isPayment should correctly identify payment objects', () => {
      const payment = { id: '123', address: '1ABC...', amount: 0.001 };
      expect(isPayment(payment)).toBe(true);
      expect(isPayment({ id: '123', amount: '0.001' })).toBe(false);
    });

    test('isBlock should correctly identify block objects', () => {
      const block = createMockBlock();
      expect(isBlock(block)).toBe(true);
      expect(isBlock({ height: '700000' })).toBe(false);
    });
  });

  describe('Basic type guards', () => {
    test('isArray should correctly identify arrays', () => {
      expect(isArray([1, 2, 3], isNumber)).toBe(true);
      expect(isArray(['a', 'b'], isString)).toBe(true);
      expect(isArray([1, 'a'], isNumber)).toBe(false);
      expect(isArray('not array', isString)).toBe(false);
    });

    test('isNotNull should filter null values', () => {
      expect(isNotNull(null)).toBe(false);
      expect(isNotNull(undefined)).toBe(true);
      expect(isNotNull(0)).toBe(true);
      expect(isNotNull('')).toBe(true);
    });

    test('isDefined should filter undefined values', () => {
      expect(isDefined(undefined)).toBe(false);
      expect(isDefined(null)).toBe(true);
      expect(isDefined(0)).toBe(true);
      expect(isDefined(false)).toBe(true);
    });

    test('isPresent should filter null and undefined', () => {
      expect(isPresent(null)).toBe(false);
      expect(isPresent(undefined)).toBe(false);
      expect(isPresent(0)).toBe(true);
      expect(isPresent('')).toBe(true);
      expect(isPresent(false)).toBe(true);
    });

    test('isString should identify strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString('')).toBe(true);
      expect(isString(123)).toBe(false);
      expect(isString(null)).toBe(false);
    });

    test('isNumber should identify numbers', () => {
      expect(isNumber(123)).toBe(true);
      expect(isNumber(0)).toBe(true);
      expect(isNumber(-1.5)).toBe(true);
      expect(isNumber(NaN)).toBe(false);
      expect(isNumber('123')).toBe(false);
    });

    test('isBoolean should identify booleans', () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean('true')).toBe(false);
    });

    test('isObject should identify objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ a: 1 })).toBe(true);
      expect(isObject([])).toBe(false);
      expect(isObject(null)).toBe(false);
      expect(isObject('object')).toBe(false);
    });

    test('isFunction should identify functions', () => {
      expect(isFunction(() => {})).toBe(true);
      expect(isFunction(function() {})).toBe(true);
      expect(isFunction(async () => {})).toBe(true);
      expect(isFunction(class Test {})).toBe(true);
      expect(isFunction({})).toBe(false);
    });

    test('isPromise should identify promises', () => {
      expect(isPromise(Promise.resolve())).toBe(true);
      expect(isPromise(new Promise(() => {}))).toBe(true);
      expect(isPromise({ then: () => {}, catch: () => {} })).toBe(true);
      expect(isPromise({ then: 'not a function' })).toBe(false);
      expect(isPromise(null)).toBe(false);
    });

    test('isError should identify errors', () => {
      expect(isError(new Error())).toBe(true);
      expect(isError(new TypeError())).toBe(true);
      expect(isError({ message: 'error' })).toBe(false);
      expect(isError('error')).toBe(false);
    });
  });

  describe('Assertions', () => {
    test('assertDefined should throw for null/undefined', () => {
      expect(() => assertDefined(null)).toThrow();
      expect(() => assertDefined(undefined)).toThrow();
      expect(() => assertDefined(0)).not.toThrow();
      expect(() => assertDefined('')).not.toThrow();
      expect(() => assertDefined(null, 'Custom error')).toThrow('Custom error');
    });

    test('assert should throw for falsy conditions', () => {
      expect(() => assert(true)).not.toThrow();
      expect(() => assert(1)).not.toThrow();
      expect(() => assert(false)).toThrow();
      expect(() => assert(0)).toThrow();
      expect(() => assert(false, 'Custom message')).toThrow('Custom message');
    });
  });

  describe('Result type', () => {
    test('ok and err create correct results', () => {
      const success = ok(42);
      expect(isOk(success)).toBe(true);
      expect(isErr(success)).toBe(false);
      expect(success.value).toBe(42);

      const failure = err(new Error('Failed'));
      expect(isOk(failure)).toBe(false);
      expect(isErr(failure)).toBe(true);
      expect(failure.error.message).toBe('Failed');
    });

    test('unwrapOr provides default for errors', () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
      expect(unwrapOr(err(new Error()), 0)).toBe(0);
    });

    test('mapResult transforms success values', () => {
      const result = ok(21);
      const doubled = mapResult(result, x => x * 2);
      expect(isOk(doubled)).toBe(true);
      expect(doubled.value).toBe(42);

      const error = err<number>(new Error('Failed'));
      const mappedError = mapResult(error, x => x * 2);
      expect(isErr(mappedError)).toBe(true);
    });

    test('tryAsync catches errors', async () => {
      const success = await tryAsync(async () => 42);
      expect(isOk(success)).toBe(true);
      expect(success.value).toBe(42);

      const failure = await tryAsync(async () => {
        throw new Error('Async error');
      });
      expect(isErr(failure)).toBe(true);
      expect(failure.error.message).toBe('Async error');
    });
  });

  describe('Bitcoin types', () => {
    test('toBitcoinAddress validates addresses', () => {
      // Valid addresses
      expect(toBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBeTruthy();
      expect(toBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBeTruthy();
      expect(toBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBeTruthy();

      // Invalid addresses
      expect(toBitcoinAddress('invalid')).toBeNull();
      expect(toBitcoinAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f8b56d')).toBeNull();
      expect(toBitcoinAddress('')).toBeNull();
    });

    test('toTransactionId validates transaction IDs', () => {
      // Valid transaction IDs (64 hex chars)
      const validTxId = '0'.repeat(64);
      expect(toTransactionId(validTxId)).toBeTruthy();
      expect(toTransactionId('abcdef1234567890'.repeat(4))).toBeTruthy();

      // Invalid transaction IDs
      expect(toTransactionId('too-short')).toBeNull();
      expect(toTransactionId('not-hex-chars-zzz')).toBeNull();
      expect(toTransactionId('0'.repeat(63))).toBeNull(); // Too short
      expect(toTransactionId('0'.repeat(65))).toBeNull(); // Too long
    });
  });
});
