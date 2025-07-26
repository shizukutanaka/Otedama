/**
 * Zero-Knowledge Proof Authentication Client - Otedama
 * Client-side library for privacy-preserving authentication
 * 
 * Design Principles:
 * - Carmack: Client-side proof generation for performance
 * - Martin: Clean API for web integration
 * - Pike: Simple authentication flow
 */

class OtedamaZKPClient {
  constructor(apiUrl = '/api/zkp') {
    this.apiUrl = apiUrl;
    this.identity = null;
    this.session = null;
    this.credential = null;
    
    // Secp256k1 parameters (same as server)
    this.p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
    this.n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    this.g = BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798');
  }
  
  /**
   * Generate new identity
   */
  async generateIdentity() {
    try {
      const response = await fetch(`${this.apiUrl}/identity/generate`);
      const data = await response.json();
      
      if (data.success) {
        // Store identity locally
        this.identity = data.identity;
        
        // Save to secure storage
        this.saveIdentity(data.identity);
        
        return data.identity;
      }
      
      throw new Error(data.error || 'Failed to generate identity');
    } catch (error) {
      console.error('Identity generation error:', error);
      throw error;
    }
  }
  
  /**
   * Create zero-knowledge proof client-side
   */
  async createProof(privateKey, challenge) {
    const x = BigInt('0x' + privateKey);
    
    // Generate random nonce
    const r = await this.generateRandomBigInt();
    
    // Compute commitment
    const commitment = this.modExp(this.g, r, this.p);
    
    // Use provided challenge or generate one
    const c = challenge ? BigInt('0x' + challenge) : await this.generateChallenge(commitment);
    
    // Compute response
    const s = (r + c * x) % this.n;
    
    return {
      commitment: commitment.toString(16),
      challenge: c.toString(16),
      response: s.toString(16)
    };
  }
  
