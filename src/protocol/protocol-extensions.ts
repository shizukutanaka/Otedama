/**
 * Protocol Extensions - Custom Message Support
 * Following Carmack/Martin/Pike principles:
 * - Extensible protocol design
 * - Backward compatibility
 * - Clean message handling
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

interface ExtensionConfig {
  // Extension registry
  extensions: Map<string, ProtocolExtension>;
  
  // Protocol versioning
  version: {
    major: number;
    minor: number;
    patch: number;
  };
  
  // Compatibility
  compatibility: {
    minVersion: string;
    maxVersion: string;
    strict: boolean;
  };
  
  // Message handling
  messages: {
    maxSize: number;
    timeout: number;
    retries: number;
  };
  
  // Security
  security: {
    signing: boolean;
    encryption: boolean;
    authentication: boolean;
  };
}

interface ProtocolExtension {
  id: string;
  name: string;
  version: string;
  priority: number;
  
  // Capabilities
  capabilities: string[];
  
  // Message handlers
  handlers: Map<string, MessageHandler>;
  
  // Middleware
  middleware?: ExtensionMiddleware[];
  
  // Configuration
  config?: any;
}

interface MessageHandler {
  type: string;
  schema?: any;
  validate?: (message: any) => boolean;
  handle: (message: any, context: MessageContext) => Promise<any>;
}

interface ExtensionMiddleware {
  name: string;
  priority: number;
  pre?: (message: any, context: MessageContext) => Promise<any>;
  post?: (message: any, response: any, context: MessageContext) => Promise<any>;
}

interface MessageContext {
  connectionId: string;
  sessionId?: string;
  authenticated: boolean;
  user?: any;
  metadata: Map<string, any>;
}

interface ExtendedMessage {
  // Standard fields
  id: string;
  type: string;
  version: string;
  timestamp: number;
  
  // Extension fields
  extension?: string;
  priority?: number;
  ttl?: number;
  
  // Payload
  payload: any;
  
  // Security
  signature?: string;
  encrypted?: boolean;
  
  // Routing
  source?: string;
  destination?: string;
  route?: string[];
}

interface MessageEnvelope {
  header: MessageHeader;
  body: Buffer;
  trailer?: MessageTrailer;
}

interface MessageHeader {
  magic: number;
  version: number;
  flags: number;
  type: number;
  length: number;
  checksum?: number;
}

interface MessageTrailer {
  signature?: Buffer;
  padding?: Buffer;
}

export class ProtocolExtensionManager extends EventEmitter {
  private config: ExtensionConfig;
  private extensions: Map<string, ProtocolExtension> = new Map();
  private messageHandlers: Map<string, MessageHandler[]> = new Map();
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private sessionData: Map<string, any> = new Map();
  
  // Protocol constants
  private readonly MAGIC = 0x4F544544; // "OTED" in hex
  private readonly HEADER_SIZE = 20;
  
  // Message type registry
  private messageTypes: Map<string, number> = new Map();
  private reverseMessageTypes: Map<number, string> = new Map();
  private nextMessageType: number = 0x1000; // Start custom types at 0x1000

  constructor(config: ExtensionConfig) {
    super();
    this.config = config;
    
    // Initialize core message types
    this.registerCoreMessageTypes();
  }

  /**
   * Register core message types
   */
  private registerCoreMessageTypes(): void {
    const coreTypes = [
      // Control messages
      { name: 'hello', type: 0x0001 },
      { name: 'ping', type: 0x0002 },
      { name: 'pong', type: 0x0003 },
      { name: 'error', type: 0x0004 },
      { name: 'close', type: 0x0005 },
      
      // Mining messages
      { name: 'subscribe', type: 0x0100 },
      { name: 'authorize', type: 0x0101 },
      { name: 'notify', type: 0x0102 },
      { name: 'submit', type: 0x0103 },
      { name: 'difficulty', type: 0x0104 },
      
      // Extension messages
      { name: 'extension.list', type: 0x0200 },
      { name: 'extension.enable', type: 0x0201 },
      { name: 'extension.disable', type: 0x0202 },
      { name: 'extension.config', type: 0x0203 }
    ];

    for (const { name, type } of coreTypes) {
      this.messageTypes.set(name, type);
      this.reverseMessageTypes.set(type, name);
    }
  }

  /**
   * Register protocol extension
   */
  registerExtension(extension: ProtocolExtension): void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`Extension ${extension.id} already registered`);
    }

    // Validate extension
    this.validateExtension(extension);

    // Register extension
    this.extensions.set(extension.id, extension);

    // Register message handlers
    for (const [type, handler] of extension.handlers) {
      this.registerMessageHandler(type, handler, extension.id);
    }

    // Register custom message types
    for (const capability of extension.capabilities) {
      if (capability.startsWith('message:')) {
        const messageType = capability.substring(8);
        if (!this.messageTypes.has(messageType)) {
          this.registerMessageType(messageType);
        }
      }
    }

    logger.info('Registered protocol extension', {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      capabilities: extension.capabilities
    });

    this.emit('extension:registered', extension);
  }

  /**
   * Unregister protocol extension
   */
  unregisterExtension(extensionId: string): void {
    const extension = this.extensions.get(extensionId);
    if (!extension) return;

    // Remove message handlers
    for (const type of extension.handlers.keys()) {
      const handlers = this.messageHandlers.get(type);
      if (handlers) {
        this.messageHandlers.set(
          type,
          handlers.filter(h => h !== extension.handlers.get(type))
        );
      }
    }

    this.extensions.delete(extensionId);
    
    logger.info('Unregistered protocol extension', { id: extensionId });
    this.emit('extension:unregistered', extensionId);
  }

  /**
   * Validate extension
   */
  private validateExtension(extension: ProtocolExtension): void {
    if (!extension.id || !extension.name || !extension.version) {
      throw new Error('Extension must have id, name, and version');
    }

    if (!extension.handlers || extension.handlers.size === 0) {
      throw new Error('Extension must have at least one message handler');
    }

    // Check version compatibility
    if (this.config.compatibility.strict) {
      const extVersion = this.parseVersion(extension.version);
      const minVersion = this.parseVersion(this.config.compatibility.minVersion);
      const maxVersion = this.parseVersion(this.config.compatibility.maxVersion);

      if (this.compareVersions(extVersion, minVersion) < 0 ||
          this.compareVersions(extVersion, maxVersion) > 0) {
        throw new Error(`Extension version ${extension.version} not compatible`);
      }
    }
  }

  /**
   * Register message type
   */
  private registerMessageType(type: string): number {
    if (this.messageTypes.has(type)) {
      return this.messageTypes.get(type)!;
    }

    const typeId = this.nextMessageType++;
    this.messageTypes.set(type, typeId);
    this.reverseMessageTypes.set(typeId, type);

    return typeId;
  }

  /**
   * Register message handler
   */
  private registerMessageHandler(
    type: string,
    handler: MessageHandler,
    extensionId: string
  ): void {
    let handlers = this.messageHandlers.get(type);
    if (!handlers) {
      handlers = [];
      this.messageHandlers.set(type, handlers);
    }

    // Add extension ID to handler
    (handler as any).extensionId = extensionId;
    handlers.push(handler);

    // Sort by extension priority
    handlers.sort((a, b) => {
      const extA = this.extensions.get((a as any).extensionId);
      const extB = this.extensions.get((b as any).extensionId);
      return (extB?.priority || 0) - (extA?.priority || 0);
    });
  }

  /**
   * Create extended message
   */
  createMessage(
    type: string,
    payload: any,
    options: Partial<ExtendedMessage> = {}
  ): ExtendedMessage {
    const message: ExtendedMessage = {
      id: options.id || crypto.randomBytes(16).toString('hex'),
      type,
      version: this.getVersionString(),
      timestamp: Date.now(),
      payload,
      ...options
    };

    // Apply extensions
    for (const extension of this.extensions.values()) {
      if (extension.middleware) {
        for (const middleware of extension.middleware) {
          if (middleware.pre) {
            message.payload = middleware.pre(message, this.createContext('system'));
          }
        }
      }
    }

    return message;
  }

  /**
   * Encode message
   */
  async encodeMessage(message: ExtendedMessage): Promise<Buffer> {
    // Serialize payload
    const payloadBuffer = Buffer.from(JSON.stringify(message.payload));
    
    // Encrypt if needed
    let body = payloadBuffer;
    if (this.config.security.encryption && message.encrypted !== false) {
      body = await this.encryptPayload(body);
      message.encrypted = true;
    }

    // Create header
    const header: MessageHeader = {
      magic: this.MAGIC,
      version: this.encodeVersion(message.version),
      flags: this.encodeFlags(message),
      type: this.messageTypes.get(message.type) || 0,
      length: body.length,
      checksum: this.calculateChecksum(body)
    };

    // Create envelope
    const envelope: MessageEnvelope = {
      header,
      body
    };

    // Sign if needed
    if (this.config.security.signing) {
      envelope.trailer = {
        signature: await this.signMessage(envelope)
      };
    }

    return this.serializeEnvelope(envelope);
  }

  /**
   * Decode message
   */
  async decodeMessage(buffer: Buffer): Promise<ExtendedMessage> {
    const envelope = this.deserializeEnvelope(buffer);

    // Verify checksum
    if (envelope.header.checksum) {
      const checksum = this.calculateChecksum(envelope.body);
      if (checksum !== envelope.header.checksum) {
        throw new Error('Invalid message checksum');
      }
    }

    // Verify signature
    if (envelope.trailer?.signature) {
      const valid = await this.verifySignature(envelope);
      if (!valid) {
        throw new Error('Invalid message signature');
      }
    }

    // Decrypt if needed
    let body = envelope.body;
    if (this.isEncrypted(envelope.header.flags)) {
      body = await this.decryptPayload(body);
    }

    // Parse payload
    const payload = JSON.parse(body.toString());

    // Reconstruct message
    const messageType = this.reverseMessageTypes.get(envelope.header.type) || 'unknown';
    const message: ExtendedMessage = {
      id: crypto.randomBytes(16).toString('hex'), // Generate if not in payload
      type: messageType,
      version: this.decodeVersion(envelope.header.version),
      timestamp: Date.now(),
      payload,
      encrypted: this.isEncrypted(envelope.header.flags)
    };

    return message;
  }

  /**
   * Handle incoming message
   */
  async handleMessage(
    message: ExtendedMessage,
    context: MessageContext
  ): Promise<any> {
    logger.debug('Handling message', {
      id: message.id,
      type: message.type,
      extension: message.extension
    });

    // Check if message is for specific extension
    if (message.extension) {
      const extension = this.extensions.get(message.extension);
      if (!extension) {
        throw new Error(`Extension ${message.extension} not found`);
      }

      const handler = extension.handlers.get(message.type);
      if (!handler) {
        throw new Error(`Handler for ${message.type} not found in extension ${message.extension}`);
      }

      return this.executeHandler(handler, message, context, extension);
    }

    // Find handlers for message type
    const handlers = this.messageHandlers.get(message.type);
    if (!handlers || handlers.length === 0) {
      logger.warn('No handler for message type', { type: message.type });
      return null;
    }

    // Execute handlers in priority order
    let result = null;
    for (const handler of handlers) {
      try {
        result = await this.executeHandler(
          handler,
          message,
          context,
          this.extensions.get((handler as any).extensionId)
        );
        
        if (result !== undefined) {
          break; // Handler processed the message
        }
      } catch (err) {
        logger.error('Handler error', {
          type: message.type,
          handler: (handler as any).extensionId,
          error: err
        });
      }
    }

    return result;
  }

  /**
   * Execute message handler
   */
  private async executeHandler(
    handler: MessageHandler,
    message: ExtendedMessage,
    context: MessageContext,
    extension?: ProtocolExtension
  ): Promise<any> {
    // Validate message
    if (handler.validate && !handler.validate(message.payload)) {
      throw new Error('Message validation failed');
    }

    // Apply pre-middleware
    let payload = message.payload;
    if (extension?.middleware) {
      for (const middleware of extension.middleware) {
        if (middleware.pre) {
          payload = await middleware.pre(message, context);
        }
      }
    }

    // Execute handler
    const result = await handler.handle(payload, context);

    // Apply post-middleware
    let finalResult = result;
    if (extension?.middleware) {
      for (const middleware of extension.middleware.reverse()) {
        if (middleware.post) {
          finalResult = await middleware.post(message, finalResult, context);
        }
      }
    }

    return finalResult;
  }

  /**
   * Serialize envelope
   */
  private serializeEnvelope(envelope: MessageEnvelope): Buffer {
    const buffers: Buffer[] = [];

    // Serialize header
    const headerBuffer = Buffer.allocUnsafe(this.HEADER_SIZE);
    headerBuffer.writeUInt32BE(envelope.header.magic, 0);
    headerBuffer.writeUInt16BE(envelope.header.version, 4);
    headerBuffer.writeUInt16BE(envelope.header.flags, 6);
    headerBuffer.writeUInt16BE(envelope.header.type, 8);
    headerBuffer.writeUInt32BE(envelope.header.length, 10);
    headerBuffer.writeUInt32BE(envelope.header.checksum || 0, 14);
    headerBuffer.writeUInt16BE(0, 18); // Reserved

    buffers.push(headerBuffer);
    buffers.push(envelope.body);

    // Add trailer if present
    if (envelope.trailer) {
      if (envelope.trailer.signature) {
        const sigLength = Buffer.allocUnsafe(2);
        sigLength.writeUInt16BE(envelope.trailer.signature.length, 0);
        buffers.push(sigLength);
        buffers.push(envelope.trailer.signature);
      }
    }

    return Buffer.concat(buffers);
  }

  /**
   * Deserialize envelope
   */
  private deserializeEnvelope(buffer: Buffer): MessageEnvelope {
    if (buffer.length < this.HEADER_SIZE) {
      throw new Error('Invalid message: too short');
    }

    // Parse header
    const header: MessageHeader = {
      magic: buffer.readUInt32BE(0),
      version: buffer.readUInt16BE(4),
      flags: buffer.readUInt16BE(6),
      type: buffer.readUInt16BE(8),
      length: buffer.readUInt32BE(10),
      checksum: buffer.readUInt32BE(14)
    };

    if (header.magic !== this.MAGIC) {
      throw new Error('Invalid message: bad magic');
    }

    if (buffer.length < this.HEADER_SIZE + header.length) {
      throw new Error('Invalid message: incomplete body');
    }

    // Extract body
    const body = buffer.slice(this.HEADER_SIZE, this.HEADER_SIZE + header.length);

    // Extract trailer if present
    let trailer: MessageTrailer | undefined;
    let offset = this.HEADER_SIZE + header.length;

    if (this.hasSigned(header.flags) && offset < buffer.length) {
      const sigLength = buffer.readUInt16BE(offset);
      offset += 2;

      if (offset + sigLength <= buffer.length) {
        trailer = {
          signature: buffer.slice(offset, offset + sigLength)
        };
      }
    }

    return { header, body, trailer };
  }

  /**
   * Encode version
   */
  private encodeVersion(version: string): number {
    const { major, minor } = this.parseVersion(version);
    return (major << 8) | minor;
  }

  /**
   * Decode version
   */
  private decodeVersion(encoded: number): string {
    const major = (encoded >> 8) & 0xff;
    const minor = encoded & 0xff;
    return `${major}.${minor}.0`;
  }

  /**
   * Parse version string
   */
  private parseVersion(version: string): { major: number; minor: number; patch: number } {
    const parts = version.split('.').map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    };
  }

  /**
   * Compare versions
   */
  private compareVersions(
    a: { major: number; minor: number; patch: number },
    b: { major: number; minor: number; patch: number }
  ): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
  }

  /**
   * Get version string
   */
  private getVersionString(): string {
    const { major, minor, patch } = this.config.version;
    return `${major}.${minor}.${patch}`;
  }

  /**
   * Encode flags
   */
  private encodeFlags(message: ExtendedMessage): number {
    let flags = 0;
    
    if (message.encrypted) flags |= 0x0001;
    if (message.priority === 'high') flags |= 0x0002;
    if (message.extension) flags |= 0x0004;
    if (this.config.security.signing) flags |= 0x0008;
    
    return flags;
  }

  /**
   * Check if message is encrypted
   */
  private isEncrypted(flags: number): boolean {
    return (flags & 0x0001) !== 0;
  }

  /**
   * Check if message has signature
   */
  private hasSigned(flags: number): boolean {
    return (flags & 0x0008) !== 0;
  }

  /**
   * Calculate checksum
   */
  private calculateChecksum(data: Buffer): number {
    // Simple CRC32 checksum
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ this.crc32Table[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // CRC32 table (truncated for brevity)
  private readonly crc32Table = new Uint32Array(256);

  /**
   * Encrypt payload
   */
  private async encryptPayload(data: Buffer): Promise<Buffer> {
    // Placeholder - would use actual encryption
    const encrypted = Buffer.allocUnsafe(data.length + 1);
    encrypted[0] = 0xEE; // Encryption marker
    data.copy(encrypted, 1);
    return encrypted;
  }

  /**
   * Decrypt payload
   */
  private async decryptPayload(data: Buffer): Promise<Buffer> {
    // Placeholder - would use actual decryption
    if (data[0] === 0xEE) {
      return data.slice(1);
    }
    return data;
  }

  /**
   * Sign message
   */
  private async signMessage(envelope: MessageEnvelope): Promise<Buffer> {
    // Placeholder - would use actual signing
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from([
      envelope.header.magic,
      envelope.header.version,
      envelope.header.flags,
      envelope.header.type
    ]));
    hash.update(envelope.body);
    return hash.digest();
  }

  /**
   * Verify signature
   */
  private async verifySignature(envelope: MessageEnvelope): Promise<boolean> {
    if (!envelope.trailer?.signature) return false;
    
    // Placeholder - would use actual verification
    const expected = await this.signMessage(envelope);
    return envelope.trailer.signature.equals(expected);
  }

  /**
   * Create message context
   */
  private createContext(connectionId: string): MessageContext {
    return {
      connectionId,
      authenticated: false,
      metadata: new Map()
    };
  }

  /**
   * Get available extensions
   */
  getExtensions(): ProtocolExtension[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extension capabilities
   */
  getCapabilities(): string[] {
    const capabilities = new Set<string>();
    
    for (const extension of this.extensions.values()) {
      for (const capability of extension.capabilities) {
        capabilities.add(capability);
      }
    }
    
    return Array.from(capabilities);
  }

  /**
   * Negotiate protocol
   */
  async negotiateProtocol(
    remoteCapabilities: string[],
    remoteVersion: string
  ): Promise<{
    version: string;
    extensions: string[];
    capabilities: string[];
  }> {
    // Check version compatibility
    const remoteVer = this.parseVersion(remoteVersion);
    const ourVer = this.config.version;
    
    let negotiatedVersion = this.getVersionString();
    if (this.compareVersions(remoteVer, ourVer) < 0) {
      negotiatedVersion = remoteVersion; // Use older version
    }

    // Find common capabilities
    const ourCapabilities = this.getCapabilities();
    const commonCapabilities = ourCapabilities.filter(cap => 
      remoteCapabilities.includes(cap)
    );

    // Select compatible extensions
    const compatibleExtensions: string[] = [];
    for (const extension of this.extensions.values()) {
      const hasAllCapabilities = extension.capabilities.every(cap =>
        remoteCapabilities.includes(cap)
      );
      
      if (hasAllCapabilities) {
        compatibleExtensions.push(extension.id);
      }
    }

    return {
      version: negotiatedVersion,
      extensions: compatibleExtensions,
      capabilities: commonCapabilities
    };
  }
}

interface PendingMessage {
  message: ExtendedMessage;
  context: MessageContext;
  timestamp: number;
  retries: number;
  callback?: (err?: Error, result?: any) => void;
}

// Export types
export { 
  ExtensionConfig,
  ProtocolExtension,
  MessageHandler,
  ExtensionMiddleware,
  MessageContext,
  ExtendedMessage
};
