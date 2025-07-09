// Network and protocol interface definitions
// Supporting various mining protocols and network configurations

export interface INetworkConfig {
  bindAddress: string;
  ports: number[];
  maxConnections: number;
  connectionTimeout: number;
  keepAliveInterval: number;
  enableIPv6: boolean;
  enableProxy: boolean;
  proxyProtocol?: 'v1' | 'v2';
  tcpNoDelay: boolean;
  socketTimeout: number;
}

// Stratum protocol interfaces
export interface IStratumServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(method: string, params: any[]): void;
  getConnectedMiners(): IStratumClient[];
  kickMiner(clientId: string, reason?: string): void;
  setDifficulty(clientId: string, difficulty: number): void;
  sendJob(clientId: string, job: IStratumJob): void;
}

export interface IStratumClient {
  id: string;
  socket: any;
  address: string;
  port: number;
  connectedAt: Date;
  authorized: boolean;
  subscribed: boolean;
  minerInfo?: {
    address: string;
    workerName?: string;
    userAgent?: string;
    version?: string;
  };
  difficulty: number;
  extraNonce1: string;
  stats: {
    sharesSubmitted: number;
    sharesAccepted: number;
    sharesRejected: number;
    lastShareAt?: Date;
  };
  
  send(data: any): void;
  close(reason?: string): void;
}

export interface IStratumJob {
  id: string;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranch: string[];
  version: string;
  bits: string;
  time: string;
  cleanJobs: boolean;
  target?: string;
  height?: number;
}

export interface IStratumMessage {
  id: number | null;
  method?: string;
  params?: any[];
  result?: any;
  error?: [number, string, any?];
}

// Stratum V2 interfaces
export interface IStratumV2Server {
  start(): Promise<void>;
  stop(): Promise<void>;
  getProtocolVersion(): string;
  negotiateProtocol(client: IStratumV2Client): Promise<IProtocolNegotiation>;
  openChannel(client: IStratumV2Client, request: IChannelRequest): Promise<IChannel>;
  submitShare(channelId: number, share: IStratumV2Share): Promise<boolean>;
  updateTarget(channelId: number, target: bigint): void;
}

export interface IStratumV2Client {
  id: string;
  connection: any;
  protocol: string;
  features: string[];
  channels: Map<number, IChannel>;
  publicKey?: Buffer;
  
  sendMessage(message: IStratumV2Message): void;
  close(errorCode?: number, reason?: string): void;
}

export interface IStratumV2Message {
  type: number;
  requestId?: number;
  payload: Buffer;
}

export interface IProtocolNegotiation {
  version: string;
  features: string[];
  extensions?: string[];
  flags: number;
}

export interface IChannelRequest {
  requestId: number;
  userIdentity: string;
  nominalHashrate: bigint;
  maxTarget: bigint;
}

export interface IChannel {
  id: number;
  userIdentity: string;
  target: bigint;
  extranonce: Buffer;
  extranonceSize: number;
  nominalHashrate: bigint;
  
  opened: boolean;
  groupChannelId?: number;
}

export interface IStratumV2Share {
  channelId: number;
  sequenceNumber: number;
  jobId: number;
  nonce: bigint;
  ntime: number;
  version?: number;
}

// WebSocket interfaces
export interface IWebSocketServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(event: string, data: any): void;
  sendToClient(clientId: string, event: string, data: any): void;
  getClients(): IWebSocketClient[];
  authenticate(clientId: string, token: string): Promise<boolean>;
  subscribe(clientId: string, channel: string): void;
  unsubscribe(clientId: string, channel: string): void;
}

export interface IWebSocketClient {
  id: string;
  socket: any;
  address: string;
  connectedAt: Date;
  authenticated: boolean;
  subscriptions: Set<string>;
  metadata?: Record<string, any>;
  
  send(event: string, data: any): void;
  close(code?: number, reason?: string): void;
}

export interface IWebSocketMessage {
  event: string;
  data: any;
  timestamp: number;
  id?: string;
}

// Multi-port server interfaces
export interface IMultiPortServer {
  addPort(port: number, config?: IPortConfig): Promise<void>;
  removePort(port: number): Promise<void>;
  getActivePorts(): IPortInfo[];
  setPortConfig(port: number, config: Partial<IPortConfig>): void;
  getPortStats(port: number): IPortStats;
  redistributeLoad(): Promise<void>;
}

export interface IPortConfig {
  protocol: 'stratum' | 'stratumv2' | 'websocket' | 'http';
  maxConnections?: number;
  difficulty?: number;
  algorithm?: string;
  ssl?: boolean;
  customHandler?: (client: any) => void;
}

export interface IPortInfo {
  port: number;
  protocol: string;
  connections: number;
  config: IPortConfig;
  status: 'active' | 'inactive' | 'error';
  startedAt: Date;
}

export interface IPortStats {
  port: number;
  totalConnections: number;
  activeConnections: number;
  bytesReceived: number;
  bytesSent: number;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  uptime: number;
}

