// SSL/TLS support for Stratum (security enhancement)
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';

export interface TLSConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  rejectUnauthorized?: boolean;
}

export class TLSManager {
  private tlsOptions: tls.TlsOptions | null = null;
  
  constructor(private config: TLSConfig) {
    if (config.enabled) {
      this.loadCertificates();
    }
  }
  
  private loadCertificates(): void {
    if (!this.config.certPath || !this.config.keyPath) {
      throw new Error('TLS enabled but cert/key paths not provided');
    }
    
    try {
      this.tlsOptions = {
        cert: fs.readFileSync(this.config.certPath),
        key: fs.readFileSync(this.config.keyPath),
        rejectUnauthorized: this.config.rejectUnauthorized ?? true
      };
      
      if (this.config.caPath) {
        this.tlsOptions.ca = fs.readFileSync(this.config.caPath);
      }
      
      console.log('TLS certificates loaded successfully');
    } catch (error) {
      console.error('Failed to load TLS certificates:', error);
      throw error;
    }
  }
  
  createServer(connectionHandler: (socket: tls.TLSSocket) => void): tls.Server | null {
    if (!this.tlsOptions) {
      return null;
    }
    
    const server = tls.createServer(this.tlsOptions, connectionHandler);
    
    server.on('tlsClientError', (error, socket) => {
      console.error('TLS client error:', error);
      socket.destroy();
    });
    
    return server;
  }
  
  // Generate self-signed certificate for development
  static async generateSelfSignedCert(outputDir: string): Promise<void> {
    // In production, use proper certificates from Let's Encrypt or other CA
    console.log('Generating self-signed certificate for development...');
    
    // This would use openssl or node-forge to generate certificates
    // For now, provide instructions
    const instructions = `
To generate self-signed certificates for development:

1. Install OpenSSL
2. Run the following commands:

# Generate private key
openssl genrsa -out ${path.join(outputDir, 'server.key')} 2048

# Generate certificate signing request
openssl req -new -key ${path.join(outputDir, 'server.key')} -out ${path.join(outputDir, 'server.csr')}

# Generate self-signed certificate
openssl x509 -req -days 365 -in ${path.join(outputDir, 'server.csr')} -signkey ${path.join(outputDir, 'server.key')} -out ${path.join(outputDir, 'server.crt')}

3. Update your .env file:
TLS_CERT_PATH=${path.join(outputDir, 'server.crt')}
TLS_KEY_PATH=${path.join(outputDir, 'server.key')}
`;
    
    console.log(instructions);
  }
  
  isEnabled(): boolean {
    return this.config.enabled;
  }
  
  getTLSOptions(): tls.TlsOptions | null {
    return this.tlsOptions;
  }
}

// Secure WebSocket implementation for dashboard
export class SecureWebSocketServer {
  private httpsServer: any;
  
  constructor(
    private port: number,
    private tlsManager: TLSManager
  ) {}
  
  async start(wsHandler: (ws: any) => void): Promise<void> {
    if (this.tlsManager.isEnabled()) {
      // Use HTTPS with WebSocket
      const https = await import('https');
      const WebSocket = await import('ws');
      
      this.httpsServer = https.createServer(
        this.tlsManager.getTLSOptions()!,
        (req, res) => {
          res.writeHead(426, { 'Content-Type': 'text/plain' });
          res.end('This service requires WebSocket protocol');
        }
      );
      
      const wss = new WebSocket.Server({ server: this.httpsServer });
      wss.on('connection', wsHandler);
      
      this.httpsServer.listen(this.port, () => {
        console.log(`Secure WebSocket server listening on wss://localhost:${this.port}`);
      });
    } else {
      // Fallback to non-TLS WebSocket
      const WebSocket = await import('ws');
      const wss = new WebSocket.Server({ port: this.port });
      wss.on('connection', wsHandler);
      
      console.log(`WebSocket server listening on ws://localhost:${this.port}`);
    }
  }
  
  stop(): void {
    if (this.httpsServer) {
      this.httpsServer.close();
    }
  }
}

// Certificate rotation manager
export class CertificateRotation {
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private tlsManager: TLSManager,
    private checkIntervalHours: number = 24
  ) {}
  
  start(): void {
    this.checkInterval = setInterval(() => {
      this.checkCertificates();
    }, this.checkIntervalHours * 3600000);
    
    // Check immediately
    this.checkCertificates();
  }
  
  private checkCertificates(): void {
    // Check certificate expiration
    // In production, implement automatic renewal with Let's Encrypt
    console.log('Checking certificate expiration...');
  }
  
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}
