const EventEmitter = require('events');
const crypto = require('crypto');
const Web3 = require('web3');
const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const HDKey = require('hdkey');
const axios = require('axios');
const Database = require('better-sqlite3');

class MultiCurrencyWallet extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      dbPath: options.dbPath || './wallet.db',
      networks: {
        bitcoin: options.btcNetwork || bitcoin.networks.bitcoin,
        ethereum: options.ethNetwork || 'mainnet',
        binanceSmartChain: options.bscNetwork || 'mainnet',
        polygon: options.polygonNetwork || 'mainnet'
      },
      
      // RPC endpoints
      rpcEndpoints: {
        ethereum: options.ethRpc || 'https://mainnet.infura.io/v3/YOUR_INFURA_KEY',
        binanceSmartChain: options.bscRpc || 'https://bsc-dataseed.binance.org/',
        polygon: options.polygonRpc || 'https://polygon-rpc.com/'
      },
      
      // Price feeds
      priceFeeds: {
        coingecko: 'https://api.coingecko.com/api/v3',
        binance: 'https://api.binance.com/api/v3'
      },
      
      // Security
      encryptionAlgorithm: 'aes-256-gcm',
      derivationIterations: 100000,
      
      // Features
      enablePriceFeeds: options.enablePriceFeeds !== false,
      enableTransactionHistory: options.enableTransactionHistory !== false,
      enableStaking: options.enableStaking !== false,
      enableDeFi: options.enableDeFi !== false
    };
    
    // Initialize database
    this.db = new Database(this.config.dbPath);
    this.initializeDatabase();
    
    // Web3 instances
    this.web3Instances = {
      ethereum: new Web3(this.config.rpcEndpoints.ethereum),
      binanceSmartChain: new Web3(this.config.rpcEndpoints.binanceSmartChain),
      polygon: new Web3(this.config.rpcEndpoints.polygon)
    };
    
    // Wallet data
    this.wallets = new Map();
    this.balances = new Map();
    this.prices = new Map();
    this.transactions = new Map();
    
    // Price update interval
    this.priceUpdateInterval = null;
  }
  
  initializeDatabase() {
    // Wallets table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        address TEXT NOT NULL,
        publicKey TEXT,
        encryptedPrivateKey TEXT,
        derivationPath TEXT,
        created INTEGER NOT NULL,
        lastUsed INTEGER,
        metadata TEXT
      )
    `);
    
    // Transactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        walletId TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount TEXT NOT NULL,
        fee TEXT,
        hash TEXT UNIQUE,
        fromAddress TEXT,
        toAddress TEXT,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        blockNumber INTEGER,
        confirmations INTEGER,
        metadata TEXT,
        FOREIGN KEY (walletId) REFERENCES wallets(id)
      )
    `);
    
    // Balances table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        walletId TEXT NOT NULL,
        currency TEXT NOT NULL,
        balance TEXT NOT NULL,
        pendingBalance TEXT DEFAULT '0',
        lastUpdated INTEGER NOT NULL,
        PRIMARY KEY (walletId, currency),
        FOREIGN KEY (walletId) REFERENCES wallets(id)
      )
    `);
    
    // Price history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        currency TEXT NOT NULL,
        price REAL NOT NULL,
        volume REAL,
        marketCap REAL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);
    
    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(walletId);
      CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_price_history_currency ON price_history(currency, timestamp);
    `);
  }
  
  async initialize() {
    this.emit('initializing');
    
    // Load existing wallets
    await this.loadWallets();
    
    // Start price feeds
    if (this.config.enablePriceFeeds) {
      await this.startPriceFeeds();
    }
    
    // Update all balances
    await this.updateAllBalances();
    
    this.emit('initialized');
  }
  
  // Wallet Management
  
  async createWallet(options = {}) {
    const {
      name = 'Default Wallet',
      type = 'hd', // 'hd' or 'simple'
      password,
      mnemonic = bip39.generateMnemonic(256),
      currencies = ['bitcoin', 'ethereum']
    } = options;
    
    if (!password) {
      throw new Error('Password is required to create wallet');
    }
    
    const walletId = this.generateWalletId();
    const walletData = {
      id: walletId,
      name,
      type,
      mnemonic,
      addresses: {},
      created: Date.now()
    };
    
    // Generate addresses for each currency
    for (const currency of currencies) {
      const addressData = await this.generateAddress(currency, mnemonic);
      walletData.addresses[currency] = addressData;
      
      // Save to database
      const encryptedPrivateKey = this.encryptPrivateKey(
        addressData.privateKey,
        password
      );
      
      this.saveWalletToDatabase({
        id: `${walletId}_${currency}`,
        name: `${name} (${currency})`,
        type,
        address: addressData.address,
        publicKey: addressData.publicKey,
        encryptedPrivateKey,
        derivationPath: addressData.derivationPath,
        created: Date.now()
      });
    }
    
    // Store in memory (without private keys)
    const safeWalletData = { ...walletData };
    delete safeWalletData.mnemonic;
    Object.keys(safeWalletData.addresses).forEach(currency => {
      delete safeWalletData.addresses[currency].privateKey;
    });
    
    this.wallets.set(walletId, safeWalletData);
    
    this.emit('walletCreated', { walletId, name, currencies });
    
    return {
      walletId,
      mnemonic, // Return only on creation
      addresses: Object.keys(walletData.addresses).reduce((acc, currency) => {
        acc[currency] = walletData.addresses[currency].address;
        return acc;
      }, {})
    };
  }
  
  async importWallet(options = {}) {
    const {
      name = 'Imported Wallet',
      mnemonic,
      privateKey,
      password,
      currency
    } = options;
    
    if (!password) {
      throw new Error('Password is required to import wallet');
    }
    
    let walletData;
    
    if (mnemonic) {
      // Import HD wallet from mnemonic
      walletData = await this.createWallet({
        name,
        type: 'hd',
        password,
        mnemonic,
        currencies: ['bitcoin', 'ethereum', 'binanceSmartChain', 'polygon']
      });
    } else if (privateKey && currency) {
      // Import single currency wallet from private key
      const walletId = this.generateWalletId();
      const addressData = await this.importPrivateKey(currency, privateKey);
      
      const encryptedPrivateKey = this.encryptPrivateKey(privateKey, password);
      
      this.saveWalletToDatabase({
        id: `${walletId}_${currency}`,
        name: `${name} (${currency})`,
        type: 'simple',
        address: addressData.address,
        publicKey: addressData.publicKey,
        encryptedPrivateKey,
        created: Date.now()
      });
      
      walletData = {
        walletId,
        addresses: {
          [currency]: addressData.address
        }
      };
    } else {
      throw new Error('Either mnemonic or privateKey with currency is required');
    }
    
    this.emit('walletImported', walletData);
    return walletData;
  }
  
  async generateAddress(currency, mnemonic) {
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const hdkey = HDKey.fromMasterSeed(seed);
    
    let addressData;
    
    switch (currency) {
      case 'bitcoin':
        addressData = this.generateBitcoinAddress(hdkey);
        break;
        
      case 'ethereum':
      case 'binanceSmartChain':
      case 'polygon':
        addressData = this.generateEthereumAddress(hdkey);
        break;
        
      default:
        throw new Error(`Unsupported currency: ${currency}`);
    }
    
    return addressData;
  }
  
  generateBitcoinAddress(hdkey) {
    const derivationPath = "m/84'/0'/0'/0/0"; // BIP84 for SegWit
    const child = hdkey.derive(derivationPath);
    
    const keyPair = bitcoin.ECPair.fromPrivateKey(child.privateKey, {
      network: this.config.networks.bitcoin
    });
    
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: this.config.networks.bitcoin
    });
    
    return {
      address,
      publicKey: keyPair.publicKey.toString('hex'),
      privateKey: keyPair.privateKey.toString('hex'),
      derivationPath
    };
  }
  
  generateEthereumAddress(hdkey) {
    const derivationPath = "m/44'/60'/0'/0/0"; // BIP44 for Ethereum
    const child = hdkey.derive(derivationPath);
    
    const privateKey = child.privateKey.toString('hex');
    const account = this.web3Instances.ethereum.eth.accounts.privateKeyToAccount('0x' + privateKey);
    
    return {
      address: account.address,
      publicKey: account.publicKey,
      privateKey: privateKey,
      derivationPath
    };
  }
  
  async importPrivateKey(currency, privateKey) {
    switch (currency) {
      case 'bitcoin':
        return this.importBitcoinPrivateKey(privateKey);
        
      case 'ethereum':
      case 'binanceSmartChain':
      case 'polygon':
        return this.importEthereumPrivateKey(privateKey);
        
      default:
        throw new Error(`Unsupported currency: ${currency}`);
    }
  }
  
  importBitcoinPrivateKey(privateKey) {
    const keyPair = bitcoin.ECPair.fromPrivateKey(
      Buffer.from(privateKey, 'hex'),
      { network: this.config.networks.bitcoin }
    );
    
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: this.config.networks.bitcoin
    });
    
    return {
      address,
      publicKey: keyPair.publicKey.toString('hex')
    };
  }
  
  importEthereumPrivateKey(privateKey) {
    const account = this.web3Instances.ethereum.eth.accounts.privateKeyToAccount(
      privateKey.startsWith('0x') ? privateKey : '0x' + privateKey
    );
    
    return {
      address: account.address,
      publicKey: account.publicKey
    };
  }
  
  // Balance Management
  
  async updateAllBalances() {
    const wallets = this.getWalletsFromDatabase();
    
    for (const wallet of wallets) {
      try {
        await this.updateBalance(wallet.id);
      } catch (error) {
        console.error(`Failed to update balance for wallet ${wallet.id}:`, error);
      }
    }
  }
  
  async updateBalance(walletId) {
    const wallet = this.getWalletFromDatabase(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const currency = this.getCurrencyFromWalletId(walletId);
    let balance;
    
    switch (currency) {
      case 'bitcoin':
        balance = await this.getBitcoinBalance(wallet.address);
        break;
        
      case 'ethereum':
      case 'binanceSmartChain':
      case 'polygon':
        balance = await this.getEthereumBalance(wallet.address, currency);
        break;
        
      default:
        throw new Error(`Unsupported currency: ${currency}`);
    }
    
    // Save to database
    this.saveBalance(walletId, currency, balance);
    
    // Update in memory
    if (!this.balances.has(walletId)) {
      this.balances.set(walletId, {});
    }
    this.balances.get(walletId)[currency] = balance;
    
    this.emit('balanceUpdated', { walletId, currency, balance });
    
    return balance;
  }
  
  async getBitcoinBalance(address) {
    // In production, use a proper Bitcoin API service
    try {
      const response = await axios.get(
        `https://blockchain.info/q/addressbalance/${address}`
      );
      
      return {
        confirmed: response.data.toString(),
        unconfirmed: '0'
      };
    } catch (error) {
      console.error('Failed to fetch Bitcoin balance:', error);
      return { confirmed: '0', unconfirmed: '0' };
    }
  }
  
  async getEthereumBalance(address, network = 'ethereum') {
    const web3 = this.web3Instances[network];
    
    try {
      const balance = await web3.eth.getBalance(address);
      
      return {
        confirmed: balance,
        unconfirmed: '0'
      };
    } catch (error) {
      console.error(`Failed to fetch ${network} balance:`, error);
      return { confirmed: '0', unconfirmed: '0' };
    }
  }
  
  // Transaction Management
  
  async sendTransaction(options = {}) {
    const {
      fromWalletId,
      toAddress,
      amount,
      currency,
      password,
      gasPrice,
      gasLimit,
      fee
    } = options;
    
    if (!fromWalletId || !toAddress || !amount || !currency || !password) {
      throw new Error('Missing required transaction parameters');
    }
    
    // Get wallet and decrypt private key
    const wallet = this.getWalletFromDatabase(fromWalletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const privateKey = this.decryptPrivateKey(wallet.encryptedPrivateKey, password);
    
    let transaction;
    
    switch (currency) {
      case 'bitcoin':
        transaction = await this.sendBitcoinTransaction({
          privateKey,
          fromAddress: wallet.address,
          toAddress,
          amount,
          fee
        });
        break;
        
      case 'ethereum':
      case 'binanceSmartChain':
      case 'polygon':
        transaction = await this.sendEthereumTransaction({
          privateKey,
          fromAddress: wallet.address,
          toAddress,
          amount,
          network: currency,
          gasPrice,
          gasLimit
        });
        break;
        
      default:
        throw new Error(`Unsupported currency: ${currency}`);
    }
    
    // Save transaction to database
    this.saveTransaction({
      walletId: fromWalletId,
      type: 'send',
      currency,
      amount,
      fee: transaction.fee,
      hash: transaction.hash,
      fromAddress: wallet.address,
      toAddress,
      status: 'pending',
      timestamp: Date.now()
    });
    
    this.emit('transactionSent', transaction);
    
    return transaction;
  }
  
  async sendBitcoinTransaction(options) {
    // Simplified Bitcoin transaction
    // In production, use proper UTXO management and fee estimation
    const { privateKey, fromAddress, toAddress, amount, fee } = options;
    
    const keyPair = bitcoin.ECPair.fromPrivateKey(
      Buffer.from(privateKey, 'hex'),
      { network: this.config.networks.bitcoin }
    );
    
    // This is a placeholder - actual implementation would:
    // 1. Fetch UTXOs
    // 2. Build transaction
    // 3. Sign transaction
    // 4. Broadcast transaction
    
    return {
      hash: crypto.randomBytes(32).toString('hex'),
      fee: fee || '0.0001',
      status: 'pending'
    };
  }
  
  async sendEthereumTransaction(options) {
    const { privateKey, fromAddress, toAddress, amount, network, gasPrice, gasLimit } = options;
    
    const web3 = this.web3Instances[network];
    
    // Get nonce
    const nonce = await web3.eth.getTransactionCount(fromAddress);
    
    // Build transaction
    const tx = {
      nonce: web3.utils.toHex(nonce),
      to: toAddress,
      value: web3.utils.toHex(web3.utils.toWei(amount.toString(), 'ether')),
      gasLimit: web3.utils.toHex(gasLimit || 21000),
      gasPrice: web3.utils.toHex(gasPrice || await web3.eth.getGasPrice())
    };
    
    // Sign transaction
    const signedTx = await web3.eth.accounts.signTransaction(tx, '0x' + privateKey);
    
    // Send transaction
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
    return {
      hash: receipt.transactionHash,
      fee: web3.utils.fromWei(
        (BigInt(tx.gasPrice) * BigInt(receipt.gasUsed)).toString(),
        'ether'
      ),
      status: receipt.status ? 'confirmed' : 'failed',
      blockNumber: receipt.blockNumber
    };
  }
  
  // Price Feeds
  
  async startPriceFeeds() {
    // Initial price update
    await this.updatePrices();
    
    // Update prices every minute
    this.priceUpdateInterval = setInterval(() => {
      this.updatePrices().catch(console.error);
    }, 60000);
  }
  
  async updatePrices() {
    const currencies = ['bitcoin', 'ethereum', 'binancecoin', 'matic-network'];
    
    try {
      // Fetch from CoinGecko
      const response = await axios.get(
        `${this.config.priceFeeds.coingecko}/simple/price`,
        {
          params: {
            ids: currencies.join(','),
            vs_currencies: 'usd',
            include_24hr_vol: true,
            include_market_cap: true
          }
        }
      );
      
      // Update prices in memory and database
      for (const [currency, data] of Object.entries(response.data)) {
        this.prices.set(currency, {
          price: data.usd,
          volume: data.usd_24h_vol,
          marketCap: data.usd_market_cap,
          timestamp: Date.now()
        });
        
        // Save to database
        this.savePriceHistory(currency, data);
      }
      
      this.emit('pricesUpdated', this.prices);
      
    } catch (error) {
      console.error('Failed to update prices:', error);
    }
  }
  
  // Database Operations
  
  saveWalletToDatabase(wallet) {
    const stmt = this.db.prepare(`
      INSERT INTO wallets (
        id, name, type, address, publicKey, encryptedPrivateKey, 
        derivationPath, created, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      wallet.id,
      wallet.name,
      wallet.type,
      wallet.address,
      wallet.publicKey,
      wallet.encryptedPrivateKey,
      wallet.derivationPath,
      wallet.created,
      JSON.stringify(wallet.metadata || {})
    );
  }
  
  getWalletFromDatabase(walletId) {
    const stmt = this.db.prepare('SELECT * FROM wallets WHERE id = ?');
    return stmt.get(walletId);
  }
  
  getWalletsFromDatabase() {
    const stmt = this.db.prepare('SELECT * FROM wallets ORDER BY created DESC');
    return stmt.all();
  }
  
  saveBalance(walletId, currency, balance) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO balances (walletId, currency, balance, lastUpdated)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(
      walletId,
      currency,
      balance.confirmed,
      Date.now()
    );
  }
  
  saveTransaction(transaction) {
    const stmt = this.db.prepare(`
      INSERT INTO transactions (
        id, walletId, type, currency, amount, fee, hash,
        fromAddress, toAddress, status, timestamp, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      this.generateTransactionId(),
      transaction.walletId,
      transaction.type,
      transaction.currency,
      transaction.amount,
      transaction.fee,
      transaction.hash,
      transaction.fromAddress,
      transaction.toAddress,
      transaction.status,
      transaction.timestamp,
      JSON.stringify(transaction.metadata || {})
    );
  }
  
  savePriceHistory(currency, data) {
    const stmt = this.db.prepare(`
      INSERT INTO price_history (currency, price, volume, marketCap, timestamp, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      currency,
      data.usd,
      data.usd_24h_vol,
      data.usd_market_cap,
      Date.now(),
      'coingecko'
    );
  }
  
  // Encryption/Decryption
  
  encryptPrivateKey(privateKey, password) {
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, salt, this.config.derivationIterations, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(this.config.encryptionAlgorithm, key, iv);
    
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }
  
  decryptPrivateKey(encryptedData, password) {
    const { encrypted, salt, iv, authTag } = encryptedData;
    
    const key = crypto.pbkdf2Sync(
      password,
      Buffer.from(salt, 'hex'),
      this.config.derivationIterations,
      32,
      'sha256'
    );
    
    const decipher = crypto.createDecipheriv(
      this.config.encryptionAlgorithm,
      key,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  // Utility Methods
  
  generateWalletId() {
    return 'wallet_' + crypto.randomBytes(16).toString('hex');
  }
  
  generateTransactionId() {
    return 'tx_' + crypto.randomBytes(16).toString('hex');
  }
  
  getCurrencyFromWalletId(walletId) {
    const parts = walletId.split('_');
    return parts[parts.length - 1];
  }
  
  async loadWallets() {
    const wallets = this.getWalletsFromDatabase();
    
    for (const wallet of wallets) {
      const baseWalletId = wallet.id.split('_')[0];
      
      if (!this.wallets.has(baseWalletId)) {
        this.wallets.set(baseWalletId, {
          id: baseWalletId,
          name: wallet.name.split(' (')[0],
          type: wallet.type,
          addresses: {},
          created: wallet.created
        });
      }
      
      const currency = this.getCurrencyFromWalletId(wallet.id);
      this.wallets.get(baseWalletId).addresses[currency] = {
        address: wallet.address,
        publicKey: wallet.publicKey
      };
    }
  }
  
  // Public API Methods
  
  getWallets() {
    return Array.from(this.wallets.values());
  }
  
  getWallet(walletId) {
    return this.wallets.get(walletId);
  }
  
  getBalance(walletId, currency) {
    const balances = this.balances.get(`${walletId}_${currency}`);
    return balances ? balances[currency] : { confirmed: '0', unconfirmed: '0' };
  }
  
  getTotalBalance(walletId) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return 0;
    
    let totalUSD = 0;
    
    for (const currency of Object.keys(wallet.addresses)) {
      const balance = this.getBalance(walletId, currency);
      const price = this.prices.get(currency);
      
      if (balance && price) {
        const amount = parseFloat(balance.confirmed);
        totalUSD += amount * price.price;
      }
    }
    
    return totalUSD;
  }
  
  getTransactionHistory(walletId, options = {}) {
    const { limit = 100, offset = 0, currency } = options;
    
    let query = 'SELECT * FROM transactions WHERE walletId = ?';
    const params = [walletId];
    
    if (currency) {
      query += ' AND currency = ?';
      params.push(currency);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }
  
  getPriceHistory(currency, period = '24h') {
    const periodMs = {
      '1h': 3600000,
      '24h': 86400000,
      '7d': 604800000,
      '30d': 2592000000
    };
    
    const since = Date.now() - (periodMs[period] || periodMs['24h']);
    
    const stmt = this.db.prepare(`
      SELECT * FROM price_history 
      WHERE currency = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `);
    
    return stmt.all(currency, since);
  }
  
  async exportWallet(walletId, password) {
    const wallet = this.getWallet(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    // Get encrypted private keys
    const privateKeys = {};
    
    for (const currency of Object.keys(wallet.addresses)) {
      const dbWallet = this.getWalletFromDatabase(`${walletId}_${currency}`);
      if (dbWallet && dbWallet.encryptedPrivateKey) {
        const privateKey = this.decryptPrivateKey(
          JSON.parse(dbWallet.encryptedPrivateKey),
          password
        );
        privateKeys[currency] = privateKey;
      }
    }
    
    return {
      wallet,
      privateKeys,
      warning: 'Keep these private keys secure!'
    };
  }
  
  stop() {
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
    }
    
    if (this.db) {
      this.db.close();
    }
    
    this.emit('stopped');
  }
}

module.exports = MultiCurrencyWallet;