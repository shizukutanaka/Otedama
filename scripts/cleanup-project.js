/**
 * Clean up duplicate and obsolete files in Otedama project
 * Following Rob Pike's principle: simplicity through elimination
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.join(__dirname, '..');

class ProjectCleaner {
  constructor() {
    this.deletedFiles = [];
    this.deletedDirs = [];
    this.errors = [];
    this.mergedFiles = [];
  }

  async clean() {
    console.log('Starting Otedama project cleanup...\n');
    
    // Phase 1: Delete obvious obsolete directories
    await this.deleteObsoleteDirectories();
    
    // Phase 2: Delete backup files
    await this.deleteBackupFiles();
    
    // Phase 3: Merge duplicate security modules
    await this.mergeSecurityModules();
    
    // Phase 4: Clean up duplicate network modules
    await this.cleanNetworkModules();
    
    // Phase 5: Clean up duplicate storage modules
    await this.cleanStorageModules();
    
    // Generate report
    this.generateReport();
  }

  async deleteObsoleteDirectories() {
    console.log('Phase 1: Deleting obsolete directories...');
    
    const obsoleteDirs = [
      'old_files',
      'lib/old_auth_to_delete',
      '.claude'
    ];
    
    for (const dir of obsoleteDirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          this.deletedDirs.push(dir);
          console.log(`  ✓ Deleted: ${dir}`);
        } catch (error) {
          this.errors.push({ path: dir, error: error.message });
          console.log(`  ✗ Error deleting ${dir}: ${error.message}`);
        }
      }
    }
  }

  async deleteBackupFiles() {
    console.log('\nPhase 2: Deleting backup files...');
    
    const scanDirectory = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
          if (item.name !== 'node_modules' && item.name !== '.git') {
            scanDirectory(fullPath);
          }
        } else if (item.isFile()) {
          // Delete .bak files and _old_ files
          if (item.name.endsWith('.bak') || item.name.startsWith('_old_')) {
            try {
              fs.unlinkSync(fullPath);
              this.deletedFiles.push(path.relative(projectRoot, fullPath));
              console.log(`  ✓ Deleted: ${path.relative(projectRoot, fullPath)}`);
            } catch (error) {
              this.errors.push({ path: fullPath, error: error.message });
            }
          }
        }
      }
    };
    
    scanDirectory(projectRoot);
  }

  async mergeSecurityModules() {
    console.log('\nPhase 3: Merging security modules...');
    
    const securityDir = path.join(projectRoot, 'lib/security');
    
    // Define which files to keep and which to remove
    const mergeMap = {
      // Keep the most comprehensive versions
      'index.js': ['manager.js', 'security-manager.js', 'core.js'],
      'ddos-protection.js': ['enhanced-ddos-protection.js'],
      'rate-limiter.js': ['advanced-rate-limiter.js'],
      'audit-compliance.js': ['audit.js', 'unified-audit-manager.js'],
      'auth-manager.js': ['enhanced-auth-system.js', 'multi-factor-auth.js'],
      'national-security.js': ['enhanced-security-system.js', 'comprehensive-security-middleware.js'],
      'advanced-threat-detection.js': ['ai-anomaly-detection.js', 'advanced-attack-protection.js']
    };
    
    // Create unified security index
    const unifiedIndex = `/**
 * Unified Security Module for Otedama
 * Combines all security features into a clean, maintainable structure
 * 
 * Design principles:
 * - Carmack: Performance-critical security operations
 * - Martin: Clean separation of concerns
 * - Pike: Simple, composable security components
 */

// Core security components
export { DDoSProtection } from './ddos-protection.js';
export { RateLimiter } from './rate-limiter.js';
export { AuditCompliance } from './audit-compliance.js';
export { AuthManager } from './auth-manager.js';
export { InputValidator } from './input-validator.js';
export { EncryptionManager } from './encryption-manager.js';

// Advanced security features
export { ThreatDetection } from './advanced-threat-detection.js';
export { NationalSecurity } from './national-security.js';
export { ZKPComplianceSystem } from '../zkp/zkp-compliance.js';

// Network security
export { NetworkSecurity } from './network-security.js';
export { MTLSImplementation } from './mtls-implementation.js';

// Session and authentication
export { SessionManager } from './session-manager.js';
export { CSRFProtection } from './csrf-protection.js';

// Specialized features
export { MEVProtection } from './mev-protection.js';
export { FeeProtection } from './fee-protection.js';
export { MultiSignature } from './multi-signature.js';

// Security middleware
export { createSecurityMiddleware } from './unified-security-middleware.js';

// Default security manager
class SecurityManager {
  constructor(options = {}) {
    this.ddos = new DDoSProtection(options.ddos);
    this.rateLimiter = new RateLimiter(options.rateLimit);
    this.auth = new AuthManager(options.auth);
    this.audit = new AuditCompliance(options.audit);
    this.threat = new ThreatDetection(options.threat);
    this.zkp = new ZKPComplianceSystem(options.zkp);
  }
  
