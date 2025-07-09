// Protocol versioning for compatibility management (Pike's simplicity principle)
import { logger as baseLogger, createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('protocol-versioning');

// Protocol version definition
export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
  features: Set<string>;
}

// Protocol features
export enum ProtocolFeature {
  // Basic features
  BASIC_MINING = 'basic_mining',
  DIFFICULTY_ADJUSTMENT = 'difficulty_adjustment',
  LONG_POLLING = 'long_polling',
  
  // Extended features
  STRATUM_V2 = 'stratum_v2',
  BINARY_PROTOCOL = 'binary_protocol',
  TRANSACTION_SELECTION = 'transaction_selection',
  ASICBOOST = 'asicboost',
  
  // Security features
  TLS_SUPPORT = 'tls_support',
  AUTHENTICATION = 'authentication',
  ENCRYPTED_SHARES = 'encrypted_shares',
  
  // Performance features
  SHARE_BATCHING = 'share_batching',
  COMPRESSED_WORK = 'compressed_work',
  MULTI_VERSION_ROLLING = 'multi_version_rolling',
  
  // Notification features
  BLOCK_NOTIFICATION = 'block_notification',
  HASHRATE_REPORTING = 'hashrate_reporting',
  REJECT_REASON_EXTENDED = 'reject_reason_extended'
}

// Version compatibility rules
export class VersionCompatibility {
  // Define supported versions
  private static readonly SUPPORTED_VERSIONS: ProtocolVersion[] = [
    {
      major: 1,
      minor: 0,
      patch: 0,
      features: new Set([
        ProtocolFeature.BASIC_MINING,
        ProtocolFeature.DIFFICULTY_ADJUSTMENT
      ])
    },
    {
      major: 1,
      minor: 1,
      patch: 0,
      features: new Set([
        ProtocolFeature.BASIC_MINING,
        ProtocolFeature.DIFFICULTY_ADJUSTMENT,
        ProtocolFeature.LONG_POLLING,
        ProtocolFeature.TLS_SUPPORT
      ])
    },
    {
      major: 1,
      minor: 2,
      patch: 0,
      features: new Set([
        ProtocolFeature.BASIC_MINING,
        ProtocolFeature.DIFFICULTY_ADJUSTMENT,
        ProtocolFeature.LONG_POLLING,
        ProtocolFeature.TLS_SUPPORT,
        ProtocolFeature.AUTHENTICATION,
        ProtocolFeature.BLOCK_NOTIFICATION,
        ProtocolFeature.HASHRATE_REPORTING
      ])
    },
    {
      major: 2,
      minor: 0,
      patch: 0,
      features: new Set([
        ProtocolFeature.BASIC_MINING,
        ProtocolFeature.DIFFICULTY_ADJUSTMENT,
        ProtocolFeature.LONG_POLLING,
        ProtocolFeature.TLS_SUPPORT,
        ProtocolFeature.AUTHENTICATION,
        ProtocolFeature.BLOCK_NOTIFICATION,
        ProtocolFeature.HASHRATE_REPORTING,
        ProtocolFeature.STRATUM_V2,
        ProtocolFeature.BINARY_PROTOCOL,
        ProtocolFeature.TRANSACTION_SELECTION
      ])
    }
  ];
  
  // Current server version
  static readonly CURRENT_VERSION: ProtocolVersion = {
    major: 1,
    minor: 2,
    patch: 0,
    features: new Set([
      ProtocolFeature.BASIC_MINING,
      ProtocolFeature.DIFFICULTY_ADJUSTMENT,
      ProtocolFeature.LONG_POLLING,
      ProtocolFeature.TLS_SUPPORT,
      ProtocolFeature.AUTHENTICATION,
      ProtocolFeature.BLOCK_NOTIFICATION,
      ProtocolFeature.HASHRATE_REPORTING
    ])
  };
  
  // Check if version is supported
  static isVersionSupported(version: ProtocolVersion): boolean {
    return this.SUPPORTED_VERSIONS.some(v => 
      v.major === version.major && 
      v.minor === version.minor && 
      v.patch === version.patch
    );
  }
  
  // Check if feature is supported
  static isFeatureSupported(
    clientVersion: ProtocolVersion,
    feature: ProtocolFeature
  ): boolean {
    return clientVersion.features.has(feature);
  }
  
