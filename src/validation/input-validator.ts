/**
 * 入力検証強化システム
 * SQLインジェクション、XSS、その他の攻撃を防御
 */

import { createError, ErrorCode } from '../errors/types';

export interface ValidationRule {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'email' | 'url' | 'ip' | 'custom';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  customValidator?: (value: any) => boolean | string;
  sanitize?: boolean;
  allowNull?: boolean;
}

export interface ValidationSchema {
  [key: string]: ValidationRule;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  sanitizedData?: any;
  securityThreats?: string[];
}

// 悪意のあるパターンの定義（事前コンパイル）
const SECURITY_PATTERNS = {
  // SQLインジェクション
  sqlInjection: [
    /('|(\\'))+.*(select|union|insert|update|delete|drop|create|alter|exec|execute|script)/i,
    /(union\s+all\s+select|union\s+select)/i,
    /('|\"|\`|\[|\]|\(|\)|;|--|\||\*|%|\?|<|>|=|!|&|\||\^|~|\+|-|\/|\\|\$|@|#|{|})/,
    /(or\s+1\s*=\s*1|and\s+1\s*=\s*1)/i,
    /(select\s+.*\s+from|insert\s+into|update\s+.*\s+set|delete\s+from)/i,
    /(sleep\s*\(|benchmark\s*\(|waitfor\s+delay)/i,
    /(information_schema|sys\.)/i,
    /(0x[0-9a-f]+|char\s*\()/i
  ],

  // XSS攻撃
  xss: [
    /<script[^>]*>[\s\S]*?<\/script>/gi,
    /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
    /<object[^>]*>[\s\S]*?<\/object>/gi,
    /<embed[^>]*>/gi,
    /<form[^>]*>[\s\S]*?<\/form>/gi,
    /on\w+\s*=\s*["'][^"']*["']/gi,
    /javascript\s*:/gi,
    /vbscript\s*:/gi,
    /data\s*:\s*text\/html/gi,
    /<meta[^>]*http-equiv/gi
  ],

  // NoSQLインジェクション
  nosqlInjection: [
    /\$where|\$ne|\$gt|\$lt|\$gte|\$lte|\$in|\$nin|\$and|\$or|\$not|\$nor/i,
    /\$regex|\$options|\$elemMatch|\$size|\$all|\$slice/i,
    /\$push|\$pull|\$pop|\$unset|\$set|\$inc|\$mul/i,
    /this\.|function\s*\(|eval\s*\(/i
  ],

  // コマンドインジェクション
  commandInjection: [
    /[;&|`$(){}[\]\\]/,
    /(rm|del|format|fdisk|shutdown|reboot|halt)/i,
    /(cat|type|more|less|head|tail)\s+/i,
    /(wget|curl|nc|netcat|telnet|ssh)/i,
    /(chmod|chown|passwd|su|sudo)/i,
    /(\||&&|;|>|<|>>|<<)/
  ],

  // パストラバーサル
  pathTraversal: [
    /\.\.\//,
    /\.\.\\/,
    /%2e%2e%2f/i,
    /%2e%2e%5c/i,
    /\.\.\/|\.\.\\|%252e%252e%252f/i,
    /\/etc\/passwd|\/etc\/shadow/i,
    /windows\\system32|winnt\\system32/i
  ],

  // 一般的な悪意のあるパターン
  malicious: [
    /<\?php|\?>/i,
    /<%[\s\S]*?%>/,
    /\${[\s\S]*?}/,
    /\#\{[\s\S]*?\}/,
    /eval\s*\(|exec\s*\(|system\s*\(/i,
    /base64_decode|gzinflate|str_rot13/i,
    /document\.cookie|window\.location/i
  ]
};

// 許可された文字セット
const ALLOWED_PATTERNS = {
  alphanumeric: /^[a-zA-Z0-9]+$/,
  username: /^[a-zA-Z0-9_-]{3,32}$/,
  email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
  ipv6: /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
  url: /^https?:\/\/[a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,})?(?:\/[^?\s]*)?(?:\?[^#\s]*)?(?:#[^\s]*)?$/,
  hex: /^[0-9a-fA-F]+$/,
  workerName: /^[a-zA-Z0-9._-]{1,64}$/,
  bitcoinAddress: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/
};

export class InputValidator {
  private static instance: InputValidator;
  private threatCache = new Map<string, boolean>();
  private cacheSize = 1000;

  public static getInstance(): InputValidator {
    if (!InputValidator.instance) {
      InputValidator.instance = new InputValidator();
    }
    return InputValidator.instance;
  }

  /**
   * スキーマベース検証
   */
  public validate(data: any, schema: ValidationSchema): ValidationResult {
    const errors: string[] = [];
    const securityThreats: string[] = [];
    const sanitizedData: any = {};

    for (const [field, rule] of Object.entries(schema)) {
      const value = data[field];
      
      // 必須チェック
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }

      // null許可チェック
      if (value === null || value === undefined) {
        if (rule.allowNull) {
          sanitizedData[field] = value;
          continue;
        } else if (!rule.required) {
          continue;
        }
      }

      // 型チェック
      const typeResult = this.validateType(value, rule.type);
      if (!typeResult.isValid) {
        errors.push(`${field}: ${typeResult.error}`);
        continue;
      }

      // セキュリティチェック
      const securityResult = this.checkSecurity(value, field);
      if (securityResult.threats.length > 0) {
        securityThreats.push(...securityResult.threats.map(threat => `${field}: ${threat}`));
        errors.push(`${field}: Security threat detected`);
        continue;
      }

      // 長さチェック
      if (rule.min !== undefined || rule.max !== undefined) {
        const lengthResult = this.validateLength(value, rule.min, rule.max);
        if (!lengthResult.isValid) {
          errors.push(`${field}: ${lengthResult.error}`);
          continue;
        }
      }

      // パターンチェック
      if (rule.pattern && typeof value === 'string') {
        if (!rule.pattern.test(value)) {
          errors.push(`${field}: Invalid format`);
          continue;
        }
      }

      // カスタムバリデーター
      if (rule.customValidator) {
        const customResult = rule.customValidator(value);
        if (customResult !== true) {
          errors.push(`${field}: ${typeof customResult === 'string' ? customResult : 'Validation failed'}`);
          continue;
        }
      }

      // サニタイズ
      sanitizedData[field] = rule.sanitize ? this.sanitize(value) : value;
    }

    return {
      isValid: errors.length === 0 && securityThreats.length === 0,
      errors,
      sanitizedData,
      securityThreats
    };
  }

  /**
   * 型検証
   */
  private validateType(value: any, type: string): { isValid: boolean; error?: string } {
    switch (type) {
      case 'string':
        if (typeof value !== 'string') {
          return { isValid: false, error: 'Must be a string' };
        }
        break;

      case 'number':
        if (typeof value !== 'number' || isNaN(value)) {
          return { isValid: false, error: 'Must be a valid number' };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return { isValid: false, error: 'Must be a boolean' };
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          return { isValid: false, error: 'Must be an array' };
        }
        break;

      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { isValid: false, error: 'Must be an object' };
        }
        break;

      case 'email':
        if (typeof value !== 'string' || !ALLOWED_PATTERNS.email.test(value)) {
          return { isValid: false, error: 'Must be a valid email address' };
        }
        break;

      case 'url':
        if (typeof value !== 'string' || !ALLOWED_PATTERNS.url.test(value)) {
          return { isValid: false, error: 'Must be a valid URL' };
        }
        break;

      case 'ip':
        if (typeof value !== 'string' || 
            (!ALLOWED_PATTERNS.ipv4.test(value) && !ALLOWED_PATTERNS.ipv6.test(value))) {
          return { isValid: false, error: 'Must be a valid IP address' };
        }
        break;
    }

    return { isValid: true };
  }

  /**
   * 長さ検証
   */
  private validateLength(value: any, min?: number, max?: number): { isValid: boolean; error?: string } {
    let length: number;

    if (typeof value === 'string' || Array.isArray(value)) {
      length = value.length;
    } else if (typeof value === 'number') {
      length = value;
    } else {
      return { isValid: true }; // 長さチェック不可能な型はスキップ
    }

    if (min !== undefined && length < min) {
      return { isValid: false, error: `Must be at least ${min} characters/items` };
    }

    if (max !== undefined && length > max) {
      return { isValid: false, error: `Must be at most ${max} characters/items` };
    }

    return { isValid: true };
  }

  /**
   * セキュリティチェック
   */
  public checkSecurity(value: any, field?: string): { isSecure: boolean; threats: string[] } {
    if (typeof value !== 'string') {
      return { isSecure: true, threats: [] };
    }

    // キャッシュチェック
    const cacheKey = `${field || ''}:${value}`;
    if (this.threatCache.has(cacheKey)) {
      const isThreat = this.threatCache.get(cacheKey)!;
      return { isSecure: !isThreat, threats: isThreat ? ['Cached threat'] : [] };
    }

    const threats: string[] = [];
    const lowerValue = value.toLowerCase();

    // SQLインジェクションチェック
    for (const pattern of SECURITY_PATTERNS.sqlInjection) {
      if (pattern.test(value)) {
        threats.push('SQL Injection attempt detected');
        break;
      }
    }

    // XSSチェック
    for (const pattern of SECURITY_PATTERNS.xss) {
      if (pattern.test(value)) {
        threats.push('XSS attempt detected');
        break;
      }
    }

    // NoSQLインジェクションチェック
    for (const pattern of SECURITY_PATTERNS.nosqlInjection) {
      if (pattern.test(value)) {
        threats.push('NoSQL Injection attempt detected');
        break;
      }
    }

    // コマンドインジェクションチェック
    for (const pattern of SECURITY_PATTERNS.commandInjection) {
      if (pattern.test(value)) {
        threats.push('Command Injection attempt detected');
        break;
      }
    }

    // パストラバーサルチェック
    for (const pattern of SECURITY_PATTERNS.pathTraversal) {
      if (pattern.test(value)) {
        threats.push('Path Traversal attempt detected');
        break;
      }
    }

    // 一般的な悪意のあるパターンチェック
    for (const pattern of SECURITY_PATTERNS.malicious) {
      if (pattern.test(value)) {
        threats.push('Malicious pattern detected');
        break;
      }
    }

    // キャッシュに保存（LRU）
    if (this.threatCache.size >= this.cacheSize) {
      const firstKey = this.threatCache.keys().next().value;
      this.threatCache.delete(firstKey);
    }
    this.threatCache.set(cacheKey, threats.length > 0);

    return { isSecure: threats.length === 0, threats };
  }

  /**
   * 入力値のサニタイズ
   */
  public sanitize(value: any): any {
    if (typeof value !== 'string') {
      return value;
    }

    return value
      .replace(/[<>\"']/g, '') // 危険な文字を除去
      .replace(/javascript:/gi, '') // JavaScriptプロトコルを除去
      .replace(/vbscript:/gi, '') // VBScriptプロトコルを除去
      .replace(/on\w+\s*=/gi, '') // イベントハンドラーを除去
      .trim(); // 前後の空白を除去
  }

  /**
   * 特定フィールド用のクイック検証
   */
  public validateWorkerName(name: string): ValidationResult {
    return this.validate({ name }, {
      name: {
        type: 'string',
        required: true,
        min: 1,
        max: 64,
        pattern: ALLOWED_PATTERNS.workerName,
        sanitize: true
      }
    });
  }

  public validateBitcoinAddress(address: string): ValidationResult {
    return this.validate({ address }, {
      address: {
        type: 'string',
        required: true,
        pattern: ALLOWED_PATTERNS.bitcoinAddress,
        sanitize: true
      }
    });
  }

  public validateEmail(email: string): ValidationResult {
    return this.validate({ email }, {
      email: {
        type: 'email',
        required: true,
        max: 254,
        sanitize: true
      }
    });
  }

  public validateIP(ip: string): ValidationResult {
    return this.validate({ ip }, {
      ip: {
        type: 'ip',
        required: true,
        sanitize: true
      }
    });
  }

  /**
   * バルク検証（大量データ用）
   */
  public validateBulk(items: any[], schema: ValidationSchema): ValidationResult[] {
    return items.map(item => this.validate(item, schema));
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      cacheSize: this.threatCache.size,
      maxCacheSize: this.cacheSize
    };
  }

  /**
   * キャッシュクリア
   */
  public clearCache(): void {
    this.threatCache.clear();
  }
}

// デフォルトスキーマ定義
export const DEFAULT_SCHEMAS = {
  minerAuth: {
    username: { type: 'string' as const, required: true, min: 3, max: 32, pattern: ALLOWED_PATTERNS.username, sanitize: true },
    password: { type: 'string' as const, required: true, min: 8, max: 128, sanitize: true },
    workerName: { type: 'string' as const, required: false, max: 64, pattern: ALLOWED_PATTERNS.workerName, sanitize: true }
  },

  submitShare: {
    jobId: { type: 'string' as const, required: true, min: 1, max: 64, pattern: ALLOWED_PATTERNS.hex, sanitize: true },
    nonce: { type: 'string' as const, required: true, pattern: ALLOWED_PATTERNS.hex, sanitize: true },
    result: { type: 'string' as const, required: true, pattern: ALLOWED_PATTERNS.hex, sanitize: true },
    workerId: { type: 'string' as const, required: true, min: 1, max: 64, sanitize: true }
  },

  apiRequest: {
    method: { type: 'string' as const, required: true, max: 50, sanitize: true },
    params: { type: 'object' as const, required: false },
    id: { type: 'number' as const, required: false }
  }
};

export default InputValidator;