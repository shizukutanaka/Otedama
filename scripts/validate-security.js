#!/usr/bin/env node

/**
 * Security Validation Script
 * Runs comprehensive security checks to ensure no hardcoded credentials
 * and proper environment configuration
 */

import { validateCredentialSecurity, quickEnvCheck } from '../lib/security/credential-validator.js';
import { existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(process.cwd());

async function main() {
  console.log('🛡️  Otedama Security Validation');
  console.log('================================\n');
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  const quickMode = args.includes('--quick');
  const envMode = args.includes('--env-only');
  
  if (quickMode) {
    console.log('Running quick environment check...\n');
    const envCheck = quickEnvCheck();
    process.exit(envCheck ? 0 : 1);
  }
  
  if (envMode) {
    console.log('Validating environment variables only...\n');
    const result = await validateCredentialSecurity({
      checkEnvironmentVariables: true,
      scanCodebase: false
    });
    process.exit(result.passed ? 0 : 1);
  }
  
  // Check if we're in production
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    console.log('🔴 Production mode detected - enabling strict validation\n');
  }
  
  // Check if .env template exists
  const envTemplatePath = join(PROJECT_ROOT, '.env.template');
  if (!existsSync(envTemplatePath)) {
    console.log('⚠️  .env.template file not found - consider creating one for configuration guidance\n');
  }
  
  // Check if .env file exists
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath) && isProduction) {
    console.log('❌ .env file not found in production mode!');
    console.log('📋 Copy .env.template to .env and configure your credentials\n');
  }
  
  try {
    // Run comprehensive validation
    const result = await validateCredentialSecurity({
      strictMode: isProduction,
      projectRoot: PROJECT_ROOT
    });
    
    // Output detailed results
    const report = result.getReport();
    
    console.log('\\n📋 Detailed Results:');
    console.log('-'.repeat(40));
    
    if (report.errors.length > 0) {
      console.log('\\n🚨 CRITICAL ISSUES (must fix):');
      for (let i = 0; i < report.errors.length; i++) {\n        const error = report.errors[i];\n        console.log(`${i + 1}. ${error.message}`);\n        if (error.file) console.log(`   📁 ${error.file}:${error.lineNumber || '?'}`);\n        if (error.variable) console.log(`   🔑 Variable: ${error.variable}`);\n        if (error.type) console.log(`   🏷️  Type: ${error.type}`);\n      }\n    }\n    \n    if (report.warnings.length > 0) {\n      console.log('\\n⚠️  WARNINGS (should fix):');\n      for (let i = 0; i < report.warnings.length; i++) {\n        const warning = report.warnings[i];\n        console.log(`${i + 1}. ${warning.message}`);\n        if (warning.file) console.log(`   📁 ${warning.file}:${warning.lineNumber || '?'}`);\n      }\n    }\n    \n    // Security recommendations\n    console.log('\\n🔒 Security Recommendations:');\n    console.log('-'.repeat(40));\n    console.log('1. Use strong, unique passwords (minimum 12 characters)');\n    console.log('2. Enable 2FA for all admin accounts');\n    console.log('3. Rotate secrets regularly (every 90 days)');\n    console.log('4. Use a secrets management system in production');\n    console.log('5. Monitor for unauthorized access attempts');\n    console.log('6. Keep dependencies updated');\n    console.log('7. Use HTTPS/TLS for all communications');\n    \n    if (isProduction) {\n      console.log('\\n🔴 Production Security Checklist:');\n      console.log('- [ ] All environment variables configured');\n      console.log('- [ ] SSL certificates installed');\n      console.log('- [ ] Firewall configured');\n      console.log('- [ ] Monitoring enabled');\n      console.log('- [ ] Backups configured');\n      console.log('- [ ] Incident response plan ready');\n    }\n    \n    // Exit with appropriate code\n    if (result.passed) {\n      console.log('\\n✅ Security validation PASSED');\n      console.log('Your application appears to be properly configured!');\n      process.exit(0);\n    } else {\n      console.log('\\n❌ Security validation FAILED');\n      console.log('Please fix the critical issues before deployment.');\n      process.exit(1);\n    }\n    \n  } catch (error) {\n    console.error('\\n💥 Security validation failed with error:');\n    console.error(error.message);\n    if (process.env.DEBUG) {\n      console.error(error.stack);\n    }\n    process.exit(1);\n  }\n}\n\n// Handle process signals\nprocess.on('SIGINT', () => {\n  console.log('\\n⚠️  Security validation interrupted');\n  process.exit(130);\n});\n\nprocess.on('SIGTERM', () => {\n  console.log('\\n⚠️  Security validation terminated');\n  process.exit(143);\n});\n\nif (import.meta.url === `file://${process.argv[1]}`) {\n  main().catch(error => {\n    console.error('Fatal error:', error);\n    process.exit(1);\n  });\n}