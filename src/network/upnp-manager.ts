/**
 * UPnP対応実装
 * 自動ポート開放とネットワーク設定
 * 
 * 設計思想：
 * - Carmack: 効率的なネットワーク自動設定
 * - Martin: 標準プロトコルの適切な実装
 * - Pike: シンプルで信頼性の高いポート管理
 */

import { EventEmitter } from 'events';
import * as dgram from 'dgram';
import * as http from 'http';
import * as xml2js from 'xml2js';
import { URL } from 'url';

// === 型定義 ===
export interface UPnPConfig {
  // 基本設定
  discoveryTimeout: number;         // 探索タイムアウト（ms）
  requestTimeout: number;           // リクエストタイムアウト（ms）
  maxRetries: number;              // 最大リトライ回数
  
  // ポート設定
  externalPort?: number;           // 外部ポート（未指定時は内部と同じ）
  protocol: 'TCP' | 'UDP' | 'BOTH'; // プロトコル
  description: string;             // ポートマッピングの説明
  
  // リース設定
  leaseDuration: number;           // リース期間（秒、0=無期限）
  autoRenew: boolean;              // 自動更新
  renewInterval?: number;          // 更新間隔（秒）
}

export interface IGDevice {
  // デバイス情報
  deviceType: string;
  friendlyName: string;
  manufacturer: string;
  modelName: string;
  UDN: string;                     // Unique Device Name
  
  // ネットワーク情報
  location: string;                // デバイスのURL
  serviceUrl: string;              // WANIPConnectionサービスURL
  controlUrl: string;              // コントロールURL
  
  // 状態
  available: boolean;
  lastSeen: number;
}

export interface PortMapping {
  // マッピング情報
  protocol: 'TCP' | 'UDP';
  externalPort: number;
  internalPort: number;
  internalClient: string;
  description: string;
  enabled: boolean;
  
  // リース情報
  leaseDuration: number;
  createdAt: number;
  expiresAt?: number;
}

export interface NetworkStatus {
  externalIP: string;
  connectionStatus: string;
  uptime: number;
  bytesReceived: number;
  bytesSent: number;
  packetsReceived: number;
  packetsSent: number;
}

// SSDP (Simple Service Discovery Protocol) メッセージ
const SSDP_SEARCH = 
`M-SEARCH * HTTP/1.1\r
HOST: 239.255.255.250:1900\r
MAN: "ssdp:discover"\r
MX: 3\r
ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r
\r
`;

// === UPnPマネージャー ===
export class UPnPManager extends EventEmitter {
  private config: UPnPConfig;
  private devices: Map<string, IGDevice> = new Map();
  private portMappings: Map<string, PortMapping> = new Map();
  private selectedDevice?: IGDevice;
  private renewTimer?: NodeJS.Timeout;
  private discoverySocket?: dgram.Socket;
  
  // 統計情報
  private statistics = {
    devicesDiscovered: 0,
    portMappingsCreated: 0,
    portMappingsDeleted: 0,
    renewalCount: 0,
    failedOperations: 0
  };
  
  constructor(config: UPnPConfig) {
    super();
    this.config = config;
  }
  
  // UPnPの開始
  async start(): Promise<void> {
    try {
      // デバイスの探索
      await this.discoverDevices();
      
      // デバイスの選択
      if (this.devices.size > 0) {
        this.selectedDevice = this.selectBestDevice();
        
        if (this.selectedDevice) {
          // 自動更新の開始
          if (this.config.autoRenew) {
            this.startAutoRenewal();
          }
          
          this.emit('deviceSelected', this.selectedDevice);
        }
      }
      
      this.emit('started', {
        devicesFound: this.devices.size,
        selectedDevice: this.selectedDevice?.friendlyName
      });
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // デバイスの探索
  private async discoverDevices(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.discoverySocket = dgram.createSocket('udp4');
      const devices = new Map<string, IGDevice>();
      
      // タイムアウトの設定
      const timeout = setTimeout(() => {
        this.discoverySocket?.close();
        this.devices = devices;
        this.statistics.devicesDiscovered = devices.size;
        resolve();
      }, this.config.discoveryTimeout);
      
      // レスポンスハンドラー
      this.discoverySocket.on('message', async (msg, rinfo) => {
        try {
          const device = await this.parseSSDPResponse(msg.toString(), rinfo);
          if (device && !devices.has(device.UDN)) {
            devices.set(device.UDN, device);
            this.emit('deviceDiscovered', device);
          }
        } catch (error) {
          // 個別のエラーは無視
        }
      });
      
      this.discoverySocket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      
      // M-SEARCHメッセージの送信
      this.discoverySocket.send(
        Buffer.from(SSDP_SEARCH),
        1900,
        '239.255.255.250',
        (err) => {
          if (err) {
            clearTimeout(timeout);
            reject(err);
          }
        }
      );
    });
  }
  
