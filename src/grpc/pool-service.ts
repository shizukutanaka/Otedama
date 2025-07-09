// src/grpc/pool-service.ts
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Logger } from '../logging/logger';
import { PoolMetrics } from '../metrics/metrics';
import path from 'path';

// Proto definitions for mining pool gRPC service
const PROTO_PATH = path.join(__dirname, '../proto/pool.proto');

interface PoolRequest {
  minerId: string;
  action: string;
  data?: any;
}

interface PoolResponse {
  success: boolean;
  message: string;
  data?: any;
}

interface ShareSubmission {
  minerId: string;
  jobId: string;
  nonce: number;
  result: string;
  timestamp: number;
}

interface ShareResponse {
  accepted: boolean;
  reason?: string;
  difficulty: number;
  target: string;
}

export class GrpcPoolService {
  private server: grpc.Server;
  private logger: Logger;
  private metrics: PoolMetrics;
  private packageDefinition: protoLoader.PackageDefinition;
  private proto: any;

  constructor(logger: Logger, metrics: PoolMetrics) {
    this.logger = logger;
    this.metrics = metrics;
    this.server = new grpc.Server({
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 2000,
      'grpc.keepalive_permit_without_calls': true,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.http2.min_time_between_pings_ms': 10000,
      'grpc.http2.min_ping_interval_without_data_ms': 300000
    });
    
    this.initializeProtos();
    this.setupServices();
  }

  private initializeProtos(): void {
    try {
      this.packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [path.dirname(PROTO_PATH)]
      });
      
