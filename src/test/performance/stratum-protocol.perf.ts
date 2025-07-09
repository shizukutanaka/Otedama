// Stratum protocol performance tests
// Testing protocol parsing, serialization, and message handling

import { perfTest } from './performance-test-framework';
import * as crypto from 'crypto';

/**
 * Stratum message types
 */
interface StratumRequest {
  id: number | null;
  method: string;
  params: any[];
}

interface StratumResponse {
  id: number;
  result: any;
  error: any;
}

interface StratumNotification {
  id: null;
  method: string;
  params: any[];
}

/**
 * Stratum protocol handler
 */
class StratumProtocolHandler {
  private messageId: number = 1;
  private pendingRequests: Map<number, {
    method: string;
    timestamp: number;
    resolve: (result: any) => void;
    reject: (error: any) => void;
  }> = new Map();
  
  /**
   * Parse incoming message
   */
  parseMessage(data: string): StratumRequest | StratumResponse | null {
    try {
      const message = JSON.parse(data);
      
      // Validate message structure
      if (typeof message !== 'object' || message === null) {
        return null;
      }
      
      // Check if it's a response
      if ('result' in message || 'error' in message) {
        return message as StratumResponse;
      }
      
      // Check if it's a request or notification
      if ('method' in message && 'params' in message) {
        return message as StratumRequest;
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  /**
   * Serialize request
   */
  serializeRequest(method: string, params: any[], id?: number | null): string {
    const request: StratumRequest = {
      id: id !== undefined ? id : this.messageId++,
      method,
      params
    };
    
    return JSON.stringify(request) + '\n';
  }
  
  /**
   * Serialize response
   */
  serializeResponse(id: number, result: any, error: any = null): string {
    const response: StratumResponse = {
      id,
      result,
      error
    };
    
    return JSON.stringify(response) + '\n';
  }
  
  /**
   * Handle mining.subscribe
   */
  handleSubscribe(params: any[]): any {
    const userAgent = params[0] || 'unknown';
    const sessionId = params[1];
    
    return [
      [
        ['mining.set_difficulty', crypto.randomBytes(4).toString('hex')],
        ['mining.notify', crypto.randomBytes(4).toString('hex')]
      ],
      crypto.randomBytes(4).toString('hex'), // extraNonce1
      4 // extraNonce2Size
    ];
  }
  
  /**
   * Handle mining.authorize
   */
  handleAuthorize(params: any[]): boolean {
    const [username, password] = params;
    
    // Simple validation
    return username && typeof username === 'string' && username.length > 0;
  }
  
  /**
   * Handle mining.submit
   */
  handleSubmit(params: any[]): boolean {
    const [worker, jobId, extraNonce2, ntime, nonce] = params;
    
    // Validate parameters
    if (!worker || !jobId || !extraNonce2 || !ntime || !nonce) {
      return false;
    }
    
    // Simulate share validation
    return Math.random() > 0.02; // 98% valid shares
  }
  
  /**
   * Create mining.notify message
   */
  createNotifyMessage(
    jobId: string,
    prevHash: string,
    coinbase1: string,
    coinbase2: string,
    merkleBranches: string[],
    version: string,
    nbits: string,
    ntime: string,
    cleanJobs: boolean
  ): string {
    return this.serializeRequest('mining.notify', [
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleBranches,
      version,
      nbits,
      ntime,
      cleanJobs
    ], null);
  }
  
  /**
   * Create set_difficulty message
   */
  createSetDifficultyMessage(difficulty: number): string {
    return this.serializeRequest('mining.set_difficulty', [difficulty], null);
  }
}

/**
 * Stratum protocol performance tests
 */
export class StratumProtocolPerformance {
  private handler: StratumProtocolHandler;
  private testMessages: {
    requests: string[];
    responses: string[];
    notifications: string[];
  };
  
  constructor() {
    this.handler = new StratumProtocolHandler();
    this.testMessages = this.generateTestMessages();
  }
  
  /**
   * Generate test messages
   */
  private generateTestMessages() {
    const requests: string[] = [];
    const responses: string[] = [];
    const notifications: string[] = [];
    
    // Generate subscribe requests
    for (let i = 0; i < 100; i++) {
      requests.push(JSON.stringify({
        id: i,
        method: 'mining.subscribe',
        params: [`test-miner/${i}`, null]
      }));
    }
    
    // Generate authorize requests
    for (let i = 0; i < 100; i++) {
      requests.push(JSON.stringify({
        id: 100 + i,
        method: 'mining.authorize',
        params: [`worker.${i}`, 'password']
      }));
    }
    
    // Generate submit requests
    for (let i = 0; i < 1000; i++) {
      requests.push(JSON.stringify({
        id: 200 + i,
        method: 'mining.submit',
        params: [
          `worker.${i % 100}`,
          crypto.randomBytes(8).toString('hex'),
          crypto.randomBytes(4).toString('hex'),
          Math.floor(Date.now() / 1000).toString(16),
          crypto.randomBytes(4).toString('hex')
        ]
      }));
    }
    
    // Generate responses
    for (let i = 0; i < 100; i++) {
      responses.push(JSON.stringify({
        id: i,
        result: true,
        error: null
      }));
      
      responses.push(JSON.stringify({
        id: 100 + i,
        result: null,
        error: [20, 'Job not found', null]
      }));
    }
    
    // Generate notifications
    for (let i = 0; i < 100; i++) {
      notifications.push(JSON.stringify({
        id: null,
        method: 'mining.notify',
        params: [
          crypto.randomBytes(8).toString('hex'),
          crypto.randomBytes(32).toString('hex'),
          crypto.randomBytes(50).toString('hex'),
          crypto.randomBytes(50).toString('hex'),
          Array.from({ length: 5 }, () => crypto.randomBytes(32).toString('hex')),
          '20000000',
          '1a0e119a',
          Math.floor(Date.now() / 1000).toString(16),
          true
        ]
      }));
    }
    
    return { requests, responses, notifications };
  }
  
  /**
   * Test message parsing
   */
  async testMessageParsing(): Promise<void> {
    const allMessages = [
      ...this.testMessages.requests,
      ...this.testMessages.responses,
      ...this.testMessages.notifications
    ];
    
    let messageIndex = 0;
    
    await perfTest.run(() => {
      const message = allMessages[messageIndex % allMessages.length];
      messageIndex++;
      
      return this.handler.parseMessage(message);
    }, {
      name: 'Message Parsing',
      iterations: 100000,
      warmupIterations: 1000
    });
  }
  
  /**
   * Test message serialization
   */
  async testMessageSerialization(): Promise<void> {
    const methods = ['mining.subscribe', 'mining.authorize', 'mining.submit'];
    const paramSets = [
      ['test-miner/1.0', null],
      ['worker.1', 'password'],
      ['worker.1', 'job123', '00000000', '5e9a5f3e', '00000000']
    ];
    
    let index = 0;
    
    await perfTest.run(() => {
      const methodIndex = index % methods.length;
      const method = methods[methodIndex];
      const params = paramSets[methodIndex];
      index++;
      
      return this.handler.serializeRequest(method, params);
    }, {
      name: 'Message Serialization',
      iterations: 100000,
      warmupIterations: 1000
    });
  }
  
  /**
   * Test request handling
   */
  async testRequestHandling(): Promise<void> {
    const requests = this.testMessages.requests.map(r => JSON.parse(r));
    let requestIndex = 0;
    
    await perfTest.run(() => {
      const request = requests[requestIndex % requests.length];
      requestIndex++;
      
      let result;
      let error = null;
      
      try {
        switch (request.method) {
          case 'mining.subscribe':
            result = this.handler.handleSubscribe(request.params);
            break;
          case 'mining.authorize':
            result = this.handler.handleAuthorize(request.params);
            break;
          case 'mining.submit':
            result = this.handler.handleSubmit(request.params);
            break;
          default:
            error = [20, 'Unknown method', null];
        }
      } catch (e) {
        error = [20, 'Internal error', null];
      }
      
      return this.handler.serializeResponse(request.id, result, error);
    }, {
      name: 'Request Handling',
      iterations: 10000,
      warmupIterations: 100
    });
  }
  
  /**
   * Test notification creation
   */
  async testNotificationCreation(): Promise<void> {
    const jobIds = Array.from({ length: 100 }, (_, i) => 
      crypto.randomBytes(8).toString('hex')
    );
    const prevHashes = Array.from({ length: 100 }, () => 
      crypto.randomBytes(32).toString('hex')
    );
    
    let index = 0;
    
    await perfTest.run(() => {
      const jobId = jobIds[index % jobIds.length];
      const prevHash = prevHashes[index % prevHashes.length];
      index++;
      
      return this.handler.createNotifyMessage(
        jobId,
        prevHash,
        crypto.randomBytes(50).toString('hex'),
        crypto.randomBytes(50).toString('hex'),
        [],
        '20000000',
        '1a0e119a',
        Math.floor(Date.now() / 1000).toString(16),
        false
      );
    }, {
      name: 'Notification Creation',
      iterations: 10000,
      warmupIterations: 100
    });
  }
  
  /**
   * Test bulk message processing
   */
  async testBulkProcessing(): Promise<void> {
    const messages = this.testMessages.requests.slice(0, 100);
    
    await perfTest.run(() => {
      const results = [];
      
      for (const message of messages) {
        const parsed = this.handler.parseMessage(message);
        if (parsed && 'method' in parsed) {
          let result;
          let error = null;
          
          switch (parsed.method) {
            case 'mining.subscribe':
              result = this.handler.handleSubscribe(parsed.params);
              break;
            case 'mining.authorize':
              result = this.handler.handleAuthorize(parsed.params);
              break;
            case 'mining.submit':
              result = this.handler.handleSubmit(parsed.params);
              break;
            default:
              error = [20, 'Unknown method', null];
          }
          
          results.push(this.handler.serializeResponse(parsed.id as number, result, error));
        }
      }
      
      return results;
    }, {
      name: 'Bulk Processing (100 messages)',
      iterations: 100,
      warmupIterations: 10
    });
  }
  
  /**
   * Compare parsing strategies
   */
  async compareParsingStrategies(): Promise<void> {
    const testMessage = '{"id":1,"method":"mining.submit","params":["worker.1","job123","00000000","5e9a5f3e","00000000"]}';
    
    // Strategy A: JSON.parse with try-catch
    const jsonParseStrategy = () => {
      try {
        const parsed = JSON.parse(testMessage);
        return parsed.method === 'mining.submit';
      } catch {
        return false;
      }
    };
    
    // Strategy B: Manual parsing (simplified)
    const manualParseStrategy = () => {
      // Quick validation
      if (!testMessage.startsWith('{') || !testMessage.endsWith('}')) {
        return false;
      }
      
      // Check for method
      const methodMatch = testMessage.match(/"method"\s*:\s*"([^"]+)"/);
      return methodMatch && methodMatch[1] === 'mining.submit';
    };
    
    const result = await perfTest.compare(
      'Parsing Strategies',
      jsonParseStrategy,
      manualParseStrategy,
      {
        iterations: 100000,
        warmupIterations: 1000
      }
    );
    
    console.log(`\nParsing strategy comparison: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
  }
  
  /**
   * Test message validation
   */
  async testMessageValidation(): Promise<void> {
    const validMessages = this.testMessages.requests;
    const invalidMessages = [
      'invalid json',
      '{"incomplete":',
      '[]',
      '{"id":1}',
      '{"method":"test"}',
      '{"id":1,"method":"test","params":"not array"}',
      JSON.stringify({ id: 'not number', method: 'test', params: [] })
    ];
    
    const allMessages = [...validMessages, ...invalidMessages];
    let messageIndex = 0;
    
    await perfTest.run(() => {
      const message = allMessages[messageIndex % allMessages.length];
      messageIndex++;
      
      const parsed = this.handler.parseMessage(message);
      
      if (!parsed) return false;
      
      // Validate structure
      if ('method' in parsed) {
        return (
          typeof parsed.method === 'string' &&
          Array.isArray(parsed.params) &&
          (parsed.id === null || typeof parsed.id === 'number')
        );
      } else if ('result' in parsed || 'error' in parsed) {
        return typeof parsed.id === 'number';
      }
      
      return false;
    }, {
      name: 'Message Validation',
      iterations: 50000,
      warmupIterations: 500
    });
  }
  
  /**
   * Test protocol versioning
   */
  async testProtocolVersioning(): Promise<void> {
    const v1Messages = this.testMessages.requests.map(m => ({
      ...JSON.parse(m),
      version: 1
    }));
    
    const v2Messages = v1Messages.map(m => ({
      ...m,
      version: 2,
      extra: { timestamp: Date.now() }
    }));
    
    const allMessages = [...v1Messages, ...v2Messages];
    let messageIndex = 0;
    
    await perfTest.run(() => {
      const message = allMessages[messageIndex % allMessages.length];
      messageIndex++;
      
      // Handle different versions
      switch (message.version) {
        case 1:
          return message.method && message.params;
        case 2:
          return message.method && message.params && message.extra;
        default:
          return false;
      }
    }, {
      name: 'Protocol Versioning',
      iterations: 50000,
      warmupIterations: 500
    });
  }
  
  /**
   * Run all Stratum protocol performance tests
   */
  async runAll(): Promise<void> {
    await perfTest.suite('Stratum Protocol Performance', [
      { name: 'Message Parsing', fn: () => this.testMessageParsing() },
      { name: 'Message Serialization', fn: () => this.testMessageSerialization() },
      { name: 'Request Handling', fn: () => this.testRequestHandling() },
      { name: 'Notification Creation', fn: () => this.testNotificationCreation() },
      { name: 'Bulk Processing', fn: () => this.testBulkProcessing() },
      { name: 'Parsing Comparison', fn: () => this.compareParsingStrategies() },
      { name: 'Message Validation', fn: () => this.testMessageValidation() },
      { name: 'Protocol Versioning', fn: () => this.testProtocolVersioning() }
    ]);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new StratumProtocolPerformance();
  test.runAll().catch(console.error);
}
