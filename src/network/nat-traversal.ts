/**
 * NAT Traversal実装
 * ファイアウォール貫通とピア接続の確立
 * 
 * 設計思想：
 * - Carmack: 効率的なホールパンチング
 * - Martin: 複数の貫通手法の統合
 * - Pike: シンプルで信頼性の高い接続確立
 */

import { EventEmitter } from 'events';
import * as dgram from 'dgram';
import * as net from 'net';
import { createHash } from 'crypto';

// === 型定義 ===
export interface NATTraversalConfig {
  // 基本設定
  stunServers: string[];         // STUNサーバーリスト
  turnServers?: TurnServer[];    // TURNサーバー（オプション）
  signalServer?: string;         // シグナリングサーバー
  
  // タイムアウト設定
  stunTimeout: number;           // STUNタイムアウト（ms）
  punchTimeout: number;          // ホールパンチングタイムアウト
  keepAliveInterval: number;     // キープアライブ間隔
  
  // リトライ設定
  maxRetries: number;           // 最大リトライ回数
  retryDelay: number;          // リトライ間隔（ms）
  
  // ポート設定
  portRange: {
    min: number;
    max: number;
  };
  
  // セキュリティ
  enableEncryption: boolean;
  presharedKey?: string;
}

export interface TurnServer {
  url: string;
  username?: string;
  credential?: string;
}

export interface NATType {
  type: 'full_cone' | 'restricted_cone' | 'port_restricted_cone' | 'symmetric' | 'unknown';
  externalAddress: string;
  externalPort: number;
  localAddress: string;
  localPort: number;
  mappingBehavior: 'endpoint_independent' | 'address_dependent' | 'address_port_dependent';
  filteringBehavior: 'endpoint_independent' | 'address_dependent' | 'address_port_dependent';
}

export interface PeerConnection {
  peerId: string;
  localEndpoint: Endpoint;
  remoteEndpoint: Endpoint;
  connectionType: 'direct' | 'relay' | 'upnp';
  status: 'connecting' | 'connected' | 'failed' | 'closed';
  established: number;
  lastActivity: number;
  statistics: ConnectionStats;
}

export interface Endpoint {
  address: string;
  port: number;
  type: 'public' | 'private' | 'relay';
}

export interface ConnectionStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  latency: number;
  jitter: number;
  packetLoss: number;
}

export interface HolePunchRequest {
  requestId: string;
  fromPeer: string;
  toPeer: string;
  localEndpoint: Endpoint;
  remoteEndpoint: Endpoint;
  timestamp: number;
  attempts: number;
}

// === STUNメッセージ ===
interface StunMessage {
  type: number;
  transactionId: Buffer;
  attributes: Map<number, Buffer>;
}

// STUNメッセージタイプ
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;

// STUN属性タイプ
const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const STUN_ATTR_CHANGE_REQUEST = 0x0003;

// === NAT Traversalマネージャー ===
export class NATTraversalManager extends EventEmitter {
  private config: NATTraversalConfig;
  private udpSocket?: dgram.Socket;
  private tcpServer?: net.Server;
  private natType?: NATType;
  private connections: Map<string, PeerConnection> = new Map();
  private pendingPunches: Map<string, HolePunchRequest> = new Map();
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // UPnP対応
  private upnpClient: any; // UPnPクライアント（実装依存）
  private upnpMappings: Map<number, string> = new Map();
  
  constructor(config: NATTraversalConfig) {
    super();
    this.config = config;
  }
  
