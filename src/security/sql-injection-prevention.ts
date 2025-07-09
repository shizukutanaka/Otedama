// SQL Injection Prevention System with Multi-layer Protection
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

interface QueryValidationResult {
  safe: boolean;
  sanitized?: string;
  risks: string[];
  confidence: number;
}

interface SQLPattern {
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  falsePositiveKeywords?: string[];
}

export class SQLInjectionPrevention extends EventEmitter {
  // Comprehensive SQL injection patterns
  private readonly INJECTION_PATTERNS: SQLPattern[] = [
    // Critical patterns
    {
      pattern: /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b.*\b(from|into|where|table|database)\b)/gi,
      severity: 'critical',
      description: 'SQL command injection'
    },
    {
      pattern: /(';|";|`)\s*(drop|delete|truncate|update|insert|exec)/gi,
      severity: 'critical',
      description: 'Command termination and execution'
    },
    {
      pattern: /(\b(sys|information_schema|mysql|performance_schema)\b\.\w+)/gi,
      severity: 'critical',
      description: 'System table access'
    },
    // High severity
    {
      pattern: /(\b(or|and)\b\s*["']?\d+["']?\s*=\s*["']?\d+["']?)/gi,
      severity: 'high',
      description: 'Boolean-based blind injection'
    },
    {
      pattern: /(\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*)/g,
      severity: 'high',
      description: 'SQL comment injection'
    },
    {
      pattern: /(\b(waitfor|sleep|benchmark|pg_sleep)\b\s*\()/gi,
      severity: 'high',
      description: 'Time-based blind injection'
    },
    // Medium severity
    {
      pattern: /(\b(concat|substring|ascii|char|hex)\b\s*\()/gi,
      severity: 'medium',
      description: 'String manipulation functions',
      falsePositiveKeywords: ['email', 'name', 'description']
    },
    {
      pattern: /(0x[0-9a-f]+)/gi,
      severity: 'medium',
      description: 'Hexadecimal values'
    },
    // Low severity
    {
      pattern: /([<>!=]+)/g,
      severity: 'low',
      description: 'Comparison operators',
      falsePositiveKeywords: ['email', 'html', 'xml']
    }
  ];
  
  // Safe parameter types
  private readonly SAFE_TYPES = new Set(['number', 'boolean']);
  
  // Prepared statement cache
  private preparedStatements: Map<string, PreparedStatement> = new Map();
  
  // Query execution history for anomaly detection
  private queryHistory: Map<string, QueryStats> = new Map();
  
  /**
   * Validate and sanitize input before it reaches the database
   */
  validateInput(
    input: any,
    expectedType: 'string' | 'number' | 'boolean' | 'array' | 'object',
    context?: string
  ): QueryValidationResult {
    const risks: string[] = [];
    let sanitized = input;
    let confidence = 1.0;
    
    // Type validation
    if (typeof input !== expectedType) {
      if (expectedType === 'number' && !isNaN(Number(input))) {
        sanitized = Number(input);
      } else if (expectedType === 'boolean') {
        sanitized = Boolean(input);
      } else {
        risks.push(`Type mismatch: expected ${expectedType}, got ${typeof input}`);
        confidence -= 0.3;
      }
    }
    
    // Skip detailed validation for safe types
    if (this.SAFE_TYPES.has(typeof sanitized)) {
      return { safe: true, sanitized: String(sanitized), risks, confidence };
    }
    
    // String validation
    if (typeof sanitized === 'string') {
      const validation = this.validateString(sanitized, context);
      risks.push(...validation.risks);
      sanitized = validation.sanitized;
      confidence *= validation.confidence;
    }
    
    // Array validation
    if (Array.isArray(sanitized)) {
      sanitized = sanitized.map(item => {
        const itemValidation = this.validateInput(item, 'string', context);
        risks.push(...itemValidation.risks);
        return itemValidation.sanitized;
      });
    }
    
    // Object validation
    if (typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)) {
      const sanitizedObj: any = {};
      for (const [key, value] of Object.entries(sanitized)) {
        const keyValidation = this.validateString(key, 'object_key');
        const valueValidation = this.validateInput(value, typeof value as any, context);
        
        risks.push(...keyValidation.risks, ...valueValidation.risks);
        sanitizedObj[keyValidation.sanitized as string] = valueValidation.sanitized;
      }
      sanitized = sanitizedObj;
    }
    
    const safe = risks.filter(r => !r.includes('low severity')).length === 0;
    
    if (!safe) {
      this.emit('sql_injection_attempt', {
        input: input.toString().substring(0, 100),
        risks,
        context,
        timestamp: new Date()
      });
    }
    
    return { safe, sanitized, risks, confidence };
  }
  
  /**
   * Validate string input for SQL injection patterns
   */
  private validateString(input: string, context?: string): QueryValidationResult {
    const risks: string[] = [];
    let sanitized = input;
    let confidence = 1.0;
    
    // Length check
    if (input.length > 10000) {
      risks.push('Input too long - potential buffer overflow');
      sanitized = input.substring(0, 10000);
      confidence -= 0.2;
    }
    
    // Pattern matching
    for (const patternDef of this.INJECTION_PATTERNS) {
      const matches = input.match(patternDef.pattern);
      if (matches) {
        // Check for false positives
        const isFalsePositive = context && 
          patternDef.falsePositiveKeywords?.some(keyword => 
            context.toLowerCase().includes(keyword)
          );
        
        if (!isFalsePositive) {
          risks.push(`${patternDef.severity} severity: ${patternDef.description}`);
          
          // Apply confidence penalty based on severity
          switch (patternDef.severity) {
            case 'critical':
              confidence -= 0.5;
              break;
            case 'high':
              confidence -= 0.3;
              break;
            case 'medium':
              confidence -= 0.1;
              break;
            case 'low':
              confidence -= 0.05;
              break;
          }
        }
      }
    }
    
    // Advanced sanitization
    sanitized = this.sanitizeString(sanitized);
    
    // Context-specific validation
    if (context) {
      const contextValidation = this.validateContext(sanitized, context);
      risks.push(...contextValidation.risks);
      confidence *= contextValidation.confidence;
    }
    
    return { safe: risks.length === 0, sanitized, risks, confidence: Math.max(0, confidence) };
  }
  
  /**
   * Sanitize string by escaping dangerous characters
   */
  private sanitizeString(input: string): string {
    // Escape single quotes
    let sanitized = input.replace(/'/g, "''");
    
    // Escape backslashes
    sanitized = sanitized.replace(/\\/g, '\\\\');
    
    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');
    
    // Escape special characters in LIKE clauses
    sanitized = sanitized.replace(/([%_])/g, '\\$1');
    
    // Remove or escape other dangerous characters
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
    
    return sanitized;
  }
  
  /**
   * Context-specific validation
   */
  private validateContext(input: string, context: string): { risks: string[]; confidence: number } {
    const risks: string[] = [];
    let confidence = 1.0;
    
    switch (context) {
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
          risks.push('Invalid email format');
          confidence -= 0.2;
        }
        break;
        
      case 'username':
        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(input)) {
          risks.push('Invalid username format');
          confidence -= 0.2;
        }
        break;
        
      case 'bitcoin_address':
        if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(input)) {
          risks.push('Invalid Bitcoin address format');
          confidence -= 0.3;
        }
        break;
        
      case 'numeric_id':
        if (!/^\d+$/.test(input)) {
          risks.push('Non-numeric ID');
          confidence -= 0.5;
        }
        break;
    }
    
    return { risks, confidence };
  }
  
  /**
   * Create a safe prepared statement
   */
  prepareSafeQuery(
    template: string,
    params: any[],
    paramTypes?: Array<'string' | 'number' | 'boolean'>
  ): PreparedStatement {
    const queryHash = createHash('sha256').update(template).digest('hex');
    
    // Check cache
    let statement = this.preparedStatements.get(queryHash);
    if (!statement) {
      statement = new PreparedStatement(template, paramTypes);
      this.preparedStatements.set(queryHash, statement);
    }
    
    // Validate parameters
    const validatedParams = params.map((param, index) => {
      const expectedType = paramTypes?.[index] || 'string';
      const validation = this.validateInput(param, expectedType);
      
      if (!validation.safe) {
        throw new Error(`Unsafe parameter at index ${index}: ${validation.risks.join(', ')}`);
      }
      
      return validation.sanitized;
    });
    
    statement.bind(validatedParams);
    return statement;
  }
  
  /**
   * Detect anomalous query patterns
   */
  detectAnomalies(userId: string, query: string): boolean {
    const userStats = this.queryHistory.get(userId) || {
      queries: new Map(),
      totalQueries: 0,
      lastQuery: Date.now()
    };
    
    const now = Date.now();
    const timeSinceLastQuery = now - userStats.lastQuery;
    
    // Rapid query detection
    if (timeSinceLastQuery < 100) { // Less than 100ms
      this.emit('anomaly_detected', {
        type: 'rapid_queries',
        userId,
        interval: timeSinceLastQuery
      });
      return true;
    }
    
    // Unusual query pattern
    const queryPattern = this.getQueryPattern(query);
    const queryCount = userStats.queries.get(queryPattern) || 0;
    
    if (queryCount > 100) { // Same pattern repeated many times
      this.emit('anomaly_detected', {
        type: 'repetitive_queries',
        userId,
        pattern: queryPattern,
        count: queryCount
      });
      return true;
    }
    
    // Update stats
    userStats.queries.set(queryPattern, queryCount + 1);
    userStats.totalQueries++;
    userStats.lastQuery = now;
    this.queryHistory.set(userId, userStats);
    
    // Cleanup old stats periodically
    if (userStats.totalQueries % 1000 === 0) {
      this.cleanupQueryHistory(userId);
    }
    
    return false;
  }
  
  /**
   * Generate a pattern signature for a query
   */
  private getQueryPattern(query: string): string {
    // Remove values and keep structure
    let pattern = query.toLowerCase();
    
    // Remove string values
    pattern = pattern.replace(/'[^']*'/g, '?');
    pattern = pattern.replace(/"[^"]*"/g, '?');
    
    // Remove numeric values
    pattern = pattern.replace(/\b\d+\b/g, '?');
    
    // Remove whitespace variations
    pattern = pattern.replace(/\s+/g, ' ').trim();
    
    return pattern;
  }
  
  /**
   * Cleanup old query history
   */
  private cleanupQueryHistory(userId: string): void {
    const stats = this.queryHistory.get(userId);
    if (!stats) return;
    
    // Keep only top 100 patterns
    const sortedPatterns = Array.from(stats.queries.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);
    
    stats.queries = new Map(sortedPatterns);
  }
  
  /**
   * Generate SQL injection report
   */
  generateSecurityReport(): {
    totalAttempts: number;
    blockedQueries: number;
    topPatterns: Array<{ pattern: string; count: number }>;
    riskDistribution: Record<string, number>;
  } {
    // This would aggregate data from monitoring
    return {
      totalAttempts: 0,
      blockedQueries: 0,
      topPatterns: [],
      riskDistribution: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0
      }
    };
  }
}

