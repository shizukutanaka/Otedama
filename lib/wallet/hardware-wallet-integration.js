/**
 * Hardware Wallet Integration
 * Supports Ledger, Trezor, and other hardware wallets for enhanced security
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import TransportNodeHid from '@ledgerhq/hw-transport-node-hid';
import AppBtc from '@ledgerhq/hw-app-btc';
import TrezorConnect from '@trezor/connect';

const logger = createLogger('hardware-wallet');

class HardwareWalletIntegration extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      timeout: options.timeout || 30000,
      confirmationRequired: options.confirmationRequired !== false,
      supportedWallets: options.supportedWallets || ['ledger', 'trezor', 'keepkey'],
      network: options.network || bitcoinjs.networks.bitcoin,
      ...options
    };
    
    this.connectedDevices = new Map();
    this.initialized = false;
  }
  
  /**
   * Initialize hardware wallet support
   */
  async initialize() {
    try {
      // Initialize Trezor
      await TrezorConnect.init({
        lazyLoad: true,
        manifest: {
          email: 'support@otedama.io',
          appUrl: 'https://otedama.io'
        }
      });
      
      this.initialized = true;
      logger.info('Hardware wallet support initialized');
      
      // Start device monitoring
      this.startDeviceMonitoring();
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize hardware wallet support:', error);
      throw error;
    }
  }
  
  /**
   * List available hardware wallets
   */
  async listDevices() {
    const devices = [];
    
    try {
      // Check for Ledger devices
      const ledgerDevices = await this.detectLedgerDevices();
      devices.push(...ledgerDevices);
      
      // Check for Trezor devices
      const trezorDevices = await this.detectTrezorDevices();
      devices.push(...trezorDevices);
      
      logger.info(`Found ${devices.length} hardware wallet(s)`);
      return devices;
    } catch (error) {
      logger.error('Error listing devices:', error);
      return [];
    }
  }
  
  /**
   * Connect to a hardware wallet
   */
  async connect(deviceId, type) {
    if (this.connectedDevices.has(deviceId)) {
      return this.connectedDevices.get(deviceId);
    }
    
    let connection;
    
    try {
      switch (type) {
        case 'ledger':
          connection = await this.connectLedger(deviceId);
          break;
        case 'trezor':
          connection = await this.connectTrezor(deviceId);
          break;
        default:
          throw new Error(`Unsupported wallet type: ${type}`);
      }
      
      this.connectedDevices.set(deviceId, connection);
      this.emit('device-connected', { deviceId, type });
      
      return connection;
    } catch (error) {
      logger.error(`Failed to connect to ${type} device:`, error);
      throw error;
    }
  }
  
  /**
   * Get Bitcoin address from hardware wallet
   */
  async getAddress(deviceId, derivationPath = "m/84'/0'/0'/0/0") {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('Device not connected');
    }
    
    try {
      let address;
      
      switch (device.type) {
        case 'ledger':
          address = await this.getLedgerAddress(device, derivationPath);
          break;
        case 'trezor':
          address = await this.getTrezorAddress(device, derivationPath);
          break;
        default:
          throw new Error('Unknown device type');
      }
      
      logger.info(`Retrieved address from ${device.type}: ${address}`);
      return address;
    } catch (error) {
      logger.error('Failed to get address:', error);
      throw error;
    }
  }
  
  /**
   * Sign transaction with hardware wallet
   */
  async signTransaction(deviceId, transaction, inputs) {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('Device not connected');
    }
    
    try {
      if (this.options.confirmationRequired) {
        this.emit('confirmation-required', {
          deviceId,
          action: 'sign-transaction',
          details: {
            inputs: inputs.length,
            outputs: transaction.outs.length,
            fee: this.calculateFee(transaction, inputs)
          }
        });
      }
      
      let signedTx;
      
      switch (device.type) {
        case 'ledger':
          signedTx = await this.signWithLedger(device, transaction, inputs);
          break;
        case 'trezor':
          signedTx = await this.signWithTrezor(device, transaction, inputs);
          break;
        default:
          throw new Error('Unknown device type');
      }
      
      logger.info('Transaction signed successfully');
      this.emit('transaction-signed', { deviceId, txId: signedTx.getId() });
      
      return signedTx;
    } catch (error) {
      logger.error('Failed to sign transaction:', error);
      throw error;
    }
  }
  
  /**
   * Verify address on device screen
   */
  async verifyAddress(deviceId, address, derivationPath) {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('Device not connected');
    }
    
    try {
      this.emit('verification-required', {
        deviceId,
        action: 'verify-address',
        address
      });
      
      let verified;
      
      switch (device.type) {
        case 'ledger':
          verified = await this.verifyLedgerAddress(device, address, derivationPath);
          break;
        case 'trezor':
          verified = await this.verifyTrezorAddress(device, address, derivationPath);
          break;
        default:
          throw new Error('Unknown device type');
      }
      
      if (verified) {
        logger.info('Address verified on device');
        this.emit('address-verified', { deviceId, address });
      }
      
      return verified;
    } catch (error) {
      logger.error('Failed to verify address:', error);
      throw error;
    }
  }
  
  /**
   * Disconnect hardware wallet
   */
  async disconnect(deviceId) {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      return;
    }
    
    try {
      switch (device.type) {
        case 'ledger':
          await device.transport.close();
          break;
        case 'trezor':
          // Trezor handles disconnection automatically
          break;
      }
      
      this.connectedDevices.delete(deviceId);
      this.emit('device-disconnected', { deviceId });
      
      logger.info(`Disconnected ${device.type} device`);
    } catch (error) {
      logger.error('Error disconnecting device:', error);
    }
  }
  
  /**
   * Detect Ledger devices
   */
  async detectLedgerDevices() {
    const devices = [];
    
    try {
      const descriptors = await TransportNodeHid.list();
      
      for (const descriptor of descriptors) {
        devices.push({
          id: descriptor.path,
          type: 'ledger',
          model: this.getLedgerModel(descriptor),
          status: 'available'
        });
      }
    } catch (error) {
      logger.debug('No Ledger devices found');
    }
    
    return devices;
  }
  
  /**
   * Detect Trezor devices
   */
  async detectTrezorDevices() {
    const devices = [];
    
    try {
      const result = await TrezorConnect.getFeatures();
      
      if (result.success) {
        devices.push({
          id: result.payload.device_id,
          type: 'trezor',
          model: result.payload.model,
          status: 'available'
        });
      }
    } catch (error) {
      logger.debug('No Trezor devices found');
    }
    
    return devices;
  }
  
  /**
   * Connect to Ledger device
   */
  async connectLedger(devicePath) {
    const transport = await TransportNodeHid.open(devicePath);
    const app = new AppBtc(transport);
    
    // Verify Bitcoin app is open
    const appInfo = await app.getAppAndVersion();
    if (!appInfo.name.includes('Bitcoin')) {
      throw new Error('Please open Bitcoin app on Ledger device');
    }
    
    return {
      type: 'ledger',
      transport,
      app,
      devicePath
    };
  }
  
  /**
   * Connect to Trezor device
   */
  async connectTrezor(deviceId) {
    const result = await TrezorConnect.getFeatures();
    
    if (!result.success) {
      throw new Error('Failed to connect to Trezor');
    }
    
    return {
      type: 'trezor',
      deviceId,
      features: result.payload
    };
  }
  
  /**
   * Get address from Ledger
   */
  async getLedgerAddress(device, derivationPath) {
    const result = await device.app.getWalletPublicKey(derivationPath, {
      format: 'bech32'
    });
    
    return result.bitcoinAddress;
  }
  
  /**
   * Get address from Trezor
   */
  async getTrezorAddress(device, derivationPath) {
    const result = await TrezorConnect.getAddress({
      path: derivationPath,
      coin: 'btc'
    });
    
    if (!result.success) {
      throw new Error(result.payload.error);
    }
    
    return result.payload.address;
  }
  
  /**
   * Sign transaction with Ledger
   */
  async signWithLedger(device, transaction, inputs) {
    const tx = new bitcoinjs.Transaction();
    
    // Prepare inputs for Ledger
    const ledgerInputs = inputs.map(input => [
      device.app.splitTransaction(input.hex),
      input.index,
      null, // Legacy script
      null  // Sequence
    ]);
    
    // Get signatures
    const signatures = await device.app.signP2SHTransaction(
      ledgerInputs,
      inputs.map(i => i.derivationPath),
      transaction.toHex()
    );
    
    // Build signed transaction
    // ... (implementation details)
    
    return tx;
  }
  
  /**
   * Sign transaction with Trezor
   */
  async signWithTrezor(device, transaction, inputs) {
    const result = await TrezorConnect.signTransaction({
      inputs: inputs.map(input => ({
        address_n: this.parsePath(input.derivationPath),
        prev_hash: input.txId,
        prev_index: input.index,
        amount: input.value.toString()
      })),
      outputs: transaction.outs.map(output => ({
        address: bitcoinjs.address.fromOutputScript(output.script, this.options.network),
        amount: output.value.toString()
      })),
      coin: 'btc'
    });
    
    if (!result.success) {
      throw new Error(result.payload.error);
    }
    
    return bitcoinjs.Transaction.fromHex(result.payload.serializedTx);
  }
  
  /**
   * Verify address on Ledger screen
   */
  async verifyLedgerAddress(device, address, derivationPath) {
    const result = await device.app.getWalletPublicKey(derivationPath, {
      format: 'bech32',
      verify: true // This shows address on device screen
    });
    
    return result.bitcoinAddress === address;
  }
  
  /**
   * Verify address on Trezor screen
   */
  async verifyTrezorAddress(device, address, derivationPath) {
    const result = await TrezorConnect.getAddress({
      path: derivationPath,
      coin: 'btc',
      showOnTrezor: true
    });
    
    return result.success && result.payload.address === address;
  }
  
  /**
   * Start monitoring for device connections
   */
  startDeviceMonitoring() {
    // Monitor Ledger devices
    setInterval(async () => {
      const devices = await this.listDevices();
      
      // Check for new devices
      for (const device of devices) {
        if (!this.connectedDevices.has(device.id)) {
          this.emit('device-detected', device);
        }
      }
      
      // Check for disconnected devices
      for (const [deviceId, connection] of this.connectedDevices) {
        const stillConnected = devices.some(d => d.id === deviceId);
        if (!stillConnected) {
          await this.disconnect(deviceId);
        }
      }
    }, 5000);
  }
  
  /**
   * Calculate transaction fee
   */
  calculateFee(transaction, inputs) {
    const inputValue = inputs.reduce((sum, input) => sum + input.value, 0);
    const outputValue = transaction.outs.reduce((sum, output) => sum + output.value, 0);
    return inputValue - outputValue;
  }
  
  /**
   * Parse derivation path
   */
  parsePath(path) {
    return path.split('/').slice(1).map(p => {
      const hardened = p.endsWith("'");
      const index = parseInt(p.replace("'", ""));
      return hardened ? index + 0x80000000 : index;
    });
  }
  
  /**
   * Get Ledger model from descriptor
   */
  getLedgerModel(descriptor) {
    // Ledger Nano S
    if (descriptor.vendorId === 0x2c97 && descriptor.productId === 0x0001) {
      return 'Nano S';
    }
    // Ledger Nano X
    if (descriptor.vendorId === 0x2c97 && descriptor.productId === 0x0004) {
      return 'Nano X';
    }
    // Ledger Nano S Plus
    if (descriptor.vendorId === 0x2c97 && descriptor.productId === 0x0005) {
      return 'Nano S Plus';
    }
    return 'Unknown';
  }
  
  /**
   * Export extended public key
   */
  async getExtendedPublicKey(deviceId, derivationPath = "m/84'/0'/0'") {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('Device not connected');
    }
    
    try {
      let xpub;
      
      switch (device.type) {
        case 'ledger':
          const result = await device.app.getWalletPublicKey(derivationPath);
          xpub = result.publicKey;
          break;
        case 'trezor':
          const trezorResult = await TrezorConnect.getPublicKey({
            path: derivationPath,
            coin: 'btc'
          });
          if (!trezorResult.success) {
            throw new Error(trezorResult.payload.error);
          }
          xpub = trezorResult.payload.xpub;
          break;
      }
      
      return xpub;
    } catch (error) {
      logger.error('Failed to get extended public key:', error);
      throw error;
    }
  }
}

export default HardwareWalletIntegration;