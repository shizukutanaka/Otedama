const { EventEmitter } = require('events');
const IPFS = require('ipfs-core');
const crypto = require('crypto');
const { Readable } = require('stream');

class IPFSStorageSystem extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            replicationFactor: options.replicationFactor || 3,
            chunkSize: options.chunkSize || 262144, // 256KB
            encryptionEnabled: options.encryptionEnabled !== false,
            compressionEnabled: options.compressionEnabled !== false,
            pinningServices: options.pinningServices || [],
            maxFileSize: options.maxFileSize || 5368709120, // 5GB
            cacheSize: options.cacheSize || 1073741824, // 1GB
            ...options
        };
        
        this.ipfsNode = null;
        this.fileIndex = new Map();
        this.chunksCache = new Map();
        this.encryptionKeys = new Map();
        
        // Performance metrics
        this.metrics = {
            totalUploads: 0,
            totalDownloads: 0,
            bytesUploaded: 0,
            bytesDownloaded: 0,
            averageUploadSpeed: 0,
            averageDownloadSpeed: 0
        };
        
        // Redundancy management
        this.redundancyMap = new Map();
        this.healthChecks = new Map();
    }

    async initialize() {
        try {
            // Create IPFS node
            this.ipfsNode = await IPFS.create({
                repo: this.config.repo || './ipfs-repo',
                config: {
                    Addresses: {
                        Swarm: [
                            '/ip4/0.0.0.0/tcp/4002',
                            '/ip4/127.0.0.1/tcp/4003/ws'
                        ]
                    },
                    Bootstrap: [
                        '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
                        '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
                    ]
                },
                preload: { enabled: false }
            });
            
            const nodeInfo = await this.ipfsNode.id();
            this.nodeId = nodeInfo.id;
            
            this.emit('initialized', { nodeId: this.nodeId });
            
            // Start health monitoring
            this.startHealthMonitoring();
            
            // Initialize pinning services
            await this.initializePinningServices();
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async storeFile(filePath, metadata = {}) {
        const startTime = Date.now();
        
        try {
            // Read file
            const fileData = await this.readFile(filePath);
            const fileSize = fileData.length;
            
            // Validate file size
            if (fileSize > this.config.maxFileSize) {
                throw new Error(`File size ${fileSize} exceeds maximum ${this.config.maxFileSize}`);
            }
            
            // Compress if enabled
            let processedData = fileData;
            if (this.config.compressionEnabled) {
                processedData = await this.compressData(fileData);
            }
            
            // Encrypt if enabled
            let encryptionKey = null;
            if (this.config.encryptionEnabled) {
                const encrypted = await this.encryptData(processedData);
                processedData = encrypted.data;
                encryptionKey = encrypted.key;
            }
            
            // Split into chunks for large files
            const chunks = this.splitIntoChunks(processedData);
            const chunkCIDs = [];
            
            // Upload chunks
            for (const chunk of chunks) {
                const result = await this.ipfsNode.add(chunk, {
                    pin: true,
                    wrapWithDirectory: false
                });
                chunkCIDs.push(result.cid.toString());
            }
            
            // Create manifest
            const manifest = {
                filename: metadata.filename || filePath,
                size: fileSize,
                compressedSize: processedData.length,
                chunks: chunkCIDs,
                chunkSize: this.config.chunkSize,
                encrypted: this.config.encryptionEnabled,
                compressed: this.config.compressionEnabled,
                timestamp: Date.now(),
                checksum: this.calculateChecksum(fileData),
                metadata
            };
            
            // Store manifest
            const manifestResult = await this.ipfsNode.add(JSON.stringify(manifest), {
                pin: true
            });
            const manifestCID = manifestResult.cid.toString();
            
            // Store in index
            this.fileIndex.set(manifestCID, manifest);
            
            // Store encryption key if used
            if (encryptionKey) {
                this.encryptionKeys.set(manifestCID, encryptionKey);
            }
            
            // Ensure redundancy
            await this.ensureRedundancy(manifestCID, chunkCIDs);
            
            // Update metrics
            const uploadTime = Date.now() - startTime;
            this.updateUploadMetrics(fileSize, uploadTime);
            
            this.emit('file:stored', {
                cid: manifestCID,
                size: fileSize,
                chunks: chunkCIDs.length,
                uploadTime
            });
            
            return {
                cid: manifestCID,
                size: fileSize,
                encrypted: this.config.encryptionEnabled,
                chunks: chunkCIDs.length
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async retrieveFile(cid, outputPath = null) {
        const startTime = Date.now();
        
        try {
            // Get manifest
            const manifestData = await this.getFromIPFS(cid);
            const manifest = JSON.parse(manifestData.toString());
            
            // Retrieve chunks
            const chunks = [];
            for (const chunkCID of manifest.chunks) {
                const chunk = await this.getChunkWithCache(chunkCID);
                chunks.push(chunk);
            }
            
            // Combine chunks
            let fileData = Buffer.concat(chunks);
            
            // Decrypt if needed
            if (manifest.encrypted) {
                const key = this.encryptionKeys.get(cid);
                if (!key) {
                    throw new Error('Decryption key not found');
                }
                fileData = await this.decryptData(fileData, key);
            }
            
            // Decompress if needed
            if (manifest.compressed) {
                fileData = await this.decompressData(fileData);
            }
            
            // Verify checksum
            const checksum = this.calculateChecksum(fileData);
            if (checksum !== manifest.checksum) {
                throw new Error('Checksum verification failed');
            }
            
            // Save to file if path provided
            if (outputPath) {
                await this.writeFile(outputPath, fileData);
            }
            
            // Update metrics
            const downloadTime = Date.now() - startTime;
            this.updateDownloadMetrics(fileData.length, downloadTime);
            
            this.emit('file:retrieved', {
                cid,
                size: fileData.length,
                downloadTime
            });
            
            return {
                data: fileData,
                metadata: manifest.metadata
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async getChunkWithCache(chunkCID) {
        // Check cache first
        if (this.chunksCache.has(chunkCID)) {
            return this.chunksCache.get(chunkCID);
        }
        
        // Retrieve from IPFS
        const chunk = await this.getFromIPFS(chunkCID);
        
        // Cache chunk
        this.addToCache(chunkCID, chunk);
        
        return chunk;
    }

    async getFromIPFS(cid) {
        const chunks = [];
        
        for await (const chunk of this.ipfsNode.cat(cid)) {
            chunks.push(chunk);
        }
        
        return Buffer.concat(chunks);
    }

    addToCache(cid, data) {
        this.chunksCache.set(cid, data);
        
        // Enforce cache size limit
        let cacheSize = 0;
        for (const [_, chunk] of this.chunksCache) {
            cacheSize += chunk.length;
        }
        
        // Remove oldest entries if cache is full
        while (cacheSize > this.config.cacheSize && this.chunksCache.size > 0) {
            const firstKey = this.chunksCache.keys().next().value;
            const removedChunk = this.chunksCache.get(firstKey);
            cacheSize -= removedChunk.length;
            this.chunksCache.delete(firstKey);
        }
    }

    splitIntoChunks(data) {
        const chunks = [];
        let offset = 0;
        
        while (offset < data.length) {
            const chunkSize = Math.min(this.config.chunkSize, data.length - offset);
            chunks.push(data.slice(offset, offset + chunkSize));
            offset += chunkSize;
        }
        
        return chunks;
    }

    async ensureRedundancy(manifestCID, chunkCIDs) {
        const allCIDs = [manifestCID, ...chunkCIDs];
        
        // Pin to local node
        for (const cid of allCIDs) {
            await this.ipfsNode.pin.add(cid);
        }
        
        // Track redundancy
        this.redundancyMap.set(manifestCID, {
            chunks: chunkCIDs,
            replicas: 1,
            lastChecked: Date.now()
        });
        
        // Pin to remote services
        if (this.config.pinningServices.length > 0) {
            await this.pinToRemoteServices(allCIDs);
        }
        
        // Request additional replicas from swarm
        await this.requestSwarmReplicas(allCIDs);
    }

    async pinToRemoteServices(cids) {
        const promises = [];
        
        for (const service of this.config.pinningServices) {
            for (const cid of cids) {
                promises.push(this.pinToService(service, cid));
            }
        }
        
        await Promise.allSettled(promises);
    }

    async pinToService(service, cid) {
        try {
            // Implementation would depend on the pinning service API
            // Example: Pinata, Infura, etc.
            const response = await fetch(`${service.endpoint}/pin`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${service.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ cid })
            });
            
            if (!response.ok) {
                throw new Error(`Pinning failed: ${response.statusText}`);
            }
            
            this.emit('pin:remote', { service: service.name, cid });
        } catch (error) {
            this.emit('pin:error', { service: service.name, cid, error });
        }
    }

    async requestSwarmReplicas(cids) {
        // Use IPFS DHT to ensure content is replicated
        for (const cid of cids) {
            try {
                const providers = await this.ipfsNode.dht.findProvs(cid, {
                    numProviders: this.config.replicationFactor
                });
                
                const providerCount = Array.from(providers).length;
                
                if (providerCount < this.config.replicationFactor) {
                    // Announce to DHT to attract more providers
                    await this.ipfsNode.dht.provide(cid);
                }
            } catch (error) {
                this.emit('replication:error', { cid, error });
            }
        }
    }

    async compressData(data) {
        const zlib = require('zlib');
        const { promisify } = require('util');
        const gzip = promisify(zlib.gzip);
        
        return await gzip(data);
    }

    async decompressData(data) {
        const zlib = require('zlib');
        const { promisify } = require('util');
        const gunzip = promisify(zlib.gunzip);
        
        return await gunzip(data);
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
            key: key
        };
    }

    async decryptData(data, key) {
        const algorithm = 'aes-256-gcm';
        
        const iv = data.slice(0, 16);
        const authTag = data.slice(16, 32);
        const encrypted = data.slice(32);
        
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(authTag);
        
        return Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
    }

    calculateChecksum(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    startHealthMonitoring() {
        setInterval(async () => {
            await this.checkStorageHealth();
            await this.verifyRedundancy();
            await this.cleanupExpiredContent();
        }, 300000); // Every 5 minutes
    }

    async checkStorageHealth() {
        try {
            // Check IPFS node status
            const stats = await this.ipfsNode.stats.repo();
            
            this.emit('health:checked', {
                repoSize: stats.repoSize,
                storageMax: stats.storageMax,
                numObjects: stats.numObjects
            });
            
            // Check if approaching storage limit
            const usage = stats.repoSize / stats.storageMax;
            if (usage > 0.9) {
                this.emit('storage:warning', { usage });
                await this.performGarbageCollection();
            }
        } catch (error) {
            this.emit('health:error', error);
        }
    }

    async verifyRedundancy() {
        for (const [manifestCID, info] of this.redundancyMap) {
            try {
                const providers = await this.ipfsNode.dht.findProvs(manifestCID, {
                    numProviders: 10
                });
                
                const providerCount = Array.from(providers).length;
                info.replicas = providerCount;
                info.lastChecked = Date.now();
                
                if (providerCount < this.config.replicationFactor) {
                    this.emit('redundancy:low', { cid: manifestCID, replicas: providerCount });
                    await this.requestSwarmReplicas([manifestCID, ...info.chunks]);
                }
            } catch (error) {
                this.emit('redundancy:check-error', { cid: manifestCID, error });
            }
        }
    }

    async performGarbageCollection() {
        try {
            await this.ipfsNode.repo.gc();
            this.emit('gc:completed');
        } catch (error) {
            this.emit('gc:error', error);
        }
    }

    async cleanupExpiredContent() {
        // Implement content expiration logic if needed
        const now = Date.now();
        const expirationTime = 30 * 24 * 60 * 60 * 1000; // 30 days
        
        for (const [cid, manifest] of this.fileIndex) {
            if (manifest.metadata?.expiresAt && manifest.metadata.expiresAt < now) {
                await this.removeFile(cid);
            }
        }
    }

    async removeFile(cid) {
        try {
            const manifest = this.fileIndex.get(cid);
            if (!manifest) return;
            
            // Unpin all chunks
            for (const chunkCID of manifest.chunks) {
                await this.ipfsNode.pin.rm(chunkCID);
            }
            
            // Unpin manifest
            await this.ipfsNode.pin.rm(cid);
            
            // Remove from index
            this.fileIndex.delete(cid);
            this.encryptionKeys.delete(cid);
            this.redundancyMap.delete(cid);
            
            this.emit('file:removed', { cid });
        } catch (error) {
            this.emit('remove:error', { cid, error });
        }
    }

    updateUploadMetrics(size, time) {
        this.metrics.totalUploads++;
        this.metrics.bytesUploaded += size;
        
        const speed = size / (time / 1000); // bytes per second
        this.metrics.averageUploadSpeed = 
            (this.metrics.averageUploadSpeed * (this.metrics.totalUploads - 1) + speed) / 
            this.metrics.totalUploads;
    }

    updateDownloadMetrics(size, time) {
        this.metrics.totalDownloads++;
        this.metrics.bytesDownloaded += size;
        
        const speed = size / (time / 1000); // bytes per second
        this.metrics.averageDownloadSpeed = 
            (this.metrics.averageDownloadSpeed * (this.metrics.totalDownloads - 1) + speed) / 
            this.metrics.totalDownloads;
    }

    async readFile(path) {
        const fs = require('fs').promises;
        return await fs.readFile(path);
    }

    async writeFile(path, data) {
        const fs = require('fs').promises;
        await fs.writeFile(path, data);
    }

    initializePinningServices() {
        // Initialize connections to pinning services
        // This would be implemented based on specific service APIs
    }

    getMetrics() {
        return {
            ...this.metrics,
            cacheSize: this.chunksCache.size,
            indexedFiles: this.fileIndex.size,
            redundancyTracked: this.redundancyMap.size
        };
    }

    async stop() {
        if (this.ipfsNode) {
            await this.ipfsNode.stop();
        }
        
        this.emit('stopped');
    }
}

module.exports = IPFSStorageSystem;