      this.proto = grpc.loadPackageDefinition(this.packageDefinition).pool;
    } catch (error) {
      // Fallback: create in-memory proto definition
      this.createFallbackProto();
    }
  }

  private createFallbackProto(): void {
    // Simplified proto definition for basic functionality
    this.proto = {
      PoolService: {
        service: {
          submitShare: {
            path: '/pool.PoolService/SubmitShare',
            requestStream: false,
            responseStream: false,
            requestType: 'ShareSubmission',
            responseType: 'ShareResponse'
          },
          getWork: {
            path: '/pool.PoolService/GetWork',
            requestStream: false,
            responseStream: false,
            requestType: 'WorkRequest',
            responseType: 'WorkResponse'
          },
          getMinerStats: {
            path: '/pool.PoolService/GetMinerStats',
            requestStream: false,
            responseStream: false,
            requestType: 'StatsRequest',
            responseType: 'StatsResponse'
          }
        }
      }
    };
  }

  private setupServices(): void {
    const serviceImplementation = {
      submitShare: this.handleShareSubmission.bind(this),
      getWork: this.handleGetWork.bind(this),
      getMinerStats: this.handleGetMinerStats.bind(this),
      subscribeToBlocks: this.handleBlockSubscription.bind(this)
    };

    if (this.proto?.PoolService) {
      this.server.addService(this.proto.PoolService.service, serviceImplementation);
    }
  }

  private async handleShareSubmission(
    call: grpc.ServerUnaryCall<ShareSubmission, ShareResponse>,
    callback: grpc.sendUnaryData<ShareResponse>
  ): Promise<void> {
    const startTime = Date.now();
    
    try {
      const { minerId, jobId, nonce, result, timestamp } = call.request;
      
      // Validate share submission
      if (!minerId || !jobId || nonce === undefined || !result) {
        callback(null, {
          accepted: false,
          reason: 'Invalid share data',
          difficulty: 0,
          target: ''
        });
        return;
      }

      // Process share (simplified)
      const isValid = await this.validateShare(call.request);
      const difficulty = await this.getCurrentDifficulty(minerId);
      const target = await this.getCurrentTarget();

      const response: ShareResponse = {
        accepted: isValid,
        reason: isValid ? undefined : 'Invalid share',
        difficulty,
        target
      };

      // Update metrics
      this.metrics.incrementCounter('grpc_share_submissions_total', {
        miner_id: minerId,
        accepted: isValid.toString()
      });

      const duration = Date.now() - startTime;
      this.metrics.observeHistogram('grpc_request_duration_ms', duration, {
        method: 'submitShare'
      });

      callback(null, response);
      
    } catch (error) {
      this.logger.error('Error handling share submission:', error);
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error'
      }, null);
    }
  }

  private async handleGetWork(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const startTime = Date.now();
    
    try {
      const { minerId } = call.request;
      
      if (!minerId) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Miner ID required'
        }, null);
        return;
      }

      // Generate work for miner
      const work = await this.generateWork(minerId);
      
      callback(null, {
        jobId: work.jobId,
        target: work.target,
        blockHeader: work.blockHeader,
        coinbase1: work.coinbase1,
        coinbase2: work.coinbase2,
        merkleRoot: work.merkleRoot,
        version: work.version,
        bits: work.bits,
        timestamp: work.timestamp
      });

      const duration = Date.now() - startTime;
      this.metrics.observeHistogram('grpc_request_duration_ms', duration, {
        method: 'getWork'
      });

    } catch (error) {
      this.logger.error('Error handling get work:', error);
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error'
      }, null);
    }
  }

  private async handleGetMinerStats(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    try {
      const { minerId } = call.request;
      
      if (!minerId) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Miner ID required'
        }, null);
        return;
      }

      const stats = await this.getMinerStatistics(minerId);
      
      callback(null, {
        minerId,
        hashrate: stats.hashrate,
        sharesAccepted: stats.sharesAccepted,
        sharesRejected: stats.sharesRejected,
        balance: stats.balance,
        lastSeen: stats.lastSeen,
        difficulty: stats.difficulty
      });

    } catch (error) {
      this.logger.error('Error handling get miner stats:', error);
      callback({
        code: grpc.status.INTERNAL,
        message: 'Internal server error'
      }, null);
    }
  }

  private handleBlockSubscription(
    call: grpc.ServerWritableStream<any, any>
  ): void {
    const minerId = call.request.minerId;
    
    if (!minerId) {
      call.destroy(new Error('Miner ID required'));
      return;
    }

    // Set up block notification stream
    const intervalId = setInterval(() => {
      try {
        call.write({
          blockHeight: this.getCurrentBlockHeight(),
          blockHash: this.getCurrentBlockHash(),
          timestamp: Date.now()
        });
      } catch (error) {
        this.logger.error('Error writing to block subscription stream:', error);
        clearInterval(intervalId);
        call.end();
      }
    }, 30000); // Send update every 30 seconds

    call.on('cancelled', () => {
      clearInterval(intervalId);
      this.logger.info(`Block subscription cancelled for miner: ${minerId}`);
    });

    call.on('error', (error) => {
      clearInterval(intervalId);
      this.logger.error(`Block subscription error for miner ${minerId}:`, error);
    });
  }

  private async validateShare(submission: ShareSubmission): Promise<boolean> {
    // Simplified share validation
    return submission.nonce > 0 && submission.result.length === 64;
  }

  private async getCurrentDifficulty(minerId: string): Promise<number> {
    // Return current difficulty for miner
    return 1024; // Simplified
  }

  private async getCurrentTarget(): Promise<string> {
    // Return current target
    return '0000ffff00000000000000000000000000000000000000000000000000000000';
  }

  private async generateWork(minerId: string): Promise<any> {
    // Generate work for miner (simplified)
    return {
      jobId: `job_${Date.now()}_${minerId}`,
      target: await this.getCurrentTarget(),
      blockHeader: '0'.repeat(160),
      coinbase1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
      coinbase2: 'ffffffff01',
      merkleRoot: '0'.repeat(64),
      version: 1,
      bits: '1d00ffff',
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  private async getMinerStatistics(minerId: string): Promise<any> {
    // Get miner statistics (simplified)
    return {
      hashrate: 1000000, // 1 MH/s
      sharesAccepted: 100,
      sharesRejected: 5,
      balance: 0.001,
      lastSeen: Date.now(),
      difficulty: 1024
    };
  }

  private getCurrentBlockHeight(): number {
    return 800000; // Simplified
  }

  private getCurrentBlockHash(): string {
    return '0'.repeat(64); // Simplified
  }

  public async start(port: number = 50051): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `0.0.0.0:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => {
          if (error) {
            this.logger.error('Failed to bind gRPC server:', error);
            reject(error);
            return;
          }

          this.server.start();
          this.logger.info(`gRPC server started on port ${boundPort}`);
          
          // Update metrics
          this.metrics.setGauge('grpc_server_status', 1);
          
          resolve();
        }
      );
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.tryShutdown((error) => {
        if (error) {
          this.logger.error('Error shutting down gRPC server:', error);
          this.server.forceShutdown();
        } else {
          this.logger.info('gRPC server shut down gracefully');
        }
        
        this.metrics.setGauge('grpc_server_status', 0);
        resolve();
      });
    });
  }

  public getServer(): grpc.Server {
    return this.server;
  }
}

// gRPC Client for external pool communication
export class GrpcPoolClient {
  private client: any;
  private logger: Logger;

  constructor(address: string, logger: Logger) {
    this.logger = logger;
    
    try {
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      });
      
      const proto = grpc.loadPackageDefinition(packageDefinition).pool;
      this.client = new (proto as any).PoolService(
        address,
        grpc.credentials.createInsecure()
      );
    } catch (error) {
      this.logger.warn('Could not load proto file, using simplified client');
      this.client = null;
    }
  }

  public async submitShare(submission: ShareSubmission): Promise<ShareResponse> {
    if (!this.client) {
      throw new Error('gRPC client not initialized');
    }

    return new Promise((resolve, reject) => {
      this.client.submitShare(submission, (error: any, response: ShareResponse) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  public async getWork(minerId: string): Promise<any> {
    if (!this.client) {
      throw new Error('gRPC client not initialized');
    }

    return new Promise((resolve, reject) => {
      this.client.getWork({ minerId }, (error: any, response: any) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  public close(): void {
    if (this.client) {
      this.client.close();
    }
  }
}