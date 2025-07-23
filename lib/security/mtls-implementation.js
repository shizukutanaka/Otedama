const fs = require('fs').promises;
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const forge = require('node-forge');

class MTLSImplementation extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Certificate paths
      certPath: config.certPath || path.join(__dirname, '../../certs'),
      caFile: config.caFile || 'ca.crt',
      serverCertFile: config.serverCertFile || 'server.crt',
      serverKeyFile: config.serverKeyFile || 'server.key',
      clientCertFile: config.clientCertFile || 'client.crt',
      clientKeyFile: config.clientKeyFile || 'client.key',
      
      // Certificate generation
      generateCerts: config.generateCerts || false,
      certOrganization: config.certOrganization || 'Otedama Mining Pool',
      certCountry: config.certCountry || 'US',
      certState: config.certState || 'CA',
      certLocality: config.certLocality || 'San Francisco',
      certValidityDays: config.certValidityDays || 365,
      
      // TLS options
      minVersion: config.minVersion || 'TLSv1.2',
      ciphers: config.ciphers || 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256',
      ecdhCurve: config.ecdhCurve || 'auto',
      honorCipherOrder: config.honorCipherOrder !== false,
      
      // Client certificate validation
      rejectUnauthorized: config.rejectUnauthorized !== false,
      requestCert: config.requestCert !== false,
      checkClientCertificate: config.checkClientCertificate || this.defaultCertificateCheck.bind(this),
      
      // Certificate rotation
      enableRotation: config.enableRotation || false,
      rotationCheckInterval: config.rotationCheckInterval || 3600000, // 1 hour
      certExpiryWarningDays: config.certExpiryWarningDays || 30,
      
      // Revocation checking
      enableOCSP: config.enableOCSP || true,
      enableCRL: config.enableCRL || false,
      crlUrl: config.crlUrl || null,
      
      // Session management
      sessionTimeout: config.sessionTimeout || 300, // 5 minutes
      maxSessions: config.maxSessions || 10000,
      
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000
    };
    
    this.certificates = new Map();
    this.tlsContexts = new Map();
    this.activeSessions = new Map();
    this.revokedCertificates = new Set();
    this.metrics = {
      connectionsTotal: 0,
      connectionsActive: 0,
      handshakesSuccessful: 0,
      handshakesFailed: 0,
      certificatesIssued: 0,
      certificatesRevoked: 0,
      certificatesExpired: 0,
      sessionResumed: 0,
      ocspChecks: 0,
      crlChecks: 0
    };
    
    this.rotationTimer = null;
    this.metricsTimer = null;
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Ensure certificate directory exists
      await fs.mkdir(this.config.certPath, { recursive: true });
      
      // Generate certificates if needed
      if (this.config.generateCerts) {
        await this.generateCertificates();
      }
      
      // Load certificates
      await this.loadCertificates();
      
      // Create TLS contexts
      await this.createTLSContexts();
      
      // Start certificate rotation monitoring
      if (this.config.enableRotation) {
        this.startRotationMonitoring();
      }
      
      // Start metrics collection
      if (this.config.enableMetrics) {
        this.startMetricsCollection();
      }
      
      this.initialized = true;
      this.emit('initialized');
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async generateCertificates() {
    console.log('Generating mTLS certificates...');
    
    try {
      // Generate CA certificate
      const ca = await this.generateCACertificate();
      await this.saveCertificate('ca', ca.cert, ca.key);
      
      // Generate server certificate
      const server = await this.generateServerCertificate(ca);
      await this.saveCertificate('server', server.cert, server.key);
      
      // Generate client certificate template
      const client = await this.generateClientCertificate(ca, 'default-client');
      await this.saveCertificate('client', client.cert, client.key);
      
      this.metrics.certificatesIssued += 3;
      this.emit('certificates_generated');
      
    } catch (error) {
      this.emit('error', { type: 'certificate_generation', error });
      throw error;
    }
  }
  
  async generateCACertificate() {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.generateSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(
      cert.validity.notBefore.getDate() + this.config.certValidityDays * 2
    );
    
    const attrs = [{
      name: 'commonName',
      value: 'Otedama CA'
    }, {
      name: 'countryName',
      value: this.config.certCountry
    }, {
      shortName: 'ST',
      value: this.config.certState
    }, {
      name: 'localityName',
      value: this.config.certLocality
    }, {
      name: 'organizationName',
      value: this.config.certOrganization
    }, {
      shortName: 'OU',
      value: 'Certificate Authority'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true,
      critical: true
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
      critical: true
    }, {
      name: 'subjectKeyIdentifier'
    }]);
    
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }
  
  async generateServerCertificate(ca) {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.generateSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(
      cert.validity.notBefore.getDate() + this.config.certValidityDays
    );
    
    const attrs = [{
      name: 'commonName',
      value: 'otedama.local'
    }, {
      name: 'countryName',
      value: this.config.certCountry
    }, {
      shortName: 'ST',
      value: this.config.certState
    }, {
      name: 'localityName',
      value: this.config.certLocality
    }, {
      name: 'organizationName',
      value: this.config.certOrganization
    }, {
      shortName: 'OU',
      value: 'Mining Pool Server'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(forge.pki.certificateFromPem(ca.cert).subject.attributes);
    
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: false,
      critical: true
    }, {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
      critical: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    }, {
      name: 'subjectAltName',
      altNames: [{
        type: 2, // DNS
        value: 'otedama.local'
      }, {
        type: 2,
        value: '*.otedama.local'
      }, {
        type: 7, // IP
        ip: '127.0.0.1'
      }, {
        type: 7,
        ip: '::1'
      }]
    }, {
      name: 'subjectKeyIdentifier'
    }]);
    
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const caKey = forge.pki.privateKeyFromPem(ca.key);
    cert.sign(caKey, forge.md.sha256.create());
    
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }
  
  async generateClientCertificate(ca, clientId) {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = this.generateSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(
      cert.validity.notBefore.getDate() + this.config.certValidityDays
    );
    
    const attrs = [{
      name: 'commonName',
      value: clientId
    }, {
      name: 'countryName',
      value: this.config.certCountry
    }, {
      shortName: 'ST',
      value: this.config.certState
    }, {
      name: 'localityName',
      value: this.config.certLocality
    }, {
      name: 'organizationName',
      value: this.config.certOrganization
    }, {
      shortName: 'OU',
      value: 'Mining Pool Client'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(forge.pki.certificateFromPem(ca.cert).subject.attributes);
    
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: false,
      critical: true
    }, {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
      critical: true
    }, {
      name: 'extKeyUsage',
      clientAuth: true
    }, {
      name: 'subjectKeyIdentifier'
    }]);
    
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const caKey = forge.pki.privateKeyFromPem(ca.key);
    cert.sign(caKey, forge.md.sha256.create());
    
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
      fingerprint: this.calculateFingerprint(cert)
    };
  }
  
  generateSerialNumber() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  calculateFingerprint(cert) {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(
      typeof cert === 'string' ? forge.pki.certificateFromPem(cert) : cert
    )).getBytes();
    return crypto.createHash('sha256').update(der, 'binary').digest('hex');
  }
  
  async saveCertificate(name, cert, key) {
    const certFile = path.join(this.config.certPath, `${name}.crt`);
    const keyFile = path.join(this.config.certPath, `${name}.key`);
    
    await fs.writeFile(certFile, cert, { mode: 0o644 });
    await fs.writeFile(keyFile, key, { mode: 0o600 });
  }
  
  async loadCertificates() {
    try {
      // Load CA certificate
      const caCert = await fs.readFile(
        path.join(this.config.certPath, this.config.caFile),
        'utf8'
      );
      this.certificates.set('ca', { cert: caCert });
      
      // Load server certificate and key
      const serverCert = await fs.readFile(
        path.join(this.config.certPath, this.config.serverCertFile),
        'utf8'
      );
      const serverKey = await fs.readFile(
        path.join(this.config.certPath, this.config.serverKeyFile),
        'utf8'
      );
      this.certificates.set('server', { cert: serverCert, key: serverKey });
      
      // Load client certificate and key (optional)
      try {
        const clientCert = await fs.readFile(
          path.join(this.config.certPath, this.config.clientCertFile),
          'utf8'
        );
        const clientKey = await fs.readFile(
          path.join(this.config.certPath, this.config.clientKeyFile),
          'utf8'
        );
        this.certificates.set('client', { cert: clientCert, key: clientKey });
      } catch (error) {
        // Client certificate is optional
      }
      
      this.emit('certificates_loaded');
      
    } catch (error) {
      this.emit('error', { type: 'certificate_loading', error });
      throw error;
    }
  }
  
  async createTLSContexts() {
    // Server TLS options
    const serverOptions = {
      ca: this.certificates.get('ca').cert,
      cert: this.certificates.get('server').cert,
      key: this.certificates.get('server').key,
      minVersion: this.config.minVersion,
      ciphers: this.config.ciphers,
      ecdhCurve: this.config.ecdhCurve,
      honorCipherOrder: this.config.honorCipherOrder,
      requestCert: this.config.requestCert,
      rejectUnauthorized: this.config.rejectUnauthorized,
      sessionTimeout: this.config.sessionTimeout
    };
    
    // Add SNI callback for multiple domains
    serverOptions.SNICallback = (servername, callback) => {
      const ctx = this.getSNIContext(servername);
      callback(null, ctx);
    };
    
    this.tlsContexts.set('server', tls.createSecureContext(serverOptions));
    
    // Client TLS options
    if (this.certificates.has('client')) {
      const clientOptions = {
        ca: this.certificates.get('ca').cert,
        cert: this.certificates.get('client').cert,
        key: this.certificates.get('client').key,
        minVersion: this.config.minVersion,
        ciphers: this.config.ciphers,
        ecdhCurve: this.config.ecdhCurve,
        rejectUnauthorized: this.config.rejectUnauthorized
      };
      
      this.tlsContexts.set('client', tls.createSecureContext(clientOptions));
    }
  }
  
  getSNIContext(servername) {
    // Check if we have a specific certificate for this servername
    const cert = this.certificates.get(`server-${servername}`);
    if (cert) {
      return tls.createSecureContext({
        ca: this.certificates.get('ca').cert,
        cert: cert.cert,
        key: cert.key
      });
    }
    
    // Return default context
    return this.tlsContexts.get('server');
  }
  
  getServerOptions() {
    if (!this.initialized) {
      throw new Error('mTLS not initialized');
    }
    
    return {
      ca: this.certificates.get('ca').cert,
      cert: this.certificates.get('server').cert,
      key: this.certificates.get('server').key,
      minVersion: this.config.minVersion,
      ciphers: this.config.ciphers,
      ecdhCurve: this.config.ecdhCurve,
      honorCipherOrder: this.config.honorCipherOrder,
      requestCert: this.config.requestCert,
      rejectUnauthorized: this.config.rejectUnauthorized,
      sessionTimeout: this.config.sessionTimeout,
      SNICallback: (servername, callback) => {
        const ctx = this.getSNIContext(servername);
        callback(null, ctx);
      }
    };
  }
  
  getClientOptions(clientId) {
    if (!this.initialized) {
      throw new Error('mTLS not initialized');
    }
    
    const clientCert = this.certificates.get(`client-${clientId}`) || this.certificates.get('client');
    if (!clientCert) {
      throw new Error('Client certificate not found');
    }
    
    return {
      ca: this.certificates.get('ca').cert,
      cert: clientCert.cert,
      key: clientCert.key,
      minVersion: this.config.minVersion,
      ciphers: this.config.ciphers,
      ecdhCurve: this.config.ecdhCurve,
      rejectUnauthorized: this.config.rejectUnauthorized,
      checkServerIdentity: this.checkServerIdentity.bind(this)
    };
  }
  
  async verifyClientCertificate(socket) {
    const cert = socket.getPeerCertificate();
    
    if (!cert || Object.keys(cert).length === 0) {
      this.metrics.handshakesFailed++;
      return { valid: false, reason: 'No certificate provided' };
    }
    
    try {
      // Check if certificate is revoked
      if (this.revokedCertificates.has(cert.fingerprint256)) {
        this.metrics.handshakesFailed++;
        return { valid: false, reason: 'Certificate revoked' };
      }
      
      // Check certificate expiry
      const now = Date.now();
      const validFrom = new Date(cert.valid_from).getTime();
      const validTo = new Date(cert.valid_to).getTime();
      
      if (now < validFrom || now > validTo) {
        this.metrics.handshakesFailed++;
        return { valid: false, reason: 'Certificate expired or not yet valid' };
      }
      
      // Check certificate chain
      if (!socket.authorized) {
        this.metrics.handshakesFailed++;
        return { valid: false, reason: socket.authorizationError };
      }
      
      // OCSP checking
      if (this.config.enableOCSP) {
        const ocspValid = await this.checkOCSP(cert);
        if (!ocspValid) {
          this.metrics.handshakesFailed++;
          this.metrics.ocspChecks++;
          return { valid: false, reason: 'OCSP validation failed' };
        }
      }
      
      // CRL checking
      if (this.config.enableCRL && this.config.crlUrl) {
        const crlValid = await this.checkCRL(cert);
        if (!crlValid) {
          this.metrics.handshakesFailed++;
          this.metrics.crlChecks++;
          return { valid: false, reason: 'CRL validation failed' };
        }
      }
      
      // Custom certificate validation
      if (this.config.checkClientCertificate) {
        const customValid = await this.config.checkClientCertificate(cert);
        if (!customValid) {
          this.metrics.handshakesFailed++;
          return { valid: false, reason: 'Custom validation failed' };
        }
      }
      
      // Track session
      this.activeSessions.set(cert.fingerprint256, {
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        fingerprint: cert.fingerprint256,
        connectedAt: new Date(),
        lastActivity: new Date()
      });
      
      this.metrics.handshakesSuccessful++;
      return { valid: true, certificate: cert };
      
    } catch (error) {
      this.metrics.handshakesFailed++;
      this.emit('error', { type: 'certificate_verification', error });
      return { valid: false, reason: error.message };
    }
  }
  
  async checkOCSP(cert) {
    // Simplified OCSP checking - in production, use ocsp module
    try {
      // This is a placeholder - implement actual OCSP checking
      this.metrics.ocspChecks++;
      return true;
    } catch (error) {
      this.emit('error', { type: 'ocsp_check', error });
      return false;
    }
  }
  
  async checkCRL(cert) {
    // Simplified CRL checking - in production, fetch and parse CRL
    try {
      // This is a placeholder - implement actual CRL checking
      this.metrics.crlChecks++;
      return true;
    } catch (error) {
      this.emit('error', { type: 'crl_check', error });
      return false;
    }
  }
  
  checkServerIdentity(hostname, cert) {
    // Custom server identity verification
    try {
      const err = tls.checkServerIdentity(hostname, cert);
      if (err) {
        return err;
      }
      
      // Additional custom checks
      // ...
      
      return undefined;
    } catch (error) {
      return error;
    }
  }
  
  defaultCertificateCheck(cert) {
    // Default certificate validation logic
    return true;
  }
  
  async issueClientCertificate(clientId, metadata = {}) {
    if (!this.initialized) {
      throw new Error('mTLS not initialized');
    }
    
    try {
      const ca = {
        cert: this.certificates.get('ca').cert,
        key: await fs.readFile(
          path.join(this.config.certPath, `ca.key`),
          'utf8'
        )
      };
      
      const client = await this.generateClientCertificate(ca, clientId);
      
      // Save certificate
      await this.saveCertificate(`client-${clientId}`, client.cert, client.key);
      
      // Store in memory
      this.certificates.set(`client-${clientId}`, {
        cert: client.cert,
        key: client.key,
        metadata,
        issuedAt: new Date(),
        fingerprint: client.fingerprint
      });
      
      this.metrics.certificatesIssued++;
      this.emit('certificate_issued', { clientId, fingerprint: client.fingerprint });
      
      return {
        certificate: client.cert,
        privateKey: client.key,
        fingerprint: client.fingerprint
      };
      
    } catch (error) {
      this.emit('error', { type: 'certificate_issuance', error });
      throw error;
    }
  }
  
  async revokeCertificate(fingerprint, reason = 'unspecified') {
    if (!this.initialized) {
      throw new Error('mTLS not initialized');
    }
    
    this.revokedCertificates.add(fingerprint);
    
    // Disconnect any active sessions using this certificate
    const session = this.activeSessions.get(fingerprint);
    if (session) {
      this.activeSessions.delete(fingerprint);
      this.emit('session_revoked', { fingerprint, session });
    }
    
    this.metrics.certificatesRevoked++;
    this.emit('certificate_revoked', { fingerprint, reason });
    
    // Update CRL if enabled
    if (this.config.enableCRL) {
      await this.updateCRL(fingerprint, reason);
    }
  }
  
  async updateCRL(fingerprint, reason) {
    // Placeholder for CRL update logic
    // In production, maintain and publish a proper CRL
  }
  
  startRotationMonitoring() {
    this.rotationTimer = setInterval(async () => {
      await this.checkCertificateExpiry();
    }, this.config.rotationCheckInterval);
  }
  
  async checkCertificateExpiry() {
    const now = Date.now();
    const warningThreshold = this.config.certExpiryWarningDays * 24 * 60 * 60 * 1000;
    
    for (const [name, cert] of this.certificates) {
      if (!cert.cert) continue;
      
      try {
        const parsed = forge.pki.certificateFromPem(cert.cert);
        const validTo = parsed.validity.notAfter.getTime();
        const timeUntilExpiry = validTo - now;
        
        if (timeUntilExpiry < 0) {
          this.metrics.certificatesExpired++;
          this.emit('certificate_expired', { name, validTo: parsed.validity.notAfter });
        } else if (timeUntilExpiry < warningThreshold) {
          const daysUntilExpiry = Math.floor(timeUntilExpiry / (24 * 60 * 60 * 1000));
          this.emit('certificate_expiry_warning', { name, daysUntilExpiry });
        }
      } catch (error) {
        this.emit('error', { type: 'certificate_expiry_check', error });
      }
    }
  }
  
  startMetricsCollection() {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
    }, this.config.metricsInterval);
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      activeSessions: this.activeSessions.size,
      revokedCertificates: this.revokedCertificates.size,
      loadedCertificates: this.certificates.size,
      timestamp: new Date()
    };
  }
  
  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }
  
  updateSessionActivity(fingerprint) {
    const session = this.activeSessions.get(fingerprint);
    if (session) {
      session.lastActivity = new Date();
    }
  }
  
  cleanupInactiveSessions() {
    const now = Date.now();
    const timeout = this.config.sessionTimeout * 1000;
    
    for (const [fingerprint, session] of this.activeSessions) {
      if (now - session.lastActivity.getTime() > timeout) {
        this.activeSessions.delete(fingerprint);
        this.emit('session_timeout', { fingerprint, session });
      }
    }
  }
  
  async exportCertificate(name, format = 'pem') {
    const cert = this.certificates.get(name);
    if (!cert) {
      throw new Error(`Certificate ${name} not found`);
    }
    
    if (format === 'pem') {
      return cert.cert;
    } else if (format === 'der') {
      const parsed = forge.pki.certificateFromPem(cert.cert);
      return forge.asn1.toDer(forge.pki.certificateToAsn1(parsed)).getBytes();
    } else if (format === 'p12' && cert.key) {
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
        forge.pki.privateKeyFromPem(cert.key),
        [forge.pki.certificateFromPem(cert.cert)],
        'password',
        { algorithm: '3des' }
      );
      return forge.asn1.toDer(p12Asn1).getBytes();
    } else {
      throw new Error(`Unsupported format: ${format}`);
    }
  }
  
  async importCertificate(name, data, format = 'pem', key = null) {
    try {
      let cert, privateKey;
      
      if (format === 'pem') {
        cert = data;
        privateKey = key;
      } else if (format === 'der') {
        const parsed = forge.pki.certificateFromAsn1(
          forge.asn1.fromDer(forge.util.createBuffer(data))
        );
        cert = forge.pki.certificateToPem(parsed);
        privateKey = key;
      } else if (format === 'p12') {
        const p12Der = forge.util.createBuffer(data);
        const p12Asn1 = forge.asn1.fromDer(p12Der);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, 'password');
        
        // Extract certificate and key
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        
        cert = forge.pki.certificateToPem(certBags[forge.pki.oids.certBag][0].cert);
        privateKey = forge.pki.privateKeyToPem(keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key);
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }
      
      this.certificates.set(name, { cert, key: privateKey });
      this.emit('certificate_imported', { name });
      
    } catch (error) {
      this.emit('error', { type: 'certificate_import', error });
      throw error;
    }
  }
  
  async destroy() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    this.certificates.clear();
    this.tlsContexts.clear();
    this.activeSessions.clear();
    this.revokedCertificates.clear();
    
    this.initialized = false;
    this.emit('destroyed');
  }
}

module.exports = MTLSImplementation;