  async initialize() {
    await Promise.all([
      this.ddos.initialize(),
      this.rateLimiter.initialize(),
      this.auth.initialize(),
      this.audit.initialize(),
      this.threat.initialize(),
      this.zkp.initialize()
    ]);
  }
  
  middleware() {
    return createSecurityMiddleware({
      ddos: this.ddos,
      rateLimiter: this.rateLimiter,
      auth: this.auth,
      audit: this.audit,
      threat: this.threat
    });
  }
  
  async shutdown() {
    await Promise.all([
      this.ddos.shutdown(),
      this.rateLimiter.shutdown(),
      this.auth.shutdown(),
      this.audit.shutdown(),
      this.threat.shutdown(),
      this.zkp.shutdown()
    ]);
  }
}

export default SecurityManager;
`;
    
    // Write unified index
    fs.writeFileSync(path.join(securityDir, 'index.js'), unifiedIndex);
    console.log('  ✓ Created unified security index');
    
    // Delete redundant files
    for (const [keep, deleteList] of Object.entries(mergeMap)) {
      for (const file of deleteList) {
        const fullPath = path.join(securityDir, file);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
            this.deletedFiles.push(`lib/security/${file}`);
            console.log(`  ✓ Merged ${file} into ${keep}`);
          } catch (error) {
            this.errors.push({ path: fullPath, error: error.message });
          }
        }
      }
    }
  }

  async cleanNetworkModules() {
    console.log('\nPhase 4: Cleaning network modules...');
    
    const networkDir = path.join(projectRoot, 'lib/network');
    
    // Remove duplicate implementations
    const toDelete = [
      'p2p-network-old.js',
      'stratum-server-basic.js',
      'websocket-server-old.js'
    ];
    
    for (const file of toDelete) {
      const fullPath = path.join(networkDir, file);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          this.deletedFiles.push(`lib/network/${file}`);
          console.log(`  ✓ Deleted: ${file}`);
        } catch (error) {
          this.errors.push({ path: fullPath, error: error.message });
        }
      }
    }
  }

  async cleanStorageModules() {
    console.log('\nPhase 5: Cleaning storage modules...');
    
    const storageDir = path.join(projectRoot, 'lib/storage');
    
    // Check for duplicate database implementations
    const files = fs.readdirSync(storageDir);
    const dbFiles = files.filter(f => f.includes('database') || f.includes('db-'));
    
    if (dbFiles.length > 2) {
      console.log(`  Found ${dbFiles.length} database-related files, consolidating...`);
      // Keep only the main database.js and index.js
      const toKeep = ['database.js', 'index.js', 'cache-manager.js'];
      
      for (const file of dbFiles) {
        if (!toKeep.includes(file)) {
          const fullPath = path.join(storageDir, file);
          try {
            fs.unlinkSync(fullPath);
            this.deletedFiles.push(`lib/storage/${file}`);
            console.log(`  ✓ Deleted: ${file}`);
          } catch (error) {
            this.errors.push({ path: fullPath, error: error.message });
          }
        }
      }
    }
  }

  generateReport() {
    console.log('\n\n=== CLEANUP REPORT ===');
    console.log('─'.repeat(50));
    
    console.log(`\nDeleted Directories: ${this.deletedDirs.length}`);
    this.deletedDirs.forEach(dir => console.log(`  - ${dir}`));
    
    console.log(`\nDeleted Files: ${this.deletedFiles.length}`);
    
    // Group by directory
    const filesByDir = {};
    this.deletedFiles.forEach(file => {
      const dir = path.dirname(file);
      if (!filesByDir[dir]) filesByDir[dir] = [];
      filesByDir[dir].push(path.basename(file));
    });
    
    Object.entries(filesByDir).forEach(([dir, files]) => {
      console.log(`\n  ${dir}:`);
      files.forEach(file => console.log(`    - ${file}`));
    });
    
    if (this.errors.length > 0) {
      console.log(`\nErrors: ${this.errors.length}`);
      this.errors.forEach(({ path, error }) => {
        console.log(`  ✗ ${path}: ${error}`);
      });
    }
    
    console.log('\n─'.repeat(50));
    console.log('Cleanup complete!');
    
    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      deletedDirectories: this.deletedDirs,
      deletedFiles: this.deletedFiles,
      errors: this.errors,
      summary: {
        directoriesDeleted: this.deletedDirs.length,
        filesDeleted: this.deletedFiles.length,
        errorsEncountered: this.errors.length
      }
    };
    
    fs.writeFileSync(
      path.join(projectRoot, 'cleanup-report.json'),
      JSON.stringify(report, null, 2)
    );
    
    console.log('\nDetailed report saved to: cleanup-report.json');
  }
}

// Run cleanup
async function main() {
  const cleaner = new ProjectCleaner();
  await cleaner.clean();
}

main().catch(console.error);
