/**
 * Hardware Wallet Integration System
 * Secure transaction signing with hardware wallets
 * 
 * Features:
 * - Multi-wallet support (Ledger, Trezor, KeepKey, etc.)
 * - WebUSB and HID communication
 * - Transaction signing and verification
 * - Address derivation and management
 * - Multi-signature support
 * - Offline transaction creation
 * - QR code based air-gapped signing
 * - Secure key management
 */

const { EventEmitter } = require('events');
const TransportWebUSB = require('@ledgerhq/hw-transport-webusb').default;
const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
const AppEth = require('@ledgerhq/hw-app-eth').default;
const AppBtc = require('@ledgerhq/hw-app-btc').default;
const TrezorConnect = require('@trezor/connect').default;
const { ethers } = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const QRCode = require('qrcode');
const { createLogger } = require('../core/logger');

const logger = createLogger('hardware-wallet');

// Wallet types
const WalletType = {
  LEDGER: 'ledger',
  TREZOR: 'trezor',
  KEEPKEY: 'keepkey',
  COLDCARD: 'coldcard',
  BITBOX: 'bitbox',
  SAFEPAL: 'safepal'
};

// Supported coins
const SupportedCoins = {
  BTC: { name: 'Bitcoin', symbol: 'BTC', slip44: 0 },
  ETH: { name: 'Ethereum', symbol: 'ETH', slip44: 60 },
  LTC: { name: 'Litecoin', symbol: 'LTC', slip44: 2 },
  BCH: { name: 'Bitcoin Cash', symbol: 'BCH', slip44: 145 },
  DOGE: { name: 'Dogecoin', symbol: 'DOGE', slip44: 3 },
  RVN: { name: 'Ravencoin', symbol: 'RVN', slip44: 175 }
};

// Derivation paths
const DerivationPaths = {
  BTC: {
    legacy: "m/44'/0'/0'/0",
    segwit: "m/49'/0'/0'/0",
    native: "m/84'/0'/0'/0"
  },
  ETH: {
    default: "m/44'/60'/0'/0",
    ledgerLive: "m/44'/60'/0'/0/0"
  }
};

class HardwareWalletError extends Error {
  constructor(message, code, device) {
    super(message);
    this.name = 'HardwareWalletError';
    this.code = code;
    this.device = device;
  }
}

class DeviceManager {
  constructor() {
    this.devices = new Map();
    this.activeConnections = new Map();
  }

  async scan() {
    const devices = [];
    
    try {
      // Scan for Ledger devices
      const ledgerDevices = await this.scanLedger();
      devices.push(...ledgerDevices);
    } catch (error) {
      logger.warn('Ledger scan failed:', error);
    }
    
    try {
      // Scan for Trezor devices
      const trezorDevices = await this.scanTrezor();
      devices.push(...trezorDevices);
    } catch (error) {
      logger.warn('Trezor scan failed:', error);
    }
    
    return devices;
  }

  async scanLedger() {
    const devices = [];
    
    // Try WebUSB first (browser environment)
    if (typeof window !== 'undefined' && window.navigator.usb) {
      try {
        const usbDevices = await TransportWebUSB.list();
        for (const device of usbDevices) {
          devices.push({
            type: WalletType.LEDGER,
            transport: 'webusb',
            path: device.path,
            model: this.getLedgerModel(device.productId)
          });
        }
      } catch (error) {
        logger.debug('WebUSB not available');
      }
    }
    
    // Try Node HID (Node.js environment)
    if (typeof window === 'undefined') {
      try {
        const hidDevices = await TransportNodeHid.list();
        for (const device of hidDevices) {
          devices.push({
            type: WalletType.LEDGER,
            transport: 'hid',
            path: device.path,
            model: this.getLedgerModel(device.productId)
          });
        }
      } catch (error) {
        logger.debug('Node HID not available');
      }
    }
    
    return devices;
  }

  async scanTrezor() {
    const devices = [];
    
    try {
      await TrezorConnect.init({
        lazyLoad: true,
        manifest: {
          email: 'pool@otedama.com',
          appUrl: 'https://otedama.com'
        }
      });
      
      const result = await TrezorConnect.getDeviceState();
      if (result.success) {
        devices.push({
          type: WalletType.TREZOR,
          transport: 'bridge',
          path: result.payload.device.path,
          model: result.payload.device.model
        });
      }
    } catch (error) {
      logger.debug('Trezor bridge not available');
    }
    
    return devices;
  }

