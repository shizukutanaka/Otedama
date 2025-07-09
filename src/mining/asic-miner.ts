/**
 * ASIC Mining Support
 * Following Carmack/Martin/Pike principles:
 * - Simple interface for various ASIC hardware
 * - Efficient communication protocols
 * - Robust error handling
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as SerialPort from 'serialport';
import * as usb from 'usb';

interface ASICDevice {
  id: string;
  type: ASICType;
  model: string;
  serial: string;
  chips: number;
  frequency: number; // MHz
  hashRate: number; // GH/s
  temperature: number;
  status: 'idle' | 'mining' | 'error';
  connection: ASICConnection;
}

enum ASICType {
  ANTMINER = 'antminer',
  WHATSMINER = 'whatsminer',
  AVALON = 'avalon',
  INNOSILICON = 'innosilicon',
  GENERIC = 'generic'
}

interface ASICConnection {
  type: 'serial' | 'usb' | 'network';
  path?: string;
  host?: string;
  port?: number;
}

interface ASICMinerOptions {
  scanInterval?: number;
  autoDetect?: boolean;
  devices?: ASICConnection[];
  temperatureLimit?: number;
  autoRestart?: boolean;
}

export class ASICMiner extends EventEmitter {
  private devices: Map<string, ASICDevice> = new Map();
  private workers: Map<string, ASICWorker> = new Map();
  private options: Required<ASICMinerOptions>;
  private scanInterval?: NodeJS.Timer;
  private isRunning = false;

  constructor(options: ASICMinerOptions = {}) {
    super();
    
    this.options = {
      scanInterval: 30000, // 30 seconds
      autoDetect: true,
      devices: [],
      temperatureLimit: 85,
      autoRestart: true,
      ...options
    };
  }

  /**
   * Initialize ASIC miners
   */
  async initialize(): Promise<void> {
    if (this.options.autoDetect) {
      await this.scanForDevices();
      
      // Start periodic scanning
      this.scanInterval = setInterval(() => {
        this.scanForDevices().catch(err => {
          this.emit('error', { type: 'scan', error: err });
        });
      }, this.options.scanInterval);
    }
    
    // Connect to specified devices
    for (const connection of this.options.devices) {
      await this.connectDevice(connection);
    }
    
    this.emit('initialized', { devices: Array.from(this.devices.values()) });
  }

  /**
   * Start mining on all ASICs
   */
  async start(poolUrl: string, username: string, password: string): Promise<void> {
    this.isRunning = true;
    
    for (const [id, device] of this.devices) {
      if (device.status === 'error') continue;
      
      const worker = new ASICWorker(device);
      
      worker.on('hashrate', (rate) => {
        device.hashRate = rate;
        this.emit('hashrate', { deviceId: id, hashRate: rate });
      });
      
      worker.on('temperature', (temp) => {
        device.temperature = temp;
        this.checkTemperature(device);
      });
      
      worker.on('share', (share) => {
        this.emit('share', { deviceId: id, ...share });
      });
      
      worker.on('error', (error) => {
        device.status = 'error';
        this.emit('error', { deviceId: id, error });
        
        if (this.options.autoRestart) {
          this.restartDevice(id);
        }
      });
      
      await worker.start(poolUrl, username, password);
      device.status = 'mining';
      this.workers.set(id, worker);
    }
    
    this.emit('start', { devices: this.devices.size });
  }

  /**
   * Stop all ASIC miners
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    
    // Stop all workers
    const stopPromises = Array.from(this.workers.values())
      .map(worker => worker.stop());
    
    await Promise.all(stopPromises);
    
    this.workers.clear();
    
    // Update device status
    for (const device of this.devices.values()) {
      device.status = 'idle';
    }
    
    this.emit('stop');
  }

  /**
   * Get total hash rate
   */
  getTotalHashRate(): number {
    return Array.from(this.devices.values())
      .reduce((total, device) => total + device.hashRate, 0);
  }

  /**
   * Get device statistics
   */
  getDeviceStats(): ASICDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Scan for ASIC devices
   */
  private async scanForDevices(): Promise<void> {
    const foundDevices: ASICDevice[] = [];
    
    // Scan USB devices
    if (this.options.autoDetect) {
      foundDevices.push(...await this.scanUSBDevices());
    }
    
    // Scan serial ports
    foundDevices.push(...await this.scanSerialPorts());
    
    // Scan network (common ASIC IPs)
    foundDevices.push(...await this.scanNetwork());
    
    // Update device list
    for (const device of foundDevices) {
      if (!this.devices.has(device.id)) {
        this.devices.set(device.id, device);
        this.emit('deviceFound', device);
      }
    }
  }

  /**
   * Scan USB devices
   */
  private async scanUSBDevices(): Promise<ASICDevice[]> {
    const devices: ASICDevice[] = [];
    
    // Common ASIC USB vendor/product IDs
    const asicUSBDevices = [
      { vendor: 0x0403, product: 0x6014, type: ASICType.ANTMINER, model: 'Antminer U3' },
      { vendor: 0x10c4, product: 0xea60, type: ASICType.AVALON, model: 'Avalon Nano' },
      // Add more known ASIC USB IDs
    ];
    
    const usbDevices = usb.getDeviceList();
    
    for (const usbDevice of usbDevices) {
      const descriptor = usbDevice.deviceDescriptor;
      
      const knownDevice = asicUSBDevices.find(
        d => d.vendor === descriptor.idVendor && d.product === descriptor.idProduct
      );
      
      if (knownDevice) {
        const device: ASICDevice = {
          id: `usb_${descriptor.idVendor}_${descriptor.idProduct}_${usbDevice.busNumber}_${usbDevice.deviceAddress}`,
          type: knownDevice.type,
          model: knownDevice.model,
          serial: 'unknown',
          chips: 1,
          frequency: 100,
          hashRate: 0,
          temperature: 0,
          status: 'idle',
          connection: {
            type: 'usb',
            path: `${usbDevice.busNumber}:${usbDevice.deviceAddress}`
          }
        };
        
        devices.push(device);
      }
    }
    
    return devices;
  }

  /**
   * Scan serial ports
   */
  private async scanSerialPorts(): Promise<ASICDevice[]> {
    const devices: ASICDevice[] = [];
    
    try {
      const ports = await SerialPort.list();
      
      for (const port of ports) {
        // Check if it's likely an ASIC
        if (port.manufacturer && 
            (port.manufacturer.includes('Silicon Labs') || 
             port.manufacturer.includes('FTDI'))) {
          
          // Try to identify the device
          const device = await this.identifySerialDevice(port.path);
          if (device) {
            devices.push(device);
          }
        }
      }
    } catch (error) {
      // Serial port scanning not available
    }
    
    return devices;
  }

  /**
   * Identify serial device
   */
  private async identifySerialDevice(path: string): Promise<ASICDevice | null> {
    try {
      const port = new SerialPort(path, {
        baudRate: 115200,
        autoOpen: false
      });
      
      await new Promise((resolve, reject) => {
        port.open((err) => err ? reject(err) : resolve(undefined));
      });
      
      // Send identification command
      await new Promise((resolve) => {
        port.write('{"command":"version"}\n', resolve);
      });
      
      // Wait for response
      const response = await new Promise<string>((resolve) => {
        let buffer = '';
        port.on('data', (data) => {
          buffer += data.toString();
          if (buffer.includes('\n')) {
            resolve(buffer);
          }
        });
        
        setTimeout(() => resolve(''), 1000); // 1 second timeout
      });
      
      port.close();
      
      if (response) {
        // Parse device info
        try {
          const info = JSON.parse(response);
          
          return {
            id: `serial_${path}`,
            type: this.detectASICType(info),
            model: info.model || 'Unknown',
            serial: info.serial || 'unknown',
            chips: info.chips || 1,
            frequency: info.frequency || 100,
            hashRate: 0,
            temperature: 0,
            status: 'idle',
            connection: {
              type: 'serial',
              path
            }
          };
        } catch {
          // Invalid response
        }
      }
    } catch {
      // Device not responding or not an ASIC
    }
    
    return null;
  }

  /**
   * Scan network for ASICs
   */
  private async scanNetwork(): Promise<ASICDevice[]> {
    const devices: ASICDevice[] = [];
    
    // Common ASIC ports
    const commonPorts = [4028, 4029, 4030]; // CGMiner API ports
    
    // Scan local network (simplified)
    // In production, this would scan the actual network range
    const localIPs = ['192.168.1.100', '192.168.1.101']; // Example
    
    for (const ip of localIPs) {
      for (const port of commonPorts) {
        const device = await this.identifyNetworkDevice(ip, port);
        if (device) {
          devices.push(device);
        }
      }
    }
    
    return devices;
  }

  /**
   * Identify network device
   */
  private async identifyNetworkDevice(host: string, port: number): Promise<ASICDevice | null> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      
      socket.setTimeout(1000); // 1 second timeout
      
      socket.on('connect', async () => {
        // Send CGMiner API version command
        socket.write('{"command":"version"}\n');
      });
      
      socket.on('data', (data) => {
        try {
          const response = JSON.parse(data.toString());
          
          const device: ASICDevice = {
            id: `network_${host}_${port}`,
            type: this.detectASICType(response),
            model: response.Description || 'Unknown',
            serial: 'unknown',
            chips: 1,
            frequency: 100,
            hashRate: 0,
            temperature: 0,
            status: 'idle',
            connection: {
              type: 'network',
              host,
              port
            }
          };
          
          socket.destroy();
          resolve(device);
        } catch {
          socket.destroy();
          resolve(null);
        }
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });
      
      socket.on('error', () => {
        resolve(null);
      });
      
      socket.connect(port, host);
    });
  }

  /**
   * Detect ASIC type from device info
   */
  private detectASICType(info: any): ASICType {
    const description = (info.Description || info.model || '').toLowerCase();
    
    if (description.includes('antminer')) return ASICType.ANTMINER;
    if (description.includes('whatsminer')) return ASICType.WHATSMINER;
    if (description.includes('avalon')) return ASICType.AVALON;
    if (description.includes('innosilicon')) return ASICType.INNOSILICON;
    
    return ASICType.GENERIC;
  }

  /**
   * Connect to specific device
   */
  private async connectDevice(connection: ASICConnection): Promise<void> {
    let device: ASICDevice | null = null;
    
    switch (connection.type) {
      case 'serial':
        if (connection.path) {
          device = await this.identifySerialDevice(connection.path);
        }
        break;
        
      case 'network':
        if (connection.host && connection.port) {
          device = await this.identifyNetworkDevice(connection.host, connection.port);
        }
        break;
    }
    
    if (device) {
      this.devices.set(device.id, device);
      this.emit('deviceConnected', device);
    }
  }

  /**
   * Check device temperature
   */
  private checkTemperature(device: ASICDevice): void {
    if (device.temperature > this.options.temperatureLimit) {
      this.emit('overheating', {
        deviceId: device.id,
        temperature: device.temperature,
        limit: this.options.temperatureLimit
      });
      
      // Stop device if too hot
      const worker = this.workers.get(device.id);
      if (worker) {
        worker.stop();
        device.status = 'error';
      }
    }
  }

  /**
   * Restart device
   */
  private async restartDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    
    // Wait before restart
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (!this.isRunning) return;
    
    const worker = this.workers.get(deviceId);
    if (worker) {
      try {
        await worker.restart();
        device.status = 'mining';
        this.emit('deviceRestarted', { deviceId });
      } catch (error) {
        this.emit('error', { deviceId, error });
      }
    }
  }
}

