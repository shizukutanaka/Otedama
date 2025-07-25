/**
 * Enhanced TLS Configuration
 * Implements best practices for SSL/TLS security
 */

const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class EnhancedTLSConfig {
    constructor(config = {}) {
        this.config = {
            // TLS Version
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.3',
            
            // Cipher Suites (TLS 1.3 + strong TLS 1.2 ciphers)
            ciphers: [
                // TLS 1.3 ciphers
                'TLS_AES_256_GCM_SHA384',
                'TLS_CHACHA20_POLY1305_SHA256',
                'TLS_AES_128_GCM_SHA256',
                // TLS 1.2 ciphers (ECDHE for forward secrecy)
                'ECDHE-RSA-AES256-GCM-SHA384',
                'ECDHE-RSA-CHACHA20-POLY1305',
                'ECDHE-RSA-AES128-GCM-SHA256',
                'ECDHE-ECDSA-AES256-GCM-SHA384',
                'ECDHE-ECDSA-CHACHA20-POLY1305',
                'ECDHE-ECDSA-AES128-GCM-SHA256'
            ].join(':'),
            
            // Elliptic curves
            ecdhCurve: 'auto',
            
            // Certificate options
            honorCipherOrder: true,
            requestCert: true,
            rejectUnauthorized: true,
            
            // Session configuration
            sessionIdContext: crypto.randomBytes(32).toString('hex'),
            sessionTimeout: 300, // 5 minutes
            
            // OCSP Stapling
            requestOCSP: true,
            
            // SNI (Server Name Indication)
            servername: config.servername || 'otedama.local',
            
            // ALPN (Application-Layer Protocol Negotiation)
            ALPNProtocols: ['h2', 'http/1.1'],
            
            // DH Parameters
            dhparam: config.dhparam || null,
            
            ...config
        };
        
        this.securityHeaders = {
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'X-XSS-Protection': '1; mode=block',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
        };
    }
    
    /**
     * Get server TLS options
     */
    async getServerOptions(certPath) {
        const options = {
            // Certificate and key
            cert: await fs.readFile(path.join(certPath, 'server.crt'), 'utf8'),
            key: await fs.readFile(path.join(certPath, 'server.key'), 'utf8'),
            ca: await fs.readFile(path.join(certPath, 'ca.crt'), 'utf8'),
            
            // TLS versions
            minVersion: this.config.minVersion,
            maxVersion: this.config.maxVersion,
            
            // Ciphers
            ciphers: this.config.ciphers,
            honorCipherOrder: this.config.honorCipherOrder,
            ecdhCurve: this.config.ecdhCurve,
            
            // Client certificates
            requestCert: this.config.requestCert,
            rejectUnauthorized: this.config.rejectUnauthorized,
            
            // Session
            sessionIdContext: this.config.sessionIdContext,
            sessionTimeout: this.config.sessionTimeout,
            
            // ALPN
            ALPNProtocols: this.config.ALPNProtocols,
            
            // Security callbacks
            checkServerIdentity: this.checkServerIdentity.bind(this),
            
            // SNI callback
            SNICallback: this.sniCallback.bind(this)
        };
        
        // Add DH parameters if available
        if (this.config.dhparam) {
            options.dhparam = await fs.readFile(this.config.dhparam, 'utf8');
        }
        
        return options;
    }
    
    /**
     * Get client TLS options
     */
    async getClientOptions(certPath, clientId = 'default') {
        return {
            // Certificate and key
            cert: await fs.readFile(path.join(certPath, `client-${clientId}.crt`), 'utf8'),
            key: await fs.readFile(path.join(certPath, `client-${clientId}.key`), 'utf8'),
            ca: await fs.readFile(path.join(certPath, 'ca.crt'), 'utf8'),
            
            // TLS versions
            minVersion: this.config.minVersion,
            maxVersion: this.config.maxVersion,
            
            // Ciphers
            ciphers: this.config.ciphers,
            ecdhCurve: this.config.ecdhCurve,
            
            // Server verification
            rejectUnauthorized: this.config.rejectUnauthorized,
            servername: this.config.servername,
            
            // ALPN
            ALPNProtocols: this.config.ALPNProtocols,
            
            // Security callbacks
            checkServerIdentity: this.checkServerIdentity.bind(this)
        };
    }
    
    /**
     * SNI callback for multiple domains
     */
    async sniCallback(servername, callback) {
        try {
            // Load appropriate certificate based on servername
            const ctx = tls.createSecureContext({
                cert: await this.getCertificateForDomain(servername),
                key: await this.getKeyForDomain(servername)
            });
            
            callback(null, ctx);
        } catch (error) {
            callback(error);
        }
    }
    
    /**
     * Check server identity
     */
    checkServerIdentity(hostname, cert) {
        // Perform standard check
        const err = tls.checkServerIdentity(hostname, cert);
        if (err) return err;
        
        // Additional checks
        const now = Date.now();
        const notBefore = new Date(cert.valid_from).getTime();
        const notAfter = new Date(cert.valid_to).getTime();
        
        if (now < notBefore) {
            return new Error('Certificate not yet valid');
        }
        
        if (now > notAfter) {
            return new Error('Certificate has expired');
        }
        
        // Check key strength
        if (cert.bits < 2048) {
            return new Error('Certificate key too weak');
        }
        
        return undefined;
    }
    
    /**
     * Generate DH parameters
     */
    async generateDHParams(bits = 2048) {
        const { DiffieHellman } = crypto.constants;
        const dh = crypto.createDiffieHellman(bits);
        
        return {
            prime: dh.getPrime(),
            generator: dh.getGenerator()
        };
    }
    
    /**
     * Create secure context with additional options
     */
    createSecureContext(options) {
        const ctx = tls.createSecureContext(options);
        
        // Set additional options if available
        if (ctx.setTicketKeys) {
            // Set session ticket keys for better forward secrecy
            const keys = crypto.randomBytes(48);
            ctx.setTicketKeys(keys);
        }
        
        return ctx;
    }
    
    /**
     * Middleware for Express to add security headers
     */
    securityHeadersMiddleware() {
        return (req, res, next) => {
            // Add security headers
            Object.entries(this.securityHeaders).forEach(([header, value]) => {
                res.setHeader(header, value);
            });
            
            // Add certificate pinning if using HTTPS
            if (req.secure) {
                const pins = this.getCertificatePins();
                if (pins.length > 0) {
                    res.setHeader(
                        'Public-Key-Pins',
                        `${pins.map(pin => `pin-sha256="${pin}"`).join('; ')}; max-age=5184000; includeSubDomains`
                    );
                }
            }
            
            next();
        };
    }
    
    /**
     * Get certificate pins for HPKP
     */
    getCertificatePins() {
        // In production, calculate actual pins from certificates
        return [
            // Primary pin
            'base64+primary==',
            // Backup pin
            'base64+backup=='
        ];
    }
    
    /**
     * Validate TLS connection
     */
    validateConnection(socket) {
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();
        
        // Check protocol version
        if (protocol < this.config.minVersion) {
            return {
                valid: false,
                reason: 'Protocol version too old'
            };
        }
        
        // Check cipher strength
        if (!this.isStrongCipher(cipher.name)) {
            return {
                valid: false,
                reason: 'Weak cipher suite'
            };
        }
        
        // Check certificate
        if (socket.authorized === false) {
            return {
                valid: false,
                reason: socket.authorizationError
            };
        }
        
        return {
            valid: true,
            protocol,
            cipher: cipher.name,
            version: cipher.version
        };
    }
    
    /**
     * Check if cipher is strong
     */
    isStrongCipher(cipherName) {
        const weakCiphers = [
            'RC4', 'DES', '3DES', 'MD5', 'CBC'
        ];
        
        return !weakCiphers.some(weak => cipherName.includes(weak));
    }
    
    /**
     * Get certificate for specific domain
     */
    async getCertificateForDomain(domain) {
        // Implementation would load domain-specific certificate
        const certPath = path.join(this.config.certPath, `${domain}.crt`);
        try {
            return await fs.readFile(certPath, 'utf8');
        } catch (error) {
            // Fall back to default certificate
            return await fs.readFile(path.join(this.config.certPath, 'server.crt'), 'utf8');
        }
    }
    
    /**
     * Get key for specific domain
     */
    async getKeyForDomain(domain) {
        // Implementation would load domain-specific key
        const keyPath = path.join(this.config.certPath, `${domain}.key`);
        try {
            return await fs.readFile(keyPath, 'utf8');
        } catch (error) {
            // Fall back to default key
            return await fs.readFile(path.join(this.config.certPath, 'server.key'), 'utf8');
        }
    }
    
    /**
     * Monitor TLS connections
     */
    monitorConnection(socket) {
        const startTime = Date.now();
        const info = {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            protocol: socket.getProtocol(),
            cipher: socket.getCipher(),
            peerCertificate: socket.getPeerCertificate(),
            authorized: socket.authorized
        };
        
        socket.on('close', () => {
            info.duration = Date.now() - startTime;
            info.bytesRead = socket.bytesRead;
            info.bytesWritten = socket.bytesWritten;
            
            // Log connection info
            this.logConnection(info);
        });
        
        return info;
    }
    
    /**
     * Log TLS connection details
     */
    logConnection(info) {
        // Implementation would log to secure audit log
        console.log('TLS Connection:', {
            timestamp: new Date().toISOString(),
            ...info
        });
    }
}

module.exports = EnhancedTLSConfig;