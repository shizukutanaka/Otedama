/**
 * Utilities Module - Otedama
 * Common utility functions
 * 
 * Design principles:
 * - Carmack: Efficient implementations
 * - Martin: Reusable functions
 * - Pike: Simple utilities
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Format hashrate for display
 */
export function formatHashrate(hashrate) {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let unitIndex = 0;
  let value = hashrate;
  
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format duration from seconds
 */
export function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

/**
 * Format bytes for display
 */
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format number with commas
 */
export function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Calculate percentage
 */
export function calculatePercentage(value, total, decimals = 2) {
  if (total === 0) return 0;
  return ((value / total) * 100).toFixed(decimals);
}

/**
 * Generate random ID
 */
export function generateId(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate unique ID with prefix
 */
export function generateUniqueId(prefix = 'id') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Hash data using SHA256
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Hash data using SHA256 (binary output)
 */
export function sha256Binary(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Create HMAC
 */
export function createHmac(key, data, algorithm = 'sha256') {
  return crypto.createHmac(algorithm, key).update(data).digest('hex');
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retry(fn, options = {}) {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    onError = null
  } = options;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      if (onError) {
        onError(error, attempt);
      }
      
      if (attempt < maxAttempts) {
        const waitTime = delay * Math.pow(backoff, attempt - 1);
        await sleep(waitTime);
      }
    }
  }
  
  throw lastError;
}

/**
 * Chunk array into smaller arrays
 */
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Flatten nested array
 */
export function flatten(array, depth = 1) {
  return depth > 0
    ? array.reduce((acc, val) => acc.concat(Array.isArray(val) ? flatten(val, depth - 1) : val), [])
    : array.slice();
}

/**
 * Deep clone object
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (obj instanceof Object) {
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = deepClone(obj[key]);
      }
    }
    return clonedObj;
  }
}

/**
 * Merge objects deeply
 */
export function deepMerge(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();
  
  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepMerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  
  return deepMerge(target, ...sources);
}

/**
 * Check if value is object
 */
export function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Pick properties from object
 */
export function pick(obj, keys) {
  return keys.reduce((acc, key) => {
    if (obj.hasOwnProperty(key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
}

/**
 * Omit properties from object
 */
export function omit(obj, keys) {
  const keysToOmit = new Set(keys);
  return Object.keys(obj).reduce((acc, key) => {
    if (!keysToOmit.has(key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
}

/**
 * Throttle function calls
 */
export function throttle(fn, delay) {
  let lastCall = 0;
  let timeout = null;
  
  return function(...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall >= delay) {
      lastCall = now;
      fn.apply(this, args);
    } else {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        lastCall = Date.now();
        fn.apply(this, args);
      }, delay - timeSinceLastCall);
    }
  };
}

/**
 * Debounce function calls
 */
export function debounce(fn, delay) {
  let timeout = null;
  
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/**
 * Parse duration string to milliseconds
 */
export function parseDuration(duration) {
  const units = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000
  };
  
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  
  const value = parseInt(match[1]);
  const unit = match[2] || 's';
  
  return value * (units[unit] || 1);
}

/**
 * Create directory recursively
 */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Read JSON file
 */
export async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

/**
 * Write JSON file
 */
export async function writeJsonFile(filePath, data, indent = 2) {
  const content = JSON.stringify(data, null, indent);
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Check if file exists
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size
 */
export async function getFileSize(filePath) {
  const stats = await fs.stat(filePath);
  return stats.size;
}

/**
 * Validate email
 */
export function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Validate URL
 */
export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize filename
 */
export function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9._-]/gi, '_');
}

/**
 * Get timestamp string
 */
export function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Parse boolean from string
 */
export function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return !!value;
}

/**
 * Clamp number between min and max
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation
 */
export function lerp(start, end, t) {
  return start + (end - start) * t;
}

/**
 * Map value from one range to another
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

/**
 * Create enum from array
 */
export function createEnum(values) {
  const enumObj = {};
  for (const value of values) {
    enumObj[value] = value;
  }
  return Object.freeze(enumObj);
}

/**
 * Measure function execution time
 */
export async function measureTime(fn, label = 'Execution') {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  const duration = Number(end - start) / 1e6; // Convert to ms
  
  console.log(`${label} took ${duration.toFixed(2)}ms`);
  
  return result;
}

// Re-export specific utilities from other files
export { createLogger } from '../core/logger.js';
export { ValidationError } from '../core/errors.js';

export default {
  // Formatting
  formatHashrate,
  formatDuration,
  formatBytes,
  formatNumber,
  calculatePercentage,
  
  // Crypto
  generateId,
  generateUniqueId,
  sha256,
  sha256Binary,
  createHmac,
  
  // Async utilities
  sleep,
  retry,
  
  // Array utilities
  chunk,
  flatten,
  
  // Object utilities
  deepClone,
  deepMerge,
  isObject,
  pick,
  omit,
  
  // Function utilities
  throttle,
  debounce,
  
  // Time utilities
  parseDuration,
  getTimestamp,
  
  // File utilities
  ensureDir,
  readJsonFile,
  writeJsonFile,
  fileExists,
  getFileSize,
  
  // Validation utilities
  isValidEmail,
  isValidUrl,
  parseBoolean,
  
  // String utilities
  sanitizeFilename,
  
  // Math utilities
  clamp,
  lerp,
  mapRange,
  
  // Other utilities
  createEnum,
  measureTime
};