/**
 * ASIC Worker - handles communication with a single ASIC
 */
class ASICWorker extends EventEmitter {
  private device: ASICDevice;
  private connection?: net.Socket | SerialPort;
  private isRunning = false;
  private statsInterval?: NodeJS.Timer;

  constructor(device: ASICDevice) {
    super();
    this.device = device;
  }

  async start(poolUrl: string, username: string, password: string): Promise<void> {
    this.isRunning = true;
    
    // Connect to device
    await this.connect();
    
    // Configure mining
    await this.configureMining(poolUrl, username, password);
    
    // Start mining
    await this.sendCommand({ command: 'enable' });
    
    // Start monitoring
    this.startMonitoring();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }
    
    // Stop mining
    await this.sendCommand({ command: 'disable' });
    
    // Close connection
    if (this.connection) {
      if ('close' in this.connection) {
        this.connection.close();
      } else {
        this.connection.destroy();
      }
      this.connection = undefined;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Re-start would be called by parent
  }

  private async connect(): Promise<void> {
    switch (this.device.connection.type) {
      case 'serial':
        await this.connectSerial();
        break;
      case 'network':
        await this.connectNetwork();
        break;
      default:
        throw new Error(`Unsupported connection type: ${this.device.connection.type}`);
    }
  }

  private async connectSerial(): Promise<void> {
    const port = new SerialPort(this.device.connection.path!, {
      baudRate: 115200
    });
    
    await new Promise((resolve, reject) => {
      port.on('open', resolve);
      port.on('error', reject);
    });
    
    this.connection = port;
  }

