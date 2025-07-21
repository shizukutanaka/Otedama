/**
 * Load Test Worker
 * 
 * Worker thread for generating HTTP requests in load tests
 * Optimized for high performance and minimal overhead
 */

import { parentPort } from 'worker_threads';
import { performance } from 'perf_hooks';
import http from 'http';
import https from 'https';
import { URL } from 'url';

class LoadTestWorker {
  constructor() {
    this.config = null;
    this.isRunning = false;
    this.requestCount = 0;
    this.httpAgent = null;
    this.httpsAgent = null;
    this.scenario = null;
    this.variables = {};
    
    this.setupAgents();
    this.setupMessageHandling();
  }
  
  /**
   * Setup HTTP/HTTPS agents for connection pooling
   */
  setupAgents() {
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 30000,
      keepAliveMsecs: 1000
    });
    
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 30000,
      keepAliveMsecs: 1000,
      rejectUnauthorized: false // For testing purposes
    });
  }
  
  /**
   * Setup message handling from main thread
   */
  setupMessageHandling() {
    parentPort.on('message', (message) => {
      switch (message.command) {
        case 'configure':
          this.configure(message.config);
          break;
        case 'start':
          this.start();
          break;
        case 'stop':
          this.stop();
          break;
        case 'slow_down':
          this.slowDown();
          break;
        case 'speed_up':
          this.speedUp();
          break;
      }
    });
  }
  
  /**
   * Configure worker with test parameters
   */
  configure(config) {
    this.config = config;
    this.scenario = config.scenario;
    this.variables = { ...config.scenario.variables };
    
    // Update agents if needed
    if (config.keepAlive !== undefined) {
      this.httpAgent.keepAlive = config.keepAlive;
      this.httpsAgent.keepAlive = config.keepAlive;
    }
    
    this.sendMessage('worker_status', {
      status: 'configured',
      scenario: this.scenario.name
    });
  }
  
  /**
   * Start load generation
   */
  async start() {
    if (!this.config || this.isRunning) return;
    
    this.isRunning = true;
    this.requestCount = 0;
    
    this.sendMessage('worker_status', {
      status: 'started',
      scenario: this.scenario.name
    });
    
    // Run scenario setup if provided
    if (this.scenario.setup) {
      try {
        await this.executeSetup();
      } catch (error) {
        this.sendMessage('worker_status', {
          status: 'setup_failed',
          error: error.message
        });
        return;
      }
    }
    
    // Start request loop
    this.requestLoop();
  }
  
  /**
   * Stop load generation
   */
  async stop() {
    this.isRunning = false;
    
    // Run scenario teardown if provided
    if (this.scenario.teardown) {
      try {
        await this.executeTeardown();
      } catch (error) {
        this.sendMessage('worker_status', {
          status: 'teardown_failed',
          error: error.message
        });
      }
    }
    
    this.sendMessage('worker_status', {
      status: 'stopped',
      totalRequests: this.requestCount
    });
  }
  
  /**
   * Slow down request rate
   */
  slowDown() {
    if (this.scenario.thinkTime) {
      this.scenario.thinkTime = Math.min(this.scenario.thinkTime * 1.5, 5000);
    } else {
      this.scenario.thinkTime = 1000;
    }
  }
  
  /**
   * Speed up request rate
   */
  speedUp() {
    if (this.scenario.thinkTime) {
      this.scenario.thinkTime = Math.max(this.scenario.thinkTime * 0.8, 100);
    }
  }
  
  /**
   * Main request loop
   */
  async requestLoop() {
    while (this.isRunning) {
      try {
        // Execute scenario requests
        for (const request of this.scenario.requests) {
          if (!this.isRunning) break;
          
          await this.executeRequest(request);
          
          // Think time between requests
          const thinkTime = this.scenario.thinkTime || 
                           this.getRandomThinkTime(100, 1000);
          await this.sleep(thinkTime);
        }
        
        // Scenario completion think time
        const scenarioThinkTime = this.scenario.scenarioThinkTime || 
                                 this.getRandomThinkTime(1000, 3000);
        await this.sleep(scenarioThinkTime);
        
      } catch (error) {
        this.sendMessage('request_failed', {
          error: error.message,
          timestamp: Date.now()
        });
      }
    }
  }
  
  /**
   * Execute a single HTTP request
   */
  async executeRequest(requestConfig) {
    const startTime = performance.now();
    
    try {
      // Prepare request
      const request = this.prepareRequest(requestConfig);
      
      // Execute request
      const response = await this.makeHttpRequest(request);
      
      const endTime = performance.now();
      const responseTime = endTime - startTime;
      
      // Validate response if assertions are provided
      const validationResults = this.validateResponse(response, requestConfig.assertions);
      
      // Update variables from response if extractors are provided
      if (requestConfig.extractors) {
        this.extractVariables(response, requestConfig.extractors);
      }
      
      this.requestCount++;
      
      // Send success metrics
      this.sendMessage('request_completed', {
        responseTime,
        statusCode: response.statusCode,
        bytesReceived: response.body ? response.body.length : 0,
        bytesSent: request.body ? request.body.length : 0,
        url: request.url,
        method: request.method,
        validationResults,
        timestamp: Date.now()
      });
      
      // Send performance data
      this.sendMessage('performance_data', {
        responseTime,
        timestamp: Date.now(),
        memoryUsage: process.memoryUsage()
      });
      
    } catch (error) {
      const endTime = performance.now();
      const responseTime = endTime - startTime;
      
      this.sendMessage('request_failed', {
        error: error.message,
        responseTime,
        url: requestConfig.url,
        method: requestConfig.method,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Prepare HTTP request with variable substitution
   */
  prepareRequest(requestConfig) {
    const request = {
      method: requestConfig.method || 'GET',
      url: this.substituteVariables(requestConfig.url || '/'),
      headers: { ...requestConfig.headers },
      body: requestConfig.body ? this.substituteVariables(requestConfig.body) : null,
      timeout: this.config.timeout || 5000
    };
    
    // Add base URL if relative path
    if (!request.url.startsWith('http')) {
      request.url = `${this.config.baseUrl}${request.url}`;
    }
    
    // Add default headers
    if (!request.headers['User-Agent']) {
      request.headers['User-Agent'] = 'Otedama-LoadTester/1.0';
    }
    
    if (request.body && !request.headers['Content-Type']) {
      request.headers['Content-Type'] = 'application/json';
    }
    
    return request;
  }
  
  /**
   * Make HTTP request
   */
  makeHttpRequest(request) {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      const agent = isHttps ? this.httpsAgent : this.httpAgent;
      
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: request.method,
        headers: request.headers,
        agent,
        timeout: request.timeout
      };
      
      const req = httpModule.request(options, (res) => {
        let body = '';
        
        res.on('data', (chunk) => {
          body += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body
          });
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      // Write body if present
      if (request.body) {
        req.write(request.body);
      }
      
      req.end();
    });
  }
  
  /**
   * Validate response against assertions
   */
  validateResponse(response, assertions = []) {
    const results = [];
    
    for (const assertion of assertions) {
      let result = { assertion, passed: false, message: '' };
      
      try {
        switch (assertion.type) {
          case 'status_code':
            result.passed = response.statusCode === assertion.expected;
            result.message = `Expected ${assertion.expected}, got ${response.statusCode}`;
            break;
            
          case 'response_time':
            // Response time assertion would be handled at a higher level
            result.passed = true;
            break;
            
          case 'body_contains':
            result.passed = response.body.includes(assertion.expected);
            result.message = `Body ${result.passed ? 'contains' : 'does not contain'} "${assertion.expected}"`;
            break;
            
          case 'body_json':
            try {
              const json = JSON.parse(response.body);
              const value = this.getNestedValue(json, assertion.path);
              result.passed = value === assertion.expected;
              result.message = `Expected ${assertion.expected}, got ${value}`;
            } catch (error) {
              result.passed = false;
              result.message = `Invalid JSON: ${error.message}`;
            }
            break;
            
          case 'header_exists':
            result.passed = !!response.headers[assertion.expected.toLowerCase()];
            result.message = `Header "${assertion.expected}" ${result.passed ? 'exists' : 'does not exist'}`;
            break;
            
          case 'header_value':
            const headerValue = response.headers[assertion.header.toLowerCase()];
            result.passed = headerValue === assertion.expected;
            result.message = `Expected "${assertion.expected}", got "${headerValue}"`;
            break;
        }
      } catch (error) {
        result.passed = false;
        result.message = `Assertion error: ${error.message}`;
      }
      
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * Extract variables from response
   */
  extractVariables(response, extractors) {
    for (const extractor of extractors) {
      try {
        let value;
        
        switch (extractor.type) {
          case 'json_path':
            const json = JSON.parse(response.body);
            value = this.getNestedValue(json, extractor.path);
            break;
            
          case 'regex':
            const match = response.body.match(new RegExp(extractor.pattern));
            value = match ? match[extractor.group || 1] : null;
            break;
            
          case 'header':
            value = response.headers[extractor.header.toLowerCase()];
            break;
            
          case 'status_code':
            value = response.statusCode;
            break;
        }
        
        if (value !== undefined) {
          this.variables[extractor.name] = value;
        }
      } catch (error) {
        // Ignore extraction errors
      }
    }
  }
  
  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }
  
  /**
   * Substitute variables in string
   */
  substituteVariables(str) {
    if (typeof str !== 'string') return str;
    
    return str.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      if (this.variables.hasOwnProperty(varName)) {
        return this.variables[varName];
      }
      
      // Built-in variables
      switch (varName) {
        case 'timestamp':
          return Date.now().toString();
        case 'random':
          return Math.random().toString();
        case 'uuid':
          return this.generateUUID();
        case 'worker_id':
          return process.pid.toString();
        default:
          return match; // Keep original if no substitution found
      }
    });
  }
  
  /**
   * Generate simple UUID
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  /**
   * Execute scenario setup
   */
  async executeSetup() {
    if (typeof this.scenario.setup === 'function') {
      await this.scenario.setup(this.variables);
    }
  }
  
  /**
   * Execute scenario teardown
   */
  async executeTeardown() {
    if (typeof this.scenario.teardown === 'function') {
      await this.scenario.teardown(this.variables);
    }
  }
  
  /**
   * Get random think time
   */
  getRandomThinkTime(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Send message to main thread
   */
  sendMessage(type, data) {
    parentPort.postMessage({ type, data });
  }
}

// Initialize worker
new LoadTestWorker();