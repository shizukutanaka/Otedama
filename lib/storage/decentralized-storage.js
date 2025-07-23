const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class DecentralizedStorageIntegration extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      providers: options.providers || ['ipfs', 'arweave', 'filecoin', 'storj'],
      redundancy: options.redundancy || 3, // Store on 3 providers
      encryption: options.encryption !== false,
      compression: options.compression !== false,
      chunking: options.chunking !== false,
      chunkSize: options.chunkSize || 1024 * 1024, // 1MB chunks
      pinning: options.pinning !== false,
      caching: options.caching !== false,
      cacheDir: options.cacheDir || './storage-cache',
      maxCacheSize: options.maxCacheSize || 10 * 1024 * 1024 * 1024, // 10GB
      ipfsConfig: options.ipfsConfig || {
        host: 'ipfs.infura.io',
        port: 5001,
        protocol: 'https'
      },
      arweaveConfig: options.arweaveConfig || {
        host: 'arweave.net',
        port: 443,
        protocol: 'https'
      }
    };
    
    this.providers = new Map();
    this.storageIndex = new Map(); // Maps file hashes to storage locations
    this.encryptionKeys = new Map();
    this.downloadQueue = [];
    this.uploadQueue = [];
    this.cacheSize = 0;
    this.isInitialized = false;
  }
  
  async initialize() {
    try {
      // Initialize storage providers
      await this.initializeProviders();
      
      // Create cache directory
      await this.initializeCache();
      
      // Load storage index
      await this.loadStorageIndex();
      
      // Start queue processors
      this.startQueueProcessors();
      
      this.isInitialized = true;
      this.emit('initialized', {
        providers: Array.from(this.providers.keys()),
        cacheSize: this.cacheSize
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async initializeProviders() {
    for (const providerName of this.config.providers) {
      try {
        const provider = await this.createProvider(providerName);
        this.providers.set(providerName, provider);
        this.emit('providerInitialized', { provider: providerName });
      } catch (error) {
        this.emit('warning', {
          provider: providerName,
          message: `Failed to initialize provider: ${error.message}`
        });
      }
    }
    
    if (this.providers.size === 0) {
      throw new Error('No storage providers could be initialized');
    }
  }
  
  async createProvider(name) {
    switch (name) {
      case 'ipfs':
        return new IPFSProvider(this.config.ipfsConfig);
      case 'arweave':
        return new ArweaveProvider(this.config.arweaveConfig);
      case 'filecoin':
        return new FilecoinProvider(this.config.filecoinConfig);
      case 'storj':
        return new StorjProvider(this.config.storjConfig);
      default:
        throw new Error(`Unknown provider: ${name}`);
    }
  }
  
  async initializeCache() {
    try {
      await fs.mkdir(this.config.cacheDir, { recursive: true });
      
      // Calculate current cache size
      const files = await fs.readdir(this.config.cacheDir);
      for (const file of files) {
        const stats = await fs.stat(path.join(this.config.cacheDir, file));
        this.cacheSize += stats.size;
      }
    } catch (error) {
      this.emit('warning', {
        message: `Failed to initialize cache: ${error.message}`
      });
    }
  }
  
  async loadStorageIndex() {
    try {
      const indexPath = path.join(this.config.cacheDir, 'storage-index.json');
      const indexData = await fs.readFile(indexPath, 'utf8');
      const index = JSON.parse(indexData);
      
      for (const [hash, locations] of Object.entries(index)) {
        this.storageIndex.set(hash, locations);
      }
    } catch (error) {
      // Index doesn't exist yet, start fresh
      this.storageIndex = new Map();
    }
  }
  
  async saveStorageIndex() {
    try {
      const indexPath = path.join(this.config.cacheDir, 'storage-index.json');
      const index = Object.fromEntries(this.storageIndex);
      await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    } catch (error) {
      this.emit('error', {
        type: 'indexSave',
        error
      });
    }
  }
  
  async store(data, options = {}) {
    const storeOptions = {
      redundancy: options.redundancy || this.config.redundancy,
      encryption: options.encryption !== undefined ? options.encryption : this.config.encryption,
      compression: options.compression !== undefined ? options.compression : this.config.compression,
      metadata: options.metadata || {},
      priority: options.priority || 'normal'
    };
    
    try {
      // Process data
      let processedData = data;
      const dataHash = this.calculateHash(data);
      
      // Check if already stored
      if (this.storageIndex.has(dataHash)) {
        const locations = this.storageIndex.get(dataHash);
        if (locations.length >= storeOptions.redundancy) {
          this.emit('alreadyStored', { hash: dataHash, locations });
          return { hash: dataHash, locations, cached: true };
        }
      }
      
      // Compress if enabled
      if (storeOptions.compression) {
        processedData = await this.compressData(processedData);
      }
      
      // Encrypt if enabled
      let encryptionKey = null;
      if (storeOptions.encryption) {
        const encrypted = await this.encryptData(processedData);
        processedData = encrypted.data;
        encryptionKey = encrypted.key;
        this.encryptionKeys.set(dataHash, encryptionKey);
      }
      
      // Chunk if needed
      const chunks = this.config.chunking ? 
        await this.chunkData(processedData) : 
        [processedData];
      
      // Store on multiple providers
      const locations = await this.storeWithRedundancy(
        chunks,
        dataHash,
        storeOptions
      );
      
      // Update storage index
      this.storageIndex.set(dataHash, locations);
      await this.saveStorageIndex();
      
      // Cache locally if enabled
      if (this.config.caching) {
        await this.cacheData(dataHash, data);
      }
      
      this.emit('stored', {
        hash: dataHash,
        size: data.length,
        locations,
        encrypted: storeOptions.encryption,
        compressed: storeOptions.compression
      });
      
      return {
        hash: dataHash,
        locations,
        encryptionKey,
        metadata: storeOptions.metadata
      };
    } catch (error) {
      this.emit('error', { type: 'store', error });
      throw error;
    }
  }
  
  async retrieve(hash, options = {}) {
    try {
      // Check cache first
      if (this.config.caching) {
        const cached = await this.retrieveFromCache(hash);
        if (cached) {
          this.emit('retrieved', { hash, source: 'cache' });
          return cached;
        }
      }
      
      // Get storage locations
      const locations = this.storageIndex.get(hash);
      if (!locations || locations.length === 0) {
        throw new Error(`No storage locations found for hash: ${hash}`);
      }
      
      // Try to retrieve from providers
      let data = null;
      let successfulProvider = null;
      
      for (const location of locations) {
        try {
          data = await this.retrieveFromProvider(location);
          successfulProvider = location.provider;
          break;
        } catch (error) {
          this.emit('warning', {
            message: `Failed to retrieve from ${location.provider}: ${error.message}`
          });
        }
      }
      
      if (!data) {
        throw new Error('Failed to retrieve data from any provider');
      }
      
      // Decrypt if needed
      if (this.encryptionKeys.has(hash)) {
        const key = this.encryptionKeys.get(hash);
        data = await this.decryptData(data, key);
      }
      
      // Decompress if needed
      if (options.decompress || this.isCompressed(data)) {
        data = await this.decompressData(data);
      }
      
      // Cache for future use
      if (this.config.caching) {
        await this.cacheData(hash, data);
      }
      
      this.emit('retrieved', {
        hash,
        size: data.length,
        source: successfulProvider
      });
      
      return data;
    } catch (error) {
      this.emit('error', { type: 'retrieve', error });
      throw error;
    }
  }
  
  async storeWithRedundancy(chunks, hash, options) {
    const locations = [];
    const providers = this.selectProviders(options.redundancy);
    
    for (const provider of providers) {
      try {
        const location = await this.storeOnProvider(provider, chunks, hash, options);
        locations.push(location);
        
        if (locations.length >= options.redundancy) {
          break;
        }
      } catch (error) {
        this.emit('warning', {
          provider: provider.name,
          message: `Failed to store: ${error.message}`
        });
      }
    }
    
    if (locations.length === 0) {
      throw new Error('Failed to store on any provider');
    }
    
    return locations;
  }
  
  selectProviders(count) {
    const available = Array.from(this.providers.values());
    const selected = [];
    
    // Prioritize by reliability and cost
    const scored = available.map(provider => ({
      provider,
      score: this.scoreProvider(provider)
    })).sort((a, b) => b.score - a.score);
    
    for (let i = 0; i < Math.min(count, scored.length); i++) {
      selected.push(scored[i].provider);
    }
    
    return selected;
  }
  
  scoreProvider(provider) {
    // Score based on various factors
    let score = 100;
    
    // Reliability score
    score += provider.reliability * 50;
    
    // Cost score (lower is better)
    score -= provider.costPerGB * 10;
    
    // Speed score
    score += provider.averageSpeed * 20;
    
    // Availability score
    score += provider.uptime * 30;
    
    return score;
  }
  
  async storeOnProvider(provider, chunks, hash, options) {
    const chunkHashes = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkHash = await provider.store(chunks[i], {
        ...options.metadata,
        originalHash: hash,
        chunkIndex: i,
        totalChunks: chunks.length
      });
      chunkHashes.push(chunkHash);
    }
    
    return {
      provider: provider.name,
      chunkHashes,
      timestamp: Date.now(),
      metadata: options.metadata
    };
  }
  
  async retrieveFromProvider(location) {
    const provider = this.providers.get(location.provider);
    if (!provider) {
      throw new Error(`Provider not available: ${location.provider}`);
    }
    
    const chunks = [];
    
    for (const chunkHash of location.chunkHashes) {
      const chunk = await provider.retrieve(chunkHash);
      chunks.push(chunk);
    }
    
    // Reassemble chunks
    return Buffer.concat(chunks);
  }
  
  calculateHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  async compressData(data) {
    const zlib = require('zlib');
    return new Promise((resolve, reject) => {
      zlib.gzip(data, (error, compressed) => {
        if (error) reject(error);
        else resolve(compressed);
      });
    });
  }
  
  async decompressData(data) {
    const zlib = require('zlib');
    return new Promise((resolve, reject) => {
      zlib.gunzip(data, (error, decompressed) => {
        if (error) reject(error);
        else resolve(decompressed);
      });
    });
  }
  
  isCompressed(data) {
    // Check gzip magic number
    return data[0] === 0x1f && data[1] === 0x8b;
  }
  
  async encryptData(data) {
    const algorithm = 'aes-256-gcm';
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      data: Buffer.concat([iv, authTag, encrypted]),
      key: key.toString('hex')
    };
  }
  
  async decryptData(encryptedData, keyHex) {
    const algorithm = 'aes-256-gcm';
    const key = Buffer.from(keyHex, 'hex');
    
    const iv = encryptedData.slice(0, 16);
    const authTag = encryptedData.slice(16, 32);
    const encrypted = encryptedData.slice(32);
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted;
  }
  
  async chunkData(data) {
    const chunks = [];
    const chunkSize = this.config.chunkSize;
    
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.slice(i, i + chunkSize));
    }
    
    return chunks;
  }
  
  async cacheData(hash, data) {
    if (!this.config.caching) return;
    
    try {
      const cachePath = path.join(this.config.cacheDir, hash);
      
      // Check cache size limit
      if (this.cacheSize + data.length > this.config.maxCacheSize) {
        await this.evictFromCache(data.length);
      }
      
      await fs.writeFile(cachePath, data);
      this.cacheSize += data.length;
      
      // Update cache metadata
      const metaPath = cachePath + '.meta';
      await fs.writeFile(metaPath, JSON.stringify({
        size: data.length,
        timestamp: Date.now(),
        accessCount: 0
      }));
    } catch (error) {
      this.emit('warning', {
        message: `Failed to cache data: ${error.message}`
      });
    }
  }
  
  async retrieveFromCache(hash) {
    if (!this.config.caching) return null;
    
    try {
      const cachePath = path.join(this.config.cacheDir, hash);
      const data = await fs.readFile(cachePath);
      
      // Update access metadata
      const metaPath = cachePath + '.meta';
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      meta.lastAccess = Date.now();
      meta.accessCount++;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      
      return data;
    } catch (error) {
      return null;
    }
  }
  
  async evictFromCache(neededSpace) {
    const files = await fs.readdir(this.config.cacheDir);
    const fileStats = [];
    
    // Get metadata for all cached files
    for (const file of files) {
      if (file.endsWith('.meta')) continue;
      
      try {
        const metaPath = path.join(this.config.cacheDir, file + '.meta');
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        fileStats.push({
          hash: file,
          ...meta,
          score: this.calculateEvictionScore(meta)
        });
      } catch (error) {
        // Skip files without metadata
      }
    }
    
    // Sort by eviction score (higher score = more likely to evict)
    fileStats.sort((a, b) => b.score - a.score);
    
    let freedSpace = 0;
    for (const file of fileStats) {
      if (freedSpace >= neededSpace) break;
      
      try {
        await fs.unlink(path.join(this.config.cacheDir, file.hash));
        await fs.unlink(path.join(this.config.cacheDir, file.hash + '.meta'));
        freedSpace += file.size;
        this.cacheSize -= file.size;
      } catch (error) {
        // Continue if file already deleted
      }
    }
  }
  
  calculateEvictionScore(meta) {
    const now = Date.now();
    const age = now - meta.timestamp;
    const timeSinceAccess = now - (meta.lastAccess || meta.timestamp);
    
    // Higher score = more likely to evict
    // Favor evicting old, infrequently accessed files
    return (age / 3600000) + (timeSinceAccess / 3600000) - (meta.accessCount * 10);
  }
  
  startQueueProcessors() {
    // Process upload queue
    setInterval(() => {
      if (this.uploadQueue.length > 0) {
        this.processUploadQueue();
      }
    }, 1000);
    
    // Process download queue
    setInterval(() => {
      if (this.downloadQueue.length > 0) {
        this.processDownloadQueue();
      }
    }, 1000);
  }
  
  async processUploadQueue() {
    const batch = this.uploadQueue.splice(0, 10); // Process up to 10 items
    
    for (const item of batch) {
      try {
        const result = await this.store(item.data, item.options);
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }
  }
  
  async processDownloadQueue() {
    const batch = this.downloadQueue.splice(0, 10);
    
    for (const item of batch) {
      try {
        const data = await this.retrieve(item.hash, item.options);
        item.resolve(data);
      } catch (error) {
        item.reject(error);
      }
    }
  }
  
  // Public API methods
  
  async storeFile(filePath, options = {}) {
    const data = await fs.readFile(filePath);
    const metadata = {
      ...options.metadata,
      filename: path.basename(filePath),
      size: data.length,
      mimeType: this.getMimeType(filePath)
    };
    
    return this.store(data, { ...options, metadata });
  }
  
  async retrieveFile(hash, outputPath, options = {}) {
    const data = await this.retrieve(hash, options);
    await fs.writeFile(outputPath, data);
    return { path: outputPath, size: data.length };
  }
  
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.pdf': 'application/pdf'
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }
  
  async pin(hash, options = {}) {
    if (!this.config.pinning) return;
    
    const locations = this.storageIndex.get(hash);
    if (!locations) {
      throw new Error(`Hash not found: ${hash}`);
    }
    
    const pinned = [];
    
    for (const location of locations) {
      const provider = this.providers.get(location.provider);
      if (provider && provider.pin) {
        try {
          await provider.pin(location.chunkHashes);
          pinned.push(location.provider);
        } catch (error) {
          this.emit('warning', {
            message: `Failed to pin on ${location.provider}: ${error.message}`
          });
        }
      }
    }
    
    return { hash, pinned };
  }
  
  async unpin(hash) {
    const locations = this.storageIndex.get(hash);
    if (!locations) return;
    
    for (const location of locations) {
      const provider = this.providers.get(location.provider);
      if (provider && provider.unpin) {
        try {
          await provider.unpin(location.chunkHashes);
        } catch (error) {
          // Continue unpinning on other providers
        }
      }
    }
  }
  
  async getStorageStats() {
    const stats = {
      totalFiles: this.storageIndex.size,
      totalSize: 0,
      providers: {},
      cacheSize: this.cacheSize,
      cacheUtilization: (this.cacheSize / this.config.maxCacheSize) * 100
    };
    
    // Calculate provider statistics
    for (const [name, provider] of this.providers) {
      stats.providers[name] = {
        status: provider.isConnected ? 'connected' : 'disconnected',
        filesStored: 0,
        totalSize: 0,
        reliability: provider.reliability,
        costPerGB: provider.costPerGB
      };
    }
    
    // Count files per provider
    for (const locations of this.storageIndex.values()) {
      for (const location of locations) {
        if (stats.providers[location.provider]) {
          stats.providers[location.provider].filesStored++;
        }
      }
    }
    
    return stats;
  }
  
  async garbageCollection() {
    const orphaned = [];
    
    // Find orphaned chunks
    for (const [hash, locations] of this.storageIndex) {
      let accessible = false;
      
      for (const location of locations) {
        const provider = this.providers.get(location.provider);
        if (provider && provider.isConnected) {
          accessible = true;
          break;
        }
      }
      
      if (!accessible) {
        orphaned.push(hash);
      }
    }
    
    // Clean up orphaned entries
    for (const hash of orphaned) {
      this.storageIndex.delete(hash);
      this.encryptionKeys.delete(hash);
    }
    
    await this.saveStorageIndex();
    
    return { orphaned: orphaned.length };
  }
}

