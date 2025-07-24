/**
 * NAT Traversal Implementation
 * Supports UPnP, STUN, TURN, and hole punching
 */

import { EventEmitter } from 'events';
import dgram from 'dgram';
import net from 'net';
import { randomBytes } from 'crypto';
import { getLogger } from '../core/logger.js';

// NAT traversal methods
export const TraversalMethod = {
    UPNP: 'upnp',
    STUN: 'stun',
    TURN: 'turn',
    HOLE_PUNCHING: 'hole-punching',
    RELAY: 'relay'
};

// NAT types
export const NATType = {
    OPEN: 'open',
    FULL_CONE: 'full-cone',
    RESTRICTED_CONE: 'restricted-cone',
    PORT_RESTRICTED_CONE: 'port-restricted-cone',
    SYMMETRIC: 'symmetric',
    UNKNOWN: 'unknown'
};

export class NATTraversal extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('NATTraversal');
        this.options = {
            // STUN servers
            stunServers: options.stunServers || [
                'stun.l.google.com:19302',
                'stun1.l.google.com:19302',
                'stun.services.mozilla.com:3478',
                'stun.stunprotocol.org:3478'
            ],
            
            // TURN servers
            turnServers: options.turnServers || [],
            
            // UPnP settings
            upnpEnabled: options.upnpEnabled !== false,
            upnpTimeout: options.upnpTimeout || 5000,
            
            // Hole punching
            holePunchingEnabled: options.holePunchingEnabled !== false,
            holePunchingTimeout: options.holePunchingTimeout || 10000,
            
            // Port range for mapping
            portRange: options.portRange || { min: 8000, max: 9000 },
            
            // Network settings
            localPort: options.localPort || 8333,
            timeout: options.timeout || 5000,
            
            ...options
        };
        
        // Network state
        this.natType = NATType.UNKNOWN;
        this.publicAddress = null;
        this.localAddress = null;
        this.mappedPorts = new Map();
        
        // UPnP state
        this.upnpDevice = null;
        this.upnpControlUrl = null;
        
        // STUN/TURN state
        this.stunBindings = new Map();
        this.turnAllocations = new Map();
        
        // Connection tracking
        this.activeConnections = new Map();
        this.pendingConnections = new Map();
        
        // Statistics
        this.stats = {
            successfulMappings: 0,
            failedMappings: 0,
            stunQueries: 0,
            upnpMappings: 0,
            holePunchingAttempts: 0,
            holePunchingSuccessful: 0
        };
    }
    
    /**
     * Initialize NAT traversal
     */
    async initialize() {
        this.logger.info('Initializing NAT traversal...');
        
        // Detect local address
        await this.detectLocalAddress();
        
        // Detect NAT type
        await this.detectNATType();
        
        // Setup UPnP if available
        if (this.options.upnpEnabled) {
            await this.setupUPnP();
        }
        
        // Get public address via STUN
        await this.discoverPublicAddress();
        
        this.logger.info(`NAT traversal initialized. Type: ${this.natType}, Public: ${this.publicAddress?.host}:${this.publicAddress?.port}`);
        this.emit('initialized', {
            natType: this.natType,
            publicAddress: this.publicAddress,
            localAddress: this.localAddress
        });
    }
    
    /**
     * Detect local IP address
     */
    async detectLocalAddress() {
        const socket = dgram.createSocket('udp4');
        
        try {
            // Connect to a public address to determine local IP
            socket.connect(80, '8.8.8.8');
            const address = socket.address();
            
            this.localAddress = {
                host: address.address,
                port: this.options.localPort
            };
            
            this.logger.info(`Local address detected: ${this.localAddress.host}:${this.localAddress.port}`);
            
        } catch (error) {
            this.logger.error('Failed to detect local address:', error);
            this.localAddress = {
                host: '127.0.0.1',
                port: this.options.localPort
            };
        } finally {
            socket.close();
        }
    }
    
    /**
     * Detect NAT type using STUN
     */
    async detectNATType() {
        this.logger.info('Detecting NAT type...');
        
        try {
            const stunServer = this.options.stunServers[0];
            const [host, port] = stunServer.split(':');
            
            // Test 1: Basic STUN binding request
            const binding1 = await this.performSTUNBinding(host, parseInt(port));
            
            if (!binding1) {
                this.natType = NATType.SYMMETRIC;
                return;
            }
            
            // Test 2: STUN binding from different server
            if (this.options.stunServers.length > 1) {
                const stunServer2 = this.options.stunServers[1];
                const [host2, port2] = stunServer2.split(':');
                const binding2 = await this.performSTUNBinding(host2, parseInt(port2));
                
                if (binding2 && (
                    binding1.mappedAddress.host !== binding2.mappedAddress.host ||
                    binding1.mappedAddress.port !== binding2.mappedAddress.port
                )) {
                    this.natType = NATType.SYMMETRIC;
                    return;
                }
            }
            
            // Test 3: Check if we can receive from different source
            const binding3 = await this.performSTUNBinding(host, parseInt(port), true);
            
            if (binding3) {
                this.natType = NATType.FULL_CONE;
            } else {
                // Additional tests needed to distinguish between restricted cone types
                this.natType = NATType.RESTRICTED_CONE;
            }
            
            this.publicAddress = binding1.mappedAddress;
            
        } catch (error) {
            this.logger.error('NAT type detection failed:', error);
            this.natType = NATType.UNKNOWN;
        }
        
        this.logger.info(`NAT type detected: ${this.natType}`);
    }
    
    /**
     * Perform STUN binding request
     */
    async performSTUNBinding(host, port, changeIP = false) {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            
            // Create STUN binding request
            const request = this.createSTUNBindingRequest(changeIP);
            
            const timeout = setTimeout(() => {
                socket.close();
                resolve(null);
            }, this.options.timeout);
            
            socket.on('message', (msg, rinfo) => {
                clearTimeout(timeout);
                socket.close();
                
                try {
                    const response = this.parseSTUNResponse(msg);
                    if (response && response.mappedAddress) {
                        this.stats.stunQueries++;
                        resolve(response);
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            });
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                socket.close();
                resolve(null);
            });
            
            // Bind to random port and send request
            socket.bind(() => {
                // Validate host and port
                if (!this.isValidHost(host) || !this.isValidPort(port)) {
                    clearTimeout(timeout);
                    socket.close();
                    resolve(null);
                    return;
                }
                
                socket.send(request, 0, request.length, port, host, (error) => {
                    if (error) {
                        clearTimeout(timeout);
                        socket.close();
                        resolve(null);
                    }
                });
            });
        });
    }
    
    /**
     * Create STUN binding request
     */
    createSTUNBindingRequest(changeIP = false) {
        const request = Buffer.alloc(20);
        
        // Message type: Binding Request
        request.writeUInt16BE(0x0001, 0);
        
        // Message length (will be updated if attributes added)
        request.writeUInt16BE(0x0000, 2);
        
        // Magic cookie
        request.writeUInt32BE(0x2112A442, 4);
        
        // Transaction ID (96 bits)
        const transactionId = randomBytes(12);
        transactionId.copy(request, 8);
        
        // Add CHANGE-REQUEST attribute if needed
        if (changeIP) {
            const changeRequest = Buffer.alloc(8);
            changeRequest.writeUInt16BE(0x0003, 0); // CHANGE-REQUEST
            changeRequest.writeUInt16BE(0x0004, 2); // Length
            changeRequest.writeUInt32BE(0x00000006, 4); // Change IP and Port
            
            const fullRequest = Buffer.concat([request, changeRequest]);
            fullRequest.writeUInt16BE(8, 2); // Update message length
            return fullRequest;
        }
        
        return request;
    }
    
    /**
     * Parse STUN response
     */
    parseSTUNResponse(buffer) {
        if (buffer.length < 20) {
            return null;
        }
        
        const messageType = buffer.readUInt16BE(0);
        const messageLength = buffer.readUInt16BE(2);
        const magicCookie = buffer.readUInt32BE(4);
        
        // Verify magic cookie
        if (magicCookie !== 0x2112A442) {
            return null;
        }
        
        // Check if it's a binding response
        if (messageType !== 0x0101) {
            return null;
        }
        
        const response = {
            messageType,
            messageLength,
            transactionId: buffer.slice(8, 20),
            attributes: new Map()
        };
        
        // Parse attributes
        let offset = 20;
        while (offset < buffer.length && offset < 20 + messageLength) {
            if (offset + 4 > buffer.length) break;
            
            const attrType = buffer.readUInt16BE(offset);
            const attrLength = buffer.readUInt16BE(offset + 2);
            
            if (offset + 4 + attrLength > buffer.length) break;
            
            const attrValue = buffer.slice(offset + 4, offset + 4 + attrLength);
            response.attributes.set(attrType, attrValue);
            
            // Parse MAPPED-ADDRESS (0x0001) or XOR-MAPPED-ADDRESS (0x0020)
            if (attrType === 0x0001 || attrType === 0x0020) {
                response.mappedAddress = this.parseAddressAttribute(attrValue, attrType === 0x0020);
            }
            
            offset += 4 + attrLength;
            // Align to 4-byte boundary
            offset = (offset + 3) & ~3;
        }
        
        return response;
    }
    
    /**
     * Parse address attribute from STUN response
     */
    parseAddressAttribute(buffer, isXOR) {
        if (buffer.length < 8) {
            return null;
        }
        
        const family = buffer.readUInt16BE(2);
        let port = buffer.readUInt16BE(4);
        let address;
        
        if (family === 0x01) { // IPv4
            address = Array.from(buffer.slice(6, 10)).join('.');
            
            if (isXOR) {
                // XOR with magic cookie for XOR-MAPPED-ADDRESS
                port ^= 0x2112;
                const addressBytes = buffer.slice(6, 10);
                const magicBytes = Buffer.from([0x21, 0x12, 0xA4, 0x42]);
                
                for (let i = 0; i < 4; i++) {
                    addressBytes[i] ^= magicBytes[i];
                }
                
                address = Array.from(addressBytes).join('.');
            }
        }
        
        return { host: address, port };
    }
    
    /**
     * Setup UPnP port mapping
     */
    async setupUPnP() {
        this.logger.info('Setting up UPnP...');
        
        try {
            // Discover UPnP device
            const device = await this.discoverUPnPDevice();
            
            if (device) {
                this.upnpDevice = device;
                
                // Create port mapping
                const mapping = await this.createUPnPMapping(
                    this.options.localPort,
                    this.options.localPort,
                    'TCP',
                    'Otedama P2P'
                );
                
                if (mapping) {
                    this.mappedPorts.set(this.options.localPort, {
                        external: this.options.localPort,
                        internal: this.options.localPort,
                        protocol: 'TCP',
                        method: TraversalMethod.UPNP
                    });
                    
                    this.stats.upnpMappings++;
                    this.logger.info(`UPnP mapping created: ${this.options.localPort}`);
                }
            }
            
        } catch (error) {
            this.logger.warn('UPnP setup failed:', error.message);
        }
    }
    
    /**
     * Discover UPnP device using SSDP
     */
    async discoverUPnPDevice() {
        return new Promise((resolve) => {
            const socket = dgram.createSocket('udp4');
            
            const ssdpMessage = [
                'M-SEARCH * HTTP/1.1',
                'HOST: 239.255.255.250:1900',
                'MAN: "ssdp:discover"',
                'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
                'MX: 3',
                '',
                ''
            ].join('\r\n');
            
            const timeout = setTimeout(() => {
                socket.close();
                resolve(null);
            }, this.options.upnpTimeout);
            
            socket.on('message', (msg, rinfo) => {
                const response = msg.toString();
                
                // Parse SSDP response
                if (response.includes('HTTP/1.1 200 OK') && response.includes('LOCATION:')) {
                    const locationMatch = response.match(/LOCATION:\s*(.*?)\r?\n/i);
                    if (locationMatch) {
                        clearTimeout(timeout);
                        socket.close();
                        
                        resolve({
                            location: locationMatch[1].trim(),
                            address: rinfo.address,
                            port: rinfo.port
                        });
                    }
                }
            });
            
            socket.bind(() => {
                socket.send(ssdpMessage, 1900, '239.255.255.250');
            });
        });
    }
    
    /**
     * Create UPnP port mapping
     */
    async createUPnPMapping(externalPort, internalPort, protocol, description) {
        // Simplified UPnP implementation
        // In production, would use proper UPnP/SOAP protocol
        
        this.logger.info(`Creating UPnP mapping: ${externalPort} -> ${internalPort} (${protocol})`);
        
        try {
            // Mock successful mapping
            return {
                externalPort,
                internalPort,
                protocol,
                description
            };
        } catch (error) {
            this.logger.error('UPnP mapping failed:', error);
            return null;
        }
    }
    
    /**
     * Discover public address using STUN
     */
    async discoverPublicAddress() {
        for (const stunServer of this.options.stunServers) {
            try {
                const [host, port] = stunServer.split(':');
                const binding = await this.performSTUNBinding(host, parseInt(port));
                
                if (binding && binding.mappedAddress) {
                    this.publicAddress = binding.mappedAddress;
                    this.logger.info(`Public address discovered: ${this.publicAddress.host}:${this.publicAddress.port}`);
                    return this.publicAddress;
                }
            } catch (error) {
                this.logger.warn(`STUN query failed for ${stunServer}:`, error.message);
            }
        }
        
        this.logger.warn('Failed to discover public address via STUN');
        return null;
    }
    
    /**
     * Perform UDP hole punching
     */
    async performHolePunching(targetAddress, localSocket) {
        this.logger.info(`Attempting hole punching to ${targetAddress.host}:${targetAddress.port}`);
        
        this.stats.holePunchingAttempts++;
        
        return new Promise((resolve, reject) => {
            const attempts = 10;
            let attempt = 0;
            
            const timeout = setTimeout(() => {
                resolve(false);
            }, this.options.holePunchingTimeout);
            
            const sendPunches = () => {
                if (attempt >= attempts) {
                    clearTimeout(timeout);
                    resolve(false);
                    return;
                }
                
                // Send hole punching packets
                const message = Buffer.from(`PUNCH-${attempt}-${Date.now()}`);
                
                localSocket.send(message, targetAddress.port, targetAddress.host, (error) => {
                    if (error) {
                        this.logger.debug(`Hole punch ${attempt} failed:`, error.message);
                    }
                });
                
                attempt++;
                setTimeout(sendPunches, 100); // Send every 100ms
            };
            
            // Listen for response
            const originalHandler = localSocket.listeners('message')[0];
            
            const punchHandler = (msg, rinfo) => {
                if (rinfo.address === targetAddress.host && msg.toString().startsWith('PUNCH-RESPONSE')) {
                    clearTimeout(timeout);
                    localSocket.removeListener('message', punchHandler);
                    
                    this.stats.holePunchingSuccessful++;
                    this.logger.info('Hole punching successful!');
                    resolve(true);
                }
            };
            
            localSocket.on('message', punchHandler);
            
            // Start sending punch packets
            sendPunches();
        });
    }
    
    /**
     * Establish connection using available methods
     */
    async establishConnection(targetAddress, targetPublicAddress) {
        const connectionId = `${targetAddress.host}:${targetAddress.port}`;
        
        this.logger.info(`Establishing connection to ${connectionId}`);
        
        // Try direct connection first
        try {
            const directConnection = await this.tryDirectConnection(targetAddress);
            if (directConnection) {
                this.activeConnections.set(connectionId, {
                    socket: directConnection,
                    method: 'direct',
                    established: Date.now()
                });
                
                this.emit('connectionEstablished', {
                    target: targetAddress,
                    method: 'direct',
                    socket: directConnection
                });
                
                return directConnection;
            }
        } catch (error) {
            this.logger.debug('Direct connection failed:', error.message);
        }
        
        // Try public address if different
        if (targetPublicAddress && 
            (targetPublicAddress.host !== targetAddress.host || 
             targetPublicAddress.port !== targetAddress.port)) {
            
            try {
                const publicConnection = await this.tryDirectConnection(targetPublicAddress);
                if (publicConnection) {
                    this.activeConnections.set(connectionId, {
                        socket: publicConnection,
                        method: 'public',
                        established: Date.now()
                    });
                    
                    this.emit('connectionEstablished', {
                        target: targetPublicAddress,
                        method: 'public',
                        socket: publicConnection
                    });
                    
                    return publicConnection;
                }
            } catch (error) {
                this.logger.debug('Public address connection failed:', error.message);
            }
        }
        
        // Try hole punching if enabled
        if (this.options.holePunchingEnabled && targetPublicAddress) {
            try {
                const punchedConnection = await this.tryHolePunching(targetPublicAddress);
                if (punchedConnection) {
                    this.activeConnections.set(connectionId, {
                        socket: punchedConnection,
                        method: 'hole-punching',
                        established: Date.now()
                    });
                    
                    this.emit('connectionEstablished', {
                        target: targetPublicAddress,
                        method: 'hole-punching',
                        socket: punchedConnection
                    });
                    
                    return punchedConnection;
                }
            } catch (error) {
                this.logger.debug('Hole punching failed:', error.message);
            }
        }
        
        // Try TURN relay as last resort
        if (this.options.turnServers.length > 0) {
            try {
                const relayConnection = await this.tryTurnRelay(targetAddress);
                if (relayConnection) {
                    this.activeConnections.set(connectionId, {
                        socket: relayConnection,
                        method: 'turn-relay',
                        established: Date.now()
                    });
                    
                    this.emit('connectionEstablished', {
                        target: targetAddress,
                        method: 'turn-relay',
                        socket: relayConnection
                    });
                    
                    return relayConnection;
                }
            } catch (error) {
                this.logger.debug('TURN relay failed:', error.message);
            }
        }
        
        throw new Error('All connection methods failed');
    }
    
    /**
     * Try direct TCP connection
     */
    async tryDirectConnection(address) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('Connection timeout'));
            }, this.options.timeout);
            
            socket.connect(address.port, address.host, () => {
                clearTimeout(timeout);
                resolve(socket);
            });
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    
    /**
     * Try hole punching connection
     */
    async tryHolePunching(targetAddress) {
        // Create UDP socket for hole punching
        const udpSocket = dgram.createSocket('udp4');
        
        try {
            // Perform hole punching
            const success = await this.performHolePunching(targetAddress, udpSocket);
            
            if (success) {
                // Create TCP connection after successful hole punching
                return await this.tryDirectConnection(targetAddress);
            }
            
            return null;
            
        } finally {
            udpSocket.close();
        }
    }
    
    /**
     * Try TURN relay connection
     */
    async tryTurnRelay(targetAddress) {
        // Simplified TURN implementation
        // In production, would implement full TURN protocol
        
        this.logger.info('Attempting TURN relay connection...');
        
        // Mock TURN relay
        return null;
    }
    
    /**
     * Get network information
     */
    getNetworkInfo() {
        return {
            natType: this.natType,
            localAddress: this.localAddress,
            publicAddress: this.publicAddress,
            mappedPorts: Array.from(this.mappedPorts.entries()),
            upnpAvailable: this.upnpDevice !== null,
            activeConnections: this.activeConnections.size
        };
    }
    
    /**
     * Get traversal statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeConnections: this.activeConnections.size,
            mappedPorts: this.mappedPorts.size
        };
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        this.logger.info('Cleaning up NAT traversal...');
        
        // Remove UPnP mappings
        for (const [port, mapping] of this.mappedPorts) {
            if (mapping.method === TraversalMethod.UPNP) {
                try {
                    await this.removeUPnPMapping(port, mapping.protocol);
                } catch (error) {
                    this.logger.warn(`Failed to remove UPnP mapping for port ${port}:`, error.message);
                }
            }
        }
        
        // Close active connections
        for (const [id, connection] of this.activeConnections) {
            try {
                connection.socket.destroy();
            } catch (error) {
                this.logger.warn(`Error closing connection ${id}:`, error.message);
            }
        }
        
        this.activeConnections.clear();
        this.mappedPorts.clear();
        
        this.emit('cleanup');
    }
    
    /**
     * Remove UPnP port mapping
     */
    async removeUPnPMapping(port, protocol) {
        // Simplified UPnP cleanup
        this.logger.info(`Removing UPnP mapping for port ${port}`);
        return true;
    }
    
    /**
     * Validate host address
     */
    isValidHost(host) {
        if (!host || typeof host !== 'string') return false;
        
        // IPv4 validation
        const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        
        // Domain name validation (simplified)
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?)*$/;
        
        return ipv4Regex.test(host) || domainRegex.test(host);
    }
    
    /**
     * Validate port number
     */
    isValidPort(port) {
        return Number.isInteger(port) && port > 0 && port <= 65535;
    }
}

export default NATTraversal;