  /**
   * Register with the pool
   */
  async register() {
    if (!this.identity) {
      throw new Error('No identity generated');
    }
    
    try {
      // Create proof of identity ownership
      const proof = await this.createProof(this.identity.privateKey);
      
      const response = await fetch(`${this.apiUrl}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          publicKey: this.identity.publicKey,
          proof
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.credential = data.credential;
        this.saveCredential(data.credential);
        return data;
      }
      
      throw new Error(data.error || 'Registration failed');
    } catch (error) {
      console.error('Registration error:', error);
      throw error;
    }
  }
  
  /**
   * Authenticate with the pool
   */
  async authenticate() {
    if (!this.identity || !this.credential) {
      throw new Error('Not registered');
    }
    
    try {
      // Get challenge from server
      const challengeResponse = await fetch(`${this.apiUrl}/challenge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          publicKey: this.identity.publicKey
        })
      });
      
      const challengeData = await challengeResponse.json();
      
      if (!challengeData.success) {
        throw new Error(challengeData.error || 'Failed to get challenge');
      }
      
      // Create proof with challenge
      const proof = await this.createProof(
        this.identity.privateKey,
        challengeData.challenge
      );
      
      // Authenticate
      const authResponse = await fetch(`${this.apiUrl}/authenticate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          credential: this.credential,
          proof
        })
      });
      
      const authData = await authResponse.json();
      
      if (authData.success) {
        this.session = {
          id: authData.sessionId,
          expiresIn: authData.expiresIn,
          expiresAt: Date.now() + (authData.expiresIn * 1000)
        };
        
        this.saveSession(this.session);
        this.startSessionRefresh();
        
        return authData;
      }
      
      throw new Error(authData.error || 'Authentication failed');
    } catch (error) {
      console.error('Authentication error:', error);
      throw error;
    }
  }
  
  /**
   * Make authenticated API request
   */
  async request(endpoint, options = {}) {
    if (!this.session) {
      throw new Error('Not authenticated');
    }
    
    // Check session expiry
    if (Date.now() > this.session.expiresAt - 60000) { // 1 minute buffer
      await this.refreshSession();
    }
    
    const response = await fetch(`${this.apiUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        'X-Session-ID': this.session.id
      }
    });
    
    if (response.status === 401) {
      // Try to re-authenticate
      await this.authenticate();
      
      // Retry request
      return this.request(endpoint, options);
    }
    
    return response;
  }
  
  /**
   * Get miner statistics
   */
  async getStats() {
    const response = await this.request('/stats');
    return response.json();
  }
  
  /**
   * Logout
   */
  async logout() {
    if (!this.session) return;
    
    try {
      await this.request('/logout', { method: 'POST' });
    } finally {
      this.session = null;
      this.clearSession();
    }
  }
  
  /**
   * Load saved identity from storage
   */
  loadIdentity() {
    const stored = localStorage.getItem('otedama_identity');
    if (stored) {
      try {
        this.identity = JSON.parse(stored);
        return true;
      } catch (error) {
        console.error('Failed to load identity:', error);
      }
    }
    return false;
  }
  
  /**
   * Load saved credential
   */
  loadCredential() {
    const stored = localStorage.getItem('otedama_credential');
    if (stored) {
      try {
        this.credential = JSON.parse(stored);
        return true;
      } catch (error) {
        console.error('Failed to load credential:', error);
      }
    }
    return false;
  }
  
  /**
   * Load saved session
   */
  loadSession() {
    const stored = sessionStorage.getItem('otedama_session');
    if (stored) {
      try {
        this.session = JSON.parse(stored);
        
        // Check if expired
        if (Date.now() < this.session.expiresAt) {
          this.startSessionRefresh();
          return true;
        }
      } catch (error) {
        console.error('Failed to load session:', error);
      }
    }
    return false;
  }
  
  /**
   * Initialize from stored data
   */
  async init() {
    this.loadIdentity();
    this.loadCredential();
    
    if (this.loadSession()) {
      // Verify session is still valid
      try {
        const response = await this.request('/session/verify');
        const data = await response.json();
        
        if (data.success) {
          return true;
        }
      } catch (error) {
        console.error('Session verification failed:', error);
      }
    }
    
    // Try to authenticate if we have credentials
    if (this.identity && this.credential) {
      try {
        await this.authenticate();
        return true;
      } catch (error) {
        console.error('Auto-authentication failed:', error);
      }
    }
    
    return false;
  }
  
  /**
   * Utility functions
   */
  
  async generateRandomBigInt() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    
    let hex = '';
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, '0');
    }
    
    const value = BigInt('0x' + hex);
    return value % this.n;
  }
  
  async generateChallenge(commitment) {
    const encoder = new TextEncoder();
    const data = encoder.encode(commitment.toString(16) + Date.now());
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hash);
    
    let hex = '';
    for (const byte of hashArray) {
      hex += byte.toString(16).padStart(2, '0');
    }
    
    return BigInt('0x' + hex);
  }
  
  modExp(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    
    while (exp > 0n) {
      if (exp % 2n === 1n) {
        result = (result * base) % mod;
      }
      exp = exp >> 1n;
      base = (base * base) % mod;
    }
    
    return result;
  }
  
  saveIdentity(identity) {
    // In production, use more secure storage
    localStorage.setItem('otedama_identity', JSON.stringify(identity));
  }
  
  saveCredential(credential) {
    localStorage.setItem('otedama_credential', JSON.stringify(credential));
  }
  
  saveSession(session) {
    sessionStorage.setItem('otedama_session', JSON.stringify(session));
  }
  
  clearSession() {
    sessionStorage.removeItem('otedama_session');
  }
  
  startSessionRefresh() {
    // Refresh session before expiry
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    
    const refreshIn = Math.max(
      0,
      this.session.expiresAt - Date.now() - 300000 // 5 minutes before expiry
    );
    
    this.refreshTimer = setTimeout(() => {
      this.refreshSession();
    }, refreshIn);
  }
  
  async refreshSession() {
    // Re-authenticate to refresh session
    await this.authenticate();
  }
  
  /**
   * WebSocket support
   */
  connectWebSocket(url = '/socket.io/') {
    if (typeof io === 'undefined') {
      throw new Error('Socket.IO not loaded');
    }
    
    this.socket = io(url, {
      auth: {
        sessionId: this.session?.id
      }
    });
    
    this.socket.on('connect', () => {
      console.log('WebSocket connected');
    });
    
    this.socket.on('zkp:authenticated', (data) => {
      console.log('WebSocket authenticated');
    });
    
    this.socket.on('zkp:error', (error) => {
      console.error('WebSocket error:', error);
    });
    
    return this.socket;
  }
}

// Export for various module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OtedamaZKPClient;
} else if (typeof window !== 'undefined') {
  window.OtedamaZKPClient = OtedamaZKPClient;
}