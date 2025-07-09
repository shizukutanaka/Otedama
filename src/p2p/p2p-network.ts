import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { EventEmitter } from 'events';
import { Multiaddr } from '@multiformats/multiaddr';
import { PeerId } from '@libp2p/interface-peer-id';
import { createEd25519PeerId } from '@libp2p/peer-id-factory';

/**
 * P2P Network implementation using libp2p
 * Following Rob Pike's principle: clear, efficient, minimal
 */

export interface P2PConfig {
  port: number;
  bootstrapNodes?: string[];
  maxPeers?: number;
  announceAddresses?: string[];
}

export interface ShareMessage {
  type: 'share';
  minerId: string;
  hash: string;
  difficulty: number;
  height: number;
  timestamp: number;
  nonce: string;
}

export interface BlockMessage {
  type: 'block';
  hash: string;
  height: number;
  finder: string;
  timestamp: number;
}

export interface PeerInfo {
  id: string;
  addresses: string[];
  protocols: string[];
  metadata: {
    version?: string;
    hashrate?: number;
    shares?: number;
  };
}

export class P2PNetwork extends EventEmitter {
  private node: Libp2p | null = null;
  private topics = {
    shares: 'otedama/shares/1.0.0',
    blocks: 'otedama/blocks/1.0.0',
    stats: 'otedama/stats/1.0.0'
  };
  private peerMetadata = new Map<string, any>();

  constructor(private config: P2PConfig) {
    super();
  }