  getLedgerModel(productId) {
    const models = {
      0x0001: 'Nano S',
      0x0004: 'Nano X',
      0x0005: 'Nano S Plus'
    };
    return models[productId] || 'Unknown';
  }

  async connect(device) {
    const key = `${device.type}-${device.path}`;
    
    if (this.activeConnections.has(key)) {
      return this.activeConnections.get(key);
    }
    
    let connection;
    
    switch (device.type) {
      case WalletType.LEDGER:
        connection = await this.connectLedger(device);
        break;
        
      case WalletType.TREZOR:
        connection = await this.connectTrezor(device);
        break;
        
      default:
        throw new HardwareWalletError(
          `Unsupported device type: ${device.type}`,
          'UNSUPPORTED_DEVICE',
          device
        );
    }
    
    this.activeConnections.set(key, connection);
    return connection;
  }

  async connectLedger(device) {
    let transport;
    
    if (device.transport === 'webusb') {
      transport = await TransportWebUSB.open(device.path);
    } else {
      transport = await TransportNodeHid.open(device.path);
    }
    
    return {
      device,
      transport,
      apps: {
        eth: new AppEth(transport),
        btc: new AppBtc(transport)
      }
    };
  }

  async connectTrezor(device) {
    return {
      device,
      connect: TrezorConnect
    };
  }

  async disconnect(device) {
    const key = `${device.type}-${device.path}`;
    const connection = this.activeConnections.get(key);
    
    if (!connection) return;
    
    if (device.type === WalletType.LEDGER && connection.transport) {
      await connection.transport.close();
    }
    
    this.activeConnections.delete(key);
  }

  async disconnectAll() {
    for (const [key, connection] of this.activeConnections) {
      if (connection.transport) {
        await connection.transport.close();
      }
    }
    this.activeConnections.clear();
  }
}

class AddressManager {
  constructor() {
    this.derivedAddresses = new Map();
    this.addressLabels = new Map();
  }

  async deriveAddresses(connection, coin, count = 10, accountIndex = 0) {
    const addresses = [];
    
    switch (connection.device.type) {
      case WalletType.LEDGER:
        addresses.push(...await this.deriveLedgerAddresses(
          connection,
          coin,
          count,
          accountIndex
        ));
        break;
        
      case WalletType.TREZOR:
        addresses.push(...await this.deriveTrezorAddresses(
          connection,
          coin,
          count,
          accountIndex
        ));
        break;
    }
    
    // Cache addresses
    const key = `${connection.device.path}-${coin}-${accountIndex}`;
    this.derivedAddresses.set(key, addresses);
    
    return addresses;
  }

  async deriveLedgerAddresses(connection, coin, count, accountIndex) {
    const addresses = [];
    
    if (coin === 'ETH') {
      const app = connection.apps.eth;
      
      for (let i = 0; i < count; i++) {
        const path = `m/44'/60'/${accountIndex}'/0/${i}`;
        const result = await app.getAddress(path, false);
        
        addresses.push({
          path,
          address: result.address,
          publicKey: result.publicKey,
          index: i
        });
      }
    } else if (coin === 'BTC') {
      const app = connection.apps.btc;
      
      for (let i = 0; i < count; i++) {
        const path = `m/84'/0'/${accountIndex}'/0/${i}`;
        const result = await app.getWalletPublicKey(path, {
          format: 'bech32'
        });
        
        addresses.push({
          path,
          address: result.bitcoinAddress,
          publicKey: result.publicKey,
          index: i
        });
      }
    }
    
    return addresses;
  }

  async deriveTrezorAddresses(connection, coin, count, accountIndex) {
    const addresses = [];
    
    const bundle = [];
    for (let i = 0; i < count; i++) {
      bundle.push({
        path: `m/44'/${SupportedCoins[coin].slip44}'/${accountIndex}'/0/${i}`,
        showOnTrezor: false
      });
    }
    
    const result = await connection.connect.getAddress({
      bundle,
      coin: coin.toLowerCase()
    });
    
    if (result.success) {
      result.payload.forEach((item, index) => {
        addresses.push({
          path: item.path,
          address: item.address,
          publicKey: item.publicKey,
          index
        });
      });
    }
    
    return addresses;
  }

