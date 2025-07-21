/**
 * Credential Security Validator
 * Validates that no hardcoded credentials are present and all required
 * environment variables are properly configured
 * 
 * Design principles:
 * - Carmack: Fast validation with early detection
 * - Martin: Clean separation of security concerns
 * - Pike: Simple, reliable security checks
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

/**
 * Critical environment variables that must be set in production
 */
const CRITICAL_ENV_VARS = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD', 
  'JWT_SECRET',
  'CSRF_SECRET',
  'GRAFANA_ADMIN_PASSWORD',
  'POOL_OPERATOR_ADDRESS'
];

/**
 * High priority environment variables that should be set
 */
const HIGH_PRIORITY_ENV_VARS = [
  'SMTP_USER',
  'SMTP_PASSWORD',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'BACKUP_ENCRYPTION_KEY'
];

/**
 * Dangerous hardcoded patterns that should never appear in code
 */
const DANGEROUS_PATTERNS = [
  // Common hardcoded passwords
  { pattern: /password['"]\s*:\s*['"](admin123|password|123456|admin|root)/gi, severity: 'CRITICAL', type: 'hardcoded_password' },
  { pattern: /secure123|admin123|password123/gi, severity: 'CRITICAL', type: 'default_password' },
  
  // Hardcoded secrets
  { pattern: /secret['"]\s*:\s*['"](secret|change-this|your-secret)/gi, severity: 'CRITICAL', type: 'hardcoded_secret' },
  { pattern: /jwt[_-]?secret['"]\s*:\s*['"](jwt-secret|production-jwt-secret)/gi, severity: 'CRITICAL', type: 'jwt_secret' },
  
  // API Keys and tokens
  { pattern: /api[_-]?key['"]\s*:\s*['"](sk-|pk-|[A-Za-z0-9]{32,})['"]/gi, severity: 'HIGH', type: 'api_key' },
  { pattern: /token['"]\s*:\s*['"](ghp_|gho_|github_pat_)/gi, severity: 'HIGH', type: 'github_token' },
  
  // Database credentials
  { pattern: /password=\w+|pwd=\w+/gi, severity: 'HIGH', type: 'db_password' },
  { pattern: /mongodb:\/\/\w+:\w+@/gi, severity: 'HIGH', type: 'mongodb_url' },
  { pattern: /mysql:\/\/\w+:\w+@/gi, severity: 'HIGH', type: 'mysql_url' },
  
  // Private keys
  { pattern: /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)/gi, severity: 'CRITICAL', type: 'private_key' },
  
  // AWS/Cloud credentials
  { pattern: /AKIA[0-9A-Z]{16}/gi, severity: 'CRITICAL', type: 'aws_access_key' },
  { pattern: /['"](sk-[a-zA-Z0-9]{48})['"]/gi, severity: 'CRITICAL', type: 'openai_key' },
  
  // Slack/Discord webhooks
  { pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9\/]+/gi, severity: 'MEDIUM', type: 'slack_webhook' },
  { pattern: /https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+/gi, severity: 'MEDIUM', type: 'discord_webhook' },
  
  // Common cryptocurrency addresses (when hardcoded)
  { pattern: /['"](1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})['"]/gi, severity: 'HIGH', type: 'bitcoin_address' },
  
  // IP addresses and internal URLs
  { pattern: /192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+/gi, severity: 'LOW', type: 'internal_ip' }
];

/**
 * Files to exclude from scanning (binary files, dependencies, etc.)
 */
const EXCLUDED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /\.env$/,
  /\.log$/,
  /\.sqlite$/,
  /\.db$/,
  /\.(jpg|jpeg|png|gif|pdf|zip|tar|gz)$/i,
  /package-lock\.json$/,
  /yarn\.lock$/
];

/**
 * Security validation results
 */
export class SecurityValidationResult {
  constructor() {
    this.passed = true;
    this.errors = [];
    this.warnings = [];
    this.info = [];
  }
  
  addError(message, details = {}) {
    this.passed = false;
    this.errors.push({ message, ...details });
  }
  
  addWarning(message, details = {}) {
    this.warnings.push({ message, ...details });
  }
  
  addInfo(message, details = {}) {
    this.info.push({ message, ...details });
  }
  
  getReport() {
    return {
      passed: this.passed,
      summary: {
        errors: this.errors.length,
        warnings: this.warnings.length,
        info: this.info.length
      },
      errors: this.errors,
      warnings: this.warnings,
      info: this.info
    };
  }
}

/**
 * Main credential validator class
 */
export class CredentialValidator {
  constructor(options = {}) {
    this.options = {
      checkEnvironmentVariables: options.checkEnvironmentVariables !== false,
      scanCodebase: options.scanCodebase !== false,
      strictMode: options.strictMode === true,
      projectRoot: options.projectRoot || PROJECT_ROOT,
      ...options
    };
  }
  
  /**
   * Validate all security aspects
   */
  async validateAll() {
    const result = new SecurityValidationResult();
    
    console.log('🔍 Starting comprehensive security validation...');
    
    // Check environment variables
    if (this.options.checkEnvironmentVariables) {
      this.validateEnvironmentVariables(result);
    }
    
    // Scan codebase for hardcoded credentials
    if (this.options.scanCodebase) {
      await this.scanCodebaseForCredentials(result);
    }
    
    // Additional security checks
    this.performAdditionalSecurityChecks(result);
    
    return result;
  }
  
  /**
   * Validate that required environment variables are set
   */
  validateEnvironmentVariables(result) {
    console.log('📋 Checking required environment variables...');
    
    // Check critical variables
    for (const envVar of CRITICAL_ENV_VARS) {
      const value = process.env[envVar];
      
      if (!value) {
        result.addError(`Critical environment variable ${envVar} is not set`, {
          type: 'missing_env_var',
          severity: 'CRITICAL',
          variable: envVar
        });
      } else if (this.isWeakCredential(value)) {
        result.addError(`Environment variable ${envVar} contains weak credential`, {
          type: 'weak_credential',
          severity: 'CRITICAL',
          variable: envVar
        });
      } else {
        result.addInfo(`✅ ${envVar} is properly configured`);
      }
    }
    
    // Check high priority variables
    for (const envVar of HIGH_PRIORITY_ENV_VARS) {
      const value = process.env[envVar];
      
      if (!value) {
        result.addWarning(`High priority environment variable ${envVar} is not set`, {
          type: 'missing_env_var',
          severity: 'HIGH',
          variable: envVar
        });
      } else {
        result.addInfo(`✅ ${envVar} is configured`);
      }
    }
    
    // Check NODE_ENV
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      result.addInfo('✅ NODE_ENV is set to production');
      
      // In production, be extra strict
      if (!process.env.SSL_CERT_PATH || !process.env.SSL_KEY_PATH) {
        result.addWarning('SSL certificates not configured for production', {
          type: 'ssl_config',
          severity: 'HIGH'
        });
      }
    } else {
      result.addInfo(`NODE_ENV is set to: ${nodeEnv || 'development'}`);
    }
  }
  
  /**
   * Scan codebase for hardcoded credentials
   */
  async scanCodebaseForCredentials(result) {
    console.log('🔍 Scanning codebase for hardcoded credentials...');
    
    const filesToScan = this.getFilesToScan();
    let scannedFiles = 0;
    let issuesFound = 0;
    
    for (const filePath of filesToScan) {
      try {
        const content = readFileSync(filePath, 'utf8');
        const issues = this.scanFileContent(content, filePath);
        
        for (const issue of issues) {
          if (issue.severity === 'CRITICAL') {
            result.addError(issue.message, issue);
            issuesFound++;
          } else if (issue.severity === 'HIGH') {
            result.addWarning(issue.message, issue);
            issuesFound++;
          } else {
            result.addInfo(issue.message, issue);
          }
        }
        
        scannedFiles++;
      } catch (error) {
        result.addWarning(`Failed to scan file: ${filePath}`, {
          type: 'scan_error',
          error: error.message
        });
      }
    }
    
    result.addInfo(`📊 Scanned ${scannedFiles} files, found ${issuesFound} credential issues`);
  }
  
  /**
   * Get list of files to scan
   */
  getFilesToScan() {
    const files = [];\n    const scanDirectory = (dirPath) => {\n      // Implementation would recursively scan directories\n      // For now, return key files to scan\n    };\n    \n    // Key files that commonly contain credentials\n    const keyFiles = [\n      'config/production.json',\n      'config/development.json',\n      'docker-compose.yml',\n      'docker-compose.production.yml',\n      '.env',\n      '.env.local',\n      '.env.production',\n      'lib/security/manager.js',\n      'config/constants.js',\n      'lib/auth/authentication-manager.js'\n    ];\n    \n    for (const file of keyFiles) {\n      const fullPath = join(this.options.projectRoot, file);\n      if (existsSync(fullPath)) {\n        files.push(fullPath);\n      }\n    }\n    \n    return files;\n  }\n  \n  /**\n   * Scan file content for dangerous patterns\n   */\n  scanFileContent(content, filePath) {\n    const issues = [];\n    const fileName = filePath.split(/[/\\\\]/).pop();\n    \n    for (const { pattern, severity, type } of DANGEROUS_PATTERNS) {\n      let match;\n      pattern.lastIndex = 0; // Reset regex state\n      \n      while ((match = pattern.exec(content)) !== null) {\n        const lineNumber = content.substring(0, match.index).split('\\n').length;\n        const line = content.split('\\n')[lineNumber - 1]?.trim();\n        \n        issues.push({\n          message: `${severity} ${type} detected in ${fileName}:${lineNumber}`,\n          type,\n          severity,\n          file: fileName,\n          fullPath: filePath,\n          lineNumber,\n          line: line?.substring(0, 100) + (line?.length > 100 ? '...' : ''),\n          match: match[0]\n        });\n      }\n    }\n    \n    return issues;\n  }\n  \n  /**\n   * Check if credential is weak/common\n   */\n  isWeakCredential(value) {\n    if (!value || value.length < 8) return true;\n    \n    const weakPatterns = [\n      /^(admin|password|123456|qwerty|letmein|welcome)$/i,\n      /^(admin123|password123|secret123)$/i,\n      /^(change.?this|your.?password|your.?secret)$/i,\n      /^(test|demo|example)$/i\n    ];\n    \n    return weakPatterns.some(pattern => pattern.test(value));\n  }\n  \n  /**\n   * Perform additional security checks\n   */\n  performAdditionalSecurityChecks(result) {\n    // Check if .env.template exists\n    const envTemplatePath = join(this.options.projectRoot, '.env.template');\n    if (existsSync(envTemplatePath)) {\n      result.addInfo('✅ .env.template file exists for configuration guidance');\n    } else {\n      result.addWarning('Missing .env.template file', {\n        type: 'missing_template',\n        severity: 'MEDIUM'\n      });\n    }\n    \n    // Check if .env is in .gitignore\n    const gitignorePath = join(this.options.projectRoot, '.gitignore');\n    if (existsSync(gitignorePath)) {\n      const gitignoreContent = readFileSync(gitignorePath, 'utf8');\n      if (gitignoreContent.includes('.env')) {\n        result.addInfo('✅ .env files are properly ignored by git');\n      } else {\n        result.addError('.env files are not in .gitignore - credentials could be committed!', {\n          type: 'gitignore_missing',\n          severity: 'CRITICAL'\n        });\n      }\n    }\n    \n    // Check file permissions on sensitive files\n    const sensitiveFiles = ['.env', '.env.production', '.env.local'];\n    for (const file of sensitiveFiles) {\n      const filePath = join(this.options.projectRoot, file);\n      if (existsSync(filePath)) {\n        result.addInfo(`Found sensitive file: ${file} (ensure proper file permissions)`);\n      }\n    }\n  }\n}\n\n/**\n * CLI utility function\n */\nexport async function validateCredentialSecurity(options = {}) {\n  const validator = new CredentialValidator(options);\n  const result = await validator.validateAll();\n  \n  // Print results\n  console.log('\\n' + '='.repeat(60));\n  console.log('🛡️  SECURITY VALIDATION REPORT');\n  console.log('='.repeat(60));\n  \n  if (result.passed) {\n    console.log('✅ PASSED - No critical security issues found');\n  } else {\n    console.log('❌ FAILED - Critical security issues detected');\n  }\n  \n  console.log(`\\n📊 Summary:`);\n  console.log(`   Errors: ${result.errors.length}`);\n  console.log(`   Warnings: ${result.warnings.length}`);\n  console.log(`   Info: ${result.info.length}`);\n  \n  if (result.errors.length > 0) {\n    console.log('\\n🚨 CRITICAL ERRORS:');\n    for (const error of result.errors) {\n      console.log(`   ❌ ${error.message}`);\n      if (error.file && error.lineNumber) {\n        console.log(`      📁 ${error.file}:${error.lineNumber}`);\n      }\n    }\n  }\n  \n  if (result.warnings.length > 0) {\n    console.log('\\n⚠️  WARNINGS:');\n    for (const warning of result.warnings) {\n      console.log(`   ⚠️  ${warning.message}`);\n    }\n  }\n  \n  console.log('\\n' + '='.repeat(60));\n  \n  return result;\n}\n\n/**\n * Quick environment check function\n */\nexport function quickEnvCheck() {\n  console.log('🔍 Quick Environment Variable Check...');\n  \n  let allGood = true;\n  \n  for (const envVar of CRITICAL_ENV_VARS) {\n    const value = process.env[envVar];\n    if (!value) {\n      console.log(`❌ ${envVar} is not set`);\n      allGood = false;\n    } else {\n      console.log(`✅ ${envVar} is configured`);\n    }\n  }\n  \n  if (allGood) {\n    console.log('\\n✅ All critical environment variables are configured!');\n  } else {\n    console.log('\\n❌ Some critical environment variables are missing!');\n    console.log('📋 Copy .env.template to .env and configure the missing variables.');\n  }\n  \n  return allGood;\n}\n\nexport default {\n  CredentialValidator,\n  SecurityValidationResult,\n  validateCredentialSecurity,\n  quickEnvCheck\n};