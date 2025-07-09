// Configuration Validation System
import { PoolConfig } from '../config/pool';
import { Logger } from '../logging/logger';
import { AlertSystem } from '../alerts/alert-system';

export interface ValidationRule {
  check: (config: any) => boolean;
  message: string;
  severity: 'warning' | 'error';
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export class ConfigValidator {
  private rules: ValidationRule[] = [];
  private logger: Logger;
  private alertSystem: AlertSystem;

  constructor(private pool: any) {
    this.logger = Logger.getInstance();
    this.alertSystem = new AlertSystem(pool);
    this.initializeRules();
  }

  private initializeRules(): void {
    // Core configuration rules
    this.addRule({
      check: (config: PoolConfig) => config.rpcUrl && config.rpcUrl.trim(),
      message: 'RPC URL is required and must not be empty',
      severity: 'error'
    });

    this.addRule({
      check: (config: PoolConfig) => config.rpcUser && config.rpcUser.trim(),
      message: 'RPC username is required and must not be empty',
      severity: 'error'
    });

    this.addRule({
      check: (config: PoolConfig) => config.rpcPassword && config.rpcPassword.trim(),
      message: 'RPC password is required and must not be empty',
      severity: 'error'
    });

    this.addRule({
      check: (config: PoolConfig) => config.port > 0 && config.port <= 65535,
      message: 'Port number must be between 1 and 65535',
      severity: 'error'
    });

    // Performance-related rules
    this.addRule({
      check: (config: PoolConfig) => config.maxConnections > 0,
      message: 'Maximum connections must be greater than 0',
      severity: 'error'
    });

    this.addRule({
      check: (config: PoolConfig) => config.maxConnections <= 10000,
      message: 'Maximum connections should not exceed 10000',
      severity: 'warning'
    });

    // Security-related rules
    this.addRule({
      check: (config: PoolConfig) => config.security && config.security.enabled !== undefined,
      message: 'Security settings must be properly configured',
      severity: 'warning'
    });

    this.addRule({
      check: (config: PoolConfig) => config.security && config.security.whitelist.length > 0,
      message: 'Security whitelist should contain at least one IP address',
      severity: 'warning'
    });

    // Database-related rules
    this.addRule({
      check: (config: PoolConfig) => config.database && config.database.type,
      message: 'Database type must be specified',
      severity: 'error'
    });

    this.addRule({
      check: (config: PoolConfig) => config.database && config.database.path,
      message: 'Database path must be specified',
      severity: 'error'
    });

    // Logging-related rules
    this.addRule({
      check: (config: PoolConfig) => config.logging && config.logging.level,
      message: 'Logging level must be specified',
      severity: 'warning'
    });

    this.addRule({
      check: (config: PoolConfig) => config.logging && config.logging.logDirectory,
      message: 'Log directory must be specified',
      severity: 'warning'
    });
  }

  private addRule(rule: ValidationRule): void {
    this.rules.push(rule);
  }

  public validate(config: PoolConfig): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      warnings: [],
      errors: []
    };

    for (const rule of this.rules) {
      const isValid = rule.check(config);
      if (!isValid) {
        if (rule.severity === 'error') {
          result.errors.push(rule.message);
          result.valid = false;
        } else {
          result.warnings.push(rule.message);
        }
      }
    }

    // Log validation results
    if (result.errors.length > 0) {
      this.logger.error('Configuration validation failed:', result.errors);
      this.alertSystem.checkSecurityMetric('config_validation', result.errors.length, {
        errors: result.errors,
        warnings: result.warnings
      });
    } else if (result.warnings.length > 0) {
      this.logger.warn('Configuration validation completed with warnings:', result.warnings);
    } else {
      this.logger.info('Configuration validation successful');
    }

    return result;
  }

  public async validateAndStart(config: PoolConfig): Promise<boolean> {
    const result = this.validate(config);
    
    if (!result.valid) {
      throw new Error(`Configuration validation failed:\n${result.errors.join('\n')}`);
    }

    if (result.warnings.length > 0) {
      this.logger.warn('Starting with configuration warnings:\n' + result.warnings.join('\n'));
    }

    return true;
  }

  public async shutdown(): Promise<void> {
    await this.alertSystem.shutdown();
  }
}