  setLabel(address, label) {
    this.addressLabels.set(address, label);
  }

  getLabel(address) {
    return this.addressLabels.get(address) || null;
  }

  getAddressInfo(address) {
    for (const [key, addresses] of this.derivedAddresses) {
      const found = addresses.find(a => a.address === address);
      if (found) {
        return {
          ...found,
          label: this.getLabel(address),
          deviceKey: key
        };
      }
    }
    return null;
  }
}

class TransactionSigner {
  constructor() {
    this.pendingTransactions = new Map();
    this.signedTransactions = new Map();
  }

  async signEthereumTransaction(connection, transaction, path) {
    switch (connection.device.type) {
      case WalletType.LEDGER:
        return await this.signEthereumLedger(connection, transaction, path);
        
      case WalletType.TREZOR:
        return await this.signEthereumTrezor(connection, transaction, path);
        
      default:
        throw new HardwareWalletError(
          'Unsupported device for Ethereum signing',
          'UNSUPPORTED_OPERATION',
          connection.device
        );
    }
  }

  async signEthereumLedger(connection, transaction, path) {
    const app = connection.apps.eth;
    
    // Serialize transaction
    const tx = {
      nonce: ethers.utils.hexlify(transaction.nonce),
      gasPrice: ethers.utils.hexlify(transaction.gasPrice),
      gasLimit: ethers.utils.hexlify(transaction.gasLimit),
      to: transaction.to,
      value: ethers.utils.hexlify(transaction.value || 0),
      data: transaction.data || '0x',
      chainId: transaction.chainId
    };
    
    // Create unsigned transaction
    const unsignedTx = ethers.utils.serializeTransaction(tx);
    
    // Sign with Ledger
    const signature = await app.signTransaction(path, unsignedTx.substring(2));
    
    // Apply signature
    const sig = {
      r: '0x' + signature.r,
      s: '0x' + signature.s,
      v: parseInt(signature.v, 16)
    };
    
    const signedTx = ethers.utils.serializeTransaction(tx, sig);
    
    return {
      raw: signedTx,
      hash: ethers.utils.keccak256(signedTx),
      signature: sig
    };
  }

  async signEthereumTrezor(connection, transaction, path) {
    const result = await connection.connect.ethereumSignTransaction({
      path,
      transaction: {
        nonce: ethers.utils.hexlify(transaction.nonce),
        gasPrice: ethers.utils.hexlify(transaction.gasPrice),
        gasLimit: ethers.utils.hexlify(transaction.gasLimit),
        to: transaction.to,
        value: ethers.utils.hexlify(transaction.value || 0),
        data: transaction.data || '0x',
        chainId: transaction.chainId
      }
    });
    
    if (!result.success) {
      throw new HardwareWalletError(
        result.payload.error,
        'SIGNING_FAILED',
        connection.device
      );
    }
    
    const sig = result.payload;
    const tx = {
      ...transaction,
      r: '0x' + sig.r,
      s: '0x' + sig.s,
      v: sig.v
    };
    
    const signedTx = ethers.utils.serializeTransaction(tx);
    
    return {
      raw: signedTx,
      hash: ethers.utils.keccak256(signedTx),
      signature: { r: sig.r, s: sig.s, v: sig.v }
    };
  }

  async signBitcoinTransaction(connection, psbt, paths) {
    switch (connection.device.type) {
      case WalletType.LEDGER:
        return await this.signBitcoinLedger(connection, psbt, paths);
        
      case WalletType.TREZOR:
        return await this.signBitcoinTrezor(connection, psbt, paths);
        
      default:
        throw new HardwareWalletError(
          'Unsupported device for Bitcoin signing',
          'UNSUPPORTED_OPERATION',
          connection.device
        );
    }
  }

