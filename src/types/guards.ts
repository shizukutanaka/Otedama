// Type guards and type utilities for strict type checking
// Following the principle: "Make invalid states unrepresentable"

import { 
  IMiner, 
  IShare, 
  IPayment, 
  IBlock,
  IJob,
  IPoolStats,
  IAlert,
  IHealthStatus
} from '../interfaces';

/**
 * Type guard for IMiner
 */
export function isMiner(obj: unknown): obj is IMiner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'address' in obj &&
    typeof (obj as any).id === 'string' &&
    typeof (obj as any).address === 'string'
  );
}

/**
 * Type guard for IShare
 */
export function isShare(obj: unknown): obj is IShare {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'minerId' in obj &&
    'jobId' in obj &&
    typeof (obj as any).id === 'string' &&
    typeof (obj as any).minerId === 'string' &&
    typeof (obj as any).jobId === 'string'
  );
}

/**
 * Type guard for IPayment
 */
export function isPayment(obj: unknown): obj is IPayment {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'address' in obj &&
    'amount' in obj &&
    typeof (obj as any).id === 'string' &&
    typeof (obj as any).address === 'string' &&
    typeof (obj as any).amount === 'number'
  );
}

/**
 * Type guard for IBlock
 */
export function isBlock(obj: unknown): obj is IBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'height' in obj &&
    'hash' in obj &&
    typeof (obj as any).height === 'number' &&
    typeof (obj as any).hash === 'string'
  );
}

/**
 * Type guard for IJob
 */
export function isJob(obj: unknown): obj is IJob {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'prevHash' in obj &&
    typeof (obj as any).id === 'string' &&
    typeof (obj as any).prevHash === 'string'
  );
}

/**
 * Type guard for array
 */
export function isArray<T>(
  value: unknown,
  itemGuard: (item: unknown) => item is T
): value is T[] {
  return Array.isArray(value) && value.every(itemGuard);
}

/**
 * Type guard for non-null value
 */
export function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Type guard for non-undefined value
 */
export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Type guard for non-null and non-undefined value
 */
export function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Type guard for string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard for number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Type guard for boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Type guard for object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard for function
 */
export function isFunction(value: unknown): value is Function {
  return typeof value === 'function';
}

/**
 * Type guard for promise
 */
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return (
    isObject(value) &&
    'then' in value &&
    isFunction((value as any).then) &&
    'catch' in value &&
    isFunction((value as any).catch)
  );
}

/**
 * Type guard for error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Assert that a value is defined (throws if not)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string = 'Value is null or undefined'
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

/**
 * Assert that a condition is true (throws if not)
 */
export function assert(
  condition: unknown,
  message: string = 'Assertion failed'
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Exhaustive check for switch statements
 */
export function exhaustiveCheck(value: never): never {
  throw new Error(`Unhandled value: ${value}`);
}

/**
 * Safe JSON parse with type guard
 */
export function safeJsonParse<T>(
  text: string,
  guard?: (value: unknown) => value is T
): T | null {
  try {
    const parsed = JSON.parse(text);
    if (guard && !guard(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Type-safe object keys
 */
export function objectKeys<T extends Record<string, unknown>>(
  obj: T
): Array<keyof T> {
  return Object.keys(obj) as Array<keyof T>;
}

/**
 * Type-safe object entries
 */
export function objectEntries<T extends Record<string, unknown>>(
  obj: T
): Array<[keyof T, T[keyof T]]> {
  return Object.entries(obj) as Array<[keyof T, T[keyof T]]>;
}

/**
 * Type-safe object values
 */
export function objectValues<T extends Record<string, unknown>>(
  obj: T
): Array<T[keyof T]> {
  return Object.values(obj) as Array<T[keyof T]>;
}

/**
 * Pick defined values from object
 */
export function pickDefined<T extends Record<string, unknown>>(
  obj: T
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of objectEntries(obj)) {
    if (isDefined(value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Filter null and undefined from array
 */
export function filterPresent<T>(
  array: Array<T | null | undefined>
): T[] {
  return array.filter(isPresent);
}

/**
 * Type-safe setTimeout wrapper
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Type-safe setInterval wrapper with cleanup
 */
export function interval(
  callback: () => void | Promise<void>,
  ms: number
): () => void {
  const id = setInterval(callback, ms);
  return () => clearInterval(id);
}

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Create a success result
 */
export function ok<T>(value: T): Result<T, never> {
  return { success: true, value };
}

/**
 * Create an error result
 */
export function err<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Type guard for success result
 */
export function isOk<T, E>(
  result: Result<T, E>
): result is { success: true; value: T } {
  return result.success;
}

/**
 * Type guard for error result
 */
export function isErr<T, E>(
  result: Result<T, E>
): result is { success: false; error: E } {
  return !result.success;
}

/**
 * Unwrap a result or throw
 */
export function unwrapOr<T, E>(
  result: Result<T, E>,
  defaultValue: T
): T {
  return isOk(result) ? result.value : defaultValue;
}

/**
 * Map over a result
 */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  return isOk(result) ? ok(fn(result.value)) : result;
}

/**
 * Async result handler
 */
export async function tryAsync<T>(
  fn: () => Promise<T>
): Promise<Result<T>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Branded types for additional type safety
 */
export type Brand<K, T> = K & { __brand: T };

export type MinerId = Brand<string, 'MinerId'>;
export type ShareId = Brand<string, 'ShareId'>;
export type JobId = Brand<string, 'JobId'>;
export type BlockHash = Brand<string, 'BlockHash'>;
export type BitcoinAddress = Brand<string, 'BitcoinAddress'>;
export type TransactionId = Brand<string, 'TransactionId'>;

/**
 * Create branded type
 */
export function brand<T extends string, B>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

/**
 * Validate and create bitcoin address
 */
export function toBitcoinAddress(value: string): BitcoinAddress | null {
  // Basic validation (should be more comprehensive in production)
  const isValid = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(value) ||
                  /^bc1[a-z0-9]{39,59}$/.test(value);
  return isValid ? brand<string, 'BitcoinAddress'>(value) : null;
}

/**
 * Validate and create transaction ID
 */
export function toTransactionId(value: string): TransactionId | null {
  // Transaction ID should be 64 hex characters
  const isValid = /^[a-fA-F0-9]{64}$/.test(value);
  return isValid ? brand<string, 'TransactionId'>(value) : null;
}
