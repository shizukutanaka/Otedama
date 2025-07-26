/**
 * SSL Certificate Generator for Otedama
 * Generate self-signed certificates for development/testing
 * 
 * Design: Practical security tooling (Martin principle)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Generate self-signed SSL certificate
 */
function generateSSLCertificate() {
  const sslDir = path.join(__dirname, '..', 'ssl');
  const keyPath = path.join(sslDir, 'key.pem');
  const certPath = path.join(sslDir, 'cert.pem');
  
  // Create SSL directory if it doesn't exist
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { recursive: true });
  }
  
  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('SSL certificates already exist.');
    console.log(`Key: ${keyPath}`);
    console.log(`Certificate: ${certPath}`);
    
    const answer = process.argv[2];
    if (answer !== '-f' && answer !== '--force') {
      console.log('Use -f or --force to regenerate certificates.');
      return;
    }
    
    console.log('Regenerating certificates...');
  }
  
  try {
    // Check if OpenSSL is available
    try {
      execSync('openssl version', { stdio: 'ignore' });
    } catch (error) {
      console.error('OpenSSL is not installed or not in PATH.');
      console.log('Please install OpenSSL to generate SSL certificates.');
      console.log('Windows: Download from https://slproweb.com/products/Win32OpenSSL.html');
      console.log('Linux: sudo apt-get install openssl');
      console.log('macOS: brew install openssl');
      process.exit(1);
    }
    
    // Generate private key
    console.log('Generating private key...');
    execSync(`openssl genrsa -out "${keyPath}" 2048`, { stdio: 'inherit' });
    
    // Generate certificate signing request
    console.log('Generating certificate...');
    const subject = '/C=US/ST=State/L=City/O=Otedama/CN=localhost';
    execSync(
      `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 365 -subj "${subject}"`,
      { stdio: 'inherit' }
    );
    
    // Set proper permissions
    if (process.platform !== 'win32') {
      fs.chmodSync(keyPath, '600');
      fs.chmodSync(certPath, '644');
    }
    
    console.log('\nSSL certificates generated successfully!');
    console.log(`Key: ${keyPath}`);
    console.log(`Certificate: ${certPath}`);
    console.log('\nTo use HTTPS, update your config:');
    console.log('  sslEnabled: true,');
    console.log(`  sslKey: '${keyPath.replace(/\\/g, '/')}',`);
    console.log(`  sslCert: '${certPath.replace(/\\/g, '/')}',`);
    
  } catch (error) {
    console.error('Failed to generate SSL certificates:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateSSLCertificate();
}

export default generateSSLCertificate;