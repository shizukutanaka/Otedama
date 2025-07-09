/**
 * Environment configuration tests
 */

import { validateEnv, getEnvConfig, isProduction, isDevelopment, getDatabaseUrl, getRedisUrl, getBootstrapNodes } from '../env';

// Save original env
const originalEnv = process.env;

describe('Environment Configuration', () => {
  beforeEach(() => {
    // Reset modules to clear cached config
    jest.resetModules();
    
    // Reset environment
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    process.env = originalEnv;
  });
  
  describe('validateEnv', () => {
    it('should validate required environment variables', () => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      
      expect(() => validateEnv()).not.toThrow();
    });
    
    it('should throw on missing required variables', () => {
      delete process.env.POOL_ADDRESS;
      
      expect(() => validateEnv()).toThrow();
    });
    
    it('should throw on invalid JWT secret length', () => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'too_short';
      
      expect(() => validateEnv()).toThrow();
    });
    
    it('should apply default values', () => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      
      const config = validateEnv();
      
      expect(config.NODE_ENV).toBe('test');
      expect(config.STRATUM_PORT).toBe(3333);
      expect(config.API_PORT).toBe(3001);
      expect(config.POOL_FEE).toBe(1.0);
    });
    
    it('should parse numeric values correctly', () => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      process.env.STRATUM_PORT = '4444';
      process.env.POOL_FEE = '2.5';
      process.env.MAX_PEERS = '100';
      
      const config = validateEnv();
      
      expect(config.STRATUM_PORT).toBe(4444);
      expect(config.POOL_FEE).toBe(2.5);
      expect(config.MAX_PEERS).toBe(100);
    });
    
    it('should parse boolean values correctly', () => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      process.env.ENABLE_HTTPS = 'true';
      process.env.ENABLE_WEBSOCKET = 'false';
      process.env.LOG_FILE = '1';
      
      const config = validateEnv();
      
      expect(config.ENABLE_HTTPS).toBe(true);
      expect(config.ENABLE_WEBSOCKET).toBe(false);
      expect(config.LOG_FILE).toBe(true);
    });
  });
  
  describe('environment checks', () => {
    it('should detect production environment', () => {
      process.env.NODE_ENV = 'production';
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      
      jest.resetModules();
      const { isProduction, isDevelopment } = require('../env');
      
      expect(isProduction()).toBe(true);
      expect(isDevelopment()).toBe(false);
    });
    
    it('should detect development environment', () => {
      process.env.NODE_ENV = 'development';
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
      
      jest.resetModules();
      const { isProduction, isDevelopment } = require('../env');
      
      expect(isProduction()).toBe(false);
      expect(isDevelopment()).toBe(true);
    });
  });
  
  describe('getDatabaseUrl', () => {
    beforeEach(() => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
    });
    
    it('should return SQLite URL for sqlite type', () => {
      process.env.DATABASE_TYPE = 'sqlite';
      process.env.DATABASE_PATH = './test.db';
      
      jest.resetModules();
      const { getDatabaseUrl } = require('../env');
      
      expect(getDatabaseUrl()).toBe('sqlite://./test.db');
    });
    
    it('should return PostgreSQL URL when provided', () => {
      process.env.DATABASE_TYPE = 'postgresql';
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
      
      jest.resetModules();
      const { getDatabaseUrl } = require('../env');
      
      expect(getDatabaseUrl()).toBe('postgresql://user:pass@host:5432/db');
    });
    
    it('should construct PostgreSQL URL from parts', () => {
      process.env.DATABASE_TYPE = 'postgresql';
      process.env.DB_HOST = 'localhost';
      process.env.DB_PORT = '5432';
      process.env.DB_NAME = 'testdb';
      process.env.DB_USER = 'testuser';
      process.env.DB_PASSWORD = 'testpass';
      process.env.DB_SSL = 'false';
      
      jest.resetModules();
      const { getDatabaseUrl } = require('../env');
      
      expect(getDatabaseUrl()).toBe('postgresql://testuser:testpass@localhost:5432/testdb');
    });
    
    it('should add SSL parameter when enabled', () => {
      process.env.DATABASE_TYPE = 'postgresql';
      process.env.DB_HOST = 'localhost';
      process.env.DB_PORT = '5432';
      process.env.DB_NAME = 'testdb';
      process.env.DB_USER = 'testuser';
      process.env.DB_PASSWORD = 'testpass';
      process.env.DB_SSL = 'true';
      
      jest.resetModules();
      const { getDatabaseUrl } = require('../env');
      
      expect(getDatabaseUrl()).toBe('postgresql://testuser:testpass@localhost:5432/testdb?sslmode=require');
    });
  });
  
  describe('getRedisUrl', () => {
    beforeEach(() => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
    });
    
    it('should return Redis URL when provided', () => {
      process.env.REDIS_URL = 'redis://password@host:6379/1';
      
      jest.resetModules();
      const { getRedisUrl } = require('../env');
      
      expect(getRedisUrl()).toBe('redis://password@host:6379/1');
    });
    
    it('should construct Redis URL from parts', () => {
      process.env.REDIS_HOST = 'localhost';
      process.env.REDIS_PORT = '6379';
      process.env.REDIS_DATABASE = '1';
      
      jest.resetModules();
      const { getRedisUrl } = require('../env');
      
      expect(getRedisUrl()).toBe('redis://localhost:6379/1');
    });
    
    it('should include password in Redis URL', () => {
      process.env.REDIS_HOST = 'localhost';
      process.env.REDIS_PORT = '6379';
      process.env.REDIS_DATABASE = '0';
      process.env.REDIS_PASSWORD = 'secret';
      
      jest.resetModules();
      const { getRedisUrl } = require('../env');
      
      expect(getRedisUrl()).toBe('redis://:secret@localhost:6379/0');
    });
  });
  
  describe('getBootstrapNodes', () => {
    beforeEach(() => {
      process.env.POOL_ADDRESS = 'bc1qtest';
      process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long';
    });
    
    it('should return empty array when no bootstrap nodes', () => {
      jest.resetModules();
      const { getBootstrapNodes } = require('../env');
      
      expect(getBootstrapNodes()).toEqual([]);
    });
    
    it('should parse comma-separated bootstrap nodes', () => {
      process.env.BOOTSTRAP_NODES = '/ip4/1.1.1.1/tcp/4001/p2p/peer1,/ip4/2.2.2.2/tcp/4001/p2p/peer2';
      
      jest.resetModules();
      const { getBootstrapNodes } = require('../env');
      
      expect(getBootstrapNodes()).toEqual([
        '/ip4/1.1.1.1/tcp/4001/p2p/peer1',
        '/ip4/2.2.2.2/tcp/4001/p2p/peer2'
      ]);
    });
    
    it('should trim whitespace from bootstrap nodes', () => {
      process.env.BOOTSTRAP_NODES = ' /ip4/1.1.1.1/tcp/4001/p2p/peer1 , /ip4/2.2.2.2/tcp/4001/p2p/peer2 ';
      
      jest.resetModules();
      const { getBootstrapNodes } = require('../env');
      
      expect(getBootstrapNodes()).toEqual([
        '/ip4/1.1.1.1/tcp/4001/p2p/peer1',
        '/ip4/2.2.2.2/tcp/4001/p2p/peer2'
      ]);
    });
  });
});
