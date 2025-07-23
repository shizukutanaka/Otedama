const EventEmitter = require('events');
const crypto = require('crypto');
const Libp2p = require('libp2p');
const TCP = require('libp2p-tcp');
const Mplex = require('libp2p-mplex');
const { NOISE } = require('libp2p-noise');
const DHT = require('libp2p-kad-dht');
const Gossipsub = require('libp2p-gossipsub');
const PeerId = require('peer-id');

class P2PMiningPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // P2P Configuration
      p2p: {
        port: options.p2pPort || 6001,
        bootstrapNodes: options.bootstrapNodes || [],
        maxPeers: options.maxPeers || 50,
        announceInterval: options.announceInterval || 30000
      },
      
      // Pool Configuration  
      pool: {
        name: options.poolName || 'Otedama P2P Pool',
        fee: options.poolFee || 0.01, // 1%
        minPayout: options.minPayout || 0.001,
        blockTime: options.blockTime || 600000, // 10 minutes
        shareWindow: options.shareWindow || 3600000, // 1 hour
        minShareDifficulty: options.minShareDifficulty || 1000
      },
      
      // Mining Configuration
      mining: {
        algorithm: options.algorithm || 'SHA256',
        coinbaseAddress: options.coinbaseAddress,
        blockVersion: options.blockVersion || 1,
        extraNonce1Size: options.extraNonce1Size || 4,
        extraNonce2Size: options.extraNonce2Size || 4
      },
      
      // Security
      security: {
        requireAuth: options.requireAuth || false,
        maxSharesPerSecond: options.maxSharesPerSecond || 10,
        banDuration: options.banDuration || 3600000 // 1 hour
      }
    };
    
    // Core components
    this.node = null;
    this.peers = new Map();
    this.miners = new Map();
    this.shares = new Map();
    this.blocks = new Map();
    this.jobs = new Map();
    this.currentJob = null;
    
    // Statistics
    this.stats = {
      totalHashrate: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0,
      totalPaid: 0,
      connectedMiners: 0,
      activePeers: 0
    };
    
    this.isRunning = false;
  }
  
  async initialize() {
    try {
      // Initialize P2P node
      await this.initializeP2P();
      
      // Start pool services
      await this.startPoolServices();
      
      // Connect to blockchain
      await this.connectToBlockchain();
      
      this.isRunning = true;
      
      this.emit('initialized', {
        peerId: this.node.peerId.toB58String(),
        multiaddrs: this.node.multiaddrs,
        stats: this.stats
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async initializeP2P() {
    // Create peer ID
    const peerId = await PeerId.create();
    
    // Create libp2p node
    this.node = await Libp2p.create({
      peerId,
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${this.config.p2p.port}`]
      },
      modules: {
        transport: [TCP],
        streamMuxer: [Mplex],
        connEncryption: [NOISE],
        dht: DHT,
        pubsub: Gossipsub
      },
      config: {
        dht: {
          enabled: true,
          kBucketSize: 20
        },
        pubsub: {
          enabled: true,
          emitSelf: false
        }
      }
    });
    
    // Set up P2P event handlers
    this.setupP2PHandlers();
    
    // Start the node
    await this.node.start();
    
    // Connect to bootstrap nodes
    await this.connectToBootstrapNodes();
  }
  
  setupP2PHandlers() {
    // Connection events
    this.node.connectionManager.on('peer:connect', (connection) => {
      this.handlePeerConnect(connection);
    });
    
    this.node.connectionManager.on('peer:disconnect', (connection) => {
      this.handlePeerDisconnect(connection);
    });
    
    // Protocol handlers
    this.node.handle('/pool/share/1.0.0', this.handleShareProtocol.bind(this));
    this.node.handle('/pool/block/1.0.0', this.handleBlockProtocol.bind(this));
    this.node.handle('/pool/job/1.0.0', this.handleJobProtocol.bind(this));
    this.node.handle('/pool/payment/1.0.0', this.handlePaymentProtocol.bind(this));
    
    // Pubsub subscriptions
    this.node.pubsub.subscribe('pool-shares');
    this.node.pubsub.subscribe('pool-blocks');
    this.node.pubsub.subscribe('pool-jobs');
    
    this.node.pubsub.on('pool-shares', this.handleShareBroadcast.bind(this));
    this.node.pubsub.on('pool-blocks', this.handleBlockBroadcast.bind(this));
    this.node.pubsub.on('pool-jobs', this.handleJobBroadcast.bind(this));
  }
  
  async connectToBootstrapNodes() {
    for (const addr of this.config.p2p.bootstrapNodes) {
      try {
        await this.node.dial(addr);
        this.emit('bootstrapConnected', { address: addr });
      } catch (error) {
        this.emit('bootstrapError', { address: addr, error });
      }
    }
  }
  
  async startPoolServices() {
    // Start share validation service
    this.startShareValidation();
    
    // Start job generation
    this.startJobGeneration();
    
    // Start payment processor
    this.startPaymentProcessor();
    
    // Start peer discovery
    this.startPeerDiscovery();
    
    // Start statistics updater
    this.startStatisticsUpdater();
  }
  
  async connectToBlockchain() {
    // Connect to blockchain node
    // This would be implemented based on specific blockchain
    this.emit('blockchainConnected');
  }
  
  // Miner Management
  
  registerMiner(minerId, minerInfo) {
    const miner = {
      id: minerId,
      address: minerInfo.address,
      worker: minerInfo.worker || 'default',
      hashrate: 0,
      shares: {
        valid: 0,
        invalid: 0,
        stale: 0
      },
      difficulty: this.config.pool.minShareDifficulty,
      lastShare: null,
      connected: Date.now(),
      extraNonce1: this.generateExtraNonce1(),
      jobs: new Map()
    };
    
    this.miners.set(minerId, miner);
    this.stats.connectedMiners++;
    
    this.emit('minerConnected', {
      minerId,
      address: miner.address,
      worker: miner.worker
    });
    
    return miner;
  }
  
  unregisterMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    this.miners.delete(minerId);
    this.stats.connectedMiners--;
    
    this.emit('minerDisconnected', {
      minerId,
      address: miner.address,
      worker: miner.worker
    });
  }
  
  // Job Management
  
  async createJob() {
    const job = {
      id: this.generateJobId(),
      height: await this.getBlockHeight(),
      previousHash: await this.getPreviousBlockHash(),
      coinbase: await this.createCoinbaseTransaction(),
      merkleRoot: null,
      timestamp: Math.floor(Date.now() / 1000),
      bits: await this.getNetworkDifficulty(),
      nonce: 0,
      transactions: await this.getTransactions(),
      clean: true
    };
    
    // Calculate merkle root
    job.merkleRoot = this.calculateMerkleRoot([job.coinbase, ...job.transactions]);
    
    this.jobs.set(job.id, job);
    this.currentJob = job;
    
    // Broadcast to network
    await this.broadcastJob(job);
    
    return job;
  }
  
  async createCoinbaseTransaction() {
    const coinbase = {
      version: 1,
      inputs: [{
        previousOutput: {
          hash: '0000000000000000000000000000000000000000000000000000000000000000',
          index: 0xFFFFFFFF
        },
        script: this.createCoinbaseScript(),
        sequence: 0xFFFFFFFF
      }],
      outputs: this.createCoinbaseOutputs(),
      lockTime: 0
    };
    
    return coinbase;
  }
  
  createCoinbaseScript() {
    // Height + ExtraNonce1 + ExtraNonce2 placeholder + Pool signature
    const height = Buffer.alloc(4);
    height.writeUInt32LE(this.currentJob?.height || 0, 0);
    
    const poolSig = Buffer.from(`/${this.config.pool.name}/`, 'utf8');
    
    return Buffer.concat([
      Buffer.from([0x03]), // Push 3 bytes
      height.slice(0, 3),
      Buffer.alloc(this.config.mining.extraNonce1Size + this.config.mining.extraNonce2Size),
      poolSig
    ]);
  }
  
  createCoinbaseOutputs() {
    const outputs = [];
    const blockReward = this.getBlockReward();
    const poolFee = Math.floor(blockReward * this.config.pool.fee);
    
    // Pool fee output
    if (poolFee > 0) {
      outputs.push({
        value: poolFee,
        script: this.addressToScript(this.config.mining.coinbaseAddress)
      });
    }
    
    // Miner rewards will be added when block is found
    outputs.push({
      value: blockReward - poolFee,
      script: Buffer.alloc(0) // Placeholder
    });
    
    return outputs;
  }
  
  // Share Processing
  
  async submitShare(minerId, shareData) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    // Validate share
    const validation = await this.validateShare(miner, shareData);
    
    if (!validation.valid) {
      miner.shares.invalid++;
      this.stats.invalidShares++;
      
      this.emit('invalidShare', {
        minerId,
        reason: validation.reason
      });
      
      return { status: 'invalid', reason: validation.reason };
    }
    
    // Check if share is a valid block
    if (validation.isBlock) {
      await this.processBlock(miner, shareData, validation);
    }
    
    // Record share
    const share = {
      id: this.generateShareId(),
      minerId,
      jobId: shareData.jobId,
      nonce: shareData.nonce,
      extraNonce2: shareData.extraNonce2,
      nTime: shareData.nTime,
      difficulty: validation.difficulty,
      hash: validation.hash,
      timestamp: Date.now()
    };
    
    this.shares.set(share.id, share);
    miner.shares.valid++;
    miner.lastShare = Date.now();
    this.stats.validShares++;
    
    // Update miner hashrate
    this.updateMinerHashrate(miner);
    
    // Broadcast share to network
    await this.broadcastShare(share);
    
    this.emit('validShare', {
      minerId,
      difficulty: share.difficulty,
      hash: share.hash
    });
    
    return { status: 'valid', difficulty: share.difficulty };
  }
  
  async validateShare(miner, shareData) {
    const job = this.jobs.get(shareData.jobId);
    if (!job) {
      return { valid: false, reason: 'Job not found' };
    }
    
    // Check if job is current
    if (shareData.jobId !== this.currentJob.id && !job.clean) {
      return { valid: false, reason: 'Stale share' };
    }
    
    // Validate nonce
    if (!this.validateNonce(shareData.nonce)) {
      return { valid: false, reason: 'Invalid nonce' };
    }
    
    // Validate time
    const timeDiff = Math.abs(shareData.nTime - job.timestamp);
    if (timeDiff > 7200) { // 2 hours
      return { valid: false, reason: 'Time too far' };
    }
    
    // Build block header
    const header = this.buildBlockHeader(job, shareData);
    
    // Calculate hash
    const hash = this.calculateHash(header);
    const hashBigInt = BigInt('0x' + hash.toString('hex'));
    
    // Check share difficulty
    const shareDifficulty = this.calculateDifficulty(hashBigInt);
    if (shareDifficulty < miner.difficulty) {
      return { valid: false, reason: 'Low difficulty' };
    }
    
    // Check block difficulty
    const targetDifficulty = this.bitsToTarget(job.bits);
    const isBlock = hashBigInt <= targetDifficulty;
    
    return {
      valid: true,
      hash,
      difficulty: shareDifficulty,
      isBlock
    };
  }
  
  buildBlockHeader(job, shareData) {
    const header = Buffer.alloc(80);
    
    // Version (4 bytes)
    header.writeUInt32LE(this.config.mining.blockVersion, 0);
    
    // Previous hash (32 bytes)
    Buffer.from(job.previousHash, 'hex').copy(header, 4);
    
    // Merkle root (32 bytes)
    Buffer.from(job.merkleRoot, 'hex').copy(header, 36);
    
    // Timestamp (4 bytes)
    header.writeUInt32LE(shareData.nTime, 68);
    
    // Bits (4 bytes)
    header.writeUInt32LE(job.bits, 72);
    
    // Nonce (4 bytes)
    header.writeUInt32LE(shareData.nonce, 76);
    
    return header;
  }
  
  calculateHash(data) {
    // Double SHA256 for Bitcoin-like coins
    const hash1 = crypto.createHash('sha256').update(data).digest();
    const hash2 = crypto.createHash('sha256').update(hash1).digest();
    return hash2;
  }
  
  // Block Processing
  
  async processBlock(miner, shareData, validation) {
    const block = {
      id: validation.hash.toString('hex'),
      height: this.currentJob.height,
      hash: validation.hash,
      previousHash: this.currentJob.previousHash,
      timestamp: shareData.nTime,
      nonce: shareData.nonce,
      difficulty: validation.difficulty,
      reward: this.getBlockReward(),
      foundBy: miner.id,
      shares: this.getSharesForBlock()
    };
    
    // Submit to blockchain
    const submitted = await this.submitBlock(block);
    
    if (submitted) {
      this.blocks.set(block.id, block);
      this.stats.blocksFound++;
      
      // Distribute rewards
      await this.distributeBlockReward(block);
      
      // Broadcast to network
      await this.broadcastBlock(block);
      
      this.emit('blockFound', {
        height: block.height,
        hash: block.hash,
        reward: block.reward,
        foundBy: miner.address
      });
    }
  }
  
  getSharesForBlock() {
    const window = Date.now() - this.config.pool.shareWindow;
    const shares = [];
    
    for (const [id, share] of this.shares) {
      if (share.timestamp > window) {
        shares.push(share);
      }
    }
    
    return shares;
  }
  
  // Payment Distribution
  
  async distributeBlockReward(block) {
    const totalReward = block.reward;
    const poolFee = Math.floor(totalReward * this.config.pool.fee);
    const minerReward = totalReward - poolFee;
    
    // Calculate share contributions
    const shareContributions = this.calculateShareContributions(block.shares);
    
    // Create payments
    const payments = [];
    
    for (const [minerId, contribution] of shareContributions) {
      const miner = this.miners.get(minerId);
      if (!miner) continue;
      
      const amount = Math.floor(minerReward * contribution);
      if (amount >= this.config.pool.minPayout) {
        payments.push({
          address: miner.address,
          amount,
          minerId
        });
      }
    }
    
    // Execute payments
    await this.executePayments(payments);
    
    // Broadcast payment info
    await this.broadcastPayments(block.id, payments);
  }
  
  calculateShareContributions(shares) {
    const contributions = new Map();
    let totalDifficulty = 0n;
    
    // Calculate total difficulty
    for (const share of shares) {
      totalDifficulty += BigInt(share.difficulty);
    }
    
    // Calculate individual contributions
    for (const share of shares) {
      const current = contributions.get(share.minerId) || 0n;
      contributions.set(share.minerId, current + BigInt(share.difficulty));
    }
    
    // Convert to percentages
    const percentages = new Map();
    for (const [minerId, difficulty] of contributions) {
      const percentage = Number(difficulty * 1000000n / totalDifficulty) / 1000000;
      percentages.set(minerId, percentage);
    }
    
    return percentages;
  }
  
  // P2P Communication
  
  async handleShareProtocol({ stream }) {
    const data = await this.readStream(stream);
    const share = JSON.parse(data.toString());
    
    // Validate share from peer
    if (this.validatePeerShare(share)) {
      this.shares.set(share.id, share);
      this.emit('peerShare', share);
    }
  }
  
  async handleBlockProtocol({ stream }) {
    const data = await this.readStream(stream);
    const block = JSON.parse(data.toString());
    
    // Validate block from peer
    if (await this.validatePeerBlock(block)) {
      this.blocks.set(block.id, block);
      this.emit('peerBlock', block);
    }
  }
  
  async handleJobProtocol({ stream }) {
    const data = await this.readStream(stream);
    const job = JSON.parse(data.toString());
    
    // Update job if newer
    if (!this.currentJob || job.height > this.currentJob.height) {
      this.jobs.set(job.id, job);
      this.currentJob = job;
      this.notifyMinersNewJob(job);
    }
  }
  
  async handlePaymentProtocol({ stream }) {
    const data = await this.readStream(stream);
    const payment = JSON.parse(data.toString());
    
    // Process payment info
    this.emit('peerPayment', payment);
  }
  
  // Broadcasting
  
  async broadcastShare(share) {
    const message = Buffer.from(JSON.stringify({
      type: 'share',
      data: share,
      peerId: this.node.peerId.toB58String(),
      timestamp: Date.now()
    }));
    
    await this.node.pubsub.publish('pool-shares', message);
  }
  
  async broadcastBlock(block) {
    const message = Buffer.from(JSON.stringify({
      type: 'block',
      data: block,
      peerId: this.node.peerId.toB58String(),
      timestamp: Date.now()
    }));
    
    await this.node.pubsub.publish('pool-blocks', message);
  }
  
  async broadcastJob(job) {
    const message = Buffer.from(JSON.stringify({
      type: 'job',
      data: job,
      peerId: this.node.peerId.toB58String(),
      timestamp: Date.now()
    }));
    
    await this.node.pubsub.publish('pool-jobs', message);
  }
  
  // Utility functions
  
  generateJobId() {
    return crypto.randomBytes(8).toString('hex');
  }
  
  generateShareId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  generateExtraNonce1() {
    return crypto.randomBytes(this.config.mining.extraNonce1Size).toString('hex');
  }
  
  calculateMerkleRoot(transactions) {
    // Simplified merkle root calculation
    if (transactions.length === 0) return null;
    
    let hashes = transactions.map(tx => {
      const serialized = this.serializeTransaction(tx);
      return this.calculateHash(serialized);
    });
    
    while (hashes.length > 1) {
      const newHashes = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        const combined = Buffer.concat([left, right]);
        newHashes.push(this.calculateHash(combined));
      }
      
      hashes = newHashes;
    }
    
    return hashes[0].toString('hex');
  }
  
  serializeTransaction(tx) {
    // Simplified transaction serialization
    return Buffer.from(JSON.stringify(tx));
  }
  
  validateNonce(nonce) {
    return nonce >= 0 && nonce <= 0xFFFFFFFF;
  }
  
  calculateDifficulty(hashBigInt) {
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    return Number(maxTarget / hashBigInt);
  }
  
  bitsToTarget(bits) {
    const exponent = bits >> 24;
    const mantissa = bits & 0xFFFFFF;
    return BigInt(mantissa) * (BigInt(2) ** BigInt(8 * (exponent - 3)));
  }
  
  getBlockReward() {
    // Simplified block reward calculation
    const halvings = Math.floor(this.currentJob?.height / 210000);
    const reward = 50 * (10 ** 8); // 50 coins in satoshis
    return Math.floor(reward / Math.pow(2, halvings));
  }
  
  updateMinerHashrate(miner) {
    const shares = [];
    const window = Date.now() - 300000; // 5 minutes
    
    for (const [id, share] of this.shares) {
      if (share.minerId === miner.id && share.timestamp > window) {
        shares.push(share);
      }
    }
    
    if (shares.length > 0) {
      const totalDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);
      const timeSpan = (Date.now() - shares[0].timestamp) / 1000;
      miner.hashrate = (totalDifficulty * Math.pow(2, 32)) / timeSpan;
    }
  }
  
  addressToScript(address) {
    // Simplified address to script conversion
    return Buffer.from(address, 'hex');
  }
  
  async readStream(stream) {
    const chunks = [];
    
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
  }
  
  // Service functions
  
  startShareValidation() {
    // Periodic share cleanup
    setInterval(() => {
      const cutoff = Date.now() - this.config.pool.shareWindow;
      
      for (const [id, share] of this.shares) {
        if (share.timestamp < cutoff) {
          this.shares.delete(id);
        }
      }
    }, 60000); // Every minute
  }
  
  startJobGeneration() {
    // Generate new job periodically
    setInterval(async () => {
      try {
        await this.createJob();
      } catch (error) {
        this.emit('error', { type: 'jobGeneration', error });
      }
    }, 30000); // Every 30 seconds
  }
  
  startPaymentProcessor() {
    // Process pending payments
    setInterval(async () => {
      try {
        await this.processPendingPayments();
      } catch (error) {
        this.emit('error', { type: 'payment', error });
      }
    }, 300000); // Every 5 minutes
  }
  
  startPeerDiscovery() {
    // Discover new peers
    setInterval(async () => {
      try {
        const peers = await this.node.peerStore.all();
        this.stats.activePeers = peers.length;
      } catch (error) {
        this.emit('error', { type: 'peerDiscovery', error });
      }
    }, this.config.p2p.announceInterval);
  }
  
  startStatisticsUpdater() {
    // Update pool statistics
    setInterval(() => {
      this.updatePoolStatistics();
    }, 10000); // Every 10 seconds
  }
  
  updatePoolStatistics() {
    // Calculate total hashrate
    let totalHashrate = 0;
    
    for (const miner of this.miners.values()) {
      totalHashrate += miner.hashrate;
    }
    
    this.stats.totalHashrate = totalHashrate;
    
    this.emit('statsUpdate', this.stats);
  }
  
  // Placeholder functions
  
  async getBlockHeight() {
    // Get current blockchain height
    return 700000; // Placeholder
  }
  
  async getPreviousBlockHash() {
    // Get previous block hash
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
  
  async getNetworkDifficulty() {
    // Get network difficulty bits
    return 0x1705ae3a; // Placeholder
  }
  
  async getTransactions() {
    // Get pending transactions
    return [];
  }
  
  async submitBlock(block) {
    // Submit block to blockchain
    return true; // Placeholder
  }
  
  async executePayments(payments) {
    // Execute payments on blockchain
    this.stats.totalPaid += payments.reduce((sum, p) => sum + p.amount, 0);
  }
  
  async processPendingPayments() {
    // Process any pending payments
  }
  
  validatePeerShare(share) {
    // Validate share from peer
    return true; // Simplified
  }
  
  async validatePeerBlock(block) {
    // Validate block from peer
    return true; // Simplified
  }
  
  notifyMinersNewJob(job) {
    // Notify all connected miners about new job
    this.emit('newJob', job);
  }
  
  handlePeerConnect(connection) {
    const peerId = connection.remotePeer.toB58String();
    
    this.peers.set(peerId, {
      id: peerId,
      connection,
      connected: Date.now()
    });
    
    this.emit('peerConnected', { peerId });
  }
  
  handlePeerDisconnect(connection) {
    const peerId = connection.remotePeer.toB58String();
    
    this.peers.delete(peerId);
    
    this.emit('peerDisconnected', { peerId });
  }
  
  handleShareBroadcast(message) {
    try {
      const data = JSON.parse(message.data.toString());
      if (data.peerId !== this.node.peerId.toB58String()) {
        this.emit('peerShareBroadcast', data);
      }
    } catch (error) {
      this.emit('error', { type: 'shareBroadcast', error });
    }
  }
  
  handleBlockBroadcast(message) {
    try {
      const data = JSON.parse(message.data.toString());
      if (data.peerId !== this.node.peerId.toB58String()) {
        this.emit('peerBlockBroadcast', data);
      }
    } catch (error) {
      this.emit('error', { type: 'blockBroadcast', error });
    }
  }
  
  handleJobBroadcast(message) {
    try {
      const data = JSON.parse(message.data.toString());
      if (data.peerId !== this.node.peerId.toB58String()) {
        this.emit('peerJobBroadcast', data);
      }
    } catch (error) {
      this.emit('error', { type: 'jobBroadcast', error });
    }
  }
  
  async broadcastPayments(blockId, payments) {
    // Broadcast payment information to network
    const message = {
      blockId,
      payments,
      timestamp: Date.now()
    };
    
    // Send to peers
    for (const peer of this.peers.values()) {
      try {
        const { stream } = await this.node.dialProtocol(
          peer.connection.remotePeer,
          '/pool/payment/1.0.0'
        );
        
        await stream.sink([Buffer.from(JSON.stringify(message))]);
      } catch (error) {
        // Continue with other peers
      }
    }
  }
  
  // Public API
  
  getPoolStats() {
    return {
      ...this.stats,
      poolName: this.config.pool.name,
      poolFee: this.config.pool.fee,
      minPayout: this.config.pool.minPayout,
      currentJobId: this.currentJob?.id,
      currentHeight: this.currentJob?.height
    };
  }
  
  getMinerStats(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    return {
      address: miner.address,
      worker: miner.worker,
      hashrate: miner.hashrate,
      shares: miner.shares,
      difficulty: miner.difficulty,
      connected: miner.connected,
      lastShare: miner.lastShare
    };
  }
  
  async shutdown() {
    this.isRunning = false;
    
    // Stop services
    // ...
    
    // Stop P2P node
    if (this.node) {
      await this.node.stop();
    }
    
    this.emit('shutdown');
  }
}

module.exports = P2PMiningPool;