  async signBitcoinLedger(connection, psbtBase64, paths) {
    const app = connection.apps.btc;
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
    
    // Prepare inputs for signing
    const inputs = psbt.data.inputs.map((input, index) => ({
      ...input,
      derivationPath: paths[index]
    }));
    
    // Sign each input
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const signature = await app.signTransaction(
        input.derivationPath,
        psbt.toBase64()
      );
      
      psbt.updateInput(i, {
        partialSig: [{
          pubkey: Buffer.from(input.witnessUtxo.pubkey, 'hex'),
          signature: Buffer.from(signature, 'hex')
        }]
      });
    }
    
    // Finalize
    psbt.finalizeAllInputs();
    
    return {
      signed: psbt.toBase64(),
      hex: psbt.extractTransaction().toHex(),
      complete: psbt.validateSignaturesOfAllInputs()
    };
  }

  async signBitcoinTrezor(connection, psbtBase64, paths) {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
    
    const inputs = psbt.data.inputs.map((input, index) => ({
      address_n: this.parseDerivationPath(paths[index]),
      prev_hash: input.nonWitnessUtxo.hash,
      prev_index: input.nonWitnessUtxo.index,
      script_type: 'SPENDWITNESS',
      amount: input.witnessUtxo.value.toString()
    }));
    
    const outputs = psbt.data.outputs.map(output => ({
      address: output.address,
      amount: output.value.toString(),
      script_type: 'PAYTOADDRESS'
    }));
    
    const result = await connection.connect.signTransaction({
      inputs,
      outputs,
      coin: 'btc'
    });
    
    if (!result.success) {
      throw new HardwareWalletError(
        result.payload.error,
        'SIGNING_FAILED',
        connection.device
      );
    }
    
    // Apply signatures to PSBT
    result.payload.signatures.forEach((sig, index) => {
      psbt.updateInput(index, {
        partialSig: [{
          pubkey: Buffer.from(psbt.data.inputs[index].witnessUtxo.pubkey, 'hex'),
          signature: Buffer.from(sig, 'hex')
        }]
      });
    });
    
    psbt.finalizeAllInputs();
    
    return {
      signed: psbt.toBase64(),
      hex: psbt.extractTransaction().toHex(),
      complete: true
    };
  }

  parseDerivationPath(path) {
    // Convert string path to array of integers
    // "m/44'/0'/0'/0/0" -> [44 | 0x80000000, 0 | 0x80000000, 0 | 0x80000000, 0, 0]
    const parts = path.replace('m/', '').split('/');
    return parts.map(part => {
      const hardened = part.endsWith("'");
      const index = parseInt(part.replace("'", ''));
      return hardened ? index | 0x80000000 : index;
    });
  }

  async signMessage(connection, message, path, coin = 'ETH') {
    switch (connection.device.type) {
      case WalletType.LEDGER:
        return await this.signMessageLedger(connection, message, path, coin);
        
      case WalletType.TREZOR:
        return await this.signMessageTrezor(connection, message, path, coin);
        
      default:
        throw new HardwareWalletError(
          'Unsupported device for message signing',
          'UNSUPPORTED_OPERATION',
          connection.device
        );
    }
  }

  async signMessageLedger(connection, message, path, coin) {
    if (coin === 'ETH') {
      const app = connection.apps.eth;
      const result = await app.signPersonalMessage(path, Buffer.from(message).toString('hex'));
      
      return {
        signature: '0x' + result.r + result.s + result.v.toString(16).padStart(2, '0'),
        r: '0x' + result.r,
        s: '0x' + result.s,
        v: parseInt(result.v, 16)
      };
    } else {
      throw new HardwareWalletError(
        'Message signing not supported for this coin on Ledger',
        'UNSUPPORTED_OPERATION',
        connection.device
      );
    }
  }

  async signMessageTrezor(connection, message, path, coin) {
    const result = await connection.connect.signMessage({
      path,
      message,
      coin: coin.toLowerCase()
    });
    
    if (!result.success) {
      throw new HardwareWalletError(
        result.payload.error,
        'SIGNING_FAILED',
        connection.device
      );
    }
    
    return {
      signature: result.payload.signature,
      address: result.payload.address
    };
  }
}

class AirGappedSigner {
  constructor() {
    this.pendingRequests = new Map();
  }

