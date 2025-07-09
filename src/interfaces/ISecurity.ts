// Security-related interface definitions
// Following the principle of least privilege and defense in depth

export interface ISecurityConfig {
  enableAuth: boolean;
  enableSSL: boolean;
  enableIPWhitelist: boolean;
  enableDDoSProtection: boolean;
  enableRateLimiting: boolean;
  maxConnectionsPerIP: number;
  banThreshold: number;
  banDuration: number;
  sslCert?: string;
  sslKey?: string;
  sslCA?: string;
}

// Authentication interfaces
export interface IAuthService {
  initialize(config: IAuthConfig): Promise<void>;
  authenticate(username: string, password: string): Promise<IAuthResult>;
  validateToken(token: string): Promise<ITokenValidation>;
  refreshToken(refreshToken: string): Promise<IAuthResult>;
  revokeToken(token: string): Promise<void>;
  createApiKey(userId: string, name: string, permissions: string[]): Promise<string>;
  validateApiKey(apiKey: string): Promise<IApiKeyValidation>;
  revokeApiKey(apiKey: string): Promise<void>;
}

export interface IAuthConfig {
  jwtSecret: string;
  tokenExpiry: number;
  refreshTokenExpiry: number;
  passwordHashRounds: number;
  enableTwoFactor?: boolean;
  enableApiKeys?: boolean;
}

export interface IAuthResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: IAuthUser;
  error?: string;
}

export interface IAuthUser {
  id: string;
  username: string;
  email?: string;
  role: 'admin' | 'user' | 'miner';
  permissions: string[];
  twoFactorEnabled: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface ITokenValidation {
  valid: boolean;
  userId?: string;
  permissions?: string[];
  expiresAt?: Date;
  error?: string;
}

export interface IApiKeyValidation {
  valid: boolean;
  userId?: string;
  name?: string;
  permissions?: string[];
  createdAt?: Date;
  lastUsedAt?: Date;
  error?: string;
}

// IP Management interfaces
export interface IIPManager {
  addToWhitelist(ip: string, comment?: string): Promise<void>;
  removeFromWhitelist(ip: string): Promise<void>;
  isWhitelisted(ip: string): boolean;
  getWhitelist(): IIPEntry[];
  
