/**
 * Transactional Batch Operations for Otedama
 * Ensures data consistency with proper transaction boundaries
 * 
 * Design principles:
 * - Martin: Clean transaction management
 * - Pike: Simple, reliable batch operations
 * - Carmack: Efficient batch processing
 */

import { EventEmitter } from 'events';
import { getLogger } from './logger.js';

const logger = getLogger('TransactionalBatch');

/**
 * Transactional batch operation manager
 */
export class TransactionalBatchOperations extends EventEmitter {
  constructor(db, options = {}) {
    super();
    
    this.db = db;
    this.options = {
      // Transaction options
      isolationLevel: options.isolationLevel || 'IMMEDIATE',
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 100,
      
      // Batch options
      batchSize: options.batchSize || 1000,
      progressInterval: options.progressInterval || 1000,
      
      // Timeout options
      transactionTimeout: options.transactionTimeout || 30000,
      
      ...options
    };
    
    // Statistics
    this.stats = {
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      retriedOperations: 0,
      totalRowsAffected: 0
    };
  }
  
  /**
   * Execute batch operations in a transaction
   */
  async executeBatch(operations, options = {}) {
    const startTime = Date.now();
    const opts = { ...this.options, ...options };
    
    this.stats.totalOperations++;
    
    let attempt = 0;
    let lastError;
    
    while (attempt < opts.maxRetries) {
      attempt++;
      
      try {
        const result = await this._executeWithTransaction(operations, opts);
        
        this.stats.successfulOperations++;
        this.stats.totalRowsAffected += result.totalAffected;
        
        this.emit('batchComplete', {
          duration: Date.now() - startTime,
          operations: operations.length,
          affected: result.totalAffected,
          attempt
        });
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        if (this._isRetryableError(error) && attempt < opts.maxRetries) {
          this.stats.retriedOperations++;
          
          logger.warn(`Batch operation failed (attempt ${attempt}/${opts.maxRetries}): ${error.message}`);
          
          // Exponential backoff
          const delay = opts.retryDelay * Math.pow(2, attempt - 1);
          await this._sleep(delay);
          
          continue;
        }
        
        break;
      }
    }
    
    // All retries failed
    this.stats.failedOperations++;
    
    this.emit('batchFailed', {
      error: lastError,
      operations: operations.length,
      attempts: attempt
    });
    
    throw lastError;
  }
  
