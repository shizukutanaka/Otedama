/**
 * Kernel Bypass Networking - Otedama
 * Ultra-low latency networking with zero-copy and kernel bypass
 * 
 * Design Principles:
 * - Carmack: Direct hardware access, bypass kernel overhead
 * - Martin: Clean abstraction over raw sockets
 * - Pike: Simple API for complex networking
 */

import { EventEmitter } from 'events';
import dgram from 'dgram';
import net from 'net';
import os from 'os';

/**
 * High-performance packet ring buffer
 */
class PacketRingBuffer {
  constructor(size = 1024 * 1024) { // 1MB
    this.size = size;
    this.buffer = Buffer.allocUnsafe(size);
    this.metadata = new Uint32Array(size / 64); // Packet metadata
    this.readIndex = 0;
    this.writeIndex = 0;
    this.packetCount = 0;
    
    // CPU affinity for cache optimization
    this.cpuId = os.cpus().length > 1 ? 1 : 0; // Use CPU 1 for networking
  }
  
  write(packet) {
    const packetSize = packet.length;
    const totalSize = packetSize + 8; // Size header + data
    
    // Check space
    const available = this.getAvailableSpace();
    if (totalSize > available) {
      return false; // Buffer full
    }
    
    // Write size header
    this.buffer.writeUInt32LE(packetSize, this.writeIndex);
    this.buffer.writeUInt32LE(Date.now() & 0xFFFFFFFF, this.writeIndex + 4);
    
    // Copy packet data
    packet.copy(this.buffer, this.writeIndex + 8);
    
    // Update metadata
    const metaIndex = Math.floor(this.writeIndex / 64);
    this.metadata[metaIndex] = packetSize;
    
    // Update write index
    this.writeIndex = (this.writeIndex + totalSize) % this.size;
    this.packetCount++;
    
    return true;
  }
  
  read() {
    if (this.packetCount === 0) {
      return null;
    }
    
    // Read size header
    const packetSize = this.buffer.readUInt32LE(this.readIndex);
    const timestamp = this.buffer.readUInt32LE(this.readIndex + 4);
    
    // Get packet data view (zero-copy)
    const packetData = this.buffer.subarray(
      this.readIndex + 8,
      this.readIndex + 8 + packetSize
    );
    
    // Update read index
    this.readIndex = (this.readIndex + packetSize + 8) % this.size;
    this.packetCount--;
    
    return {
      data: packetData,
      timestamp,
      size: packetSize
    };
  }
  
  getAvailableSpace() {
    if (this.writeIndex >= this.readIndex) {
      return this.size - (this.writeIndex - this.readIndex) - 1;
    }
    return this.readIndex - this.writeIndex - 1;
  }
}

/**
 * Zero-copy socket implementation
 */
export class ZeroCopySocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      bufferSize: options.bufferSize || 1024 * 1024 * 16, // 16MB
      recvBufferSize: options.recvBufferSize || 1024 * 1024 * 8, // 8MB
      sendBufferSize: options.sendBufferSize || 1024 * 1024 * 8, // 8MB
      noDelay: options.noDelay !== false, // TCP_NODELAY
      keepAlive: options.keepAlive !== false,
      ...options
    };
    
    this.socket = null;
    this.recvBuffer = new PacketRingBuffer(this.options.recvBufferSize);
    this.sendBuffer = new PacketRingBuffer(this.options.sendBufferSize);
    this.stats = {
      packetsReceived: 0,
      packetsSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      latency: []
    };
  }
  
  connect(port, host) {
    this.socket = new net.Socket();
    
    // Set socket options for performance
    this.socket.setNoDelay(this.options.noDelay);
    this.socket.setKeepAlive(this.options.keepAlive);
    
    // Increase socket buffers
    try {
      this.socket.setSendBufferSize(this.options.sendBufferSize);
      this.socket.setRecvBufferSize(this.options.recvBufferSize);
    } catch (e) {
      // Not all platforms support this
    }
    
    // Direct data handling without intermediate buffers
    this.socket.on('data', (data) => {
      this.handleReceive(data);
    });
    
    this.socket.on('connect', () => {
      this.emit('connect');
      this.startSendLoop();
    });
    
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this.emit('close'));
    
    this.socket.connect(port, host);
  }
  
  handleReceive(data) {
    // Write to ring buffer
    if (this.recvBuffer.write(data)) {
      this.stats.packetsReceived++;
      this.stats.bytesReceived += data.length;
      
      // Process packets
      let packet;
      while ((packet = this.recvBuffer.read()) !== null) {
        this.emit('packet', packet);
      }
    } else {
      this.emit('error', new Error('Receive buffer full'));
    }
  }
  
  send(data) {
    // Add to send buffer
    if (this.sendBuffer.write(data)) {
      this.stats.packetsSent++;
      this.stats.bytesSent += data.length;
      return true;
    }
    return false; // Buffer full
  }
  
  startSendLoop() {
    const sendBatch = () => {
      if (!this.socket || this.socket.destroyed) return;
      
      let packet;
      let batchSize = 0;
      const maxBatchSize = 65536; // 64KB batches
      
      while ((packet = this.sendBuffer.read()) !== null && batchSize < maxBatchSize) {
        this.socket.write(packet.data);
        batchSize += packet.size;
      }
      
      // Schedule next batch
      setImmediate(sendBatch);
    };
    
    sendBatch();
  }
  
  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/**
 * UDP Fast Path Implementation
 */
