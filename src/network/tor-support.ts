/**
 * Tor対応実装
 * 匿名性とプライバシー保護のためのTorネットワーク統合
 * 
 * 設計思想：
 * - Carmack: 効率的なTor回路の管理
 * - Martin: セキュアな匿名通信レイヤー
 * - Pike: シンプルで安全な実装
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// === 型定義 ===
export interface TorConfig {
  // Tor設定
  torPath?: string;                 // Torバイナリのパス
  torrcPath?: string;              // torrcファイルのパス
  dataDirectory: string;           // Torデータディレクトリ
  
  // ポート設定
  socksPort: number;               // SOCKSプロキシポート
  controlPort: number;             // コントロールポート
  hiddenServicePort?: number;      // Hidden Serviceポート
  
  // 認証設定
  controlPassword?: string;        // コントロールパスワード
  cookieAuth: boolean;            // クッキー認証の使用
  
  // 回路設定
  circuitBuildTimeout: number;     // 回路構築タイムアウト（秒）
  maxCircuits: number;            // 最大回路数
  newCircuitPeriod: number;       // 新規回路の作成間隔（秒）
  
  // セキュリティ設定
  enforceDistinctSubnets: boolean; // 異なるサブネットの強制
  strictNodes: boolean;           // 厳格なノード選択
  excludeNodes?: string[];        // 除外ノードリスト
  excludeExitNodes?: string[];    // 除外出口ノードリスト
  
  // Hidden Service設定
  createHiddenService: boolean;    // Hidden Serviceの作成
  hiddenServiceVersion: 2 | 3;     // v2 (非推奨) または v3
}

export interface TorCircuit {
  id: string;
  status: 'building' | 'built' | 'failed' | 'closed';
  path: TorNode[];
  purpose: string;
  createdAt: number;
  bandwidth: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface TorNode {
  fingerprint: string;
  nickname?: string;
  address: string;
  orPort: number;
  flags: string[];
  bandwidth: number;
  country?: string;
}

export interface HiddenService {
  hostname: string;                // .onionアドレス
  privateKey: string;             // 秘密鍵
  version: 2 | 3;
  ports: Array<{
    virtualPort: number;
    targetPort: number;
  }>;
  createdAt: number;
}

export interface TorConnection {
  id: string;
  type: 'direct' | 'hidden_service';
  localAddress?: string;
  remoteAddress: string;
  circuit?: TorCircuit;
  status: 'connecting' | 'connected' | 'closed';
  statistics: ConnectionStatistics;
}

export interface ConnectionStatistics {
  bytesReceived: number;
  bytesSent: number;
  latency: number;
  establishedAt?: number;
  closedAt?: number;
}

export interface TorStatus {
  running: boolean;
  version: string;
  uptime: number;
  circuits: number;
  streams: number;
  orConnections: number;
  bandwidth: {
    read: number;
    written: number;
    rate: number;
    burst: number;
  };
}

// === Torマネージャー ===
export class TorManager extends EventEmitter {
  private config: TorConfig;
  private torProcess?: ChildProcess;
  private controlSocket?: net.Socket;
  private circuits: Map<string, TorCircuit> = new Map();
  private connections: Map<string, TorConnection> = new Map();
  private hiddenServices: Map<string, HiddenService> = new Map();
  private isAuthenticated = false;
  private torStatus?: TorStatus;
  
  // メトリクス
  private metrics = {
    circuitsCreated: 0,
    circuitsFailed: 0,
    connectionsTotal: 0,
    connectionsActive: 0,
    totalBytesRead: 0,
    totalBytesWritten: 0
  };
  
  constructor(config: TorConfig) {
    super();
    this.config = config;
  }
  
  // Torの起動
  async start(): Promise<void> {
    try {
      // データディレクトリの作成
      await this.ensureDataDirectory();
      
      // torrcファイルの生成
      await this.generateTorrc();
      
      // Torプロセスの起動
      await this.startTorProcess();
      
      // コントロール接続の確立
      await this.connectToControl();
      
      // 認証
      await this.authenticate();
      
      // イベントの購読
      await this.subscribeToEvents();
      
      // Hidden Serviceの設定
      if (this.config.createHiddenService) {
        await this.setupHiddenService();
      }
      
      // 初期回路の構築
      await this.buildInitialCircuits();
      
      this.emit('started', { status: await this.getStatus() });
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // torrcファイルの生成
  private async generateTorrc(): Promise<void> {
    const torrcContent = [
      `DataDirectory ${this.config.dataDirectory}`,
      `SocksPort ${this.config.socksPort}`,
      `ControlPort ${this.config.controlPort}`,
      
      // 認証設定
      this.config.cookieAuth ? 
        'CookieAuthentication 1' : 
        `HashedControlPassword ${this.hashPassword(this.config.controlPassword || '')}`,
      
      // セキュリティ設定
      this.config.enforceDistinctSubnets ? 'EnforceDistinctSubnets 1' : '',
      this.config.strictNodes ? 'StrictNodes 1' : '',
      
      // 除外ノード
      this.config.excludeNodes?.length ? 
        `ExcludeNodes ${this.config.excludeNodes.join(',')}` : '',
      this.config.excludeExitNodes?.length ? 
        `ExcludeExitNodes ${this.config.excludeExitNodes.join(',')}` : '',
      
      // パフォーマンス設定
      `CircuitBuildTimeout ${this.config.circuitBuildTimeout}`,
      `MaxCircuitDirtiness ${this.config.newCircuitPeriod}`,
      
      // Hidden Service設定
      this.config.createHiddenService ? [
        `HiddenServiceDir ${path.join(this.config.dataDirectory, 'hidden_service')}`,
        `HiddenServicePort ${this.config.hiddenServicePort || 9999} 127.0.0.1:${this.config.hiddenServicePort || 9999}`,
        `HiddenServiceVersion ${this.config.hiddenServiceVersion}`
      ].join('\n') : ''
    ].filter(line => line.length > 0).join('\n');
    
    const torrcPath = this.config.torrcPath || 
      path.join(this.config.dataDirectory, 'torrc');
    
    await fs.writeFile(torrcPath, torrcContent);
  }
  
  // Torプロセスの起動
  private async startTorProcess(): Promise<void> {
    const torPath = this.config.torPath || 'tor';
    const torrcPath = this.config.torrcPath || 
      path.join(this.config.dataDirectory, 'torrc');
    
    this.torProcess = spawn(torPath, ['-f', torrcPath]);
    
    // 起動の待機
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error('Tor startup timeout'));
      }, 30000);
      
      this.torProcess!.stdout?.on('data', (data) => {
        output += data.toString();
        
        if (output.includes('Bootstrapped 100%')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.torProcess!.stderr?.on('data', (data) => {
        this.emit('torError', data.toString());
      });
      
      this.torProcess!.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
  
  // コントロール接続
  private async connectToControl(): Promise<void> {
    this.controlSocket = new net.Socket();
    
    await new Promise<void>((resolve, reject) => {
      this.controlSocket!.connect(this.config.controlPort, '127.0.0.1', () => {
        resolve();
      });
      
      this.controlSocket!.on('error', reject);
    });
    
    // コントロールメッセージハンドラー
    this.setupControlHandlers();
  }
  
  // 認証
  private async authenticate(): Promise<void> {
    if (this.config.cookieAuth) {
      // クッキー認証
      const cookiePath = path.join(this.config.dataDirectory, 'control_auth_cookie');
      const cookie = await fs.readFile(cookiePath);
      await this.sendCommand(`AUTHENTICATE ${cookie.toString('hex')}`);
    } else {
      // パスワード認証
      await this.sendCommand(`AUTHENTICATE "${this.config.controlPassword || ''}"`);
    }
    
    this.isAuthenticated = true;
  }
  
  // イベント購読
  private async subscribeToEvents(): Promise<void> {
    await this.sendCommand('SETEVENTS CIRC STREAM ORCONN BW WARN ERR');
  }
  
  // コントロールハンドラー
  private setupControlHandlers(): void {
    let buffer = '';
    
    this.controlSocket!.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        this.handleControlMessage(line);
      }
    });
    
    this.controlSocket!.on('error', (error) => {
      this.emit('controlError', error);
    });
    
    this.controlSocket!.on('close', () => {
      this.isAuthenticated = false;
      this.emit('controlClosed');
    });
  }
  
  // コントロールメッセージの処理
  private handleControlMessage(line: string): void {
    // イベントメッセージ
    if (line.startsWith('650')) {
      const parts = line.split(' ');
      const eventType = parts[1];
      
      switch (eventType) {
        case 'CIRC':
          this.handleCircuitEvent(line);
          break;
        case 'STREAM':
          this.handleStreamEvent(line);
          break;
        case 'ORCONN':
          this.handleORConnEvent(line);
          break;
        case 'BW':
          this.handleBandwidthEvent(line);
          break;
        case 'WARN':
        case 'ERR':
          this.emit('torWarning', line);
          break;
      }
    }
  }
  
  // 回路イベントの処理
  private handleCircuitEvent(line: string): void {
    // 650 CIRC circuit_id status path purpose
    const match = line.match(/650 CIRC (\d+) (\w+)(.*)/);
    if (!match) return;
    
    const [, circuitId, status, rest] = match;
    
    let circuit = this.circuits.get(circuitId);
    if (!circuit) {
      circuit = {
        id: circuitId,
        status: 'building',
        path: [],
        purpose: '',
        createdAt: Date.now(),
        bandwidth: 0,
        bytesRead: 0,
        bytesWritten: 0
      };
      this.circuits.set(circuitId, circuit);
      this.metrics.circuitsCreated++;
    }
    
    circuit.status = status.toLowerCase() as any;
    
    if (status === 'BUILT') {
      this.emit('circuitBuilt', circuit);
    } else if (status === 'FAILED' || status === 'CLOSED') {
      if (status === 'FAILED') {
        this.metrics.circuitsFailed++;
      }
      this.circuits.delete(circuitId);
      this.emit('circuitClosed', circuit);
    }
  }
  
  // ストリームイベントの処理
  private handleStreamEvent(line: string): void {
    // ストリーム（接続）のイベント処理
    this.emit('streamEvent', line);
  }
  
  // OR接続イベントの処理
  private handleORConnEvent(line: string): void {
    // Onion Router接続のイベント処理
    this.emit('orConnEvent', line);
  }
  
  // 帯域幅イベントの処理
  private handleBandwidthEvent(line: string): void {
    // 650 BW bytes_read bytes_written
    const match = line.match(/650 BW (\d+) (\d+)/);
    if (!match) return;
    
    const [, bytesRead, bytesWritten] = match;
    
    this.metrics.totalBytesRead += parseInt(bytesRead);
    this.metrics.totalBytesWritten += parseInt(bytesWritten);
    
    this.emit('bandwidth', {
      read: parseInt(bytesRead),
      written: parseInt(bytesWritten)
    });
  }
  
  // コマンド送信
  private async sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket || !this.isAuthenticated) {
        reject(new Error('Not connected to Tor control'));
        return;
      }
      
      let response = '';
      
      const handler = (data: Buffer) => {
        response += data.toString();
        
        if (response.includes('\r\n')) {
          const lines = response.split('\r\n');
          const lastLine = lines[lines.length - 2]; // 最後の完全な行
          
          if (lastLine.startsWith('250 ')) {
            // 成功
            this.controlSocket!.removeListener('data', handler);
            resolve(response);
          } else if (lastLine.match(/^[45]\d\d /)) {
            // エラー
            this.controlSocket!.removeListener('data', handler);
            reject(new Error(lastLine));
          }
        }
      };
      
      this.controlSocket.on('data', handler);
      this.controlSocket.write(command + '\r\n');
      
      // タイムアウト
      setTimeout(() => {
        this.controlSocket?.removeListener('data', handler);
        reject(new Error('Command timeout'));
      }, 5000);
    });
  }
  
  // 初期回路の構築
  private async buildInitialCircuits(): Promise<void> {
    // 複数の回路を事前に構築
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < Math.min(3, this.config.maxCircuits); i++) {
      promises.push(this.buildNewCircuit());
    }
    
    await Promise.allSettled(promises);
  }
  
  // 新規回路の構築
  async buildNewCircuit(purpose?: string): Promise<string> {
    const response = await this.sendCommand(
      purpose ? `EXTENDCIRCUIT 0 purpose=${purpose}` : 'EXTENDCIRCUIT 0'
    );
    
    const match = response.match(/250 EXTENDED (\d+)/);
    if (!match) {
      throw new Error('Failed to build circuit');
    }
    
    return match[1];
  }
  
  // Hidden Serviceのセットアップ
  private async setupHiddenService(): Promise<void> {
    const hsDir = path.join(this.config.dataDirectory, 'hidden_service');
    
    // ホスト名の読み取り
    const hostnamePath = path.join(hsDir, 'hostname');
    const hostname = await fs.readFile(hostnamePath, 'utf-8');
    
    // 秘密鍵の読み取り
    const privateKeyPath = path.join(hsDir, 
      this.config.hiddenServiceVersion === 3 ? 'hs_ed25519_secret_key' : 'private_key'
    );
    const privateKey = await fs.readFile(privateKeyPath);
    
    const hiddenService: HiddenService = {
      hostname: hostname.trim(),
      privateKey: privateKey.toString('base64'),
      version: this.config.hiddenServiceVersion,
      ports: [{
        virtualPort: this.config.hiddenServicePort || 9999,
        targetPort: this.config.hiddenServicePort || 9999
      }],
      createdAt: Date.now()
    };
    
    this.hiddenServices.set(hostname.trim(), hiddenService);
    
    this.emit('hiddenServiceCreated', hiddenService);
  }
  
  // SOCKS接続の作成
  async createConnection(
    address: string,
    port: number,
    isOnion = false
  ): Promise<TorConnection> {
    const connectionId = this.generateConnectionId();
    
    const connection: TorConnection = {
      id: connectionId,
      type: isOnion ? 'hidden_service' : 'direct',
      remoteAddress: `${address}:${port}`,
      status: 'connecting',
      statistics: {
        bytesReceived: 0,
        bytesSent: 0,
        latency: 0
      }
    };
    
    this.connections.set(connectionId, connection);
    this.metrics.connectionsTotal++;
    this.metrics.connectionsActive++;
    
    try {
      // SOCKS5プロキシ経由で接続
      const socket = await this.connectViaSocks(address, port);
      
      connection.status = 'connected';
      connection.statistics.establishedAt = Date.now();
      
      // ソケットハンドラー
      this.setupConnectionHandlers(socket, connection);
      
      this.emit('connectionEstablished', connection);
      
      return connection;
      
    } catch (error) {
      connection.status = 'closed';
      this.metrics.connectionsActive--;
      this.connections.delete(connectionId);
      throw error;
    }
  }
  
  // SOCKS5接続
  private async connectViaSocks(
    address: string,
    port: number
  ): Promise<net.Socket> {
    const socket = new net.Socket();
    
    // SOCKSプロキシに接続
    await new Promise<void>((resolve, reject) => {
      socket.connect(this.config.socksPort, '127.0.0.1', () => {
        resolve();
      });
      
      socket.on('error', reject);
    });
    
    // SOCKS5ハンドシェイク
    await this.performSocks5Handshake(socket, address, port);
    
    return socket;
  }
  
  // SOCKS5ハンドシェイク
  private async performSocks5Handshake(
    socket: net.Socket,
    address: string,
    port: number
  ): Promise<void> {
    // 認証方法の送信
    socket.write(Buffer.from([
      0x05, // SOCKS5
      0x01, // 認証方法数
      0x00  // 認証なし
    ]));
    
    // 認証応答の待機
    await new Promise<void>((resolve, reject) => {
      socket.once('data', (data) => {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          reject(new Error('SOCKS5 authentication failed'));
        } else {
          resolve();
        }
      });
    });
    
    // 接続リクエスト
    const isOnion = address.endsWith('.onion');
    const addressBuffer = isOnion ? 
      Buffer.from(address) : 
      Buffer.from(address.split('.').map(Number));
    
    const request = Buffer.concat([
      Buffer.from([
        0x05, // SOCKS5
        0x01, // CONNECT
        0x00, // 予約済み
        isOnion ? 0x03 : 0x01 // アドレスタイプ（ドメイン名 or IPv4）
      ]),
      isOnion ? Buffer.from([addressBuffer.length]) : Buffer.alloc(0),
      addressBuffer,
      Buffer.from([port >> 8, port & 0xff]) // ポート
    ]);
    
    socket.write(request);
    
    // 接続応答の待機
    await new Promise<void>((resolve, reject) => {
      socket.once('data', (data) => {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          const errors: { [key: number]: string } = {
            0x01: 'General SOCKS server failure',
            0x02: 'Connection not allowed by ruleset',
            0x03: 'Network unreachable',
            0x04: 'Host unreachable',
            0x05: 'Connection refused',
            0x06: 'TTL expired',
            0x07: 'Command not supported',
            0x08: 'Address type not supported'
          };
          reject(new Error(errors[data[1]] || 'Unknown SOCKS error'));
        } else {
          resolve();
        }
      });
    });
  }
  
  // 接続ハンドラーのセットアップ
  private setupConnectionHandlers(
    socket: net.Socket,
    connection: TorConnection
  ): void {
    socket.on('data', (data) => {
      connection.statistics.bytesReceived += data.length;
      this.emit('data', { connectionId: connection.id, data });
    });
    
    socket.on('close', () => {
      connection.status = 'closed';
      connection.statistics.closedAt = Date.now();
      this.metrics.connectionsActive--;
      this.emit('connectionClosed', connection);
    });
    
    socket.on('error', (error) => {
      this.emit('connectionError', { connection, error });
    });
    
    // 接続をソケットに関連付け
    (socket as any).torConnection = connection;
  }
  
  // データ送信
  async send(connectionId: string, data: Buffer): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.status !== 'connected') {
      throw new Error('Connection not found or not connected');
    }
    
    // ソケットを見つける（実装依存）
    // const socket = this.findSocketForConnection(connectionId);
    // socket.write(data);
    
    connection.statistics.bytesSent += data.length;
  }
  
  // 新しいアイデンティティ
  async newIdentity(): Promise<void> {
    await this.sendCommand('SIGNAL NEWNYM');
    
    // すべての回路をクリア
    for (const circuitId of this.circuits.keys()) {
      await this.closeCircuit(circuitId);
    }
    
    // 新しい回路を構築
    await this.buildInitialCircuits();
    
    this.emit('newIdentity');
  }
  
  // 回路のクローズ
  async closeCircuit(circuitId: string): Promise<void> {
    await this.sendCommand(`CLOSECIRCUIT ${circuitId}`);
    this.circuits.delete(circuitId);
  }
  
  // ステータスの取得
  async getStatus(): Promise<TorStatus> {
    const info = await this.sendCommand('GETINFO version uptime');
    const version = info.match(/version=([\d.]+)/)?.[1] || 'unknown';
    const uptime = parseInt(info.match(/uptime=(\d+)/)?.[1] || '0');
    
    return {
      running: !!this.torProcess && !this.torProcess.killed,
      version,
      uptime,
      circuits: this.circuits.size,
      streams: this.connections.size,
      orConnections: 0, // 実装依存
      bandwidth: {
        read: this.metrics.totalBytesRead,
        written: this.metrics.totalBytesWritten,
        rate: 0, // 実装依存
        burst: 0 // 実装依存
      }
    };
  }
  
  // ノード情報の取得
  async getNodeInfo(fingerprint: string): Promise<TorNode | null> {
    try {
      const response = await this.sendCommand(`GETINFO ns/id/${fingerprint}`);
      // レスポンスの解析（実装依存）
      return null;
    } catch (error) {
      return null;
    }
  }
  
  // Hidden Serviceの取得
  getHiddenService(): HiddenService | null {
    return this.hiddenServices.values().next().value || null;
  }
  
  // メトリクスの取得
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }
  
  // 停止
  async stop(): Promise<void> {
    // すべての接続をクローズ
    for (const connectionId of this.connections.keys()) {
      await this.closeConnection(connectionId);
    }
    
    // コントロール接続をクローズ
    if (this.controlSocket) {
      this.controlSocket.destroy();
    }
    
    // Torプロセスを停止
    if (this.torProcess && !this.torProcess.killed) {
      this.torProcess.kill('SIGTERM');
      
      // 正常終了を待つ
      await new Promise<void>((resolve) => {
        this.torProcess!.on('exit', () => {
          resolve();
        });
        
        // タイムアウト後に強制終了
        setTimeout(() => {
          if (!this.torProcess!.killed) {
            this.torProcess!.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      });
    }
    
    this.emit('stopped');
  }
  
  // ヘルパーメソッド
  private async ensureDataDirectory(): Promise<void> {
    await fs.mkdir(this.config.dataDirectory, { recursive: true });
  }
  
  private hashPassword(password: string): string {
    // Tor用のパスワードハッシュ（実装簡略化）
    return createHash('sha256').update(password).digest('hex');
  }
  
  private generateConnectionId(): string {
    return randomBytes(16).toString('hex');
  }
  
  private async closeConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.status = 'closed';
      this.connections.delete(connectionId);
      this.metrics.connectionsActive--;
    }
  }
}

export default TorManager;