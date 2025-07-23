/**
 * Transaction Manager for Otedama
 * Advanced transaction handling with rollback, savepoints, and monitoring
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from './core/standardized-error-handler.js';

/**
 * Transaction isolation levels
 */
export const IsolationLevel = {
  READ_UNCOMMITTED: 'READ UNCOMMITTED',
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE'
};

/**
 * Transaction state
 */
export const TransactionState = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMMITTED: 'committed',
  ROLLED_BACK: 'rolled_back',
  FAILED: 'failed'
};

/**
 * Transaction Manager
 */
export class TransactionManager extends EventEmitter {
  constructor(dbOptimizer, options = {}) {
    super();
    this.dbOptimizer = dbOptimizer;
    this.options = {
      defaultTimeout: options.defaultTimeout || 30000, // 30 seconds
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 100,
      enableLogging: options.enableLogging !== false,
      enableMetrics: options.enableMetrics !== false,
      ...options
    };
    
    this.transactions = new Map();
    this.metrics = {
      total: 0,
      committed: 0,
      rolledBack: 0,
      failed: 0,
      retriedCount: 0,
      avgDuration: 0,
      deadlocks: 0,
      timeouts: 0
    };
    
    this.errorHandler = getErrorHandler();
  }
  
  /**
   * Create a new transaction
   */
  async createTransaction(options = {}) {
    const txId = this.generateTransactionId();
    const startTime = Date.now();
    
    const transaction = {
      id: txId,
      state: TransactionState.PENDING,
      startTime,
      options: {
        timeout: options.timeout || this.options.defaultTimeout,
        isolation: options.isolation || IsolationLevel.READ_COMMITTED,
        readOnly: options.readOnly || false,
        retries: options.retries !== undefined ? options.retries : this.options.maxRetries,
        name: options.name || `tx_${txId}`,
        metadata: options.metadata || {}
      },
      operations: [],
      savepoints: new Map(),
      db: null,
      timeoutHandle: null
    };
    
    this.transactions.set(txId, transaction);
    this.metrics.total++;
    
    this.emit('transaction:created', {
      transactionId: txId,
      options: transaction.options
    });
    
    return txId;
  }
  