  // SSDPレスポンスの解析
  private async parseSSDPResponse(
    response: string,
    rinfo: dgram.RemoteInfo
  ): Promise<IGDevice | null> {
    const lines = response.split('\r\n');
    const headers: { [key: string]: string } = {};
    
    // ヘッダーの解析
    for (const line of lines) {
      const [key, value] = line.split(': ', 2);
      if (key && value) {
        headers[key.toUpperCase()] = value;
      }
    }
    
    const location = headers['LOCATION'];
    if (!location) return null;
    
    // デバイス記述の取得
    try {
      const deviceDesc = await this.fetchDeviceDescription(location);
      return this.parseDeviceDescription(deviceDesc, location);
    } catch (error) {
      return null;
    }
  }
  
  // デバイス記述の取得
  private async fetchDeviceDescription(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = http.get(url, { timeout: this.config.requestTimeout }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve(data);
        });
      });
      
      request.on('error', reject);
      request.on('timeout', () => {
        request.abort();
        reject(new Error('Request timeout'));
      });
    });
  }
  
  // デバイス記述の解析
  private async parseDeviceDescription(
    xml: string,
    location: string
  ): Promise<IGDevice | null> {
    try {
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(xml);
      
      const device = result.root?.device?.[0];
      if (!device) return null;
      
      // WANIPConnectionサービスを探す
      const service = this.findWANIPConnection(result);
      if (!service) return null;
      
      const baseUrl = new URL(location);
      const controlUrl = this.resolveUrl(service.controlURL[0], baseUrl);
      
      return {
        deviceType: device.deviceType?.[0] || '',
        friendlyName: device.friendlyName?.[0] || '',
        manufacturer: device.manufacturer?.[0] || '',
        modelName: device.modelName?.[0] || '',
        UDN: device.UDN?.[0] || '',
        location,
        serviceUrl: service.serviceType[0],
        controlUrl,
        available: true,
        lastSeen: Date.now()
      };
      
    } catch (error) {
      return null;
    }
  }
  
  // WANIPConnectionサービスの検索
  private findWANIPConnection(deviceDesc: any): any {
    const searchService = (device: any): any => {
      // サービスリストをチェック
      if (device.serviceList?.[0]?.service) {
        for (const service of device.serviceList[0].service) {
          const serviceType = service.serviceType?.[0] || '';
          if (serviceType.includes('WANIPConnection') || 
              serviceType.includes('WANPPPConnection')) {
            return service;
          }
        }
      }
      
      // 子デバイスを再帰的に検索
      if (device.deviceList?.[0]?.device) {
        for (const childDevice of device.deviceList[0].device) {
          const found = searchService(childDevice);
          if (found) return found;
        }
      }
      
      return null;
    };
    
    return searchService(deviceDesc.root?.device?.[0]);
  }
  
  // URLの解決
  private resolveUrl(path: string, baseUrl: URL): string {
    if (path.startsWith('http')) {
      return path;
    } else if (path.startsWith('/')) {
      return `${baseUrl.protocol}//${baseUrl.host}${path}`;
    } else {
      const basePath = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/'));
      return `${baseUrl.protocol}//${baseUrl.host}${basePath}/${path}`;
    }
  }
  
  // 最適なデバイスの選択
  private selectBestDevice(): IGDevice | undefined {
    // 利用可能なデバイスから最初のものを選択（簡略化）
    // 実際には、より高度な選択ロジックを実装可能
    return Array.from(this.devices.values())
      .find(device => device.available);
  }
  
  // ポートマッピングの追加
  async addPortMapping(
    internalPort: number,
    externalPort?: number,
    protocol?: 'TCP' | 'UDP'
  ): Promise<PortMapping> {
    if (!this.selectedDevice) {
      throw new Error('No UPnP device selected');
    }
    
    const mapping: PortMapping = {
      protocol: protocol || this.config.protocol === 'BOTH' ? 'TCP' : this.config.protocol,
      externalPort: externalPort || this.config.externalPort || internalPort,
      internalPort,
      internalClient: await this.getInternalIP(),
      description: this.config.description,
      enabled: true,
      leaseDuration: this.config.leaseDuration,
      createdAt: Date.now(),
      expiresAt: this.config.leaseDuration > 0 ? 
        Date.now() + this.config.leaseDuration * 1000 : undefined
    };
    
    // SOAPリクエストの送信
    await this.sendSOAPRequest('AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: mapping.externalPort,
      NewProtocol: mapping.protocol,
      NewInternalPort: mapping.internalPort,
      NewInternalClient: mapping.internalClient,
      NewEnabled: 1,
      NewPortMappingDescription: mapping.description,
      NewLeaseDuration: mapping.leaseDuration
    });
    
    // マッピングの保存
    const key = `${mapping.protocol}:${mapping.externalPort}`;
    this.portMappings.set(key, mapping);
    this.statistics.portMappingsCreated++;
    
    this.emit('portMappingAdded', mapping);
    
    return mapping;
  }
  
  // ポートマッピングの削除
  async deletePortMapping(
    externalPort: number,
    protocol: 'TCP' | 'UDP'
  ): Promise<void> {
    if (!this.selectedDevice) {
      throw new Error('No UPnP device selected');
    }
    
    // SOAPリクエストの送信
    await this.sendSOAPRequest('DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: externalPort,
      NewProtocol: protocol
    });
    
    // マッピングの削除
    const key = `${protocol}:${externalPort}`;
    const mapping = this.portMappings.get(key);
    if (mapping) {
      this.portMappings.delete(key);
      this.statistics.portMappingsDeleted++;
      this.emit('portMappingDeleted', mapping);
    }
  }
  
  // すべてのポートマッピングを取得
  async getPortMappings(): Promise<PortMapping[]> {
    if (!this.selectedDevice) {
      throw new Error('No UPnP device selected');
    }
    
    const mappings: PortMapping[] = [];
    let index = 0;
    
    while (true) {
      try {
        const response = await this.sendSOAPRequest('GetGenericPortMappingEntry', {
          NewPortMappingIndex: index
        });
        
        const mapping: PortMapping = {
          protocol: response.NewProtocol,
          externalPort: parseInt(response.NewExternalPort),
          internalPort: parseInt(response.NewInternalPort),
          internalClient: response.NewInternalClient,
          description: response.NewPortMappingDescription,
          enabled: response.NewEnabled === '1',
          leaseDuration: parseInt(response.NewLeaseDuration),
          createdAt: 0 // 取得不可
        };
        
        mappings.push(mapping);
        index++;
        
      } catch (error: any) {
        // エラーコード713は「指定されたインデックスに値なし」
        if (error.code === 713) {
          break;
        }
        throw error;
      }
    }
    
    return mappings;
  }
  
  // 外部IPアドレスの取得
  async getExternalIP(): Promise<string> {
    if (!this.selectedDevice) {
      throw new Error('No UPnP device selected');
    }
    
    const response = await this.sendSOAPRequest('GetExternalIPAddress', {});
    return response.NewExternalIPAddress;
  }
  
  // ネットワークステータスの取得
  async getNetworkStatus(): Promise<NetworkStatus> {
    if (!this.selectedDevice) {
      throw new Error('No UPnP device selected');
    }
    
    const [connectionInfo, linkInfo] = await Promise.all([
      this.sendSOAPRequest('GetStatusInfo', {}),
      this.sendSOAPRequest('GetCommonLinkProperties', {}).catch(() => ({}))
    ]);
    
    const statistics = await this.sendSOAPRequest('GetTotalBytesReceived', {})
      .catch(() => ({}));
    
    return {
      externalIP: await this.getExternalIP(),
      connectionStatus: connectionInfo.NewConnectionStatus || 'Unknown',
      uptime: parseInt(connectionInfo.NewUptime || '0'),
      bytesReceived: parseInt(statistics.NewTotalBytesReceived || '0'),
      bytesSent: parseInt(statistics.NewTotalBytesSent || '0'),
      packetsReceived: parseInt(statistics.NewTotalPacketsReceived || '0'),
      packetsSent: parseInt(statistics.NewTotalPacketsSent || '0')
    };
  }
  
  // SOAPリクエストの送信
  private async sendSOAPRequest(
    action: string,
    params: { [key: string]: any }
  ): Promise<any> {
    if (!this.selectedDevice) {
      throw new Error('No device selected');
    }
    
    const serviceType = this.selectedDevice.serviceUrl;
    const soapAction = `"${serviceType}#${action}"`;
    
    // SOAPエンベロープの作成
    const paramString = Object.entries(params)
      .map(([key, value]) => `<${key}>${value}</${key}>`)
      .join('');
    
    const soapBody = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${paramString}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
    
    // HTTPリクエストの送信
    const url = new URL(this.selectedDevice.controlUrl);
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(soapBody),
          'SOAPAction': soapAction
        },
        timeout: this.config.requestTimeout
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', async () => {
          try {
            if (res.statusCode === 200) {
              const result = await this.parseSOAPResponse(data, action);
              resolve(result);
            } else {
              const error = await this.parseSOAPError(data);
              reject(error);
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.abort();
        reject(new Error('SOAP request timeout'));
      });
      
      req.write(soapBody);
      req.end();
    });
  }
  
  // SOAPレスポンスの解析
  private async parseSOAPResponse(xml: string, action: string): Promise<any> {
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);
    
    const body = result['s:Envelope']?.['s:Body']?.[0];
    const response = body?.[`u:${action}Response`]?.[0];
    
    if (!response) {
      throw new Error('Invalid SOAP response');
    }
    
    // レスポンスパラメータを抽出
    const params: any = {};
    for (const [key, value] of Object.entries(response)) {
      if (key !== '$') {
        params[key] = Array.isArray(value) ? value[0] : value;
      }
    }
    
    return params;
  }
  
  // SOAPエラーの解析
  private async parseSOAPError(xml: string): Promise<Error> {
    try {
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(xml);
      
      const fault = result['s:Envelope']?.['s:Body']?.[0]?.['s:Fault']?.[0];
      if (fault) {
        const errorCode = fault.detail?.[0]?.UPnPError?.[0]?.errorCode?.[0];
        const errorDescription = fault.detail?.[0]?.UPnPError?.[0]?.errorDescription?.[0];
        
        const error = new Error(errorDescription || 'SOAP fault');
        (error as any).code = parseInt(errorCode || '0');
        return error;
      }
    } catch (e) {
      // パースエラーは無視
    }
    
    return new Error('Unknown SOAP error');
  }
  
  // 内部IPアドレスの取得
  private async getInternalIP(): Promise<string> {
    const interfaces = require('os').networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    return '0.0.0.0';
  }
  
  // 自動更新の開始
  private startAutoRenewal(): void {
    const interval = this.config.renewInterval || 
      Math.floor(this.config.leaseDuration * 0.5) * 1000;
    
    this.renewTimer = setInterval(() => {
      this.renewPortMappings();
    }, interval);
  }
  
  // ポートマッピングの更新
  private async renewPortMappings(): Promise<void> {
    const now = Date.now();
    
    for (const [key, mapping] of this.portMappings) {
      // 期限が近いマッピングを更新
      if (mapping.expiresAt && mapping.expiresAt - now < 300000) { // 5分前
        try {
          await this.addPortMapping(
            mapping.internalPort,
            mapping.externalPort,
            mapping.protocol
          );
          
          this.statistics.renewalCount++;
          this.emit('portMappingRenewed', mapping);
          
        } catch (error) {
          this.statistics.failedOperations++;
          this.emit('renewalFailed', { mapping, error });
        }
      }
    }
  }
  
  // 公開API
  
  // 利用可能なデバイスのリスト
  getDevices(): IGDevice[] {
    return Array.from(this.devices.values());
  }
  
  // 現在のポートマッピング
  getCurrentMappings(): PortMapping[] {
    return Array.from(this.portMappings.values());
  }
  
  // 統計情報
  getStatistics(): typeof this.statistics {
    return { ...this.statistics };
  }
  
  // デバイスの選択
  selectDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (device) {
      this.selectedDevice = device;
      this.emit('deviceSelected', device);
      return true;
    }
    return false;
  }
  
  // すべてのマッピングをクリア
  async clearAllMappings(): Promise<void> {
    const mappings = Array.from(this.portMappings.values());
    
    for (const mapping of mappings) {
      try {
        await this.deletePortMapping(mapping.externalPort, mapping.protocol);
      } catch (error) {
        // エラーは無視
      }
    }
  }
  
  // 停止
  async stop(): Promise<void> {
    // 自動更新の停止
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
    }
    
    // ディスカバリーソケットのクローズ
    if (this.discoverySocket) {
      this.discoverySocket.close();
    }
    
    // すべてのマッピングを削除（オプション）
    if (this.config.leaseDuration === 0) {
      await this.clearAllMappings();
    }
    
    this.devices.clear();
    this.portMappings.clear();
    
    this.emit('stopped');
  }
}

export default UPnPManager;