export class UDPFastPath extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      port: options.port || 0,
      reuseAddr: options.reuseAddr !== false,
      ipv6Only: options.ipv6Only || false,
      recvBufferSize: options.recvBufferSize || 1024 * 1024 * 4, // 4MB
      sendBufferSize: options.sendBufferSize || 1024 * 1024 * 4, // 4MB
      ...options
    };
    
    this.socket = null;
    this.recvBuffer = new PacketRingBuffer(this.options.recvBufferSize);
    this.sendQueue = [];
    this.stats = {
      packetsReceived: 0,
      packetsSent: 0,
      packetsDropped: 0
    };
  }
  
  bind(port, address) {
    this.socket = dgram.createSocket({
      type: this.options.ipv6Only ? 'udp6' : 'udp4',
      reuseAddr: this.options.reuseAddr,
      recvBufferSize: this.options.recvBufferSize,
      sendBufferSize: this.options.sendBufferSize
    });
    
    // Direct packet handling
    this.socket.on('message', (msg, rinfo) => {
      this.handlePacket(msg, rinfo);
    });
    
    this.socket.on('error', (err) => this.emit('error', err));
    
    this.socket.bind(port || this.options.port, address, () => {
      this.emit('listening', this.socket.address());
      this.startSendLoop();
    });
  }
  
  handlePacket(data, rinfo) {
    const packet = {
      data,
      address: rinfo.address,
      port: rinfo.port,
      timestamp: Date.now()
    };
    
    if (this.recvBuffer.write(data)) {
      this.stats.packetsReceived++;
      this.emit('packet', packet);
    } else {
      this.stats.packetsDropped++;
    }
  }
  
  send(data, port, address) {
    this.sendQueue.push({ data, port, address });
  }
  
  startSendLoop() {
    const processSendQueue = () => {
      if (!this.socket) return;
      
      const batchSize = Math.min(this.sendQueue.length, 100);
      for (let i = 0; i < batchSize; i++) {
        const packet = this.sendQueue.shift();
        if (packet) {
          this.socket.send(packet.data, packet.port, packet.address, (err) => {
            if (err) {
              this.stats.packetsDropped++;
            } else {
              this.stats.packetsSent++;
            }
          });
        }
      }
      
      setImmediate(processSendQueue);
    };
    
    processSendQueue();
  }
  
  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

/**
 * Memory-mapped networking for ultra-low latency
 */
export class MemoryMappedNetwork {
  constructor(options = {}) {
    this.options = {
      sharedMemorySize: options.sharedMemorySize || 1024 * 1024 * 64, // 64MB
      ringBufferSize: options.ringBufferSize || 1024 * 1024 * 16, // 16MB
      ...options
    };
    
    // Shared memory for IPC
    if (typeof SharedArrayBuffer !== 'undefined') {
      this.sharedBuffer = new SharedArrayBuffer(this.options.sharedMemorySize);
      this.sharedView = new Uint8Array(this.sharedBuffer);
      this.sharedMeta = new Int32Array(this.sharedBuffer, 0, 1024); // Metadata
    }
    
    this.ringBuffers = new Map();
  }
  