  /**
   * Begin a transaction
   */
  async beginTransaction(txId, options = {}) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError('Transaction not found', ErrorCategory.DATABASE, { txId });
    }
    
    if (transaction.state !== TransactionState.PENDING) {
      throw new OtedamaError('Transaction already started', ErrorCategory.DATABASE, { 
        txId, 
        state: transaction.state 
      });
    }
    
    try {
      // Get a write connection from the pool
      const connection = await this.dbOptimizer.getWriteConnection();
      transaction.db = connection;
      
      // Set isolation level if specified
      if (transaction.options.isolation) {
        await safeExecute(async () => {
          connection.pragma(`read_uncommitted = ${
            transaction.options.isolation === IsolationLevel.READ_UNCOMMITTED ? 1 : 0
          }`);
        });
      }
      
      // Begin transaction
      await safeExecute(async () => {
        connection.exec('BEGIN IMMEDIATE');
      });
      
      transaction.state = TransactionState.ACTIVE;
      
      // Set timeout
      if (transaction.options.timeout) {
        transaction.timeoutHandle = setTimeout(() => {
          this.handleTimeout(txId);
        }, transaction.options.timeout);
      }
      
      this.emit('transaction:started', {
        transactionId: txId,
        options: transaction.options
      });
      
      return txId;
      
    } catch (error) {
      transaction.state = TransactionState.FAILED;
      this.metrics.failed++;
      
      throw new OtedamaError(
        'Failed to begin transaction',
        ErrorCategory.DATABASE,
        { txId, originalError: error }
      );
    }
  }
  
  /**
   * Execute operation within transaction
   */
  async executeOperation(txId, operation, options = {}) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError('Transaction not found', ErrorCategory.DATABASE, { txId });
    }
    
    if (transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError('Transaction not active', ErrorCategory.DATABASE, { 
        txId, 
        state: transaction.state 
      });
    }
    
    const operationId = this.generateOperationId();
    const startTime = Date.now();
    
    const op = {
      id: operationId,
      type: options.type || 'query',
      sql: operation.sql || operation,
      params: operation.params || [],
      timestamp: startTime,
      result: null,
      error: null
    };
    
    transaction.operations.push(op);
    
    try {
      // Create savepoint if requested
      if (options.savepoint) {
        await this.createSavepoint(txId, options.savepoint);
      }
      
      // Execute operation
      const result = await safeExecute(async () => {
        if (typeof operation === 'function') {
          return await operation(transaction.db);
        } else if (typeof operation === 'string') {
          const stmt = transaction.db.prepare(operation);
          return op.params.length > 0 ? stmt.run(...op.params) : stmt.run();
        } else {
          const stmt = transaction.db.prepare(op.sql);
          return op.params.length > 0 ? stmt.run(...op.params) : stmt.run();
        }
      }, {
        maxRetries: 0, // No retries within transaction
        category: ErrorCategory.DATABASE
      });
      
      op.result = result;
      op.duration = Date.now() - startTime;
      
      this.emit('transaction:operation', {
        transactionId: txId,
        operationId,
        duration: op.duration,
        type: op.type
      });
      
      return result;
      
    } catch (error) {
      op.error = error;
      op.duration = Date.now() - startTime;
      
      // Auto-rollback to savepoint if exists
      if (options.savepoint && options.autoRollback !== false) {
        try {
          await this.rollbackToSavepoint(txId, options.savepoint);
        } catch (rollbackError) {
          // Log but don't throw
          this.errorHandler.handleError(rollbackError, {
            service: 'transaction-manager',
            context: 'savepoint-rollback'
          });
        }
      }
      
      throw error;
    }
  }
  
  /**
   * Create savepoint
   */
  async createSavepoint(txId, name) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError('Invalid transaction state', ErrorCategory.DATABASE, { txId });
    }
    
    const savepointName = `sp_${name}_${Date.now()}`;
    
    await safeExecute(async () => {
      transaction.db.exec(`SAVEPOINT ${savepointName}`);
    });
    
    transaction.savepoints.set(name, {
      name: savepointName,
      created: Date.now(),
      operations: [...transaction.operations]
    });
    
    this.emit('transaction:savepoint', {
      transactionId: txId,
      savepoint: name
    });
    
    return savepointName;
  }
  
  /**
   * Rollback to savepoint
   */
  async rollbackToSavepoint(txId, name) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError('Invalid transaction state', ErrorCategory.DATABASE, { txId });
    }
    
    const savepoint = transaction.savepoints.get(name);
    if (!savepoint) {
      throw new OtedamaError('Savepoint not found', ErrorCategory.DATABASE, { txId, name });
    }
    
    await safeExecute(async () => {
      transaction.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint.name}`);
    });
    
    // Restore operations list
    transaction.operations = [...savepoint.operations];
    
    this.emit('transaction:rollback-savepoint', {
      transactionId: txId,
      savepoint: name
    });
  }
  
  /**
   * Commit transaction
   */
  async commitTransaction(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError('Transaction not found', ErrorCategory.DATABASE, { txId });
    }
    
    if (transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError('Transaction not active', ErrorCategory.DATABASE, { 
        txId, 
        state: transaction.state 
      });
    }
    
    try {
      // Clear timeout
      if (transaction.timeoutHandle) {
        clearTimeout(transaction.timeoutHandle);
      }
      
      // Commit transaction
      await safeExecute(async () => {
        transaction.db.exec('COMMIT');
      });
      
      transaction.state = TransactionState.COMMITTED;
      transaction.endTime = Date.now();
      
      // Update metrics
      this.metrics.committed++;
      const duration = transaction.endTime - transaction.startTime;
      this.updateAvgDuration(duration);
      
      this.emit('transaction:committed', {
        transactionId: txId,
        duration,
        operations: transaction.operations.length
      });
      
      // Cleanup
      this.transactions.delete(txId);
      
      return {
        transactionId: txId,
        duration,
        operations: transaction.operations.length,
        state: transaction.state
      };
      
    } catch (error) {
      // Attempt rollback
      try {
        await this.rollbackTransaction(txId);
      } catch (rollbackError) {
        // Log but don't throw
        this.errorHandler.handleError(rollbackError, {
          service: 'transaction-manager',
          context: 'commit-rollback'
        });
      }
      
      throw new OtedamaError(
        'Failed to commit transaction',
        ErrorCategory.DATABASE,
        { txId, originalError: error }
      );
    } finally {
      // Release connection
      if (transaction.db) {
        this.dbOptimizer.releaseConnection(transaction.db);
      }
    }
  }
  
  /**
   * Rollback transaction
   */
  async rollbackTransaction(txId, reason) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError('Transaction not found', ErrorCategory.DATABASE, { txId });
    }
    
    if (transaction.state === TransactionState.COMMITTED || 
        transaction.state === TransactionState.ROLLED_BACK) {
      return; // Already finalized
    }
    
    try {
      // Clear timeout
      if (transaction.timeoutHandle) {
        clearTimeout(transaction.timeoutHandle);
      }
      
      // Rollback transaction
      if (transaction.db && transaction.state === TransactionState.ACTIVE) {
        await safeExecute(async () => {
          transaction.db.exec('ROLLBACK');
        });
      }
      
      transaction.state = TransactionState.ROLLED_BACK;
      transaction.endTime = Date.now();
      
      // Update metrics
      this.metrics.rolledBack++;
      
      this.emit('transaction:rolled-back', {
        transactionId: txId,
        reason,
        duration: transaction.endTime - transaction.startTime
      });
      
      // Cleanup
      this.transactions.delete(txId);
      
    } catch (error) {
      transaction.state = TransactionState.FAILED;
      this.metrics.failed++;
      
      throw new OtedamaError(
        'Failed to rollback transaction',
        ErrorCategory.DATABASE,
        { txId, originalError: error }
      );
    } finally {
      // Release connection
      if (transaction.db) {
        this.dbOptimizer.releaseConnection(transaction.db);
      }
    }
  }
  
  /**
   * Handle transaction timeout
   */
  async handleTimeout(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      return;
    }
    
    this.metrics.timeouts++;
    
    this.emit('transaction:timeout', {
      transactionId: txId,
      duration: Date.now() - transaction.startTime
    });
    
    // Attempt rollback
    try {
      await this.rollbackTransaction(txId, 'timeout');
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'transaction-manager',
        context: 'timeout-rollback'
      });
    }
  }
  
  /**
   * Execute with retry
   */
  async executeWithRetry(operation, options = {}) {
    const maxRetries = options.retries !== undefined ? 
      options.retries : this.options.maxRetries;
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const txId = await this.createTransaction(options);
      
      try {
        await this.beginTransaction(txId);
        const result = await operation(txId);
        await this.commitTransaction(txId);
        
        if (attempt > 0) {
          this.metrics.retriedCount++;
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Check if retryable
        if (!this.isRetryableError(error) || attempt === maxRetries) {
          throw error;
        }
        
        // Exponential backoff
        const delay = this.options.retryDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }
  
  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    const retryableErrors = [
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_PROTOCOL',
      'database is locked',
      'database table is locked'
    ];
    
    const errorMessage = error.message || error.code || '';
    return retryableErrors.some(msg => errorMessage.includes(msg));
  }
  
  /**
   * Update average duration metric
   */
  updateAvgDuration(duration) {
    const alpha = 0.1; // Exponential moving average factor
    this.metrics.avgDuration = alpha * duration + (1 - alpha) * this.metrics.avgDuration;
  }
  
  /**
   * Generate unique transaction ID
   */
  generateTransactionId() {
    return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Generate unique operation ID
   */
  generateOperationId() {
    return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get transaction metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeTransactions: this.transactions.size,
      successRate: this.metrics.total > 0 ? 
        (this.metrics.committed / this.metrics.total) : 0,
      rollbackRate: this.metrics.total > 0 ? 
        (this.metrics.rolledBack / this.metrics.total) : 0,
      timeoutRate: this.metrics.total > 0 ? 
        (this.metrics.timeouts / this.metrics.total) : 0
    };
  }
  
  /**
   * Begin a transaction
   */
  async begin(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError(
        'Transaction not found',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    if (transaction.state !== TransactionState.PENDING) {
      throw new OtedamaError(
        'Transaction already started',
        ErrorCategory.DATABASE,
        { transactionId: txId, state: transaction.state }
      );
    }
    
    try {
      // Get appropriate database connection
      transaction.db = transaction.options.readOnly 
        ? this.dbOptimizer.getReadConnection()
        : this.dbOptimizer.getWriteConnection();
      
      if (!transaction.db) {
        throw new OtedamaError(
          'No database connection available',
          ErrorCategory.DATABASE,
          { readOnly: transaction.options.readOnly }
        );
      }
      
      // Begin transaction with appropriate mode
      const mode = transaction.options.readOnly ? 'DEFERRED' : 'IMMEDIATE';
      await safeExecute(() => {
        transaction.db.exec(`BEGIN ${mode}`);
      }, {
        service: 'transaction-begin',
        context: { transactionId: txId }
      });
      
      // Set isolation level if supported
      if (transaction.options.isolation && !transaction.options.readOnly) {
        // SQLite doesn't support all isolation levels, but we can simulate some
        this.setIsolationLevel(transaction.db, transaction.options.isolation);
      }
      
      // Set transaction state
      transaction.state = TransactionState.ACTIVE;
      
      // Setup timeout
      if (transaction.options.timeout > 0) {
        transaction.timeoutHandle = setTimeout(() => {
          this.handleTimeout(txId);
        }, transaction.options.timeout);
      }
      
      this.emit('transaction:began', {
        transactionId: txId,
        mode,
        isolation: transaction.options.isolation
      });
      
      if (this.options.enableLogging) {
        this.log('Transaction began', { txId, mode });
      }
      
    } catch (error) {
      transaction.state = TransactionState.FAILED;
      this.metrics.failed++;
      
      throw new OtedamaError(
        'Failed to begin transaction',
        ErrorCategory.DATABASE,
        { originalError: error, transactionId: txId }
      );
    }
  }
  
  /**
   * Execute operation within transaction
   */
  async execute(txId, operation, context = {}) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError(
        'Transaction not found',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    if (transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId, state: transaction.state }
      );
    }
    
    const operationId = this.generateOperationId();
    const startTime = Date.now();
    
    try {
      // Record operation
      transaction.operations.push({
        id: operationId,
        type: context.type || 'query',
        sql: context.sql || operation.toString(),
        params: context.params,
        startTime
      });
      
      // Execute operation
      const result = await operation(transaction.db);
      
      // Update operation record
      const op = transaction.operations[transaction.operations.length - 1];
      op.duration = Date.now() - startTime;
      op.success = true;
      
      this.emit('transaction:operation', {
        transactionId: txId,
        operationId,
        duration: op.duration,
        type: op.type
      });
      
      return result;
      
    } catch (error) {
      const op = transaction.operations[transaction.operations.length - 1];
      op.duration = Date.now() - startTime;
      op.success = false;
      op.error = error.message;
      
      // Check for deadlock
      if (this.isDeadlock(error)) {
        this.metrics.deadlocks++;
        transaction.deadlock = true;
      }
      
      throw error;
    }
  }
  
  /**
   * Create a savepoint
   */
  async savepoint(txId, name) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    const savepointName = name || `sp_${Date.now()}`;
    
    await safeExecute(() => {
      transaction.db.exec(`SAVEPOINT ${savepointName}`);
    }, {
      service: 'transaction-savepoint',
      context: { transactionId: txId, savepoint: savepointName }
    });
    
    transaction.savepoints.set(savepointName, {
      name: savepointName,
      createdAt: Date.now(),
      operationCount: transaction.operations.length
    });
    
    this.emit('transaction:savepoint', {
      transactionId: txId,
      savepoint: savepointName
    });
    
    return savepointName;
  }
  
  /**
   * Rollback to savepoint
   */
  async rollbackToSavepoint(txId, savepointName) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    if (!transaction.savepoints.has(savepointName)) {
      throw new OtedamaError(
        'Savepoint not found',
        ErrorCategory.DATABASE,
        { transactionId: txId, savepoint: savepointName }
      );
    }
    
    await safeExecute(() => {
      transaction.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    }, {
      service: 'transaction-rollback-savepoint',
      context: { transactionId: txId, savepoint: savepointName }
    });
    
    // Remove operations after savepoint
    const savepoint = transaction.savepoints.get(savepointName);
    transaction.operations = transaction.operations.slice(0, savepoint.operationCount);
    
    // Remove savepoints created after this one
    const savepointsToRemove = [];
    for (const [name, sp] of transaction.savepoints) {
      if (sp.createdAt > savepoint.createdAt) {
        savepointsToRemove.push(name);
      }
    }
    savepointsToRemove.forEach(name => transaction.savepoints.delete(name));
    
    this.emit('transaction:rollback-savepoint', {
      transactionId: txId,
      savepoint: savepointName
    });
  }
  
  /**
   * Release a savepoint
   */
  async releaseSavepoint(txId, savepointName) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    await safeExecute(() => {
      transaction.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    }, {
      service: 'transaction-release-savepoint',
      context: { transactionId: txId, savepoint: savepointName }
    });
    
    transaction.savepoints.delete(savepointName);
    
    this.emit('transaction:release-savepoint', {
      transactionId: txId,
      savepoint: savepointName
    });
  }
  
  /**
   * Commit transaction
   */
  async commit(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError(
        'Transaction not found',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    if (transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId, state: transaction.state }
      );
    }
    
    try {
      // Clear timeout
      if (transaction.timeoutHandle) {
        clearTimeout(transaction.timeoutHandle);
      }
      
      // Commit transaction
      await safeExecute(() => {
        transaction.db.exec('COMMIT');
      }, {
        service: 'transaction-commit',
        context: { transactionId: txId }
      });
      
      // Update state and metrics
      transaction.state = TransactionState.COMMITTED;
      transaction.endTime = Date.now();
      transaction.duration = transaction.endTime - transaction.startTime;
      
      this.metrics.committed++;
      this.updateAverageDuration(transaction.duration);
      
      this.emit('transaction:committed', {
        transactionId: txId,
        duration: transaction.duration,
        operationCount: transaction.operations.length
      });
      
      if (this.options.enableLogging) {
        this.log('Transaction committed', {
          txId,
          duration: transaction.duration,
          operations: transaction.operations.length
        });
      }
      
    } catch (error) {
      transaction.state = TransactionState.FAILED;
      this.metrics.failed++;
      
      // Try to rollback
      try {
        await this.rollback(txId);
      } catch (rollbackError) {
        // Log rollback error but throw original
        await this.errorHandler.handleError(rollbackError, {
          service: 'transaction-commit-rollback',
          category: ErrorCategory.DATABASE,
          severity: 'high'
        });
      }
      
      throw new OtedamaError(
        'Failed to commit transaction',
        ErrorCategory.DATABASE,
        { originalError: error, transactionId: txId }
      );
    } finally {
      // Cleanup
      this.cleanup(txId);
    }
  }
  
  /**
   * Rollback transaction
   */
  async rollback(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      throw new OtedamaError(
        'Transaction not found',
        ErrorCategory.DATABASE,
        { transactionId: txId }
      );
    }
    
    if (transaction.state === TransactionState.ROLLED_BACK) {
      return; // Already rolled back
    }
    
    if (transaction.state !== TransactionState.ACTIVE) {
      throw new OtedamaError(
        'Transaction not active',
        ErrorCategory.DATABASE,
        { transactionId: txId, state: transaction.state }
      );
    }
    
    try {
      // Clear timeout
      if (transaction.timeoutHandle) {
        clearTimeout(transaction.timeoutHandle);
      }
      
      // Rollback transaction
      await safeExecute(() => {
        transaction.db.exec('ROLLBACK');
      }, {
        service: 'transaction-rollback',
        context: { transactionId: txId }
      });
      
      // Update state and metrics
      transaction.state = TransactionState.ROLLED_BACK;
      transaction.endTime = Date.now();
      transaction.duration = transaction.endTime - transaction.startTime;
      
      this.metrics.rolledBack++;
      
      this.emit('transaction:rolled-back', {
        transactionId: txId,
        duration: transaction.duration,
        operationCount: transaction.operations.length,
        reason: transaction.rollbackReason
      });
      
      if (this.options.enableLogging) {
        this.log('Transaction rolled back', {
          txId,
          duration: transaction.duration,
          operations: transaction.operations.length,
          reason: transaction.rollbackReason
        });
      }
      
    } catch (error) {
      transaction.state = TransactionState.FAILED;
      this.metrics.failed++;
      
      throw new OtedamaError(
        'Failed to rollback transaction',
        ErrorCategory.DATABASE,
        { originalError: error, transactionId: txId }
      );
    } finally {
      // Cleanup
      this.cleanup(txId);
    }
  }
  
  /**
   * Execute a function within a transaction with automatic retry
   */
  async withTransaction(fn, options = {}) {
    let lastError;
    const maxRetries = options.retries !== undefined ? options.retries : this.options.maxRetries;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const txId = await this.createTransaction(options);
      
      try {
        await this.begin(txId);
        const result = await fn(txId, (operation, context) => 
          this.execute(txId, operation, context)
        );
        await this.commit(txId);
        
        if (attempt > 0) {
          this.metrics.retriedCount++;
        }
        
        return result;
        
      } catch (error) {
        await this.rollback(txId).catch(rollbackError => {
          // Log rollback error but continue with original error
          this.errorHandler.handleError(rollbackError, {
            service: 'transaction-with-rollback',
            category: ErrorCategory.DATABASE,
            severity: 'medium'
          });
        });
        
        lastError = error;
        
        // Check if we should retry
        if (!this.shouldRetry(error, attempt, maxRetries)) {
          break;
        }
        
        // Wait before retry with exponential backoff
        const delay = Math.min(
          this.options.retryDelay * Math.pow(2, attempt),
          5000
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError;
  }
  
  /**
   * Handle transaction timeout
   */
  async handleTimeout(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction || transaction.state !== TransactionState.ACTIVE) {
      return;
    }
    
    this.metrics.timeouts++;
    transaction.rollbackReason = 'timeout';
    
    this.emit('transaction:timeout', {
      transactionId: txId,
      duration: Date.now() - transaction.startTime
    });
    
    try {
      await this.rollback(txId);
    } catch (error) {
      await this.errorHandler.handleError(error, {
        service: 'transaction-timeout-rollback',
        category: ErrorCategory.DATABASE,
        severity: 'high',
        context: { transactionId: txId }
      });
    }
  }
  
  /**
   * Check if error is a deadlock
   */
  isDeadlock(error) {
    return error.code === 'SQLITE_BUSY' || 
           error.code === 'SQLITE_LOCKED' ||
           (error.message && error.message.includes('deadlock'));
  }
  
  /**
   * Determine if operation should be retried
   */
  shouldRetry(error, attempt, maxRetries) {
    if (attempt >= maxRetries) {
      return false;
    }
    
    // Retry on deadlock or temporary errors
    return this.isDeadlock(error) || 
           error.code === 'SQLITE_BUSY' ||
           error.code === 'SQLITE_LOCKED' ||
           error.code === 'SQLITE_IOERR';
  }
  
  /**
   * Set isolation level (SQLite simulation)
   */
  setIsolationLevel(db, level) {
    // SQLite doesn't support all isolation levels, but we can adjust behavior
    switch (level) {
      case IsolationLevel.READ_UNCOMMITTED:
        db.pragma('read_uncommitted = ON');
        break;
      case IsolationLevel.SERIALIZABLE:
        // SQLite is serializable by default
        break;
      default:
        // Other levels use default SQLite behavior
        break;
    }
  }
  
  /**
   * Cleanup transaction
   */
  cleanup(txId) {
    const transaction = this.transactions.get(txId);
    if (transaction) {
      if (transaction.timeoutHandle) {
        clearTimeout(transaction.timeoutHandle);
      }
      this.transactions.delete(txId);
    }
  }
  
  /**
   * Update average duration metric
   */
  updateAverageDuration(duration) {
    const totalTransactions = this.metrics.committed + this.metrics.rolledBack;
    this.metrics.avgDuration = 
      (this.metrics.avgDuration * (totalTransactions - 1) + duration) / totalTransactions;
  }
  
  /**
   * Generate transaction ID
   */
  generateTransactionId() {
    return randomBytes(8).toString('hex');
  }
  
  /**
   * Generate operation ID
   */
  generateOperationId() {
    return randomBytes(4).toString('hex');
  }
  
  /**
   * Log transaction event
   */
  log(message, context) {
    if (this.options.enableLogging) {
      console.log(`[TransactionManager] ${message}`, context);
    }
  }
  
  /**
   * Get transaction metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      active: this.transactions.size,
      successRate: this.metrics.total > 0 
        ? (this.metrics.committed / this.metrics.total * 100).toFixed(2) + '%'
        : '0%',
      avgDurationMs: Math.round(this.metrics.avgDuration)
    };
  }
  
  /**
   * Get transaction details
   */
  getTransaction(txId) {
    const transaction = this.transactions.get(txId);
    if (!transaction) {
      return null;
    }
    
    return {
      id: transaction.id,
      state: transaction.state,
      startTime: transaction.startTime,
      duration: transaction.endTime ? transaction.endTime - transaction.startTime : null,
      options: transaction.options,
      operationCount: transaction.operations.length,
      savepointCount: transaction.savepoints.size,
      operations: transaction.operations
    };
  }
  
  /**
   * List active transactions
   */
  listActiveTransactions() {
    const active = [];
    for (const [txId, transaction] of this.transactions) {
      if (transaction.state === TransactionState.ACTIVE) {
        active.push({
          id: txId,
          name: transaction.options.name,
          duration: Date.now() - transaction.startTime,
          operations: transaction.operations.length,
          savepoints: transaction.savepoints.size
        });
      }
    }
    return active;
  }
}

export default TransactionManager;