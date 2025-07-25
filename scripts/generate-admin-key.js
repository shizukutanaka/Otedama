#!/usr/bin/env node

/**
 * Generate Admin Key for Remote Management
 * Creates secure API keys for remote pool management
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function generateAdminKey() {
  // Generate secure random key
  const apiKey = crypto.randomBytes(32).toString('hex');
  const keyId = crypto.randomBytes(8).toString('hex');
  
  const adminKey = {
    id: keyId,
    key: apiKey,
    created: new Date().toISOString(),
    description: 'Admin API Key'
  };
  
  console.log('');
  console.log('=== Otedama Admin Key Generated ===');
  console.log('');
  console.log(`Key ID: ${adminKey.id}`);
  console.log(`API Key: ${adminKey.key}`);
  console.log('');
  console.log('Add this to your .env file:');
  console.log(`ADMIN_API_KEY_${keyId}=${apiKey}`);
  console.log('');
  console.log('Or add to otedama.config.js:');
  console.log(`adminKeys: ['${apiKey}']`);
  console.log('');
  console.log('Keep this key secure! It provides full control over your mining pool.');
  console.log('');
  
  // Save to file (optional)
  const saveToFile = process.argv.includes('--save');
  if (saveToFile) {
    const keysFile = path.join(__dirname, '../data/admin-keys.json');
    
    let keys = [];
    try {
      const existing = await fs.readFile(keysFile, 'utf8');
      keys = JSON.parse(existing);
    } catch (error) {
      // File doesn't exist
    }
    
    keys.push(adminKey);
    
    await fs.mkdir(path.dirname(keysFile), { recursive: true });
    await fs.writeFile(keysFile, JSON.stringify(keys, null, 2));
    
    console.log(`Key saved to: ${keysFile}`);
    console.log('');
  }
}

// Run
generateAdminKey().catch(console.error);
