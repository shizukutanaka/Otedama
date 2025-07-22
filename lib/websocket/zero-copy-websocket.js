/**
 * Zero-Copy WebSocket Implementation for Otedama
 * 
 * High-performance WebSocket handling with minimal memory allocation
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { globalBufferPool, RingBuffer } from '../performance/buffer-pool.js';
import { zeroCopyProtocol } from '../performance/zero-copy-protocol.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('ZeroCopyWebsocket');

/**
 * WebSocket opcodes
 */
const OpCode = {
    CONTINUATION: 0x0,
    TEXT: 0x1,
    BINARY: 0x2,
    CLOSE: 0x8,
    PING: 0x9,
    PONG: 0xA
};

/**
 * Zero-copy WebSocket connection handler
 */
export class ZeroCopyWebSocket extends EventEmitter {
    constructor(socket, options = {}) {
        super();
        
        this.socket = socket;
        this.options = {
            maxMessageSize: options.maxMessageSize || 1048576, // 1MB
            binaryMode: options.binaryMode !== false,
            compression: options.compression || false,
            heartbeatInterval: options.heartbeatInterval || 30000,
            ...options
        };
        
        // Ring buffers for zero-copy I/O
        this.readBuffer = new RingBuffer(65536);
        this.writeBuffer = new RingBuffer(65536);
        
        // Frame parsing state
        this.frameState = {
            stage: 'header',
            opcode: null,
            fin: false,
            mask: false,
            maskKey: null,
            payloadLength: 0,
            headerBuffer: globalBufferPool.allocate(14),
            headerPos: 0,
            payloadBuffer: null,
            payloadPos: 0
        };
        
        // Message fragmentation state
        this.fragments = [];
        this.fragmentOpcode = null;
        
        // Statistics
        this.stats = {
            messagesReceived: 0,
            messagesSent: 0,
            bytesReceived: 0,
            bytesSent: 0,
            pingsSent: 0,
            pongsReceived: 0
        };
        
        // Setup socket handlers
        this.setupSocket();
        
        // Start heartbeat
        this.startHeartbeat();
    }
    
    /**
     * Setup socket event handlers
     */
    setupSocket() {
        this.socket.on('data', (chunk) => {
            this.stats.bytesReceived += chunk.length;
            
            // Write to ring buffer
            if (!this.readBuffer.write(chunk)) {
                // Buffer full, process what we have
                this.processIncomingData();
                
                // Try again
                if (!this.readBuffer.write(chunk)) {
                    this.close(1008, 'Message too large');
                    return;
                }
            }
            
            this.processIncomingData();
        });
        
        this.socket.on('error', (error) => {
            this.emit('error', error);
        });
        
        this.socket.on('close', () => {
            this.cleanup();
            this.emit('close');
        });
        
        this.socket.on('drain', () => {
            this.flush();
        });
    }
    
    /**
     * Process incoming data from ring buffer
     */
    processIncomingData() {
        while (this.readBuffer.used() > 0) {
            if (this.frameState.stage === 'header') {
                if (!this.parseHeader()) break;
            }
            
            if (this.frameState.stage === 'payload') {
                if (!this.parsePayload()) break;
            }
        }
    }
    
    /**
     * Parse WebSocket frame header
     */
    parseHeader() {
        const needed = this.frameState.headerPos === 0 ? 2 : 
                      this.frameState.payloadLength === 126 ? 4 :
                      this.frameState.payloadLength === 127 ? 10 : 0;
        
        if (needed > 0 && this.readBuffer.used() < needed) {
            return false; // Need more data
        }
        
        if (this.frameState.headerPos === 0) {
            // Read first 2 bytes
            const header = this.readBuffer.read(2);
            if (!header) return false;
            
            // Parse first byte
            this.frameState.fin = (header[0] & 0x80) === 0x80;
            this.frameState.opcode = header[0] & 0x0F;
            
            // Parse second byte
            this.frameState.mask = (header[1] & 0x80) === 0x80;
            this.frameState.payloadLength = header[1] & 0x7F;
            
            this.frameState.headerPos = 2;
            
            // Extended payload length
            if (this.frameState.payloadLength === 126 || 
                this.frameState.payloadLength === 127) {
                return this.parseHeader(); // Continue parsing
            }
        }
        
        // Read extended length
        if (this.frameState.payloadLength === 126) {
            const extLength = this.readBuffer.read(2);
            if (!extLength) return false;
            
            this.frameState.payloadLength = extLength.readUInt16BE(0);
        } else if (this.frameState.payloadLength === 127) {
            const extLength = this.readBuffer.read(8);
            if (!extLength) return false;
            
            // For simplicity, convert to number (loses precision for very large messages)
            this.frameState.payloadLength = Number(extLength.readBigUInt64BE(0));
        }
        
        // Read mask key if present
        if (this.frameState.mask) {
            const maskKey = this.readBuffer.read(4);
            if (!maskKey) return false;
            
            this.frameState.maskKey = maskKey;
        }
        
        // Validate payload length
        if (this.frameState.payloadLength > this.options.maxMessageSize) {
            this.close(1009, 'Message too large');
            return false;
        }
        
        // Allocate payload buffer
        if (this.frameState.payloadLength > 0) {
            this.frameState.payloadBuffer = globalBufferPool.allocate(
                this.frameState.payloadLength
            );
        }
        
        this.frameState.stage = 'payload';
        this.frameState.payloadPos = 0;
        
        return true;
    }
    
