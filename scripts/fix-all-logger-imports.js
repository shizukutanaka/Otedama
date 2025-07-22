#!/usr/bin/env node

/**
 * Script to fix all logger imports comprehensively
 */

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

async function fixAllLoggerImports() {
  console.log('Fixing all logger imports comprehensively...\n');
  
  // Find all JavaScript files
  const files = await glob('**/*.js', {
    cwd: rootDir,
    ignore: ['node_modules/**', 'scripts/**', 'test/**', 'tests/**']
  });
  
  let fixedCount = 0;
  
  for (const file of files) {
    const filePath = join(rootDir, file);
    let content = readFileSync(filePath, 'utf8');
    let modified = false;
    
    // Fix import { logger } from '../core/logger.js'
    if (content.includes("import { logger } from '../core/logger.js'")) {
      content = content.replace(
        "import { logger } from '../core/logger.js'",
        "import { getLogger } from '../core/logger.js'"
      );
      
      // Add logger declaration if not exists
      if (!content.includes("const logger = getLogger(")) {
        const importEndPattern = /^import .+$/gm;
        const imports = content.match(importEndPattern);
        if (imports) {
          const lastImport = imports[imports.length - 1];
          const lastImportIndex = content.lastIndexOf(lastImport) + lastImport.length;
          
          const loggerDeclaration = `\n\nconst logger = getLogger('${file.split('/').pop().replace('.js', '')}');`;
          content = content.slice(0, lastImportIndex) + loggerDeclaration + content.slice(lastImportIndex);
        }
      }
      
      modified = true;
    }
    
    // Fix import { logger } from './core/logger.js'
    if (content.includes("import { logger } from './core/logger.js'")) {
      content = content.replace(
        "import { logger } from './core/logger.js'",
        "import { getLogger } from './core/logger.js'"
      );
      
      // Add logger declaration if not exists
      if (!content.includes("const logger = getLogger(")) {
        const importEndPattern = /^import .+$/gm;
        const imports = content.match(importEndPattern);
        if (imports) {
          const lastImport = imports[imports.length - 1];
          const lastImportIndex = content.lastIndexOf(lastImport) + lastImport.length;
          
          const loggerDeclaration = `\n\nconst logger = getLogger('${file.split('/').pop().replace('.js', '')}');`;
          content = content.slice(0, lastImportIndex) + loggerDeclaration + content.slice(lastImportIndex);
        }
      }
      
      modified = true;
    }
    
    // Fix import logger from '../core/logger.js'
    if (content.includes("import logger from '../core/logger.js'")) {
      content = content.replace(
        "import logger from '../core/logger.js'",
        "import { getLogger } from '../core/logger.js'"
      );
      
      // Add logger declaration if not exists
      if (!content.includes("const logger = getLogger(")) {
        const importEndPattern = /^import .+$/gm;
        const imports = content.match(importEndPattern);
        if (imports) {
          const lastImport = imports[imports.length - 1];
          const lastImportIndex = content.lastIndexOf(lastImport) + lastImport.length;
          
          const loggerDeclaration = `\n\nconst logger = getLogger('${file.split('/').pop().replace('.js', '')}');`;
          content = content.slice(0, lastImportIndex) + loggerDeclaration + content.slice(lastImportIndex);
        }
      }
      
      modified = true;
    }
    
    if (modified) {
      writeFileSync(filePath, content);
      console.log(`✓ Fixed: ${file}`);
      fixedCount++;
    }
  }
  
  console.log(`\n✅ Fixed ${fixedCount} files`);
}

// Run the script
fixAllLoggerImports().catch(console.error);