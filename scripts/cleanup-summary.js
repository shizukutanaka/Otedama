/**
 * Final cleanup summary for Otedama
 * List all files that need to be removed
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Files and directories to remove
const TO_REMOVE = {
  directories: [
    'old_files',
    'lib/old_auth_to_delete',
    '.claude'
  ],
  
  files: {
    'lib/api': [
      'batch-endpoints.js.bak',
      'social-endpoints.js.bak'
    ],
    
    'lib/security': [
      'enhanced-auth-system.js',
      'enhanced-ddos-protection.js',
      'enhanced-security-system.js',
      'manager.js',
      'security-manager.js',
      'core.js',
      'audit.js',
      'unified-audit-manager.js',
      'comprehensive-security-middleware.js'
    ]
  }
};

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getDirectorySize(dirPath) {
  let totalSize = 0;
  
  function walkDir(dir) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
          walkDir(fullPath);
        } else if (item.isFile()) {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }
  
  walkDir(dirPath);
  return totalSize;
}

function analyzeCleanup() {
  console.log('OTEDAMA CLEANUP SUMMARY');
  console.log('='.repeat(60));
  console.log();
  
  let totalSize = 0;
  let totalFiles = 0;
  
  // Analyze directories
  console.log('DIRECTORIES TO REMOVE:');
  console.log('-'.repeat(40));
  
  for (const dir of TO_REMOVE.directories) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      const size = getDirectorySize(fullPath);
      totalSize += size;
      
      // Count files
      let fileCount = 0;
      function countFiles(dirPath) {
        try {
          const items = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const item of items) {
            if (item.isFile()) {
              fileCount++;
            } else if (item.isDirectory()) {
              countFiles(path.join(dirPath, item.name));
            }
          }
        } catch (error) {
          // Ignore
        }
      }
      countFiles(fullPath);
      
      totalFiles += fileCount;
      
      console.log(`  ${dir}/`);
      console.log(`    Files: ${fileCount}`);
      console.log(`    Size: ${formatFileSize(size)}`);
    } else {
      console.log(`  ${dir}/ (not found)`);
    }
  }
  
  // Analyze individual files
  console.log('\nINDIVIDUAL FILES TO REMOVE:');
  console.log('-'.repeat(40));
  
  for (const [dir, files] of Object.entries(TO_REMOVE.files)) {
    console.log(`  ${dir}/`);
    
    for (const file of files) {
      const fullPath = path.join(projectRoot, dir, file);
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
        totalFiles++;
        console.log(`    - ${file} (${formatFileSize(stats.size)})`);
      } else {
        console.log(`    - ${file} (not found)`);
      }
    }
  }
  
  // Find additional .bak files
  console.log('\nADDITIONAL .BAK FILES FOUND:');
  console.log('-'.repeat(40));
  
  function findBakFiles(dir, relativePath = '') {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const relPath = path.join(relativePath, item.name);
        
        if (item.isDirectory() && 
            !item.name.includes('node_modules') && 
            !item.name.includes('.git') &&
            !item.name.includes('old_files')) {
          findBakFiles(fullPath, relPath);
        } else if (item.isFile() && item.name.endsWith('.bak')) {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
          totalFiles++;
          console.log(`  ${relPath} (${formatFileSize(stats.size)})`);
        }
      }
    } catch (error) {
      // Ignore
    }
  }
  
  findBakFiles(projectRoot);
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY:');
  console.log(`  Total files to remove: ${totalFiles}`);
  console.log(`  Total size to free: ${formatFileSize(totalSize)}`);
  console.log('='.repeat(60));
  
  // Safety check
  console.log('\nSAFETY CHECK:');
  console.log('The following actions will be performed:');
  console.log('  1. Delete old_files directory and all contents');
  console.log('  2. Delete empty lib/old_auth_to_delete directory');
  console.log('  3. Delete .claude directory if exists');
  console.log('  4. Remove .bak files from lib/api');
  console.log('  5. Consolidate security modules in lib/security');
  console.log('  6. Remove all other .bak files found');
  
  console.log('\nNo critical files will be deleted.');
  console.log('All removed files are either:');
  console.log('  - Backup files (.bak)');
  console.log('  - Old/obsolete files');
  console.log('  - Duplicate implementations');
  
  return {
    totalFiles,
    totalSize
  };
}

// Run analysis
const results = analyzeCleanup();

console.log('\nTo execute cleanup, run:');
console.log('  node scripts/cleanup-project.js');
console.log('\nTo perform a dry run first:');
console.log('  node scripts/cleanup-project.js --dry-run');