    /**
     * Parse WebSocket frame payload
     */
    parsePayload() {
        const remaining = this.frameState.payloadLength - this.frameState.payloadPos;
        
        if (remaining > 0) {
            const available = Math.min(remaining, this.readBuffer.used());
            if (available === 0) return false;
            
            const chunk = this.readBuffer.read(available);
            
            // Unmask if needed (in-place)
            if (this.frameState.mask) {
                for (let i = 0; i < chunk.length; i++) {
                    chunk[i] ^= this.frameState.maskKey[
                        (this.frameState.payloadPos + i) % 4
                    ];
                }
            }
            
            // Copy to payload buffer
            chunk.copy(
                this.frameState.payloadBuffer,
                this.frameState.payloadPos
            );
            
            this.frameState.payloadPos += available;
        }
        
        // Frame complete?
        if (this.frameState.payloadPos >= this.frameState.payloadLength) {
            this.handleFrame();
            this.resetFrameState();
            return true;
        }
        
        return false;
    }
    
    /**
     * Handle complete frame
     */
    handleFrame() {
        const { opcode, fin, payloadBuffer, payloadLength } = this.frameState;
        
        // Control frames
        if (opcode === OpCode.CLOSE) {
            let code = 1000;
            let reason = '';
            
            if (payloadLength >= 2) {
                code = payloadBuffer.readUInt16BE(0);
                reason = payloadBuffer.slice(2, payloadLength).toString();
            }
            
            this.close(code, reason);
            return;
        }
        
        if (opcode === OpCode.PING) {
            this.pong(payloadBuffer ? payloadBuffer.slice(0, payloadLength) : null);
            return;
        }
        
        if (opcode === OpCode.PONG) {
            this.stats.pongsReceived++;
            this.emit('pong', payloadBuffer ? payloadBuffer.slice(0, payloadLength) : null);
            return;
        }
        
        // Data frames
        if (opcode !== OpCode.CONTINUATION) {
            this.fragmentOpcode = opcode;
        }
        
        if (payloadBuffer && payloadLength > 0) {
            this.fragments.push(payloadBuffer.slice(0, payloadLength));
        }
        
        if (fin) {
            // Message complete
            const message = this.assembleMessage();
            this.stats.messagesReceived++;
            
            if (this.fragmentOpcode === OpCode.TEXT) {
                this.emit('message', message.toString());
            } else if (this.fragmentOpcode === OpCode.BINARY) {
                this.emit('message', message);
            }
            
            // Clear fragments
            this.fragments = [];
            this.fragmentOpcode = null;
        }
        
        // Release payload buffer
        if (payloadBuffer) {
            globalBufferPool.release(payloadBuffer);
        }
    }
    
    /**
     * Assemble fragmented message
     */
    assembleMessage() {
        if (this.fragments.length === 0) {
            return Buffer.alloc(0);
        }
        
        if (this.fragments.length === 1) {
            return this.fragments[0];
        }
        
        // Calculate total length
        const totalLength = this.fragments.reduce((sum, frag) => sum + frag.length, 0);
        const message = globalBufferPool.allocate(totalLength);
        
        // Copy fragments
        let offset = 0;
        for (const fragment of this.fragments) {
            fragment.copy(message, offset);
            offset += fragment.length;
        }
        
        return message;
    }
    
    /**
     * Send message with zero-copy
     */
    send(data, callback) {
        if (this.readyState !== 1) {
            if (callback) callback(new Error('WebSocket not open'));
            return;
        }
        
        try {
            let opcode;
            let payload;
            
            if (typeof data === 'string') {
                opcode = OpCode.TEXT;
                payload = Buffer.from(data);
            } else if (Buffer.isBuffer(data)) {
                opcode = OpCode.BINARY;
                payload = data;
            } else {
                // Assume it's an object, use binary protocol
                opcode = OpCode.BINARY;
                payload = this.encodeBinaryMessage(data);
            }
            
            this.sendFrame(opcode, payload, callback);
            this.stats.messagesSent++;
            
        } catch (error) {
            if (callback) callback(error);
            else this.emit('error', error);
        }
    }
    