  // Get common features between client and server
  static getCommonFeatures(clientVersion: ProtocolVersion): Set<string> {
    const common = new Set<string>();
    
    for (const feature of this.CURRENT_VERSION.features) {
      if (clientVersion.features.has(feature)) {
        common.add(feature);
      }
    }
    
    return common;
  }
  
  // Check if versions are compatible
  static areVersionsCompatible(
    clientVersion: ProtocolVersion,
    serverVersion: ProtocolVersion = this.CURRENT_VERSION
  ): { compatible: boolean; reason?: string } {
    // Major version must match
    if (clientVersion.major !== serverVersion.major) {
      return {
        compatible: false,
        reason: `Major version mismatch: client ${clientVersion.major}, server ${serverVersion.major}`
      };
    }
    
    // Client minor version can be lower (backward compatible)
    if (clientVersion.minor > serverVersion.minor) {
      return {
        compatible: false,
        reason: `Client version ${clientVersion.minor} is newer than server ${serverVersion.minor}`
      };
    }
    
    // Must have at least basic mining capability
    if (!clientVersion.features.has(ProtocolFeature.BASIC_MINING)) {
      return {
        compatible: false,
        reason: 'Client does not support basic mining'
      };
    }
    
    return { compatible: true };
  }
}

// Protocol negotiation handler
export class ProtocolNegotiator {
  private negotiatedVersions = new Map<string, {
    version: ProtocolVersion;
    features: Set<string>;
    negotiatedAt: Date;
  }>();
  
  // Negotiate protocol version with client
  negotiate(
    clientId: string,
    clientVersion: string,
    supportedFeatures?: string[]
  ): {
    success: boolean;
    version?: ProtocolVersion;
    features?: Set<string>;
    error?: string;
  } {
    try {
      // Parse client version
      const version = this.parseVersion(clientVersion);
      
      // Add supported features
      if (supportedFeatures) {
        for (const feature of supportedFeatures) {
          if (Object.values(ProtocolFeature).includes(feature as ProtocolFeature)) {
            version.features.add(feature);
          }
        }
      }
      
      // Check compatibility
      const compatibility = VersionCompatibility.areVersionsCompatible(version);
      if (!compatibility.compatible) {
        logger.warn(`Protocol negotiation failed for ${clientId}: ${compatibility.reason}`);
        return {
          success: false,
          error: compatibility.reason
        };
      }
      
      // Get common features
      const commonFeatures = VersionCompatibility.getCommonFeatures(version);
      
      // Store negotiated version
      this.negotiatedVersions.set(clientId, {
        version,
        features: commonFeatures,
        negotiatedAt: new Date()
      });
      
      logger.info(`Protocol negotiated for ${clientId}: v${version.major}.${version.minor}.${version.patch}`, {
        features: Array.from(commonFeatures)
      });
      
      return {
        success: true,
        version,
        features: commonFeatures
      };
    } catch (error) {
      logger.error(`Protocol negotiation error for ${clientId}:`, error as Error);
      return {
        success: false,
        error: 'Invalid version format'
      };
    }
  }
  
  // Parse version string
  private parseVersion(versionString: string): ProtocolVersion {
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      throw new Error('Invalid version format');
    }
    
    const [, major, minor, patch] = match;
    const version: ProtocolVersion = {
      major: parseInt(major),
      minor: parseInt(minor),
      patch: parseInt(patch),
      features: new Set()
    };
    
    // Find matching supported version to get default features
    const supported = VersionCompatibility['SUPPORTED_VERSIONS'].find(v =>
      v.major === version.major &&
      v.minor === version.minor &&
      v.patch === version.patch
    );
    
    if (supported) {
      version.features = new Set(supported.features);
    } else {
      // Unknown version, assume basic features only
      version.features = new Set([ProtocolFeature.BASIC_MINING]);
    }
    
