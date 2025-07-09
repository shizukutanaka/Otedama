/**
 * Secure Database Implementation with SQL Injection Prevention
 * Following Carmack/Martin/Pike principles:
 * - All queries use parameterization
 * - Simple and secure by default
 * - Clear separation of concerns
 */

import { Database } from 'sqlite3';
import { SQLInjectionPrevention } from '../security/sql-injection-prevention';
import { EnhancedAuditLogger } from '../audit/enhanced-audit-logger';
import * as crypto from 'crypto';

interface QueryOptions {
  timeout?: number;
  readonly?: boolean;
  transaction?: boolean;
}

interface PreparedQuery {
  id: string;
  sql: string;
  params: any[];
  timestamp: number;
}

export class SecureDatabase {
  private db: Database;
  private sqlProtection: SQLInjectionPrevention;
  private auditLogger?: EnhancedAuditLogger;
  private preparedQueries: Map<string, PreparedQuery> = new Map();
  private transactionDepth = 0;

  constructor(
    dbPath: string,
    sqlProtection: SQLInjectionPrevention,
    auditLogger?: EnhancedAuditLogger
  ) {
    this.db = new Database(dbPath);
    this.sqlProtection = sqlProtection;
    this.auditLogger = auditLogger;
    
    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');
    
    // Set secure defaults
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
  }