  /**
   * Execute operations within a transaction
   */
  async _executeWithTransaction(operations, opts) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Transaction timeout'));
      }, opts.transactionTimeout);
      
      try {
        // Start transaction
        this.db.prepare(`BEGIN ${opts.isolationLevel}`).run();
        
        const results = [];
        let totalAffected = 0;
        let operationIndex = 0;
        
        // Create savepoint for partial rollback capability
        this.db.prepare('SAVEPOINT batch_operation').run();
        
        try {
          // Execute each operation
          for (const operation of operations) {
            operationIndex++;
            
            // Validate operation
            this._validateOperation(operation);
            
            // Execute operation
            const result = this._executeOperation(operation);
            results.push(result);
            totalAffected += result.affected || 0;
            
            // Emit progress
            if (operationIndex % opts.progressInterval === 0) {
              this.emit('progress', {
                current: operationIndex,
                total: operations.length,
                affected: totalAffected
              });
            }
          }
          
          // Commit transaction
          this.db.prepare('COMMIT').run();
          
          clearTimeout(timeout);
          
          resolve({
            success: true,
            results,
            totalAffected,
            operations: operations.length
          });
          
        } catch (error) {
          // Rollback on error
          try {
            this.db.prepare('ROLLBACK').run();
          } catch (rollbackError) {
            logger.error('Rollback failed:', rollbackError);
          }
          
          clearTimeout(timeout);
          reject(error);
        }
        
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }
  
  /**
   * Validate operation structure
   */
  _validateOperation(operation) {
    if (!operation || typeof operation !== 'object') {
      throw new Error('Invalid operation: must be an object');
    }
    
    if (!operation.type) {
      throw new Error('Invalid operation: missing type');
    }
    
    const validTypes = ['insert', 'update', 'delete', 'upsert', 'custom'];
    if (!validTypes.includes(operation.type)) {
      throw new Error(`Invalid operation type: ${operation.type}`);
    }
    
    if (!operation.table && operation.type !== 'custom') {
      throw new Error('Invalid operation: missing table');
    }
  }
  
  /**
   * Execute single operation
   */
  _executeOperation(operation) {
    switch (operation.type) {
      case 'insert':
        return this._executeInsert(operation);
        
      case 'update':
        return this._executeUpdate(operation);
        
      case 'delete':
        return this._executeDelete(operation);
        
      case 'upsert':
        return this._executeUpsert(operation);
        
      case 'custom':
        return this._executeCustom(operation);
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }
  
  /**
   * Execute INSERT operation
   */
  _executeInsert(operation) {
    const { table, data, columns } = operation;
    
    if (Array.isArray(data)) {
      // Bulk insert
      const cols = columns || Object.keys(data[0]);
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      
      const stmt = this.db.prepare(sql);
      let affected = 0;
      
      for (const row of data) {
        const values = cols.map(col => row[col]);
        const result = stmt.run(...values);
        affected += result.changes;
      }
      
      return { type: 'insert', table, affected };
      
    } else {
      // Single insert
      const cols = columns || Object.keys(data);
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
      
      const values = cols.map(col => data[col]);
      const result = this.db.prepare(sql).run(...values);
      
      return {
        type: 'insert',
        table,
        affected: result.changes,
        lastInsertRowid: result.lastInsertRowid
      };
    }
  }
  
  /**
   * Execute UPDATE operation
   */
  _executeUpdate(operation) {
    const { table, data, where, params } = operation;
    
    const setClauses = Object.keys(data).map(col => `${col} = ?`).join(', ');
    const values = Object.values(data);
    
    let sql = `UPDATE ${table} SET ${setClauses}`;
    
    if (where) {
      sql += ` WHERE ${where}`;
      if (params) {
        values.push(...(Array.isArray(params) ? params : [params]));
      }
    }
    
    const result = this.db.prepare(sql).run(...values);
    
    return {
      type: 'update',
      table,
      affected: result.changes
    };
  }
  
  /**
   * Execute DELETE operation
   */
  _executeDelete(operation) {
    const { table, where, params } = operation;
    
    let sql = `DELETE FROM ${table}`;
    const values = [];
    
    if (where) {
      sql += ` WHERE ${where}`;
      if (params) {
        values.push(...(Array.isArray(params) ? params : [params]));
      }
    }
    
    const result = this.db.prepare(sql).run(...values);
    
    return {
      type: 'delete',
      table,
      affected: result.changes
    };
  }
  
  /**
   * Execute UPSERT operation
   */
  _executeUpsert(operation) {
    const { table, data, conflictColumns, updateColumns } = operation;
    
    const cols = Object.keys(data);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(data);
    
    let sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
    
    if (conflictColumns && updateColumns) {
      const updateClauses = updateColumns.map(col => `${col} = excluded.${col}`).join(', ');
      sql += ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updateClauses}`;
    } else {
      sql += ' ON CONFLICT DO NOTHING';
    }
    
    const result = this.db.prepare(sql).run(...values);
    
    return {
      type: 'upsert',
      table,
      affected: result.changes,
      lastInsertRowid: result.lastInsertRowid
    };
  }
  
  /**
   * Execute custom SQL operation
   */
  _executeCustom(operation) {
    const { sql, params, handler } = operation;
    
    if (handler && typeof handler === 'function') {
      return handler(this.db);
    }
    
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    
    return {
      type: 'custom',
      affected: result.changes || 0
    };
  }
  
  /**
   * Check if error is retryable
   */
  _isRetryableError(error) {
    const retryableMessages = [
      'database is locked',
      'database table is locked',
      'cannot commit transaction',
      'cannot start a transaction within a transaction'
    ];
    
    return retryableMessages.some(msg => 
      error.message.toLowerCase().includes(msg)
    );
  }
  
  /**
   * Sleep helper
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Create batch delete operations with retention policies
   */
  createRetentionCleanupBatch(retentionPolicies) {
    const operations = [];
    
    for (const [table, days] of Object.entries(retentionPolicies)) {
      const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
      
      switch (table) {
        case 'mining_sessions':
          operations.push({
            type: 'delete',
            table: 'mining_sessions',
            where: 'end_time < ? AND end_time IS NOT NULL',
            params: [cutoff]
          });
          break;
          
        case 'transactions':
          operations.push({
            type: 'delete',
            table: 'transactions',
            where: 'created_at < ? AND status IN (?, ?)',
            params: [cutoff, 'completed', 'failed']
          });
          break;
          
        case 'orders':
          operations.push({
            type: 'delete',
            table: 'orders',
            where: 'created_at < ? AND status IN (?, ?, ?)',
            params: [cutoff, 'filled', 'cancelled', 'expired']
          });
          break;
          
        default:
          operations.push({
            type: 'delete',
            table,
            where: 'created_at < ?',
            params: [cutoff]
          });
      }
    }
    
    return operations;
  }
  
  /**
   * Create batch insert operations
   */
  createBatchInsert(table, records, chunkSize = 100) {
    const operations = [];
    
    // Split into chunks to avoid hitting parameter limits
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      operations.push({
        type: 'insert',
        table,
        data: chunk
      });
    }
    
    return operations;
  }
  
  /**
   * Create batch update operations
   */
  createBatchUpdate(updates) {
    return updates.map(update => ({
      type: 'update',
      table: update.table,
      data: update.data,
      where: update.where,
      params: update.params
    }));
  }
  
  /**
   * Get operation statistics
   */
  getStats() {
    const successRate = this.stats.totalOperations > 0 ?
      (this.stats.successfulOperations / this.stats.totalOperations * 100).toFixed(2) : 0;
    
    return {
      ...this.stats,
      successRate: `${successRate}%`,
      avgRowsPerOperation: this.stats.successfulOperations > 0 ?
        Math.round(this.stats.totalRowsAffected / this.stats.successfulOperations) : 0
    };
  }
}

/**
 * Create transactional batch operations manager
 */
export function createTransactionalBatch(db, options) {
  return new TransactionalBatchOperations(db, options);
}

export default TransactionalBatchOperations;