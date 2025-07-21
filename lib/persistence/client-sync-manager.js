/**
 * Client-Side Data Sync Manager for Otedama
 * Handles offline storage and synchronization with server
 * 
 * Design principles:
 * - Reliable offline operation (Carmack)
 * - Clean sync protocols (Martin)
 * - Simple conflict resolution (Pike)
 */

export class ClientSyncManager {
    constructor(config = {}) {
        this.config = {
            // Storage settings
            storagePrefix: config.storagePrefix || 'otedama_',
            maxStorageSize: config.maxStorageSize || 50 * 1024 * 1024, // 50MB
            
            // Sync settings
            syncInterval: config.syncInterval || 30000, // 30 seconds
            batchSize: config.batchSize || 100,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            
            // Offline queue
            maxQueueSize: config.maxQueueSize || 1000,
            queuePersistKey: config.queuePersistKey || 'sync_queue',
            
            // Conflict resolution
            conflictStrategy: config.conflictStrategy || 'last-write-wins',
            
            // WebSocket settings
            wsUrl: config.wsUrl || 'ws://localhost:8081',
            reconnectInterval: config.reconnectInterval || 5000,
            heartbeatInterval: config.heartbeatInterval || 30000,
            
            ...config
        };
        
        // Storage backends
        this.localStorage = window.localStorage;
        this.indexedDB = null;
        this.dbName = 'OtedamaOfflineDB';
        this.dbVersion = 1;
        
        // Sync state
        this.syncQueue = [];
        this.syncing = false;
        this.lastSyncTime = null;
        this.connectionStatus = 'disconnected';
        
        // WebSocket connection
        this.ws = null;
        this.wsReconnectTimeout = null;
        this.heartbeatInterval = null;
        
        // Session management
        this.sessionId = null;
        this.userId = null;
        
        // Event handlers
        this.eventHandlers = new Map();
        
        // Initialize
        this.initialize();
    }
    
    /**
     * Initialize sync manager
     */
    async initialize() {
        try {
            // Initialize IndexedDB
            await this.initializeIndexedDB();
            
            // Load sync queue from storage
            await this.loadSyncQueue();
            
            // Restore session if exists
            await this.restoreSession();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Start sync timer
            this.startSyncTimer();
            
            // Connect WebSocket
            this.connectWebSocket();
            
            console.log('Client sync manager initialized');
            
        } catch (error) {
            console.error('Failed to initialize sync manager:', error);
        }
    }
    
    /**
     * Initialize IndexedDB
     */
    async initializeIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.indexedDB = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // User data store
                if (!db.objectStoreNames.contains('userData')) {
                    const userDataStore = db.createObjectStore('userData', { 
                        keyPath: ['userId', 'dataType'] 
                    });
                    userDataStore.createIndex('userId', 'userId');
                    userDataStore.createIndex('lastModified', 'lastModified');
                }
                
                // Sync metadata store
                if (!db.objectStoreNames.contains('syncMetadata')) {
                    const syncStore = db.createObjectStore('syncMetadata', { 
                        keyPath: 'key' 
                    });
                }
                