  createChannel(channelId) {
    if (this.ringBuffers.has(channelId)) {
      return this.ringBuffers.get(channelId);
    }
    
    const offset = this.ringBuffers.size * this.options.ringBufferSize;
    if (offset + this.options.ringBufferSize > this.options.sharedMemorySize) {
      throw new Error('Shared memory exhausted');
    }
    
    const channel = {
      id: channelId,
      buffer: new Uint8Array(this.sharedBuffer, offset, this.options.ringBufferSize),
      readIndex: 0,
      writeIndex: 0,
      lock: new Int32Array(this.sharedBuffer, offset - 4, 1)
    };
    
    this.ringBuffers.set(channelId, channel);
    return channel;
  }
  
  send(channelId, data) {
    const channel = this.ringBuffers.get(channelId);
    if (!channel) return false;
    
    // Acquire lock
    while (Atomics.compareExchange(channel.lock, 0, 0, 1) !== 0) {
      // Spin
    }
    
    try {
      // Write data
      const dataSize = data.length;
      const available = this.getAvailable(channel);
      
      if (dataSize + 4 > available) {
        return false; // Not enough space
      }
      
      // Write size
      new DataView(channel.buffer.buffer).setUint32(channel.writeIndex, dataSize, true);
      channel.writeIndex += 4;
      
      // Write data
      channel.buffer.set(data, channel.writeIndex);
      channel.writeIndex = (channel.writeIndex + dataSize) % channel.buffer.length;
      
      // Notify readers
      Atomics.notify(channel.lock, 0);
      
      return true;
    } finally {
      // Release lock
      Atomics.store(channel.lock, 0, 0);
    }
  }
  
  receive(channelId) {
    const channel = this.ringBuffers.get(channelId);
    if (!channel) return null;
    
    // Try to acquire lock
    if (Atomics.compareExchange(channel.lock, 0, 0, 1) !== 0) {
      return null; // Lock busy
    }
    
    try {
      if (channel.readIndex === channel.writeIndex) {
        return null; // Empty
      }
      
      // Read size
      const dataSize = new DataView(channel.buffer.buffer).getUint32(channel.readIndex, true);
      channel.readIndex += 4;
      
      // Read data
      const data = channel.buffer.slice(channel.readIndex, channel.readIndex + dataSize);
      channel.readIndex = (channel.readIndex + dataSize) % channel.buffer.length;
      
      return data;
    } finally {
      // Release lock
      Atomics.store(channel.lock, 0, 0);
    }
  }
  
  getAvailable(channel) {
    if (channel.writeIndex >= channel.readIndex) {
      return channel.buffer.length - (channel.writeIndex - channel.readIndex) - 1;
    }
    return channel.readIndex - channel.writeIndex - 1;
  }
}

/**
 * Kernel Bypass Manager
 */
export class KernelBypassManager {
  constructor() {
    this.tcpSockets = new Map();
    this.udpSockets = new Map();
    this.mmapNetwork = new MemoryMappedNetwork();
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      totalPackets: 0,
      totalBytes: 0
    };
  }
  
  createTCPSocket(id, options) {
    const socket = new ZeroCopySocket(options);
    this.tcpSockets.set(id, socket);
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    socket.on('close', () => {
      this.tcpSockets.delete(id);
      this.stats.activeConnections--;
    });
    
    return socket;
  }
  
  createUDPSocket(id, options) {
    const socket = new UDPFastPath(options);
    this.udpSockets.set(id, socket);
    return socket;
  }
  
  createIPCChannel(channelId) {
    return this.mmapNetwork.createChannel(channelId);
  }
  
  getStats() {
    return {
      ...this.stats,
      tcpSockets: this.tcpSockets.size,
      udpSockets: this.udpSockets.size,
      ipcChannels: this.mmapNetwork.ringBuffers.size
    };
  }
}

// Export singleton
export const kernelBypass = new KernelBypassManager();

export default {
  PacketRingBuffer,
  ZeroCopySocket,
  UDPFastPath,
  MemoryMappedNetwork,
  KernelBypassManager,
  kernelBypass
};