  private async connectNetwork(): Promise<void> {
    const socket = new net.Socket();
    
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('error', reject);
      
      socket.connect(
        this.device.connection.port!,
        this.device.connection.host!
      );
    });
    
    this.connection = socket;
  }

  private async configureMining(poolUrl: string, username: string, password: string): Promise<void> {
    // Parse pool URL
    const url = new URL(poolUrl);
    
    // Configure pool
    await this.sendCommand({
      command: 'addpool',
      parameter: `${url.href},${username},${password}`
    });
    
    // Set as primary pool
    await this.sendCommand({
      command: 'switchpool',
      parameter: '0'
    });
  }

  private async sendCommand(cmd: any): Promise<any> {
    if (!this.connection) {
      throw new Error('Not connected');
    }
    
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(cmd) + '\n';
      
      if ('write' in this.connection!) {
        this.connection.write(data);
      } else {
        this.connection.write(Buffer.from(data));
      }
      
      // Wait for response
      const handler = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          resolve(response);
        } catch (error) {
          reject(error);
        }
      };
      
      this.connection.once('data', handler);
      
      // Timeout
      setTimeout(() => {
        this.connection?.removeListener('data', handler);
        reject(new Error('Command timeout'));
      }, 5000);
    });
  }

  private startMonitoring(): void {
    this.statsInterval = setInterval(async () => {
      try {
        // Get stats
        const stats = await this.sendCommand({ command: 'stats' });
        
        // Parse hash rate
        const hashRate = this.parseHashRate(stats);
        this.emit('hashrate', hashRate);
        
        // Parse temperature
        const temperature = this.parseTemperature(stats);
        this.emit('temperature', temperature);
        
        // Check for new shares
        const shares = await this.sendCommand({ command: 'shares' });
        // Process shares...
        
      } catch (error) {
        this.emit('error', error);
      }
    }, 5000); // Every 5 seconds
  }

  private parseHashRate(stats: any): number {
    // Parse based on ASIC type
    // This is simplified - real implementation would handle various formats
    return stats['GHS 5s'] || stats['MHS av'] || 0;
  }

  private parseTemperature(stats: any): number {
    // Parse temperature based on ASIC type
    return stats.temp || stats.temp1 || stats.temperature || 0;
  }
}

// Export types
export { ASICDevice, ASICType, ASICConnection };