// Storage Provider Base Class
class StorageProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.isConnected = false;
    this.reliability = 0.95;
    this.costPerGB = 0.01;
    this.averageSpeed = 100; // MB/s
    this.uptime = 0.99;
  }
  
  async connect() {
    throw new Error('Not implemented');
  }
  
  async store(data, metadata) {
    throw new Error('Not implemented');
  }
  
  async retrieve(hash) {
    throw new Error('Not implemented');
  }
  
  async pin(hashes) {
    throw new Error('Not implemented');
  }
  
  async unpin(hashes) {
    throw new Error('Not implemented');
  }
}

// IPFS Provider
class IPFSProvider extends StorageProvider {
  constructor(config) {
    super('ipfs', config);
    this.reliability = 0.98;
    this.costPerGB = 0.005;
    this.averageSpeed = 150;
  }
  
  async connect() {
    // Initialize IPFS connection
    // This would use ipfs-http-client in production
    this.isConnected = true;
  }
  
  async store(data, metadata) {
    // Simulate IPFS storage
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `Qm${hash.substring(0, 44)}`; // Fake IPFS hash
  }
  
  async retrieve(hash) {
    // Simulate IPFS retrieval
    return Buffer.from('Retrieved data from IPFS');
  }
  
  async pin(hashes) {
    // Simulate pinning
    return true;
  }
}