// Protocol versioning interfaces
export interface IProtocolManager {
  registerProtocol(protocol: IProtocol): void;
  unregisterProtocol(name: string): void;
  getProtocol(name: string, version?: string): IProtocol | undefined;
  getSupportedProtocols(): IProtocolInfo[];
  negotiateProtocol(client: any, requested: string[]): IProtocol | undefined;
}

export interface IProtocol {
  name: string;
  version: string;
  description?: string;
  handler: IProtocolHandler;
  validator?: IProtocolValidator;
  capabilities?: string[];
}

export interface IProtocolHandler {
  handleConnect(client: any): Promise<void>;
  handleMessage(client: any, message: any): Promise<void>;
  handleDisconnect(client: any): Promise<void>;
  handleError(client: any, error: Error): Promise<void>;
}

export interface IProtocolValidator {
  validateMessage(message: any): boolean;
  validateClient(client: any): boolean;
  validateShare(share: any): boolean;
}

export interface IProtocolInfo {
  name: string;
  versions: string[];
  currentVersion: string;
  deprecated?: boolean;
  capabilities?: string[];
}

// Binary protocol interfaces
export interface IBinaryProtocol {
  encode(message: any): Buffer;
  decode(buffer: Buffer): any;
  encodeVarInt(value: number | bigint): Buffer;
  decodeVarInt(buffer: Buffer, offset?: number): { value: bigint; bytesRead: number };
  encodeString(str: string): Buffer;
  decodeString(buffer: Buffer, offset?: number): { value: string; bytesRead: number };
  calculateChecksum(data: Buffer): Buffer;
  verifyChecksum(data: Buffer, checksum: Buffer): boolean;
}

// Geographic distribution interfaces
export interface IGeographicPool {
  addRegion(region: IRegion): Promise<void>;
  removeRegion(regionId: string): Promise<void>;
  getRegions(): IRegion[];
  getClosestRegion(ip: string): Promise<IRegion>;
  routeClient(client: any): Promise<IRegion>;
  redistributeClients(): Promise<void>;
  syncRegions(): Promise<void>;
}

export interface IRegion {
  id: string;
  name: string;
  location: {
    country: string;
    city?: string;
    latitude: number;
    longitude: number;
  };
  endpoints: IEndpoint[];
  capacity: number;
  currentLoad: number;
  status: 'active' | 'maintenance' | 'offline';
  priority: number;
}

export interface IEndpoint {
  host: string;
  port: number;
  protocol: string;
  ssl?: boolean;
  weight: number;
  healthCheck?: {
    interval: number;
    timeout: number;
    healthy: boolean;
    lastCheck?: Date;
  };
}

// Mining proxy interfaces
export interface IMiningProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  addUpstream(upstream: IUpstreamPool): void;
  removeUpstream(id: string): void;
  getUpstreams(): IUpstreamPool[];
  setRoutingPolicy(policy: IRoutingPolicy): void;
  getProxyStats(): IProxyStats;
  failover(fromId: string, toId: string): Promise<void>;
}

export interface IUpstreamPool {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
  weight: number;
  priority: number;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  stats: {
    sharesSubmitted: number;
    sharesAccepted: number;
    lastShareAt?: Date;
    reconnects: number;
    errors: number;
  };
}

export interface IRoutingPolicy {
  type: 'roundrobin' | 'weighted' | 'priority' | 'leastconn' | 'custom';
  sticky?: boolean;
  failoverThreshold?: number;
  healthCheckInterval?: number;
  customLogic?: (client: any, upstreams: IUpstreamPool[]) => IUpstreamPool;
}

export interface IProxyStats {
  totalClients: number;
  totalUpstreams: number;
  activeUpstreams: number;
  totalShares: number;
  acceptedShares: number;
  rejectedShares: number;
  upstreamStats: Array<{
    id: string;
    clients: number;
    shares: number;
    hashrate: number;
  }>;
}

// Load balancing interfaces
export interface ILoadBalancer {
  addBackend(backend: IBackend): void;
  removeBackend(id: string): void;
  getBackends(): IBackend[];
  selectBackend(request: any): IBackend | undefined;
  healthCheck(): Promise<void>;
  getMetrics(): ILoadBalancerMetrics;
  setAlgorithm(algorithm: 'roundrobin' | 'leastconn' | 'weighted' | 'hash'): void;
}

export interface IBackend {
  id: string;
  host: string;
  port: number;
  weight: number;
  maxConnections: number;
  currentConnections: number;
  healthy: boolean;
  lastHealthCheck?: Date;
  metadata?: Record<string, any>;
}

export interface ILoadBalancerMetrics {
  totalRequests: number;
  totalConnections: number;
  backendMetrics: Array<{
    backendId: string;
    requests: number;
    connections: number;
    errors: number;
    avgResponseTime: number;
  }>;
  errorRate: number;
  avgResponseTime: number;
}
