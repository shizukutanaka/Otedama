/**
 * Jest test setup
 * Configure test environment and global mocks
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests

// Mock environment variables
process.env.POOL_ADDRESS = 'test_pool_address';
process.env.JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long';
process.env.RPC_URL = 'http://localhost:8332';

// Global test timeout
jest.setTimeout(30000);

// Mock console methods to reduce noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Mock timers for consistent testing
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

// Global test utilities
export const testUtils = {
  // Wait for promises to resolve
  flushPromises: () => new Promise(resolve => setImmediate(resolve)),
  
  // Mock async function
  mockAsync: <T>(value: T) => jest.fn().mockResolvedValue(value),
  
  // Mock async function that throws
  mockAsyncError: (error: Error) => jest.fn().mockRejectedValue(error),
  
  // Create mock request
  createMockRequest: (overrides?: any) => ({
    body: {},
    params: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    ...overrides
  }),
  
  // Create mock response
  createMockResponse: () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  },
  
  // Create mock socket
  createMockSocket: () => ({
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    remoteAddress: '127.0.0.1',
    remotePort: 12345
  })
};

// Make test utilities available globally
(global as any).testUtils = testUtils;