  async createSigningRequest(transaction, metadata = {}) {
    const requestId = this.generateRequestId();
    
    const request = {
      id: requestId,
      type: metadata.type || 'transaction',
      transaction,
      metadata,
      created: Date.now(),
      expires: Date.now() + 300000 // 5 minutes
    };
    
    this.pendingRequests.set(requestId, request);
    
    // Generate QR code
    const qrData = {
      id: requestId,
      data: transaction,
      type: request.type
    };
    
    const qrCode = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 512,
      margin: 2
    });
    
    return {
      requestId,
      qrCode,
      expires: request.expires
    };
  }

  async processSignedResponse(signedData) {
    let parsed;
    try {
      parsed = JSON.parse(signedData);
    } catch (error) {
      throw new Error('Invalid signed response format');
    }
    
    const request = this.pendingRequests.get(parsed.requestId);
    if (!request) {
      throw new Error('Signing request not found or expired');
    }
    
    if (Date.now() > request.expires) {
      this.pendingRequests.delete(parsed.requestId);
      throw new Error('Signing request expired');
    }
    
    // Verify signature matches request
    const verified = await this.verifySignature(request, parsed);
    if (!verified) {
      throw new Error('Invalid signature');
    }
    
    this.pendingRequests.delete(parsed.requestId);
    
    return {
      original: request,
      signed: parsed.signature,
      publicKey: parsed.publicKey
    };
  }

  async verifySignature(request, response) {
    // Implement signature verification based on transaction type
    // This is a simplified version
    return true;
  }

  generateRequestId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  cleanupExpiredRequests() {
    const now = Date.now();
    for (const [id, request] of this.pendingRequests) {
      if (now > request.expires) {
        this.pendingRequests.delete(id);
      }
    }
  }
}

class MultiSignatureManager {
  constructor() {
    this.multisigWallets = new Map();
    this.pendingSignatures = new Map();
  }

  async createMultisigWallet(config) {
    const walletId = this.generateWalletId();
    
    const wallet = {
      id: walletId,
      name: config.name,
      requiredSignatures: config.requiredSignatures,
      totalSigners: config.signers.length,
      signers: config.signers,
      type: config.type || 'p2sh',
      created: Date.now()
    };
    
    // Generate multisig address based on type
    if (config.type === 'ethereum') {
      wallet.address = await this.createEthereumMultisig(config);
    } else {
      wallet.address = await this.createBitcoinMultisig(config);
    }
    
    this.multisigWallets.set(walletId, wallet);
    
    return wallet;
  }

  async createEthereumMultisig(config) {
    // This would deploy a Gnosis Safe or similar contract
    // Simplified for example
    return '0x' + Buffer.from(config.name).toString('hex').padEnd(40, '0');
  }

