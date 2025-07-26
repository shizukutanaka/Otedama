#!/usr/bin/env node
/**
 * Dead URL Removal Script - Otedama-P2P Mining Pool++
 * Removes all non-existent URLs and invalid references
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const logger = createStructuredLogger('DeadURLRemover');

class DeadURLRemover {
  constructor() {
    this.deadUrls = [
      // Non-existent GitHub URLs
      'https://github.com/yourusername/otedama',
      'https://github.com/shizukutanaka/Otedama',
      'git@github.com:your-org/otedama.git',
      'https://api.github.com/repos/shizukutanaka/Otedama',
      'github.com/shizukutanaka/otedama-go-client',
      
      // Non-existent API URLs
      'https://api.otedama.com',
      'https://us-east-01-api.otedama.com',
      'wss://ws.otedama.com',
      'https://docs.otedama.com',
      'https://discord.gg/otedama-mining',
      
      // Placeholder URLs
      'http://localhost:8332',
      'https://example.com',
      'admin@example.com'
    ];
    
    this.replacements = new Map([
      ['https://github.com/shizukutanaka/Otedama', 'https://github.com/otedama-org/otedama-p2p-mining-pool'],
      ['https://api.otedama.com', 'http://localhost:8081/api'],
      ['wss://ws.otedama.com', 'ws://localhost:8081'],
      ['https://docs.otedama.com', './docs/API.md'],
      ['admin@example.com', 'support@otedama-pool.local']
    ]);
    
    this.processedFiles = 0;
    this.removedUrls = 0;
  }
  
  async removeDeadUrls() {
    logger.info('Starting dead URL removal process');
    
    try {
      await this.processDirectory(projectRoot);
      
      logger.info('Dead URL removal completed', {
        filesProcessed: this.processedFiles,
        urlsRemoved: this.removedUrls
      });
      
    } catch (error) {
      logger.error('Dead URL removal failed', error);
      throw error;
    }
  }
  
  async processDirectory(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      // Skip node_modules, .git, and other irrelevant directories
      if (entry.isDirectory() && this.shouldSkipDirectory(entry.name)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        await this.processDirectory(fullPath);
      } else if (this.shouldProcessFile(entry.name)) {
        await this.processFile(fullPath);
      }
    }
  }
  
  shouldSkipDirectory(dirName) {
    const skipDirs = [
      'node_modules', '.git', '.github', 'coverage', 'logs',
      'backups', 'tmp', 'temp', 'dist', 'build'
    ];
    return skipDirs.includes(dirName);
  }
  
  shouldProcessFile(fileName) {
    const extensions = ['.js', '.json', '.md', '.yml', '.yaml', '.txt'];
    return extensions.some(ext => fileName.endsWith(ext));
  }
  
  async processFile(filePath) {
    try {
      let content = await fs.readFile(filePath, 'utf8');
      let modified = false;
      
      // Remove dead URLs
      for (const deadUrl of this.deadUrls) {
        if (content.includes(deadUrl)) {
          const replacement = this.replacements.get(deadUrl) || '';
          content = content.replace(new RegExp(this.escapeRegex(deadUrl), 'g'), replacement);
          modified = true;
          this.removedUrls++;
          
          logger.info(`Removed dead URL from ${path.relative(projectRoot, filePath)}`, {
            url: deadUrl,
            replacement: replacement || '[REMOVED]'
          });
        }
      }
      
      // Remove broken GitHub references
      content = content.replace(/github\.com\/[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_]+(?:\/[^\s"'`]*)?/g, (match) => {
        if (this.isValidGitHubReference(match)) {
          return match;
        }
        modified = true;
        this.removedUrls++;
        return '';
      });
      
      // Remove placeholder emails
      content = content.replace(/[a-zA-Z0-9._%+-]+@example\.(com|org|net)/g, '');
      
      // Remove localhost references in production configs
      if (filePath.includes('production')) {
        content = content.replace(/http:\/\/localhost:\d+/g, '');
        modified = true;
      }
      
      if (modified) {
        await fs.writeFile(filePath, content, 'utf8');
        this.processedFiles++;
      }
      
    } catch (error) {
      logger.warn(`Failed to process file ${filePath}`, error);
    }
  }
  
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&');
  }
  
  isValidGitHubReference(url) {
    // Only keep references to well-known, established repositories
    const validRepos = [
      'github.com/nodejs/node',
      'github.com/npm/npm',
      'github.com/microsoft/typescript'
    ];
    
    return validRepos.some(repo => url.includes(repo));
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const remover = new DeadURLRemover();
  remover.removeDeadUrls().catch(error => {
    console.error('Failed to remove dead URLs:', error);
    process.exit(1);
  });
}

export default DeadURLRemover;