                // Offline queue store
                if (!db.objectStoreNames.contains('offlineQueue')) {
                    const queueStore = db.createObjectStore('offlineQueue', { 
                        keyPath: 'id', 
                        autoIncrement: true 
                    });
                    queueStore.createIndex('timestamp', 'timestamp');
                }
            };
        });
    }
    
    /**
     * Save data locally
     */
    async saveData(dataType, data) {
        if (!this.userId) {
            throw new Error('No active user session');
        }
        
        const record = {
            userId: this.userId,
            dataType,
            data,
            version: Date.now(),
            lastModified: Date.now(),
            syncStatus: 'pending'
        };
        
        try {
            // Save to IndexedDB
            await this.saveToIndexedDB('userData', record);
            
            // Save to localStorage for quick access
            const key = `${this.config.storagePrefix}${this.userId}_${dataType}`;
            this.localStorage.setItem(key, JSON.stringify({
                data,
                version: record.version,
                lastModified: record.lastModified
            }));
            
            // Add to sync queue
            this.addToSyncQueue({
                operation: 'save',
                dataType,
                data,
                timestamp: Date.now()
            });
            
            // Trigger immediate sync if online
            if (this.connectionStatus === 'connected') {
                this.sync();
            }
            
            this.emit('data:saved', { dataType, version: record.version });
            
        } catch (error) {
            console.error('Failed to save data locally:', error);
            throw error;
        }
    }
    
    /**
     * Load data locally
     */
    async loadData(dataType) {
        if (!this.userId) {
            throw new Error('No active user session');
        }
        
        try {
            // Try localStorage first for speed
            const key = `${this.config.storagePrefix}${this.userId}_${dataType}`;
            const cached = this.localStorage.getItem(key);
            
            if (cached) {
                const parsed = JSON.parse(cached);
                return parsed.data;
            }
            
            // Fall back to IndexedDB
            const record = await this.loadFromIndexedDB('userData', [this.userId, dataType]);
            return record ? record.data : null;
            
        } catch (error) {
            console.error('Failed to load data locally:', error);
            return null;
        }
    }
    
    /**
     * Add operation to sync queue
     */
    addToSyncQueue(operation) {
        // Check queue size limit
        if (this.syncQueue.length >= this.config.maxQueueSize) {
            // Remove oldest non-critical items
            const criticalOps = ['save', 'delete'];
            this.syncQueue = this.syncQueue.filter((op, index) => 
                criticalOps.includes(op.operation) || index > this.syncQueue.length - 100
            );
        }
        
        this.syncQueue.push({
            ...operation,
            id: Date.now() + Math.random(),
            retries: 0
        });
        
        // Persist queue
        this.saveSyncQueue();
    }
    
    /**
     * Sync data with server
     */
    async sync() {
        if (this.syncing || this.connectionStatus !== 'connected') {
            return;
        }
        
        this.syncing = true;
        
        try {
            // Get pending operations
            const batch = this.syncQueue.splice(0, this.config.batchSize);
            
            if (batch.length === 0) {
                this.syncing = false;
                return;
            }
            
            // Send batch to server
            const response = await this.sendBatch(batch);
            
            // Process results
            for (const result of response.results) {
                if (result.success) {
                    // Update local version
                    if (result.dataType && result.version) {
                        await this.updateLocalVersion(result.dataType, result.version);
                    }
                } else {
                    // Handle failure
                    const operation = batch.find(op => op.id === result.operationId);
                    if (operation) {
                        operation.retries++;
                        if (operation.retries < this.config.maxRetries) {
                            // Re-queue
                            this.syncQueue.unshift(operation);
                        } else {
                            // Max retries reached
                            this.emit('sync:failed', {
                                operation,
                                error: result.error
                            });
                        }
                    }
                }
            }
            
            // Handle conflicts
            if (response.conflicts && response.conflicts.length > 0) {
                await this.resolveConflicts(response.conflicts);
            }
            
            // Update sync metadata
            this.lastSyncTime = Date.now();
            await this.saveSyncMetadata('lastSync', this.lastSyncTime);
            
            // Save updated queue
            await this.saveSyncQueue();
            
            this.emit('sync:completed', {
                synced: response.results.filter(r => r.success).length,
                failed: response.results.filter(r => !r.success).length,
                conflicts: response.conflicts?.length || 0
            });
            
        } catch (error) {
            console.error('Sync failed:', error);
            
            // Re-queue all operations
            this.syncQueue.unshift(...batch);
            await this.saveSyncQueue();
            
            this.emit('sync:error', error);
            
        } finally {
            this.syncing = false;
            
            // Continue syncing if more items
            if (this.syncQueue.length > 0 && this.connectionStatus === 'connected') {
                setTimeout(() => this.sync(), 100);
            }
        }
    }
    
    /**
     * Send batch to server
     */
    async sendBatch(batch) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }
            
            const requestId = Date.now() + Math.random();
            
            // Setup response handler
            const handleResponse = (event) => {
                const message = JSON.parse(event.data);
                if (message.type === 'sync:response' && message.requestId === requestId) {
                    this.ws.removeEventListener('message', handleResponse);
                    resolve(message.data);
                }
            };
            
            this.ws.addEventListener('message', handleResponse);
            
            // Send batch
            this.ws.send(JSON.stringify({
                type: 'sync:batch',
                requestId,
                sessionId: this.sessionId,
                batch
            }));
            
            // Timeout
            setTimeout(() => {
                this.ws.removeEventListener('message', handleResponse);
                reject(new Error('Sync timeout'));
            }, 30000);
        });
    }
    
    /**
     * Resolve conflicts
     */
    async resolveConflicts(conflicts) {
        for (const conflict of conflicts) {
            switch (this.config.conflictStrategy) {
                case 'last-write-wins':
                    // Use the version with latest timestamp
                    if (conflict.serverVersion.lastModified > conflict.localVersion.lastModified) {
                        await this.applyServerVersion(conflict);
                    }
                    break;
                    
                case 'client-wins':
                    // Keep local version
                    this.addToSyncQueue({
                        operation: 'force-update',
                        dataType: conflict.dataType,
                        data: conflict.localVersion.data,
                        timestamp: Date.now()
                    });
                    break;
                    
                case 'merge':
                    // Custom merge logic
                    const merged = await this.mergeConflict(conflict);
                    await this.saveData(conflict.dataType, merged);
                    break;
                    
                case 'manual':
                    // Notify user to resolve manually
                    this.emit('conflict:detected', conflict);
                    break;
            }
        }
    }
    
    /**
     * Apply server version
     */
    async applyServerVersion(conflict) {
        const record = {
            userId: this.userId,
            dataType: conflict.dataType,
            data: conflict.serverVersion.data,
            version: conflict.serverVersion.version,
            lastModified: conflict.serverVersion.lastModified,
            syncStatus: 'synced'
        };
        
        await this.saveToIndexedDB('userData', record);
        
        // Update localStorage
        const key = `${this.config.storagePrefix}${this.userId}_${conflict.dataType}`;
        this.localStorage.setItem(key, JSON.stringify({
            data: record.data,
            version: record.version,
            lastModified: record.lastModified
        }));
    }
    
    /**
     * Connect WebSocket for real-time sync
     */
    connectWebSocket() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }
        
        try {
            this.ws = new WebSocket(this.config.wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.connectionStatus = 'connected';
                
                // Clear reconnect timeout
                if (this.wsReconnectTimeout) {
                    clearTimeout(this.wsReconnectTimeout);
                    this.wsReconnectTimeout = null;
                }
                
                // Authenticate session
                if (this.sessionId) {
                    this.ws.send(JSON.stringify({
                        type: 'auth',
                        sessionId: this.sessionId
                    }));
                }
                
                // Start heartbeat
                this.startHeartbeat();
                
                // Trigger sync
                this.sync();
                
                this.emit('connection:established');
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleServerMessage(message);
                } catch (error) {
                    console.error('Failed to parse message:', error);
                }
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.connectionStatus = 'disconnected';
                this.stopHeartbeat();
                
                // Schedule reconnect
                this.wsReconnectTimeout = setTimeout(() => {
                    this.connectWebSocket();
                }, this.config.reconnectInterval);
                
                this.emit('connection:lost');
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.emit('connection:error', error);
            };
            
        } catch (error) {
            console.error('Failed to connect WebSocket:', error);
            
            // Schedule reconnect
            this.wsReconnectTimeout = setTimeout(() => {
                this.connectWebSocket();
            }, this.config.reconnectInterval);
        }
    }
    
    /**
     * Handle server messages
     */
    handleServerMessage(message) {
        switch (message.type) {
            case 'auth:success':
                this.sessionId = message.sessionId;
                this.userId = message.userId;
                this.saveSession();
                break;
                
            case 'data:updated':
                // Server notifying of data update
                this.handleRemoteUpdate(message.data);
                break;
                
            case 'sync:request':
                // Server requesting sync
                this.sync();
                break;
                
            case 'pong':
                // Heartbeat response
                break;
                
            default:
                console.warn('Unknown message type:', message.type);
        }
    }
    
    /**
     * Handle remote data update
     */
    async handleRemoteUpdate(update) {
        const { dataType, data, version } = update;
        
        // Check if we have local changes
        const localData = await this.loadFromIndexedDB('userData', [this.userId, dataType]);
        
        if (localData && localData.syncStatus === 'pending') {
            // We have pending local changes - create conflict
            this.emit('conflict:detected', {
                dataType,
                localVersion: localData,
                serverVersion: update
            });
        } else {
            // Apply server update
            await this.applyServerVersion({
                dataType,
                serverVersion: update
            });
            
            this.emit('data:updated', { dataType, version });
        }
    }
    
    /**
     * Start heartbeat
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, this.config.heartbeatInterval);
    }
    
    /**
     * Stop heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    /**
     * Save to IndexedDB
     */
    async saveToIndexedDB(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.indexedDB.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    
    /**
     * Load from IndexedDB
     */
    async loadFromIndexedDB(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.indexedDB.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    /**
     * Save sync queue
     */
    async saveSyncQueue() {
        try {
            // Clear old queue
            const transaction = this.indexedDB.transaction(['offlineQueue'], 'readwrite');
            const store = transaction.objectStore('offlineQueue');
            await store.clear();
            
            // Save current queue
            for (const operation of this.syncQueue) {
                await this.saveToIndexedDB('offlineQueue', operation);
            }
            
            // Also save to localStorage for quick recovery
            this.localStorage.setItem(
                this.config.storagePrefix + this.config.queuePersistKey,
                JSON.stringify(this.syncQueue)
            );
            
        } catch (error) {
            console.error('Failed to save sync queue:', error);
        }
    }
    
    /**
     * Load sync queue
     */
    async loadSyncQueue() {
        try {
            // Try localStorage first
            const stored = this.localStorage.getItem(
                this.config.storagePrefix + this.config.queuePersistKey
            );
            
            if (stored) {
                this.syncQueue = JSON.parse(stored);
                return;
            }
            
            // Load from IndexedDB
            const transaction = this.indexedDB.transaction(['offlineQueue'], 'readonly');
            const store = transaction.objectStore('offlineQueue');
            const request = store.getAll();
            
            request.onsuccess = () => {
                this.syncQueue = request.result || [];
            };
            
        } catch (error) {
            console.error('Failed to load sync queue:', error);
            this.syncQueue = [];
        }
    }
    
    /**
     * Save session
     */
    saveSession() {
        if (this.sessionId && this.userId) {
            this.localStorage.setItem(this.config.storagePrefix + 'session', JSON.stringify({
                sessionId: this.sessionId,
                userId: this.userId,
                timestamp: Date.now()
            }));
        }
    }
    
    /**
     * Restore session
     */
    async restoreSession() {
        try {
            const stored = this.localStorage.getItem(this.config.storagePrefix + 'session');
            if (stored) {
                const session = JSON.parse(stored);
                
                // Check if session is not too old (24 hours)
                if (Date.now() - session.timestamp < 86400000) {
                    this.sessionId = session.sessionId;
                    this.userId = session.userId;
                    
                    console.log('Session restored:', this.sessionId);
                    return true;
                }
            }
        } catch (error) {
            console.error('Failed to restore session:', error);
        }
        
        return false;
    }
    
    /**
     * Clear all local data
     */
    async clearLocalData() {
        // Clear IndexedDB
        const transaction = this.indexedDB.transaction(
            ['userData', 'syncMetadata', 'offlineQueue'], 
            'readwrite'
        );
        
        await transaction.objectStore('userData').clear();
        await transaction.objectStore('syncMetadata').clear();
        await transaction.objectStore('offlineQueue').clear();
        
        // Clear localStorage
        const keys = Object.keys(this.localStorage);
        for (const key of keys) {
            if (key.startsWith(this.config.storagePrefix)) {
                this.localStorage.removeItem(key);
            }
        }
        
        // Clear memory
        this.syncQueue = [];
        this.sessionId = null;
        this.userId = null;
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Online/offline events
        window.addEventListener('online', () => {
            console.log('Network online');
            this.connectWebSocket();
            this.sync();
        });
        
        window.addEventListener('offline', () => {
            console.log('Network offline');
            this.connectionStatus = 'offline';
            this.emit('connection:offline');
        });
        
        // Page visibility
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.connectionStatus === 'disconnected') {
                this.connectWebSocket();
            }
        });
        
        // Before unload - save pending data
        window.addEventListener('beforeunload', () => {
            this.saveSyncQueue();
        });
    }
    
    /**
     * Start sync timer
     */
    startSyncTimer() {
        setInterval(() => {
            if (this.connectionStatus === 'connected' && this.syncQueue.length > 0) {
                this.sync();
            }
        }, this.config.syncInterval);
    }
    
    /**
     * Event emitter methods
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }
    
    off(event, handler) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }
    
    emit(event, data) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error(`Error in event handler for ${event}:`, error);
                }
            });
        }
    }
    
    /**
     * Get sync status
     */
    getSyncStatus() {
        return {
            connectionStatus: this.connectionStatus,
            queueLength: this.syncQueue.length,
            syncing: this.syncing,
            lastSyncTime: this.lastSyncTime,
            sessionId: this.sessionId,
            userId: this.userId
        };
    }
    
    /**
     * Login user
     */
    async login(userId, sessionId) {
        this.userId = userId;
        this.sessionId = sessionId;
        
        // Save session
        this.saveSession();
        
        // Connect if not connected
        if (this.connectionStatus !== 'connected') {
            this.connectWebSocket();
        } else {
            // Send auth message
            this.ws.send(JSON.stringify({
                type: 'auth',
                sessionId: this.sessionId
            }));
        }
        
        // Trigger sync
        this.sync();
    }
    
    /**
     * Logout user
     */
    async logout() {
        // Save any pending data
        await this.sync();
        
        // Clear session
        this.sessionId = null;
        this.userId = null;
        
        // Clear local data
        await this.clearLocalData();
        
        // Disconnect WebSocket
        if (this.ws) {
            this.ws.close();
        }
        
        this.localStorage.removeItem(this.config.storagePrefix + 'session');
    }
}

// Export for browser usage
if (typeof window !== 'undefined') {
    window.ClientSyncManager = ClientSyncManager;
}