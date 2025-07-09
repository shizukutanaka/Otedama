/**
 * Otedama Pool SDK for TypeScript/JavaScript
 * 
 * Design principles:
 * - Simplicity (Pike): Easy to use, minimal API surface
 * - Clean code (Martin): Well-structured, maintainable
 * - Performance (Carmack): Efficient HTTP/WebSocket handling
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  OtedamaConfig,
  PoolStats,
  MinerStats,
  Block,
  Payment,
  PaginatedResponse,
  AuthResponse,
  WebSocketMessage
} from './types';
import {
  OtedamaError,
  OtedamaValidationError,
  OtedamaAuthError,
  OtedamaNetworkError,
  OtedamaRateLimitError
} from './errors';

export class OtedamaPoolSDK extends EventEmitter {
  private client: AxiosInstance;
  private config: OtedamaConfig;
  private ws?: WebSocket;
  private authToken?: string;
  private refreshToken?: string;
  private tokenExpiry?: Date;

  constructor(config: OtedamaConfig) {
    super();
    this.config = {
      timeout: 30000,
      retries: 3,
      debug: false,
      ...config
    };

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Otedama-SDK/1.0.0'
      }
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        if (this.authToken) {
          config.headers.Authorization = `Bearer ${this.authToken}`;
        } else if (this.config.apiKey) {
          config.headers['X-API-Key'] = this.config.apiKey;
        }

        if (this.config.debug) {
          console.log('[Otedama SDK] Request:', config.method?.toUpperCase(), config.url);
        }

        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        if (this.config.debug) {
          console.log('[Otedama SDK] Response:', response.status, response.config.url);
        }
        return response;
      },
      async (error: AxiosError) => {
        if (this.config.debug) {
          console.error('[Otedama SDK] Error:', error.message);
        }

        // Handle token refresh
        if (error.response?.status === 401 && this.refreshToken && !error.config?.url?.includes('/auth/')) {
          try {
            await this.refreshAuth();
            // Retry original request
            return this.client.request(error.config!);
          } catch (refreshError) {
            // Refresh failed, propagate original error
          }
        }

        throw this.handleError(error);
      }
    );
  }

  private handleError(error: AxiosError): OtedamaError {
    if (error.response) {
      const { status, data } = error.response;
      const errorData = data as any;

      switch (status) {
        case 400:
          return new OtedamaValidationError(
            errorData.message || 'Validation error',
            errorData.field,
            errorData.value
          );
        case 401:
          return new OtedamaAuthError(errorData.message || 'Authentication failed');
        case 404:
          return new OtedamaError('Resource not found', 'NOT_FOUND', 404);
        case 429:
          return new OtedamaRateLimitError(
            'Rate limit exceeded',
            errorData.retryAfter
          );
        default:
          return new OtedamaError(
            errorData.message || 'Server error',
            errorData.code || 'SERVER_ERROR',
            status,
            errorData.details
          );
      }
    } else if (error.request) {
      return new OtedamaNetworkError('Network error - no response received');
    } else {
      return new OtedamaError(error.message || 'Unknown error', 'UNKNOWN_ERROR');
    }
  }

  // ===== AUTHENTICATION =====
  async authenticate(address: string, signature: string): Promise<AuthResponse> {
    const response = await this.client.post<AuthResponse>('/api/v1/auth/login', {
      address,
      signature
    });

    this.authToken = response.data.token;
    this.refreshToken = response.data.refreshToken;
    this.tokenExpiry = new Date(Date.now() + response.data.expiresIn * 1000);

    return response.data;
  }

  private async refreshAuth(): Promise<void> {
    if (!this.refreshToken) {
      throw new OtedamaAuthError('No refresh token available');
    }

    const response = await this.client.post<AuthResponse>('/api/v1/auth/refresh', {
      refreshToken: this.refreshToken
    });

    this.authToken = response.data.token;
    this.tokenExpiry = new Date(Date.now() + response.data.expiresIn * 1000);
  }

  logout(): void {
    this.authToken = undefined;
    this.refreshToken = undefined;
    this.tokenExpiry = undefined;
  }

  // ===== POOL STATISTICS =====
  async getPoolStats(): Promise<PoolStats> {
    const response = await this.client.get<PoolStats>('/api/v1/stats');
    return response.data;
  }

  async getCurrentStats(): Promise<{
    timestamp: string;
    hashrate: number;
    miners: number;
    difficulty: number;
    lastBlock?: any;
  }> {
    const response = await this.client.get('/api/v1/stats/current');
    return response.data;
  }

  async getHistoricalStats(period: '1h' | '24h' | '7d' | '30d'): Promise<any> {
    const response = await this.client.get(`/api/v1/stats/history/${period}`);
    return response.data;
  }

  // ===== MINERS =====
  async getMiners(params?: {
    page?: number;
    limit?: number;
    sortBy?: 'hashrate' | 'shares' | 'balance' | 'lastSeen';
  }): Promise<PaginatedResponse<MinerStats>> {
    const response = await this.client.get('/api/v1/miners', { params });
    return {
      data: response.data.miners,
      pagination: response.data.pagination
    };
  }

  async getMiner(address: string): Promise<MinerStats> {
    const response = await this.client.get<MinerStats>(`/api/v1/miners/${address}`);
    return response.data;
  }

  // ===== BLOCKS =====
  async getBlocks(params?: {
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<Block>> {
    const response = await this.client.get('/api/v1/blocks', { params });
    return {
      data: response.data.blocks,
      pagination: response.data.pagination
    };
  }

  async getBlock(height: number): Promise<Block> {
    const response = await this.client.get<Block>(`/api/v1/blocks/${height}`);
    return response.data;
  }

  // ===== PAYMENTS =====
  async getPayments(params?: {
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<Payment>> {
    const response = await this.client.get('/api/v1/payments', { params });
    return {
      data: response.data.payments,
      pagination: response.data.pagination
    };
  }

  async getMinerPayments(
    address: string,
    params?: {
      page?: number;
      limit?: number;
    }
  ): Promise<PaginatedResponse<Payment>> {
    const response = await this.client.get(`/api/v1/payments/${address}`, { params });
    return {
      data: response.data.payments,
      pagination: response.data.pagination
    };
  }

  // ===== ACCOUNT MANAGEMENT =====
  async getAccount(): Promise<any> {
    const response = await this.client.get('/api/v1/account');
    return response.data;
  }

  async updateAccountSettings(settings: {
    payoutThreshold?: number;
    email?: string;
    notifications?: {
      blockFound?: boolean;
      paymentSent?: boolean;
      workerOffline?: boolean;
    };
  }): Promise<void> {
    await this.client.put('/api/v1/account/settings', settings);
  }

  async requestWithdrawal(amount: number): Promise<{
    withdrawalId: string;
    amount: number;
    estimatedTime: string;
    status: string;
  }> {
    const response = await this.client.post('/api/v1/account/withdraw', { amount });
    return response.data;
  }

  // ===== WEBSOCKET =====
  connectWebSocket(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const wsUrl = this.config.baseUrl.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': this.authToken ? `Bearer ${this.authToken}` : undefined,
        'X-API-Key': this.config.apiKey
      }
    });

    this.ws.on('open', () => {
      if (this.config.debug) {
        console.log('[Otedama SDK] WebSocket connected');
      }
      this.emit('connected');
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as WebSocketMessage;
        if (this.config.debug) {
          console.log('[Otedama SDK] WebSocket message:', message.type);
        }
        this.emit(message.type, message.data);
        this.emit('message', message);
      } catch (error) {
        if (this.config.debug) {
          console.error('[Otedama SDK] Failed to parse WebSocket message:', error);
        }
      }
    });

    this.ws.on('error', (error) => {
      if (this.config.debug) {
        console.error('[Otedama SDK] WebSocket error:', error);
      }
      this.emit('error', error);
    });

    this.ws.on('close', (code, reason) => {
      if (this.config.debug) {
        console.log('[Otedama SDK] WebSocket disconnected:', code, reason.toString());
      }
      this.emit('disconnected', { code, reason: reason.toString() });
      
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.CLOSED) {
          this.connectWebSocket();
        }
      }, 5000);
    });
  }

  disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  // ===== UTILITIES =====
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    const response = await this.client.get('/health');
    return response.data;
  }

  // ===== ADMIN FUNCTIONS =====
  async admin_getMiners(): Promise<any[]> {
    const response = await this.client.get('/api/v1/admin/miners');
    return response.data;
  }

  async admin_banMiner(address: string, reason: string, duration?: number): Promise<void> {
    await this.client.post(`/api/v1/admin/ban/${address}`, { reason, duration });
  }

  async admin_unbanMiner(address: string): Promise<void> {
    await this.client.delete(`/api/v1/admin/ban/${address}`);
  }
}

export default OtedamaPoolSDK;