  // システムの開始
  async start(): Promise<void> {
    try {
      // UDPソケットの作成
      this.udpSocket = dgram.createSocket('udp4');
      this.setupUdpHandlers();
      
      // ランダムポートでバインド
      const port = this.getRandomPort();
      await new Promise<void>((resolve, reject) => {
        this.udpSocket!.bind(port, '0.0.0.0', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      // NAT検出
      await this.detectNATType();
      
      // UPnP検出と設定
      await this.setupUPnP();
      
      // TCPフォールバックサーバー
      await this.setupTCPServer();
      
      this.emit('started', {
        natType: this.natType,
        localPort: port
      });
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // NAT検出
  private async detectNATType(): Promise<void> {
    try {
      // 複数のSTUNサーバーでテスト
      const results = await Promise.all(
        this.config.stunServers.map(server => this.performSTUNTest(server))
      );
      
      // 結果の分析
      this.natType = this.analyzeSTUNResults(results);
      
      this.emit('natDetected', this.natType);
      
    } catch (error) {
      this.emit('error', { error, context: 'detectNATType' });
      this.natType = {
        type: 'unknown',
        externalAddress: '0.0.0.0',
        externalPort: 0,
        localAddress: this.getLocalAddress(),
        localPort: this.udpSocket?.address().port || 0,
        mappingBehavior: 'address_port_dependent',
        filteringBehavior: 'address_port_dependent'
      };
    }
  }
  
  // STUNテストの実行
  private async performSTUNTest(server: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const [host, port] = server.split(':');
      const stunPort = parseInt(port) || 3478;
      
      // STUNリクエストの作成
      const request = this.createSTUNRequest();
      
      // タイムアウト設定
      const timeout = setTimeout(() => {
        reject(new Error('STUN timeout'));
      }, this.config.stunTimeout);
      
      // 応答ハンドラー
      const responseHandler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (rinfo.address === host && rinfo.port === stunPort) {
          clearTimeout(timeout);
          
          try {
            const response = this.parseSTUNMessage(msg);
            if (this.isSTUNResponse(response, request)) {
              const mappedAddress = this.extractMappedAddress(response);
              resolve({
                server,
                externalAddress: mappedAddress.address,
                externalPort: mappedAddress.port,
                localPort: this.udpSocket?.address().port
              });
            }
          } catch (error) {
            reject(error);
          }
        }
      };
      
      // 一時的なハンドラー登録
      this.udpSocket?.once('message', responseHandler);
      
      // リクエスト送信
      const message = this.encodeSTUNMessage(request);
      this.udpSocket?.send(message, stunPort, host, (err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }
  
  // ピアへの接続
  async connectToPeer(peerId: string, peerInfo: any): Promise<PeerConnection> {
    try {
      // 既存の接続をチェック
      const existing = this.connections.get(peerId);
      if (existing && existing.status === 'connected') {
        return existing;
      }
      
      // 接続方法の選択
      const connectionMethod = this.selectConnectionMethod(peerInfo);
      
      let connection: PeerConnection;
      
      switch (connectionMethod) {
        case 'direct':
          connection = await this.establishDirectConnection(peerId, peerInfo);
          break;
          
        case 'upnp':
          connection = await this.establishUPnPConnection(peerId, peerInfo);
          break;
          
        case 'relay':
          connection = await this.establishRelayConnection(peerId, peerInfo);
          break;
          
        default:
          throw new Error('No suitable connection method');
      }
      
      // 接続の保存
      this.connections.set(peerId, connection);
      
      // キープアライブの開始
      this.startKeepAlive(peerId);
      
      this.emit('connectionEstablished', connection);
      
      return connection;
      
    } catch (error) {
      this.emit('error', { error, context: 'connectToPeer', peerId });
      throw error;
    }
  }
  
  // 直接接続の確立（UDP ホールパンチング）
  private async establishDirectConnection(
    peerId: string,
    peerInfo: any
  ): Promise<PeerConnection> {
    const punchRequest: HolePunchRequest = {
      requestId: this.generateRequestId(),
      fromPeer: 'self',
      toPeer: peerId,
      localEndpoint: {
        address: this.natType?.externalAddress || '',
        port: this.natType?.externalPort || 0,
        type: 'public'
      },
      remoteEndpoint: {
        address: peerInfo.address,
        port: peerInfo.port,
        type: 'public'
      },
      timestamp: Date.now(),
      attempts: 0
    };
    
    this.pendingPunches.set(punchRequest.requestId, punchRequest);
    
    // ホールパンチングの実行
    const success = await this.performHolePunching(punchRequest);
    
    if (!success) {
      throw new Error('Hole punching failed');
    }
    
    // 接続の作成
    const connection: PeerConnection = {
      peerId,
      localEndpoint: punchRequest.localEndpoint,
      remoteEndpoint: punchRequest.remoteEndpoint,
      connectionType: 'direct',
      status: 'connected',
      established: Date.now(),
      lastActivity: Date.now(),
      statistics: {
        bytesSent: 0,
        bytesReceived: 0,
        packetsSent: 0,
        packetsReceived: 0,
        latency: 0,
        jitter: 0,
        packetLoss: 0
      }
    };
    
    return connection;
  }
  
  // ホールパンチングの実行
  private async performHolePunching(request: HolePunchRequest): Promise<boolean> {
    const maxAttempts = this.config.maxRetries;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      request.attempts = attempt + 1;
      
      try {
        // 両方向からパケットを送信
        await this.sendPunchPackets(request);
        
        // 応答を待つ
        const response = await this.waitForPunchResponse(request);
        
        if (response) {
          this.emit('holePunchSuccess', request);
          return true;
        }
        
      } catch (error) {
        this.emit('holePunchAttempt', { request, attempt, error });
      }
      
      // リトライ前の遅延
      if (attempt < maxAttempts - 1) {
        await this.delay(this.config.retryDelay);
      }
    }
    
    this.emit('holePunchFailed', request);
    return false;
  }
  
  // パンチパケットの送信
  private async sendPunchPackets(request: HolePunchRequest): Promise<void> {
    const message = Buffer.from(JSON.stringify({
      type: 'hole_punch',
      requestId: request.requestId,
      fromPeer: request.fromPeer,
      timestamp: Date.now()
    }));
    
    // 複数のパケットを送信（成功率向上のため）
    for (let i = 0; i < 5; i++) {
      this.udpSocket?.send(
        message,
        request.remoteEndpoint.port,
        request.remoteEndpoint.address
      );
      
      await this.delay(10); // 短い遅延
    }
  }
  
  // パンチ応答の待機
  private async waitForPunchResponse(request: HolePunchRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, this.config.punchTimeout);
      
      const handler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        try {
          const data = JSON.parse(msg.toString());
          
          if (data.type === 'hole_punch_response' && 
              data.requestId === request.requestId) {
            clearTimeout(timeout);
            resolve(true);
          }
        } catch (error) {
          // 無視
        }
      };
      
      this.udpSocket?.once('message', handler);
    });
  }
  
  // UPnP接続の確立
  private async establishUPnPConnection(
    peerId: string,
    peerInfo: any
  ): Promise<PeerConnection> {
    // UPnPポートマッピング
    const localPort = this.getRandomPort();
    const externalPort = await this.createUPnPMapping(localPort);
    
    if (!externalPort) {
      throw new Error('UPnP mapping failed');
    }
    
    // 接続情報の交換（シグナリングサーバー経由）
    await this.exchangeConnectionInfo(peerId, {
      address: this.natType?.externalAddress,
      port: externalPort
    });
    
    // 接続の作成
    const connection: PeerConnection = {
      peerId,
      localEndpoint: {
        address: this.getLocalAddress(),
        port: localPort,
        type: 'private'
      },
      remoteEndpoint: {
        address: peerInfo.address,
        port: peerInfo.port,
        type: 'public'
      },
      connectionType: 'upnp',
      status: 'connected',
      established: Date.now(),
      lastActivity: Date.now(),
      statistics: {
        bytesSent: 0,
        bytesReceived: 0,
        packetsSent: 0,
        packetsReceived: 0,
        latency: 0,
        jitter: 0,
        packetLoss: 0
      }
    };
    
    return connection;
  }
  
  // リレー接続の確立（TURN）
  private async establishRelayConnection(
    peerId: string,
    peerInfo: any
  ): Promise<PeerConnection> {
    if (!this.config.turnServers || this.config.turnServers.length === 0) {
      throw new Error('No TURN servers configured');
    }
    
    // TURNサーバーへの接続
    const turnServer = this.config.turnServers[0];
    const relayEndpoint = await this.allocateTURNRelay(turnServer);
    
    if (!relayEndpoint) {
      throw new Error('TURN allocation failed');
    }
    
    // 接続情報の交換
    await this.exchangeConnectionInfo(peerId, relayEndpoint);
    
    // 接続の作成
    const connection: PeerConnection = {
      peerId,
      localEndpoint: relayEndpoint,
      remoteEndpoint: {
        address: peerInfo.relayAddress || peerInfo.address,
        port: peerInfo.relayPort || peerInfo.port,
        type: 'relay'
      },
      connectionType: 'relay',
      status: 'connected',
      established: Date.now(),
      lastActivity: Date.now(),
      statistics: {
        bytesSent: 0,
        bytesReceived: 0,
        packetsSent: 0,
        packetsReceived: 0,
        latency: 0,
        jitter: 0,
        packetLoss: 0
      }
    };
    
    return connection;
  }
  
  // データの送信
  async sendData(peerId: string, data: Buffer): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection || connection.status !== 'connected') {
      throw new Error('No active connection to peer');
    }
    
