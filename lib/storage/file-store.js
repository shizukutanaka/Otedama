/**
 * File Store - Otedama
 * Simple file-based storage for persistent data
 */

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../core/logger.js';

const logger = createLogger('FileStore');

export class FileStore {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(process.cwd(), 'data');
    this.encoding = options.encoding || 'utf8';
  }
  
  async ensureDir(dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
  
  async read(filename) {
    const filepath = path.join(this.baseDir, filename);
    
    try {
      const data = await fs.readFile(filepath, this.encoding);
      return this.encoding === 'utf8' ? JSON.parse(data) : data;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  
  async write(filename, data) {
    const filepath = path.join(this.baseDir, filename);
    const dir = path.dirname(filepath);
    
    await this.ensureDir(dir);
    
    const content = this.encoding === 'utf8' 
      ? JSON.stringify(data, null, 2) 
      : data;
    
    await fs.writeFile(filepath, content, this.encoding);
    
    logger.debug(`Wrote file: ${filename}`);
  }
  
  async delete(filename) {
    const filepath = path.join(this.baseDir, filename);
    
    try {
      await fs.unlink(filepath);
      logger.debug(`Deleted file: ${filename}`);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  
  async exists(filename) {
    const filepath = path.join(this.baseDir, filename);
    
    try {
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }
  
  async list(dir = '') {
    const dirpath = path.join(this.baseDir, dir);
    
    try {
      const files = await fs.readdir(dirpath);
      return files;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
  
  async getStats(filename) {
    const filepath = path.join(this.baseDir, filename);
    
    try {
      const stats = await fs.stat(filepath);
      return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isDirectory: stats.isDirectory()
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

export default FileStore;