  banIP(ip: string, duration: number, reason: string): Promise<void>;
  unbanIP(ip: string): Promise<void>;
  isBanned(ip: string): boolean;
  getBannedIPs(): IBannedIP[];
  cleanupExpiredBans(): Promise<void>;
}

export interface IIPEntry {
  ip: string;
  comment?: string;
  addedAt: Date;
}

export interface IBannedIP {
  ip: string;
  reason: string;
  bannedAt: Date;
  expiresAt: Date;
  bannedBy?: string;
}

// DDoS Protection interfaces
export interface IDDoSProtection {
  initialize(config: IDDoSConfig): void;
  checkConnection(ip: string): boolean;
  checkRequest(ip: string, endpoint: string): boolean;
  recordConnection(ip: string): void;
  recordDisconnection(ip: string): void;
  getConnectionCount(ip: string): number;
  getTotalConnections(): number;
  getMetrics(): IDDoSMetrics;
  reset(): void;
}

export interface IDDoSConfig {
  maxConnectionsPerIP: number;
  maxGlobalConnections: number;
  connectionTimeout: number;
  requestsPerMinute: number;
  requestBurstSize: number;
  blockDuration: number;
}

export interface IDDoSMetrics {
  totalConnections: number;
  blockedConnections: number;
  uniqueIPs: number;
  topIPs: Array<{ ip: string; connections: number }>;
  requestsPerSecond: number;
  blockedRequests: number;
}

// Rate Limiting interfaces
export interface IRateLimiter {
  initialize(config: IRateLimitConfig): void;
  checkLimit(key: string, limit?: number): Promise<boolean>;
  consume(key: string, points?: number): Promise<IRateLimitResult>;
  block(key: string, duration: number): Promise<void>;
  reset(key: string): Promise<void>;
  getStatus(key: string): Promise<IRateLimitStatus>;
}

export interface IRateLimitConfig {
  points: number;
  duration: number;
  blockDuration: number;
  execEvenly: boolean;
  keyPrefix?: string;
}

export interface IRateLimitResult {
  allowed: boolean;
  remainingPoints: number;
  msBeforeNext: number;
  consumedPoints: number;
  isFirstInDuration: boolean;
}

export interface IRateLimitStatus {
  remainingPoints: number;
  consumedPoints: number;
  resetAt: Date;
  isBlocked: boolean;
  blockedUntil?: Date;
}

// SSL/TLS interfaces
export interface ISSLManager {
  initialize(config: ISSLConfig): Promise<void>;
  getCredentials(): ISSLCredentials;
  renewCertificate(): Promise<void>;
  validateCertificate(): Promise<boolean>;
  getCertificateInfo(): ICertificateInfo;
}

export interface ISSLConfig {
  certPath: string;
  keyPath: string;
  caPath?: string;
  autoRenew?: boolean;
  renewBeforeDays?: number;
}

export interface ISSLCredentials {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

export interface ICertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  daysRemaining: number;
  fingerprint: string;
  isValid: boolean;
}

// Security Monitoring interfaces
export interface ISecurityMonitor {
  initialize(): void;
  recordLoginAttempt(username: string, ip: string, success: boolean): void;
  recordShareSubmission(minerId: string, valid: boolean): void;
  recordAPIAccess(apiKey: string, endpoint: string, ip: string): void;
  detectAnomalies(): ISecurityAnomaly[];
  getSecurityMetrics(): ISecurityMetrics;
  generateSecurityReport(): ISecurityReport;
}

export interface ISecurityAnomaly {
  type: 'brute_force' | 'ddos' | 'invalid_shares' | 'api_abuse' | 'suspicious_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affectedEntity: string;
  detectedAt: Date;
  indicators: Record<string, any>;
  recommendedAction?: string;
}

export interface ISecurityMetrics {
  loginAttempts: {
    total: number;
    successful: number;
    failed: number;
    uniqueIPs: number;
  };
  shareValidation: {
    total: number;
    valid: number;
    invalid: number;
    invalidRatio: number;
  };
  apiUsage: {
    totalRequests: number;
    uniqueKeys: number;
    topEndpoints: Array<{ endpoint: string; count: number }>;
  };
  threats: {
    blocked: number;
    active: number;
    resolved: number;
  };
}

export interface ISecurityReport {
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalIncidents: number;
    criticalIncidents: number;
    blockedAttacks: number;
    affectedMiners: number;
  };
  incidents: ISecurityIncident[];
  recommendations: string[];
  metrics: ISecurityMetrics;
}

export interface ISecurityIncident {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  occurredAt: Date;
  resolvedAt?: Date;
  affectedEntities: string[];
  actions: string[];
  status: 'active' | 'investigating' | 'resolved' | 'ignored';
}

// Encryption interfaces
export interface IEncryptionService {
  encrypt(data: string, key?: string): Promise<string>;
  decrypt(encryptedData: string, key?: string): Promise<string>;
  hash(data: string): string;
  compareHash(data: string, hash: string): Promise<boolean>;
  generateKey(): string;
  generateSalt(): string;
  signData(data: string, privateKey: string): string;
  verifySignature(data: string, signature: string, publicKey: string): boolean;
}

// Audit interfaces
export interface IAuditService {
  logAction(action: IAuditAction): Promise<void>;
  queryLogs(query: IAuditQuery): Promise<IAuditLog[]>;
  exportLogs(format: 'json' | 'csv', query?: IAuditQuery): Promise<string>;
  retentionCleanup(retentionDays: number): Promise<number>;
}

export interface IAuditAction {
  action: string;
  category: 'auth' | 'admin' | 'miner' | 'payment' | 'config' | 'security';
  userId?: string;
  targetId?: string;
  details?: Record<string, any>;
  ip?: string;
  userAgent?: string;
  success: boolean;
  error?: string;
}

export interface IAuditQuery {
  startDate?: Date;
  endDate?: Date;
  category?: string;
  action?: string;
  userId?: string;
  targetId?: string;
  success?: boolean;
  limit?: number;
  offset?: number;
}

export interface IAuditLog extends IAuditAction {
  id: string;
  timestamp: Date;
}