    /**
     * Send frame with zero-copy
     */
    sendFrame(opcode, payload, callback) {
        const payloadLength = payload ? payload.length : 0;
        
        // Create frame header
        const header = globalBufferPool.allocate(10);
        let headerLength = 2;
        
        // First byte: FIN + opcode
        header[0] = 0x80 | opcode;
        
        // Payload length
        if (payloadLength < 126) {
            header[1] = payloadLength;
        } else if (payloadLength < 65536) {
            header[1] = 126;
            header.writeUInt16BE(payloadLength, 2);
            headerLength = 4;
        } else {
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(payloadLength), 2);
            headerLength = 10;
        }
        
        // Write header
        this.socket.write(header.slice(0, headerLength), (err) => {
            if (err) {
                globalBufferPool.release(header);
                if (callback) callback(err);
                return;
            }
            
            // Write payload (if any)
            if (payload && payloadLength > 0) {
                this.socket.write(payload, (err) => {
                    globalBufferPool.release(header);
                    if (callback) callback(err);
                });
                
                this.stats.bytesSent += payloadLength;
            } else {
                globalBufferPool.release(header);
                if (callback) callback();
            }
            
            this.stats.bytesSent += headerLength;
        });
    }
    
    /**
     * Send ping frame
     */
    ping(data) {
        this.sendFrame(OpCode.PING, data);
        this.stats.pingsSent++;
    }
    
    /**
     * Send pong frame
     */
    pong(data) {
        this.sendFrame(OpCode.PONG, data);
    }
    
    /**
     * Close connection
     */
    close(code = 1000, reason = '') {
        if (this.readyState === 3) return;
        
        this.readyState = 3;
        
        // Create close frame
        const reasonBuffer = Buffer.from(reason);
        const payload = globalBufferPool.allocate(2 + reasonBuffer.length);
        
        payload.writeUInt16BE(code, 0);
        reasonBuffer.copy(payload, 2);
        
        this.sendFrame(OpCode.CLOSE, payload.slice(0, 2 + reasonBuffer.length), () => {
            globalBufferPool.release(payload);
            this.socket.end();
        });
    }
    
    /**
     * Reset frame parsing state
     */
    resetFrameState() {
        globalBufferPool.release(this.frameState.headerBuffer);
        
        this.frameState = {
            stage: 'header',
            opcode: null,
            fin: false,
            mask: false,
            maskKey: null,
            payloadLength: 0,
            headerBuffer: globalBufferPool.allocate(14),
            headerPos: 0,
            payloadBuffer: null,
            payloadPos: 0
        };
    }
    
    /**
     * Encode binary message using zero-copy protocol
     */
    encodeBinaryMessage(obj) {
        const buffer = globalBufferPool.allocate(1024);
        let length = 0;
        
        // Use zero-copy protocol based on message type
        if (obj.type === 'share') {
            length = zeroCopyProtocol.encodeShare(obj.data, buffer);
        } else if (obj.type === 'order') {
            length = zeroCopyProtocol.encodeOrder(obj.data, buffer);
        } else {
            // Fallback to JSON for unknown types
            const json = JSON.stringify(obj);
            const jsonBuffer = Buffer.from(json);
            jsonBuffer.copy(buffer);
            length = jsonBuffer.length;
        }
        
        return buffer.slice(0, length);
    }
    
    /**
     * Start heartbeat mechanism
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.readyState === 1) {
                this.ping();
            }
        }, this.options.heartbeatInterval);
    }
    
    /**
     * Cleanup resources
     */
    cleanup() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        // Release buffers
        if (this.frameState.headerBuffer) {
            globalBufferPool.release(this.frameState.headerBuffer);
        }
        if (this.frameState.payloadBuffer) {
            globalBufferPool.release(this.frameState.payloadBuffer);
        }
        
        // Release fragments
        for (const fragment of this.fragments) {
            globalBufferPool.release(fragment);
        }
        
        this.readBuffer.clear();
        this.writeBuffer.clear();
        
        this.readyState = 3;
    }
    
    /**
     * Get connection statistics
     */
    getStats() {
        return {
            ...this.stats,
            readBufferUsed: this.readBuffer.used(),
            writeBufferUsed: this.writeBuffer.used()
        };
    }
    
    // WebSocket ready states
    get CONNECTING() { return 0; }
    get OPEN() { return 1; }
    get CLOSING() { return 2; }
    get CLOSED() { return 3; }
    
    get readyState() {
        return this._readyState || 1;
    }
    
    set readyState(state) {
        this._readyState = state;
    }
}

export default ZeroCopyWebSocket;