/**
 * Prepared statement implementation
 */
class PreparedStatement {
  private template: string;
  private paramTypes?: Array<'string' | 'number' | 'boolean'>;
  private boundParams: any[] = [];
  
  constructor(template: string, paramTypes?: Array<'string' | 'number' | 'boolean'>) {
    this.template = template;
    this.paramTypes = paramTypes;
  }
  
  bind(params: any[]): void {
    if (this.paramTypes && params.length !== this.paramTypes.length) {
      throw new Error('Parameter count mismatch');
    }
    this.boundParams = params;
  }
  
  execute(): string {
    let query = this.template;
    let paramIndex = 0;
    
    // Replace placeholders with sanitized values
    query = query.replace(/\?/g, () => {
      if (paramIndex >= this.boundParams.length) {
        throw new Error('Not enough parameters bound');
      }
      
      const param = this.boundParams[paramIndex];
      const type = this.paramTypes?.[paramIndex];
      paramIndex++;
      
      // Format based on type
      if (type === 'number' || typeof param === 'number') {
        return String(param);
      } else if (type === 'boolean' || typeof param === 'boolean') {
        return param ? '1' : '0';
      } else {
        // String - already sanitized
        return `'${param}'`;
      }
    });
    
    if (paramIndex < this.boundParams.length) {
      throw new Error('Too many parameters bound');
    }
    
    return query;
  }
}

interface QueryStats {
  queries: Map<string, number>;
  totalQueries: number;
  lastQuery: number;
}

export default SQLInjectionPrevention;