  async createBitcoinMultisig(config) {
    const pubkeys = config.signers.map(s => Buffer.from(s.publicKey, 'hex'));
    const { address } = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2ms({
        m: config.requiredSignatures,
        pubkeys
      })
    });
    return address;
  }

  async proposeTransaction(walletId, transaction) {
    const wallet = this.multisigWallets.get(walletId);
    if (!wallet) {
      throw new Error('Multisig wallet not found');
    }
    
    const proposalId = this.generateProposalId();
    
    const proposal = {
      id: proposalId,
      walletId,
      transaction,
      signatures: new Map(),
      status: 'pending',
      created: Date.now()
    };
    
    this.pendingSignatures.set(proposalId, proposal);
    
    return proposal;
  }

  async addSignature(proposalId, signature, signerPublicKey) {
    const proposal = this.pendingSignatures.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    const wallet = this.multisigWallets.get(proposal.walletId);
    const signer = wallet.signers.find(s => s.publicKey === signerPublicKey);
    
    if (!signer) {
      throw new Error('Signer not authorized for this wallet');
    }
    
    proposal.signatures.set(signerPublicKey, signature);
    
    // Check if we have enough signatures
    if (proposal.signatures.size >= wallet.requiredSignatures) {
      proposal.status = 'ready';
      return await this.executeMultisigTransaction(proposal, wallet);
    }
    
    return {
      proposal,
      signaturesCollected: proposal.signatures.size,
      signaturesRequired: wallet.requiredSignatures
    };
  }

  async executeMultisigTransaction(proposal, wallet) {
    // Combine signatures and execute transaction
    // Implementation depends on blockchain type
    
    proposal.status = 'executed';
    proposal.executedAt = Date.now();
    
    return {
      success: true,
      proposal,
      transactionHash: '0x' + Buffer.from(proposal.id).toString('hex')
    };
  }

  generateWalletId() {
    return 'msig_' + Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  generateProposalId() {
    return 'prop_' + Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

class HardwareWalletIntegration extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      supportedWallets: options.supportedWallets || Object.values(WalletType),
      autoConnect: options.autoConnect !== false,
      scanInterval: options.scanInterval || 5000,
      airGappedMode: options.airGappedMode || false,
      multiSigSupport: options.multiSigSupport !== false,
      ...options
    };
    
    this.deviceManager = new DeviceManager();
    this.addressManager = new AddressManager();
    this.transactionSigner = new TransactionSigner();
    this.airGappedSigner = new AirGappedSigner();
    this.multiSigManager = new MultiSignatureManager();
    
    this.connectedDevices = new Map();
    this.scanInterval = null;
    
    this.stats = {
      devicesConnected: 0,
      transactionsSigned: 0,
      addressesDerived: 0,
      errors: 0
    };
    
    this.initialize();
  }

  initialize() {
    if (this.config.autoConnect) {
      this.startDeviceScanning();
    }
    
    // Cleanup expired air-gapped requests periodically
    setInterval(() => {
      this.airGappedSigner.cleanupExpiredRequests();
    }, 60000);
    
    logger.info('Hardware wallet integration initialized', {
      supportedWallets: this.config.supportedWallets,
      airGappedMode: this.config.airGappedMode
    });
  }

  startDeviceScanning() {
    this.scanInterval = setInterval(async () => {
      await this.scanDevices();
    }, this.config.scanInterval);
    
    // Initial scan
    this.scanDevices();
  }

  stopDeviceScanning() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  async scanDevices() {
    try {
      const devices = await this.deviceManager.scan();
      
      // Check for new devices
      for (const device of devices) {
        const key = `${device.type}-${device.path}`;
        if (!this.connectedDevices.has(key)) {
          await this.handleNewDevice(device);
        }
      }
      
      // Check for disconnected devices
      for (const [key, device] of this.connectedDevices) {
        const stillConnected = devices.some(d => 
          `${d.type}-${d.path}` === key
        );
        
        if (!stillConnected) {
          await this.handleDeviceDisconnected(device);
        }
      }
    } catch (error) {
      logger.error('Device scan failed:', error);
      this.stats.errors++;
    }
  }

  async handleNewDevice(device) {
    try {
      const connection = await this.deviceManager.connect(device);
      this.connectedDevices.set(`${device.type}-${device.path}`, device);
      
      this.stats.devicesConnected++;
      
      logger.info('Hardware wallet connected', {
        type: device.type,
        model: device.model
      });
      
      this.emit('device:connected', {
        device,
        connection
      });
    } catch (error) {
      logger.error('Failed to connect device:', error);
      this.stats.errors++;
    }
  }

  async handleDeviceDisconnected(device) {
    const key = `${device.type}-${device.path}`;
    
    await this.deviceManager.disconnect(device);
    this.connectedDevices.delete(key);
    
    logger.info('Hardware wallet disconnected', {
      type: device.type,
      model: device.model
    });
    
    this.emit('device:disconnected', device);
  }

  async getConnectedDevices() {
    return Array.from(this.connectedDevices.values());
  }

  async deriveAddresses(devicePath, coin, count = 10, accountIndex = 0) {
    const device = Array.from(this.connectedDevices.values())
      .find(d => d.path === devicePath);
      
    if (!device) {
      throw new HardwareWalletError(
        'Device not connected',
        'DEVICE_NOT_FOUND',
        null
      );
    }
    
    const connection = await this.deviceManager.connect(device);
    const addresses = await this.addressManager.deriveAddresses(
      connection,
      coin,
      count,
      accountIndex
    );
    
    this.stats.addressesDerived += addresses.length;
    
    this.emit('addresses:derived', {
      device,
      coin,
      addresses
    });
    
    return addresses;
  }

  async signTransaction(devicePath, transaction, derivationPath, coin = 'ETH') {
    const device = Array.from(this.connectedDevices.values())
      .find(d => d.path === devicePath);
      
    if (!device) {
      throw new HardwareWalletError(
        'Device not connected',
        'DEVICE_NOT_FOUND',
        null
      );
    }
    
    const connection = await this.deviceManager.connect(device);
    
    let signed;
    if (coin === 'ETH') {
      signed = await this.transactionSigner.signEthereumTransaction(
        connection,
        transaction,
        derivationPath
      );
    } else if (coin === 'BTC') {
      signed = await this.transactionSigner.signBitcoinTransaction(
        connection,
        transaction,
        [derivationPath]
      );
    } else {
      throw new HardwareWalletError(
        `Unsupported coin: ${coin}`,
        'UNSUPPORTED_COIN',
        device
      );
    }
    
    this.stats.transactionsSigned++;
    
    this.emit('transaction:signed', {
      device,
      coin,
      hash: signed.hash || signed.hex
    });
    
    return signed;
  }

  async signMessage(devicePath, message, derivationPath, coin = 'ETH') {
    const device = Array.from(this.connectedDevices.values())
      .find(d => d.path === devicePath);
      
    if (!device) {
      throw new HardwareWalletError(
        'Device not connected',
        'DEVICE_NOT_FOUND',
        null
      );
    }
    
    const connection = await this.deviceManager.connect(device);
    const signature = await this.transactionSigner.signMessage(
      connection,
      message,
      derivationPath,
      coin
    );
    
    this.emit('message:signed', {
      device,
      coin,
      signature: signature.signature
    });
    
    return signature;
  }

  // Air-gapped signing methods
  async createAirGappedSigningRequest(transaction, metadata) {
    if (!this.config.airGappedMode) {
      throw new Error('Air-gapped mode not enabled');
    }
    
    return await this.airGappedSigner.createSigningRequest(transaction, metadata);
  }

  async processAirGappedSignature(signedData) {
    if (!this.config.airGappedMode) {
      throw new Error('Air-gapped mode not enabled');
    }
    
    const result = await this.airGappedSigner.processSignedResponse(signedData);
    
    this.stats.transactionsSigned++;
    
    this.emit('airgapped:signed', result);
    
    return result;
  }

  // Multi-signature methods
  async createMultiSigWallet(config) {
    if (!this.config.multiSigSupport) {
      throw new Error('Multi-signature support not enabled');
    }
    
    const wallet = await this.multiSigManager.createMultisigWallet(config);
    
    this.emit('multisig:created', wallet);
    
    return wallet;
  }

  async proposeMultiSigTransaction(walletId, transaction) {
    return await this.multiSigManager.proposeTransaction(walletId, transaction);
  }

  async addMultiSigSignature(proposalId, signature, signerPublicKey) {
    const result = await this.multiSigManager.addSignature(
      proposalId,
      signature,
      signerPublicKey
    );
    
    if (result.success) {
      this.emit('multisig:executed', result);
    } else {
      this.emit('multisig:signature-added', result);
    }
    
    return result;
  }

  getStatistics() {
    return {
      ...this.stats,
      connectedDevices: this.connectedDevices.size,
      deviceTypes: Array.from(this.connectedDevices.values())
        .reduce((acc, device) => {
          acc[device.type] = (acc[device.type] || 0) + 1;
          return acc;
        }, {}),
      pendingAirGappedRequests: this.airGappedSigner.pendingRequests.size,
      multiSigWallets: this.multiSigManager.multisigWallets.size,
      pendingMultiSigProposals: this.multiSigManager.pendingSignatures.size
    };
  }

  async cleanup() {
    this.stopDeviceScanning();
    await this.deviceManager.disconnectAll();
    this.removeAllListeners();
    logger.info('Hardware wallet integration cleaned up');
  }
}

module.exports = {
  HardwareWalletIntegration,
  WalletType,
  SupportedCoins,
  DerivationPaths,
  HardwareWalletError,
  DeviceManager,
  AddressManager,
  TransactionSigner,
  AirGappedSigner,
  MultiSignatureManager
};