    return version;
  }
  
  // Get negotiated version for client
  getNegotiatedVersion(clientId: string): {
    version: ProtocolVersion;
    features: Set<string>;
  } | undefined {
    return this.negotiatedVersions.get(clientId);
  }
  
  // Check if client supports feature
  clientSupportsFeature(clientId: string, feature: ProtocolFeature): boolean {
    const negotiated = this.negotiatedVersions.get(clientId);
    return negotiated ? negotiated.features.has(feature) : false;
  }
  
  // Remove client negotiation
  removeClient(clientId: string): void {
    this.negotiatedVersions.delete(clientId);
  }
  
  // Get negotiation statistics
  getStatistics(): {
    totalClients: number;
    versionDistribution: Map<string, number>;
    featureAdoption: Map<string, number>;
  } {
    const versionDist = new Map<string, number>();
    const featureAdoption = new Map<string, number>();
    
    for (const negotiated of this.negotiatedVersions.values()) {
      const v = negotiated.version;
      const versionKey = `${v.major}.${v.minor}.${v.patch}`;
      
      versionDist.set(versionKey, (versionDist.get(versionKey) || 0) + 1);
      
      for (const feature of negotiated.features) {
        featureAdoption.set(feature, (featureAdoption.get(feature) || 0) + 1);
      }
    }
    
    return {
      totalClients: this.negotiatedVersions.size,
      versionDistribution: versionDist,
      featureAdoption
    };
  }
  
  // Cleanup old negotiations
  cleanup(maxAgeMs: number = 86400000): number { // 24 hours default
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    
    for (const [clientId, negotiated] of this.negotiatedVersions) {
      if (negotiated.negotiatedAt.getTime() < cutoff) {
        this.negotiatedVersions.delete(clientId);
        removed++;
      }
    }
    
    return removed;
  }
}

// Protocol message versioning
export class MessageVersioning {
  // Version-specific message formats
  private static readonly MESSAGE_FORMATS = new Map<string, {
    version: string;
    format: (method: string, params: any) => any;
    parse: (message: any) => { method: string; params: any };
  }>();
  
  static {
    // Register v1.0 format
    this.MESSAGE_FORMATS.set('1.0', {
      version: '1.0',
      format: (method: string, params: any) => ({
        method,
        params,
        id: Date.now()
      }),
      parse: (message: any) => ({
        method: message.method,
        params: message.params
      })
    });
    
    // Register v1.1+ format with jsonrpc
    this.MESSAGE_FORMATS.set('1.1', {
      version: '1.1',
      format: (method: string, params: any) => ({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now()
      }),
      parse: (message: any) => ({
        method: message.method,
        params: message.params
      })
    });
    
    // Register v2.0 binary format (placeholder)
    this.MESSAGE_FORMATS.set('2.0', {
      version: '2.0',
      format: (method: string, params: any) => {
        // Binary format would be implemented here
        throw new Error('Binary format not yet implemented');
      },
      parse: (message: any) => {
        throw new Error('Binary format not yet implemented');
      }
    });
  }
  
  // Format message for client version
  static formatMessage(
    clientVersion: ProtocolVersion,
    method: string,
    params: any
  ): any {
    const versionKey = `${clientVersion.major}.${clientVersion.minor}`;
    const format = this.MESSAGE_FORMATS.get(versionKey) || this.MESSAGE_FORMATS.get('1.0');
    
    return format!.format(method, params);
  }
  
  // Parse message from client
  static parseMessage(
    clientVersion: ProtocolVersion,
    message: any
  ): { method: string; params: any } {
    const versionKey = `${clientVersion.major}.${clientVersion.minor}`;
    const format = this.MESSAGE_FORMATS.get(versionKey) || this.MESSAGE_FORMATS.get('1.0');
    
    return format!.parse(message);
  }
}

// Migration helpers for version upgrades
export class ProtocolMigration {
  // Migrate work format between versions
  static migrateWork(
    work: any,
    fromVersion: ProtocolVersion,
    toVersion: ProtocolVersion
  ): any {
    // Handle work format differences between versions
    if (fromVersion.major === 1 && toVersion.major === 2) {
      // v1 to v2 migration
      return {
        ...work,
        version: 2,
        // Add v2-specific fields
        transactionSelection: false,
        compressed: false
      };
    }
    
    return work;
  }
  
  // Migrate share format between versions
  static migrateShare(
    share: any,
    fromVersion: ProtocolVersion,
    toVersion: ProtocolVersion
  ): any {
    // Handle share format differences
    if (fromVersion.major === 1 && toVersion.major === 2) {
      // v1 to v2 migration
      return {
        ...share,
        version: 2,
        // Add v2-specific fields
        signature: null
      };
    }
    
    return share;
  }
}

// Export version string helper
export function versionToString(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

// Export current version string
export const CURRENT_VERSION_STRING = versionToString(VersionCompatibility.CURRENT_VERSION);