    // 暗号化（オプション）
    const payload = this.config.enableEncryption ? 
      this.encryptData(data) : data;
    
    // 接続タイプに応じた送信
    switch (connection.connectionType) {
      case 'direct':
      case 'upnp':
        this.udpSocket?.send(
          payload,
          connection.remoteEndpoint.port,
          connection.remoteEndpoint.address
        );
        break;
        
      case 'relay':
        // TURNリレー経由での送信
        await this.sendViaTURN(connection, payload);
        break;
    }
    
    // 統計の更新
    connection.statistics.bytesSent += payload.length;
    connection.statistics.packetsSent++;
    connection.lastActivity = Date.now();
  }
  
  // UDPハンドラーのセットアップ
  private setupUdpHandlers(): void {
    if (!this.udpSocket) return;
    
    this.udpSocket.on('message', (msg, rinfo) => {
      // 接続の特定
      const connection = this.findConnectionByEndpoint(rinfo);
      
      if (connection) {
        // 統計の更新
        connection.statistics.bytesReceived += msg.length;
        connection.statistics.packetsReceived++;
        connection.lastActivity = Date.now();
        
        // 復号化（オプション）
        const data = this.config.enableEncryption ? 
          this.decryptData(msg) : msg;
        
        this.emit('dataReceived', {
          peerId: connection.peerId,
          data,
          connection
        });
      }
    });
    
    this.udpSocket.on('error', (error) => {
      this.emit('error', { error, context: 'udpSocket' });
    });
  }
  
  // TCPフォールバックサーバーのセットアップ
  private async setupTCPServer(): Promise<void> {
    this.tcpServer = net.createServer((socket) => {
      // TCP接続の処理
      this.handleTCPConnection(socket);
    });
    
    const port = this.getRandomPort();
    
    await new Promise<void>((resolve, reject) => {
      this.tcpServer!.listen(port, '0.0.0.0', () => {
        resolve();
      });
      
      this.tcpServer!.on('error', reject);
    });
  }
  
  // UPnPのセットアップ
  private async setupUPnP(): Promise<void> {
    try {
      // UPnPクライアントの初期化（実装依存）
      // this.upnpClient = new UPnPClient();
      
      // デバイスの検出
      // const devices = await this.upnpClient.discover();
      
      // ルーターの選択
      // this.upnpRouter = devices.find(d => d.type === 'InternetGatewayDevice');
      
      this.emit('upnpReady');
    } catch (error) {
      this.emit('upnpFailed', error);
    }
  }
  
  // UPnPポートマッピングの作成
  private async createUPnPMapping(localPort: number): Promise<number | null> {
    try {
      // 実装依存
      // const externalPort = await this.upnpClient.addPortMapping({
      //   protocol: 'UDP',
      //   internalPort: localPort,
      //   externalPort: localPort,
      //   description: 'Otedama P2P'
      // });
      
      const externalPort = localPort; // 仮実装
      
      this.upnpMappings.set(localPort, `UDP:${externalPort}`);
      
      return externalPort;
    } catch (error) {
      return null;
    }
  }
  
  // STUNメッセージのユーティリティ
  private createSTUNRequest(): StunMessage {
    return {
      type: STUN_BINDING_REQUEST,
      transactionId: crypto.randomBytes(12),
      attributes: new Map()
    };
  }
  
  private encodeSTUNMessage(message: StunMessage): Buffer {
    // STUNメッセージのエンコード（RFC 5389）
    const buffer = Buffer.allocUnsafe(20); // ヘッダーサイズ
    
    // メッセージタイプ
    buffer.writeUInt16BE(message.type, 0);
    
    // メッセージ長（属性なしの場合は0）
    buffer.writeUInt16BE(0, 2);
    
    // マジッククッキー
    buffer.writeUInt32BE(0x2112A442, 4);
    
    // トランザクションID
    message.transactionId.copy(buffer, 8);
    
    return buffer;
  }
  
  private parseSTUNMessage(buffer: Buffer): StunMessage {
    if (buffer.length < 20) {
      throw new Error('Invalid STUN message');
    }
    
    return {
      type: buffer.readUInt16BE(0),
      transactionId: buffer.slice(8, 20),
      attributes: this.parseSTUNAttributes(buffer.slice(20))
    };
  }
  
  private parseSTUNAttributes(buffer: Buffer): Map<number, Buffer> {
    const attributes = new Map<number, Buffer>();
    let offset = 0;
    
    while (offset < buffer.length) {
      if (offset + 4 > buffer.length) break;
      
      const type = buffer.readUInt16BE(offset);
      const length = buffer.readUInt16BE(offset + 2);
      
      if (offset + 4 + length > buffer.length) break;
      
      attributes.set(type, buffer.slice(offset + 4, offset + 4 + length));
      
      // パディングを考慮
      offset += 4 + ((length + 3) & ~3);
    }
    
    return attributes;
  }
  
  private isSTUNResponse(response: StunMessage, request: StunMessage): boolean {
    return response.type === STUN_BINDING_RESPONSE &&
           response.transactionId.equals(request.transactionId);
  }
  
  private extractMappedAddress(message: StunMessage): any {
    // XOR-MAPPED-ADDRESSを優先
    let attr = message.attributes.get(STUN_ATTR_XOR_MAPPED_ADDRESS);
    if (!attr) {
      attr = message.attributes.get(STUN_ATTR_MAPPED_ADDRESS);
    }
    
    if (!attr || attr.length < 8) {
      throw new Error('No mapped address found');
    }
    
    const family = attr.readUInt16BE(0);
    const port = attr.readUInt16BE(2);
    
    if (family === 0x0001) { // IPv4
      const address = `${attr[4]}.${attr[5]}.${attr[6]}.${attr[7]}`;
      return { address, port };
    } else {
      throw new Error('IPv6 not supported');
    }
  }
  
  // ヘルパーメソッド
  private getRandomPort(): number {
    const { min, max } = this.config.portRange;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  private getLocalAddress(): string {
    const interfaces = require('os').networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    return '127.0.0.1';
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private generateRequestId(): string {
    return createHash('sha256')
      .update(Date.now().toString())
      .update(Math.random().toString())
      .digest('hex')
      .substring(0, 16);
  }
  
  private selectConnectionMethod(peerInfo: any): string {
    // 接続方法の優先順位
    if (this.canUseDirectConnection(peerInfo)) {
      return 'direct';
    } else if (this.upnpMappings.size > 0) {
      return 'upnp';
    } else {
      return 'relay';
    }
  }
  
  private canUseDirectConnection(peerInfo: any): boolean {
    // 両方のNATタイプが互換性があるかチェック
    if (!this.natType || !peerInfo.natType) {
      return false;
    }
    
    // Full Cone NATは誰とでも接続可能
    if (this.natType.type === 'full_cone' || peerInfo.natType === 'full_cone') {
      return true;
    }
    
    // その他の組み合わせはケースバイケース
    return this.natType.type !== 'symmetric' && peerInfo.natType !== 'symmetric';
  }
  
  private findConnectionByEndpoint(rinfo: dgram.RemoteInfo): PeerConnection | null {
    for (const connection of this.connections.values()) {
      if (connection.remoteEndpoint.address === rinfo.address &&
          connection.remoteEndpoint.port === rinfo.port) {
        return connection;
      }
    }
    return null;
  }
  
  private startKeepAlive(peerId: string): void {
    const timer = setInterval(() => {
      const keepAlive = Buffer.from(JSON.stringify({
        type: 'keep_alive',
        timestamp: Date.now()
      }));
      
      this.sendData(peerId, keepAlive).catch(() => {
        // 接続が切れた場合
        this.handleConnectionLost(peerId);
      });
    }, this.config.keepAliveInterval);
    
    this.keepAliveTimers.set(peerId, timer);
  }
  
  private handleConnectionLost(peerId: string): void {
    const connection = this.connections.get(peerId);
    if (connection) {
      connection.status = 'closed';
      this.connections.delete(peerId);
      
      const timer = this.keepAliveTimers.get(peerId);
      if (timer) {
        clearInterval(timer);
        this.keepAliveTimers.delete(peerId);
      }
      
      this.emit('connectionLost', { peerId, connection });
    }
  }
  
  private encryptData(data: Buffer): Buffer {
    // 暗号化の実装（簡略化）
    return data;
  }
  
  private decryptData(data: Buffer): Buffer {
    // 復号化の実装（簡略化）
    return data;
  }
  
  private analyzeSTUNResults(results: any[]): NATType {
    // STUN結果からNATタイプを判定
    // 実際の実装では複数のテストを組み合わせて判定
    
    if (results.length === 0) {
      throw new Error('No STUN results');
    }
    
    const first = results[0];
    
    return {
      type: 'unknown', // 実際には詳細な判定ロジックが必要
      externalAddress: first.externalAddress,
      externalPort: first.externalPort,
      localAddress: this.getLocalAddress(),
      localPort: first.localPort,
      mappingBehavior: 'endpoint_independent',
      filteringBehavior: 'endpoint_independent'
    };
  }
  
  private async exchangeConnectionInfo(peerId: string, endpoint: Endpoint): Promise<void> {
    // シグナリングサーバー経由で接続情報を交換
    // 実装依存
  }
  
  private async allocateTURNRelay(server: TurnServer): Promise<Endpoint | null> {
    // TURNサーバーからリレーアドレスを取得
    // 実装依存
    return null;
  }
  
  private async sendViaTURN(connection: PeerConnection, data: Buffer): Promise<void> {
    // TURNリレー経由でデータ送信
    // 実装依存
  }
  
  private handleTCPConnection(socket: net.Socket): void {
    // TCP接続の処理
    // 実装依存
  }
  
  // 公開API
  getNATType(): NATType | null {
    return this.natType || null;
  }
  
  getConnection(peerId: string): PeerConnection | null {
    return this.connections.get(peerId) || null;
  }
  
  getAllConnections(): PeerConnection[] {
    return Array.from(this.connections.values());
  }
  
  async disconnect(peerId: string): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    
    // UPnPマッピングの削除
    if (connection.connectionType === 'upnp') {
      const localPort = connection.localEndpoint.port;
      this.upnpMappings.delete(localPort);
      // await this.upnpClient.removePortMapping(localPort);
    }
    
    // キープアライブの停止
    const timer = this.keepAliveTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(peerId);
    }
    
    // 接続の削除
    this.connections.delete(peerId);
    
    this.emit('disconnected', { peerId });
  }
  
  async stop(): Promise<void> {
    // すべての接続を閉じる
    for (const peerId of this.connections.keys()) {
      await this.disconnect(peerId);
    }
    
    // UPnPマッピングをすべて削除
    for (const [port] of this.upnpMappings) {
      // await this.upnpClient.removePortMapping(port);
    }
    
    // ソケットを閉じる
    this.udpSocket?.close();
    this.tcpServer?.close();
    
    this.emit('stopped');
  }
}

export default NATTraversalManager;