// Arweave Provider
class ArweaveProvider extends StorageProvider {
  constructor(config) {
    super('arweave', config);
    this.reliability = 0.99;
    this.costPerGB = 0.02;
    this.averageSpeed = 100;
  }
  
  async connect() {
    // Initialize Arweave connection
    this.isConnected = true;
  }
  
  async store(data, metadata) {
    // Simulate Arweave storage
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return hash;
  }
  
  async retrieve(hash) {
    // Simulate Arweave retrieval
    return Buffer.from('Retrieved data from Arweave');
  }
}

// Filecoin Provider
class FilecoinProvider extends StorageProvider {
  constructor(config) {
    super('filecoin', config);
    this.reliability = 0.97;
    this.costPerGB = 0.008;
    this.averageSpeed = 120;
  }
  
  async connect() {
    // Initialize Filecoin connection
    this.isConnected = true;
  }
  
  async store(data, metadata) {
    // Simulate Filecoin storage
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `bafy${hash.substring(0, 50)}`;
  }
  
  async retrieve(hash) {
    // Simulate Filecoin retrieval
    return Buffer.from('Retrieved data from Filecoin');
  }
}

// Storj Provider
class StorjProvider extends StorageProvider {
  constructor(config) {
    super('storj', config);
    this.reliability = 0.96;
    this.costPerGB = 0.01;
    this.averageSpeed = 130;
  }
  
  async connect() {
    // Initialize Storj connection
    this.isConnected = true;
  }
  
  async store(data, metadata) {
    // Simulate Storj storage
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return hash;
  }
  
  async retrieve(hash) {
    // Simulate Storj retrieval
    return Buffer.from('Retrieved data from Storj');
  }
}

module.exports = DecentralizedStorageIntegration;