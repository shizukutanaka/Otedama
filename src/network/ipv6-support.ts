/**
 * IPv6サポート実装
 * 次世代インターネットプロトコル対応
 * 
 * 設計思想：
 * - Carmack: 効率的なデュアルスタック実装
 * - Martin: 拡張可能なプロトコル抽象化
 * - Pike: シンプルで移行しやすい設計
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as dgram from 'dgram';
import { AddressInfo } from 'net';
import * as os from 'os';

// === 型定義 ===
export interface IPv6Config {
  // 基本設定
  enableIPv6: boolean;              // IPv6の有効化
  preferIPv6: boolean;              // IPv6を優先
  dualStack: boolean;               // デュアルスタックモード
  
  // アドレス設定
  bindAddress?: string;             // バインドアドレス（デフォルト: ::）
  scopeId?: number;                 // スコープID（リンクローカル用）
  
  // 自動設定
  autoconf: boolean;                // 自動設定の使用
  tempAddress: boolean;             // 一時アドレスの使用
  
  // フォールバック
  fallbackToIPv4: boolean;          // IPv4へのフォールバック
  happyEyeballs: boolean;           // Happy Eyeballs (RFC 8305)
  connectionTimeout: number;         // 接続タイムアウト（ms）
}

export interface NetworkAddress {
  family: 'IPv4' | 'IPv6';
  address: string;
  port: number;
  scopeId?: number;
  flowInfo?: number;
  
  // アドレスタイプ
  type: 'unicast' | 'multicast' | 'anycast' | 'loopback' | 'link_local';
  isGlobal: boolean;
  isPrivate: boolean;
  isTemporary: boolean;
}

export interface DualStackSocket {
  type: 'tcp' | 'udp';
  ipv4Socket?: net.Socket | dgram.Socket;
  ipv6Socket?: net.Socket | dgram.Socket;
  addresses: NetworkAddress[];
  statistics: SocketStatistics;
}

export interface SocketStatistics {
  ipv4: ConnectionStats;
  ipv6: ConnectionStats;
  preferenceHistory: Array<{
    timestamp: number;
    chosen: 'IPv4' | 'IPv6';
    reason: string;
  }>;
}

export interface ConnectionStats {
  connectionsTotal: number;
  connectionsActive: number;
  connectionsFailed: number;
  bytesReceived: number;
  bytesSent: number;
  averageLatency: number;
  packetLoss: number;
}

export interface AddressResolution {
  hostname: string;
  addresses: NetworkAddress[];
  preference: NetworkAddress | null;
  ttl: number;
  timestamp: number;
}

// === IPv6マネージャー ===
export class IPv6Manager extends EventEmitter {
  private config: IPv6Config;
  private sockets: Map<string, DualStackSocket> = new Map();
  private addressCache: Map<string, AddressResolution> = new Map();
  private localAddresses: NetworkAddress[] = [];
  private statistics = {
    ipv4Connections: 0,
    ipv6Connections: 0,
    dualStackConnections: 0,
    fallbacks: 0
  };
  
  constructor(config: IPv6Config) {
    super();
    this.config = config;
    
    // ローカルアドレスの検出
    this.detectLocalAddresses();
  }
  
  // ローカルアドレスの検出
  private detectLocalAddresses(): void {
    const interfaces = os.networkInterfaces();
    this.localAddresses = [];
    
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      
      for (const addr of addrs) {
        if (addr.internal) continue; // ループバックを除外
        
        const networkAddr: NetworkAddress = {
          family: addr.family as 'IPv4' | 'IPv6',
          address: addr.address,
          port: 0, // 未定
          type: this.getAddressType(addr.address),
          isGlobal: this.isGlobalAddress(addr.address),
          isPrivate: this.isPrivateAddress(addr.address),
          isTemporary: false, // OSから取得できない
          scopeId: addr.scopeid
        };
        
        this.localAddresses.push(networkAddr);
      }
    }
    
    this.emit('addressesDetected', this.localAddresses);
  }
  
  // デュアルスタックソケットの作成
  async createDualStackSocket(
    port: number,
    type: 'tcp' | 'udp' = 'tcp'
  ): Promise<DualStackSocket> {
    const socketId = `${type}_${port}`;
    
    // 既存のソケットをチェック
    if (this.sockets.has(socketId)) {
      return this.sockets.get(socketId)!;
    }
    
    const dualSocket: DualStackSocket = {
      type,
      addresses: [],
      statistics: {
        ipv4: this.createEmptyStats(),
        ipv6: this.createEmptyStats(),
        preferenceHistory: []
      }
    };
    
    try {
      // IPv4ソケットの作成
      if (!this.config.enableIPv6 || this.config.dualStack) {
        if (type === 'tcp') {
          dualSocket.ipv4Socket = await this.createTCPSocket('0.0.0.0', port);
        } else {
          dualSocket.ipv4Socket = await this.createUDPSocket('0.0.0.0', port);
        }
        
        dualSocket.addresses.push({
          family: 'IPv4',
          address: this.getIPv4Address(),
          port,
          type: 'unicast',
          isGlobal: true,
          isPrivate: false,
          isTemporary: false
        });
      }
      
      // IPv6ソケットの作成
      if (this.config.enableIPv6) {
        const bindAddr = this.config.bindAddress || '::';
        
        if (type === 'tcp') {
          dualSocket.ipv6Socket = await this.createTCPSocket(bindAddr, port);
        } else {
          dualSocket.ipv6Socket = await this.createUDPSocket(bindAddr, port);
        }
        
        // IPv6アドレスの追加
        for (const addr of this.localAddresses) {
          if (addr.family === 'IPv6' && addr.isGlobal) {
            dualSocket.addresses.push({
              ...addr,
              port
            });
          }
        }
      }
      
      // ソケットハンドラーの設定
      this.setupSocketHandlers(dualSocket);
      
      // 保存
      this.sockets.set(socketId, dualSocket);
      
      this.emit('socketCreated', { socketId, dualSocket });
      
      return dualSocket;
      
    } catch (error) {
      this.emit('error', { error, context: 'createDualStackSocket' });
      throw error;
    }
  }
  
  // アドレス解決（Happy Eyeballsアルゴリズム）
  async resolveAddress(hostname: string): Promise<AddressResolution> {
    // キャッシュチェック
    const cached = this.addressCache.get(hostname);
    if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
      return cached;
    }
    
    const resolution: AddressResolution = {
      hostname,
      addresses: [],
      preference: null,
      ttl: 300, // 5分
      timestamp: Date.now()
    };
    
    try {
      // DNS解決
      const results = await this.performDNSLookup(hostname);
      
      // アドレスの分類
      const ipv4Addresses: NetworkAddress[] = [];
      const ipv6Addresses: NetworkAddress[] = [];
      
      for (const result of results) {
        const addr: NetworkAddress = {
          family: result.family === 4 ? 'IPv4' : 'IPv6',
          address: result.address,
          port: 0,
          type: this.getAddressType(result.address),
          isGlobal: this.isGlobalAddress(result.address),
          isPrivate: this.isPrivateAddress(result.address),
          isTemporary: false
        };
        
        resolution.addresses.push(addr);
        
        if (addr.family === 'IPv4') {
          ipv4Addresses.push(addr);
        } else {
          ipv6Addresses.push(addr);
        }
      }
      
      // Happy Eyeballsによる優先順位決定
      if (this.config.happyEyeballs) {
        resolution.preference = await this.selectAddressHappyEyeballs(
          ipv4Addresses,
          ipv6Addresses
        );
      } else {
        // 単純な優先順位
        if (this.config.preferIPv6 && ipv6Addresses.length > 0) {
          resolution.preference = ipv6Addresses[0];
        } else if (ipv4Addresses.length > 0) {
          resolution.preference = ipv4Addresses[0];
        } else if (ipv6Addresses.length > 0) {
          resolution.preference = ipv6Addresses[0];
        }
      }
      
      // キャッシュに保存
      this.addressCache.set(hostname, resolution);
      
      return resolution;
      
    } catch (error) {
      this.emit('error', { error, context: 'resolveAddress', hostname });
      throw error;
    }
  }
  
  // Happy Eyeballsアルゴリズム（RFC 8305）
  private async selectAddressHappyEyeballs(
    ipv4Addresses: NetworkAddress[],
    ipv6Addresses: NetworkAddress[]
  ): Promise<NetworkAddress | null> {
    if (ipv4Addresses.length === 0 && ipv6Addresses.length === 0) {
      return null;
    }
    
    // 両方のプロトコルがある場合
    if (ipv4Addresses.length > 0 && ipv6Addresses.length > 0) {
      // 並行接続テスト
      const raceResult = await this.raceConnections(
        ipv6Addresses[0],
        ipv4Addresses[0]
      );
      
      return raceResult.winner;
    }
    
    // 単一プロトコルの場合
    return ipv6Addresses[0] || ipv4Addresses[0];
  }
  
  // 接続レース
  private async raceConnections(
    ipv6Addr: NetworkAddress,
    ipv4Addr: NetworkAddress
  ): Promise<{ winner: NetworkAddress; reason: string }> {
    const ipv6Delay = 0; // IPv6は即座に開始
    const ipv4Delay = 50; // IPv4は50ms遅延（Happy Eyeballs推奨）
    
    const ipv6Promise = this.testConnection(ipv6Addr, ipv6Delay);
    const ipv4Promise = this.testConnection(ipv4Addr, ipv4Delay);
    
    try {
      const result = await Promise.race([
        ipv6Promise.then(time => ({ addr: ipv6Addr, time, family: 'IPv6' })),
        ipv4Promise.then(time => ({ addr: ipv4Addr, time, family: 'IPv4' }))
      ]);
      
      // 統計の記録
      const stats = this.sockets.values().next().value?.statistics;
      if (stats) {
        stats.preferenceHistory.push({
          timestamp: Date.now(),
          chosen: result.family,
          reason: 'faster_connection'
        });
      }
      
      return {
        winner: result.addr,
        reason: `${result.family} was faster (${result.time}ms)`
      };
      
    } catch (error) {
      // 両方失敗した場合
      throw new Error('Both IPv4 and IPv6 connections failed');
    }
  }
  
  // 接続テスト
  private async testConnection(
    addr: NetworkAddress,
    delay: number
  ): Promise<number> {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    const start = Date.now();
    const testSocket = new net.Socket();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        testSocket.destroy();
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);
      
      testSocket.connect(80, addr.address, () => {
        clearTimeout(timeout);
        const duration = Date.now() - start;
        testSocket.destroy();
        resolve(duration);
      });
      
      testSocket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
  
  // デュアルスタック接続
  async connect(
    socketId: string,
    hostname: string,
    port: number
  ): Promise<net.Socket | dgram.Socket> {
    const dualSocket = this.sockets.get(socketId);
    if (!dualSocket) {
      throw new Error('Socket not found');
    }
    
    // アドレス解決
    const resolution = await this.resolveAddress(hostname);
    
    if (!resolution.preference) {
      throw new Error('No address available');
    }
    
    // 接続の実行
    const targetAddr = { ...resolution.preference, port };
    
    if (targetAddr.family === 'IPv6' && dualSocket.ipv6Socket) {
      this.statistics.ipv6Connections++;
      return this.performConnect(dualSocket.ipv6Socket, targetAddr);
      
    } else if (targetAddr.family === 'IPv4' && dualSocket.ipv4Socket) {
      this.statistics.ipv4Connections++;
      return this.performConnect(dualSocket.ipv4Socket, targetAddr);
      
    } else if (this.config.fallbackToIPv4 && dualSocket.ipv4Socket) {
      // IPv4へのフォールバック
      this.statistics.fallbacks++;
      const ipv4Addr = resolution.addresses.find(a => a.family === 'IPv4');
      if (ipv4Addr) {
        return this.performConnect(dualSocket.ipv4Socket, { ...ipv4Addr, port });
      }
    }
    
    throw new Error('No compatible socket available');
  }
  
  // ソケットハンドラーの設定
  private setupSocketHandlers(dualSocket: DualStackSocket): void {
    // IPv4ハンドラー
    if (dualSocket.ipv4Socket) {
      this.setupSingleSocketHandlers(
        dualSocket.ipv4Socket,
        dualSocket,
        'ipv4'
      );
    }
    
    // IPv6ハンドラー
    if (dualSocket.ipv6Socket) {
      this.setupSingleSocketHandlers(
        dualSocket.ipv6Socket,
        dualSocket,
        'ipv6'
      );
    }
  }
  
  // 単一ソケットのハンドラー設定
  private setupSingleSocketHandlers(
    socket: net.Socket | dgram.Socket,
    dualSocket: DualStackSocket,
    protocol: 'ipv4' | 'ipv6'
  ): void {
    const stats = protocol === 'ipv4' ? 
      dualSocket.statistics.ipv4 : 
      dualSocket.statistics.ipv6;
    
    if (socket instanceof net.Socket) {
      // TCPハンドラー
      socket.on('connect', () => {
        stats.connectionsActive++;
        stats.connectionsTotal++;
        this.emit('connected', { protocol, socket });
      });
      
      socket.on('data', (data) => {
        stats.bytesReceived += data.length;
      });
      
      socket.on('close', () => {
        stats.connectionsActive--;
      });
      
      socket.on('error', (error) => {
        stats.connectionsFailed++;
        this.emit('socketError', { protocol, error });
      });
      
    } else {
      // UDPハンドラー
      socket.on('message', (msg, rinfo) => {
        stats.bytesReceived += msg.length;
        
        // IPv6アドレスの正規化
        const normalizedAddr = this.normalizeAddress(rinfo.address);
        
        this.emit('message', {
          protocol,
          data: msg,
          remote: {
            address: normalizedAddr,
            port: rinfo.port,
            family: rinfo.family
          }
        });
      });
      
      socket.on('error', (error) => {
        this.emit('socketError', { protocol, error });
      });
    }
  }
  
  // TCPソケットの作成
  private async createTCPSocket(
    address: string,
    port: number
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      
      server.listen(port, address, () => {
        const socket = new net.Socket();
        server.close();
        resolve(socket);
      });
      
      server.on('error', reject);
    });
  }
  
  // UDPソケットの作成
  private async createUDPSocket(
    address: string,
    port: number
  ): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const type = address.includes(':') ? 'udp6' : 'udp4';
      const socket = dgram.createSocket(type);
      
      socket.bind(port, address, () => {
        resolve(socket);
      });
      
      socket.on('error', reject);
    });
  }
  
  // 接続の実行
  private async performConnect(
    socket: net.Socket | dgram.Socket,
    addr: NetworkAddress
  ): Promise<net.Socket | dgram.Socket> {
    if (socket instanceof net.Socket) {
      return new Promise((resolve, reject) => {
        socket.connect(addr.port, addr.address, () => {
          resolve(socket);
        });
        
        socket.on('error', reject);
      });
    } else {
      // UDP は接続の概念がないので、そのまま返す
      return socket;
    }
  }
  
  // DNS検索の実行
  private async performDNSLookup(hostname: string): Promise<any[]> {
    const dns = require('dns').promises;
    
    try {
      // IPv6とIPv4の両方を検索
      const [ipv6Results, ipv4Results] = await Promise.allSettled([
        dns.resolve6(hostname),
        dns.resolve4(hostname)
      ]);
      
      const results: any[] = [];
      
      if (ipv6Results.status === 'fulfilled') {
        for (const addr of ipv6Results.value) {
          results.push({ family: 6, address: addr });
        }
      }
      
      if (ipv4Results.status === 'fulfilled') {
        for (const addr of ipv4Results.value) {
          results.push({ family: 4, address: addr });
        }
      }
      
      return results;
      
    } catch (error) {
      throw error;
    }
  }
  
  // アドレスタイプの判定
  private getAddressType(address: string): NetworkAddress['type'] {
    // IPv4
    if (address.includes('.')) {
      if (address.startsWith('127.')) return 'loopback';
      if (address.startsWith('224.')) return 'multicast';
      return 'unicast';
    }
    
    // IPv6
    if (address === '::1') return 'loopback';
    if (address.startsWith('ff')) return 'multicast';
    if (address.startsWith('fe80:')) return 'link_local';
    
    return 'unicast';
  }
  
  // グローバルアドレスの判定
  private isGlobalAddress(address: string): boolean {
    // IPv4
    if (address.includes('.')) {
      const parts = address.split('.').map(Number);
      
      // プライベートアドレス範囲
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 127) return false; // ループバック
      
      return true;
    }
    
    // IPv6
    if (address.startsWith('fc') || address.startsWith('fd')) return false; // ULA
    if (address.startsWith('fe80:')) return false; // リンクローカル
    if (address === '::1') return false; // ループバック
    
    return true;
  }
  
  // プライベートアドレスの判定
  private isPrivateAddress(address: string): boolean {
    return !this.isGlobalAddress(address);
  }
  
  // IPv4アドレスの取得
  private getIPv4Address(): string {
    const addr = this.localAddresses.find(
      a => a.family === 'IPv4' && a.isGlobal
    );
    return addr?.address || '0.0.0.0';
  }
  
  // アドレスの正規化
  private normalizeAddress(address: string): string {
    // IPv6アドレスの正規化
    if (address.includes(':')) {
      // スコープIDの除去
      const scopeIndex = address.indexOf('%');
      if (scopeIndex > -1) {
        address = address.substring(0, scopeIndex);
      }
      
      // ゼロ圧縮の展開（簡略化）
      // 実際にはより複雑な正規化が必要
    }
    
    return address;
  }
  
  // 空の統計情報
  private createEmptyStats(): ConnectionStats {
    return {
      connectionsTotal: 0,
      connectionsActive: 0,
      connectionsFailed: 0,
      bytesReceived: 0,
      bytesSent: 0,
      averageLatency: 0,
      packetLoss: 0
    };
  }
  
  // データ送信（デュアルスタック対応）
  async send(
    socketId: string,
    data: Buffer,
    remoteAddr: NetworkAddress
  ): Promise<void> {
    const dualSocket = this.sockets.get(socketId);
    if (!dualSocket) {
      throw new Error('Socket not found');
    }
    
    const socket = remoteAddr.family === 'IPv6' ? 
      dualSocket.ipv6Socket : 
      dualSocket.ipv4Socket;
    
    if (!socket) {
      throw new Error(`No ${remoteAddr.family} socket available`);
    }
    
    const stats = remoteAddr.family === 'IPv6' ?
      dualSocket.statistics.ipv6 :
      dualSocket.statistics.ipv4;
    
    if (socket instanceof net.Socket) {
      // TCP送信
      socket.write(data);
      stats.bytesSent += data.length;
      
    } else {
      // UDP送信
      socket.send(data, remoteAddr.port, remoteAddr.address, (err) => {
        if (err) {
          this.emit('sendError', { error: err, remoteAddr });
        } else {
          stats.bytesSent += data.length;
        }
      });
    }
  }
  
  // 公開API
  getLocalAddresses(): NetworkAddress[] {
    return [...this.localAddresses];
  }
  
  getSocket(socketId: string): DualStackSocket | null {
    return this.sockets.get(socketId) || null;
  }
  
  getStatistics(): any {
    const socketStats: any[] = [];
    
    for (const [id, socket] of this.sockets) {
      socketStats.push({
        socketId: id,
        type: socket.type,
        statistics: socket.statistics
      });
    }
    
    return {
      global: this.statistics,
      sockets: socketStats,
      addressCache: this.addressCache.size
    };
  }
  
  // IPv6の有効性チェック
  isIPv6Available(): boolean {
    return this.localAddresses.some(
      addr => addr.family === 'IPv6' && addr.isGlobal
    );
  }
  
  // アドレスファミリーの優先順位設定
  setPreference(preferIPv6: boolean): void {
    this.config.preferIPv6 = preferIPv6;
    this.emit('preferenceChanged', { preferIPv6 });
  }
  
  // ソケットのクローズ
  async closeSocket(socketId: string): Promise<void> {
    const dualSocket = this.sockets.get(socketId);
    if (!dualSocket) return;
    
    if (dualSocket.ipv4Socket) {
      if (dualSocket.ipv4Socket instanceof net.Socket) {
        dualSocket.ipv4Socket.destroy();
      } else {
        dualSocket.ipv4Socket.close();
      }
    }
    
    if (dualSocket.ipv6Socket) {
      if (dualSocket.ipv6Socket instanceof net.Socket) {
        dualSocket.ipv6Socket.destroy();
      } else {
        dualSocket.ipv6Socket.close();
      }
    }
    
    this.sockets.delete(socketId);
    this.emit('socketClosed', { socketId });
  }
  
  // すべてのソケットをクローズ
  async closeAll(): Promise<void> {
    for (const socketId of this.sockets.keys()) {
      await this.closeSocket(socketId);
    }
  }
}

export default IPv6Manager;