  async start(): Promise<void> {
    // Generate or load peer ID
    const peerId = await createEd25519PeerId();

    // Create libp2p node
    this.node = await createLibp2p({
      peerId,
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${this.config.port}`],
        announce: this.config.announceAddresses || []
      },
      transports: [tcp()],
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      dht: kadDHT({
        protocolPrefix: '/otedama',
        maxInboundStreams: 100,
        maxOutboundStreams: 100
      }),
      pubsub: gossipsub({
        allowPublishToZeroPeers: true,
        emitSelf: false,
        gossipIncoming: true,
        floodPublish: true,
        doPX: true
      }),
      peerDiscovery: this.getPeerDiscoveryModules(),
      connectionManager: {
        autoDial: true,
        maxConnections: this.config.maxPeers || 50,
        minConnections: 5
      }
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Start the node
    await this.node.start();
    
    this.emit('started', {
      peerId: this.node.peerId.toString(),
      addresses: this.node.getMultiaddrs().map(ma => ma.toString())
    });

    // Subscribe to topics
    await this.subscribeToTopics();
  }

  private getPeerDiscoveryModules(): any[] {
    const modules: any[] = [];

    // Bootstrap nodes
    if (this.config.bootstrapNodes && this.config.bootstrapNodes.length > 0) {
      modules.push(bootstrap({
        list: this.config.bootstrapNodes,
        interval: 20000
      }));
    }

    // mDNS for local discovery
    modules.push(mdns({
      interval: 10000
    }));

    return modules;
  }

  private setupEventHandlers(): void {
    if (!this.node) return;

    // Connection events
    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.remotePeer.toString();
      this.emit('peerConnected', { peerId });
      this.exchangePeerInfo(peerId);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.remotePeer.toString();
      this.peerMetadata.delete(peerId);
      this.emit('peerDisconnected', { peerId });
    });

    // Discovery events
    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      this.emit('peerDiscovered', { peerId });
    });
  }

  private async subscribeToTopics(): Promise<void> {
    if (!this.node?.services.pubsub) return;

    const pubsub = this.node.services.pubsub;

    // Subscribe to shares topic
    pubsub.addEventListener('message', (evt) => {
      if (evt.detail.topic === this.topics.shares) {
        this.handleShareMessage(evt.detail);
      } else if (evt.detail.topic === this.topics.blocks) {
        this.handleBlockMessage(evt.detail);
      } else if (evt.detail.topic === this.topics.stats) {
        this.handleStatsMessage(evt.detail);
      }
    });

    await pubsub.subscribe(this.topics.shares);
    await pubsub.subscribe(this.topics.blocks);
    await pubsub.subscribe(this.topics.stats);
  }

  private handleShareMessage(message: any): void {
    try {
      const data = JSON.parse(new TextDecoder().decode(message.data));
      if (data.type === 'share') {
        this.emit('share', data);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleBlockMessage(message: any): void {
    try {
      const data = JSON.parse(new TextDecoder().decode(message.data));
      if (data.type === 'block') {
        this.emit('block', data);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleStatsMessage(message: any): void {
    try {
      const data = JSON.parse(new TextDecoder().decode(message.data));
      const peerId = message.from.toString();
      this.peerMetadata.set(peerId, data);
      this.emit('peerStats', { peerId, stats: data });
    } catch (error) {
      this.emit('error', error);
    }
  }

  // Public methods for broadcasting
  async broadcastShare(share: ShareMessage): Promise<void> {
    if (!this.node?.services.pubsub) return;

    const data = new TextEncoder().encode(JSON.stringify(share));
    await this.node.services.pubsub.publish(this.topics.shares, data);
  }

  async broadcastBlock(block: BlockMessage): Promise<void> {
    if (!this.node?.services.pubsub) return;

    const data = new TextEncoder().encode(JSON.stringify(block));
    await this.node.services.pubsub.publish(this.topics.blocks, data);
  }

  async broadcastStats(stats: any): Promise<void> {
    if (!this.node?.services.pubsub) return;

    const data = new TextEncoder().encode(JSON.stringify(stats));
    await this.node.services.pubsub.publish(this.topics.stats, data);
  }

  // Peer management
  async connectToPeer(multiaddr: string): Promise<void> {
    if (!this.node) return;

    try {
      const ma = new Multiaddr(multiaddr);
      await this.node.dial(ma);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async disconnectPeer(peerId: string): Promise<void> {
    if (!this.node) return;

    const connections = this.node.getConnections(peerId);
    for (const conn of connections) {
      await conn.close();
    }
  }

  getPeers(): PeerInfo[] {
    if (!this.node) return [];

    const peers = this.node.getPeers();
    return peers.map(peerId => {
      const id = peerId.toString();
      const connections = this.node!.getConnections(peerId);
      const addresses = connections.map(conn => conn.remoteAddr.toString());
      const metadata = this.peerMetadata.get(id) || {};

      return {
        id,
        addresses,
        protocols: [],
        metadata
      };
    });
  }

  getPeerCount(): number {
    return this.node?.getPeers().length || 0;
  }

  async findPeers(minPeers = 5): Promise<void> {
    if (!this.node?.services.dht) return;

    const dht = this.node.services.dht;
    
    // Use DHT to find peers
    try {
      const peerId = await createEd25519PeerId();
      for await (const peer of dht.findPeer(peerId)) {
        if (this.getPeerCount() >= minPeers) break;
      }
    } catch (error) {
      // It's normal to not find specific peers
    }
  }

  private async exchangePeerInfo(peerId: string): Promise<void> {
    // Send our stats to the peer
    const stats = {
      version: '1.0.0',
      hashrate: 0, // Will be filled by pool
      shares: 0,   // Will be filled by pool
      timestamp: Date.now()
    };

    await this.broadcastStats(stats);
  }

  async stop(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.node = null;
      this.peerMetadata.clear();
      this.emit('stopped');
    }
  }

  getNodeInfo(): any {
    if (!this.node) return null;

    return {
      peerId: this.node.peerId.toString(),
      addresses: this.node.getMultiaddrs().map(ma => ma.toString()),
      peers: this.getPeerCount(),
      protocols: Array.from(this.node.services.registrar.getProtocols())
    };
  }
}

// P2P Share chain implementation for decentralized consensus
export class ShareChain extends EventEmitter {
  private shares = new Map<string, any>();
  private chain: string[] = [];
  private readonly maxChainLength = 1000;

  addShare(share: ShareMessage): boolean {
    const shareId = this.getShareId(share);
    
    // Check if share already exists
    if (this.shares.has(shareId)) {
      return false;
    }

    // Validate share
    if (!this.validateShare(share)) {
      return false;
    }

    // Add to chain
    this.shares.set(shareId, share);
    this.chain.push(shareId);

    // Trim chain if too long
    if (this.chain.length > this.maxChainLength) {
      const removed = this.chain.shift();
      if (removed) {
        this.shares.delete(removed);
      }
    }

    this.emit('shareAdded', share);
    return true;
  }

  private getShareId(share: ShareMessage): string {
    return `${share.hash}_${share.nonce}`;
  }

  private validateShare(share: ShareMessage): boolean {
    // Basic validation
    if (!share.hash || !share.minerId || !share.nonce) {
      return false;
    }

    // Check timestamp (not too old, not in future)
    const now = Date.now();
    const maxAge = 3600000; // 1 hour
    const maxFuture = 60000; // 1 minute

    if (share.timestamp > now + maxFuture || share.timestamp < now - maxAge) {
      return false;
    }

    return true;
  }

  getRecentShares(count: number): ShareMessage[] {
    const start = Math.max(0, this.chain.length - count);
    return this.chain.slice(start).map(id => this.shares.get(id)).filter(Boolean);
  }

  getChainLength(): number {
    return this.chain.length;
  }

  clear(): void {
    this.shares.clear();
    this.chain = [];
  }
}