  /**
   * Execute a parameterized query
   */
  async query<T = any>(
    sql: string,
    params: any[] = [],
    options: QueryOptions = {}
  ): Promise<T[]> {
    // Validate SQL
    const sqlValidation = this.sqlProtection.validateInput(sql, 'string', 'sql_query');
    if (!sqlValidation.safe) {
      throw new Error(`Unsafe SQL query: ${sqlValidation.risks.join(', ')}`);
    }
    
    // Validate parameters
    const validatedParams = await this.validateParams(params);
    
    // Log query attempt
    await this.logQuery('query', sql, validatedParams);
    
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 30000;
      let timeoutHandle: NodeJS.Timeout;
      
      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Query timeout'));
      }, timeout);
      
      this.db.all(sql, validatedParams, (err, rows) => {
        cleanup();
        
        if (err) {
          this.logQueryError('query', sql, err);
          reject(err);
        } else {
          resolve(rows as T[]);
        }
      });
    });
  }

  /**
   * Execute a single row query
   */
  async get<T = any>(
    sql: string,
    params: any[] = [],
    options: QueryOptions = {}
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params, options);
    return rows[0] || null;
  }

  /**
   * Execute an INSERT/UPDATE/DELETE query
   */
  async run(
    sql: string,
    params: any[] = [],
    options: QueryOptions = {}
  ): Promise<{ changes: number; lastID: number }> {
    // Validate SQL
    const sqlValidation = this.sqlProtection.validateInput(sql, 'string', 'sql_query');
    if (!sqlValidation.safe) {
      throw new Error(`Unsafe SQL query: ${sqlValidation.risks.join(', ')}`);
    }
    
    // Check if it's a read-only query
    if (options.readonly && /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)/i.test(sql)) {
      throw new Error('Write operation not allowed in read-only mode');
    }
    
    // Validate parameters
    const validatedParams = await this.validateParams(params);
    
    // Log query attempt
    await this.logQuery('run', sql, validatedParams);
    
    return new Promise((resolve, reject) => {
      this.db.run(sql, validatedParams, function(err) {
        if (err) {
          this.logQueryError('run', sql, err);
          reject(err);
        } else {
          resolve({
            changes: this.changes,
            lastID: this.lastID
          });
        }
      });
    });
  }

  /**
   * Execute a query in a transaction
   */
  async transaction<T>(
    fn: (db: SecureDatabase) => Promise<T>
  ): Promise<T> {
    const isNested = this.transactionDepth > 0;
    
    if (!isNested) {
      await this.run('BEGIN TRANSACTION');
    } else {
      await this.run(`SAVEPOINT sp_${this.transactionDepth}`);
    }
    
    this.transactionDepth++;
    
    try {
      const result = await fn(this);
      
      if (!isNested) {
        await this.run('COMMIT');
      } else {
        await this.run(`RELEASE SAVEPOINT sp_${this.transactionDepth - 1}`);
      }
      
      return result;
    } catch (error) {
      if (!isNested) {
        await this.run('ROLLBACK');
      } else {
        await this.run(`ROLLBACK TO SAVEPOINT sp_${this.transactionDepth - 1}`);
      }
      
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  /**
   * Prepare a statement for repeated use
   */
  prepare(sql: string): SecurePreparedStatement {
    // Validate SQL
    const sqlValidation = this.sqlProtection.validateInput(sql, 'string', 'sql_query');
    if (!sqlValidation.safe) {
      throw new Error(`Unsafe SQL query: ${sqlValidation.risks.join(', ')}`);
    }
    
    return new SecurePreparedStatement(this, sql);
  }

  /**
   * Validate parameters
   */
  private async validateParams(params: any[]): Promise<any[]> {
    const validated: any[] = [];
    
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const paramType = typeof param;
      
      // Skip null/undefined
      if (param === null || param === undefined) {
        validated.push(param);
        continue;
      }
      
      // Validate based on type
      let validation;
      if (paramType === 'string') {
        validation = this.sqlProtection.validateInput(param, 'string', 'parameter');
      } else if (paramType === 'number') {
        validation = this.sqlProtection.validateInput(param, 'number');
      } else if (paramType === 'boolean') {
        validation = this.sqlProtection.validateInput(param, 'boolean');
      } else {
        throw new Error(`Invalid parameter type at index ${i}: ${paramType}`);
      }
      
      if (!validation.safe) {
        throw new Error(`Unsafe parameter at index ${i}: ${validation.risks.join(', ')}`);
      }
      
      validated.push(validation.sanitized);
    }
    
    return validated;
  }

  /**
   * Log query execution
   */
  private async logQuery(
    operation: string,
    sql: string,
    params: any[]
  ): Promise<void> {
    if (!this.auditLogger) return;
    
    await this.auditLogger.log({
      eventType: 'DATA_READ',
      resource: 'database',
      action: 'EXECUTE',
      result: 'success',
      metadata: {
        operation,
        query: sql.substring(0, 200), // Truncate long queries
        paramCount: params.length
      }
    });
  }

  /**
   * Log query error
   */
  private async logQueryError(
    operation: string,
    sql: string,
    error: Error
  ): Promise<void> {
    if (!this.auditLogger) return;
    
    await this.auditLogger.log({
      eventType: 'ERROR_OCCURRED',
      resource: 'database',
      action: 'EXECUTE',
      result: 'failure',
      errorMessage: error.message,
      metadata: {
        operation,
        query: sql.substring(0, 200)
      }
    });
  }

  /**
   * Close database connection
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Secure prepared statement
 */
class SecurePreparedStatement {
  private db: SecureDatabase;
  private sql: string;
  private id: string;

  constructor(db: SecureDatabase, sql: string) {
    this.db = db;
    this.sql = sql;
    this.id = crypto.randomBytes(16).toString('hex');
  }

  async run(params: any[] = []): Promise<{ changes: number; lastID: number }> {
    return this.db.run(this.sql, params);
  }

  async get<T = any>(params: any[] = []): Promise<T | null> {
    return this.db.get<T>(this.sql, params);
  }

  async all<T = any>(params: any[] = []): Promise<T[]> {
    return this.db.query<T>(this.sql, params);
  }
}

/**
 * Repository pattern with SQL injection protection
 */
export class SecureRepository<T> {
  protected db: SecureDatabase;
  protected tableName: string;

  constructor(db: SecureDatabase, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  /**
   * Find by ID
   */
  async findById(id: number | string): Promise<T | null> {
    const sql = `SELECT * FROM ${this.tableName} WHERE id = ?`;
    return this.db.get<T>(sql, [id]);
  }

  /**
   * Find all with pagination
   */
  async findAll(options: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    order?: 'ASC' | 'DESC';
  } = {}): Promise<T[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const orderBy = this.sanitizeIdentifier(options.orderBy || 'id');
    const order = options.order === 'DESC' ? 'DESC' : 'ASC';
    
    const sql = `
      SELECT * FROM ${this.tableName}
      ORDER BY ${orderBy} ${order}
      LIMIT ? OFFSET ?
    `;
    
    return this.db.query<T>(sql, [limit, offset]);
  }

  /**
   * Find by criteria
   */
  async findBy(criteria: Record<string, any>): Promise<T[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    
    for (const [key, value] of Object.entries(criteria)) {
      const column = this.sanitizeIdentifier(key);
      
      if (value === null) {
        conditions.push(`${column} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(',');
        conditions.push(`${column} IN (${placeholders})`);
        params.push(...value);
      } else {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    
    const sql = `
      SELECT * FROM ${this.tableName}
      WHERE ${conditions.join(' AND ')}
    `;
    
    return this.db.query<T>(sql, params);
  }

  /**
   * Insert record
   */
  async insert(data: Partial<T>): Promise<number> {
    const columns: string[] = [];
    const placeholders: string[] = [];
    const params: any[] = [];
    
    for (const [key, value] of Object.entries(data)) {
      columns.push(this.sanitizeIdentifier(key));
      placeholders.push('?');
      params.push(value);
    }
    
    const sql = `
      INSERT INTO ${this.tableName} (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `;
    
    const result = await this.db.run(sql, params);
    return result.lastID;
  }

  /**
   * Update record
   */
  async update(id: number | string, data: Partial<T>): Promise<number> {
    const sets: string[] = [];
    const params: any[] = [];
    
    for (const [key, value] of Object.entries(data)) {
      sets.push(`${this.sanitizeIdentifier(key)} = ?`);
      params.push(value);
    }
    
    params.push(id);
    
    const sql = `
      UPDATE ${this.tableName}
      SET ${sets.join(', ')}
      WHERE id = ?
    `;
    
    const result = await this.db.run(sql, params);
    return result.changes;
  }

  /**
   * Delete record
   */
  async delete(id: number | string): Promise<number> {
    const sql = `DELETE FROM ${this.tableName} WHERE id = ?`;
    const result = await this.db.run(sql, [id]);
    return result.changes;
  }

  /**
   * Count records
   */
  async count(criteria?: Record<string, any>): Promise<number> {
    let sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
    const params: any[] = [];
    
    if (criteria && Object.keys(criteria).length > 0) {
      const conditions: string[] = [];
      
      for (const [key, value] of Object.entries(criteria)) {
        const column = this.sanitizeIdentifier(key);
        conditions.push(`${column} = ?`);
        params.push(value);
      }
      
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    const result = await this.db.get<{ count: number }>(sql, params);
    return result?.count || 0;
  }

  /**
   * Sanitize identifier (table/column name)
   */
  protected sanitizeIdentifier(identifier: string): string {
    // Only allow alphanumeric and underscore
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    
    return identifier;
  }
}

/**
 * Example usage for mining pool
 */
export class MinerRepository extends SecureRepository<{
  id: number;
  address: string;
  username: string;
  balance: number;
  created_at: string;
}> {
  constructor(db: SecureDatabase) {
    super(db, 'miners');
  }

  async findByAddress(address: string): Promise<any> {
    const miners = await this.findBy({ address });
    return miners[0] || null;
  }

  async updateBalance(minerId: number, amount: number): Promise<void> {
    await this.db.run(
      'UPDATE miners SET balance = balance + ? WHERE id = ?',
      [amount, minerId]
    );
  }

  async getTopMiners(limit: number = 10): Promise<any[]> {
    return this.db.query(
      `SELECT address, username, balance, 
       SUM(shares.difficulty) as total_difficulty
       FROM miners
       LEFT JOIN shares ON miners.id = shares.miner_id
       GROUP BY miners.id
       ORDER BY total_difficulty DESC
       LIMIT ?`,
      [limit]
    );
  }
}
