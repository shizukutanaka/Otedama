#!/usr/bin/env node

/**
 * Script to fix Logger imports across the codebase
 */

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

async function fixLoggerImports() {
  console.log('Fixing Logger imports across the codebase...\n');
  
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
    
    // Fix Logger import statements
    if (content.includes("import { Logger } from '../logger.js'")) {
      content = content.replace(
        "import { Logger } from '../logger.js'",
        "import { getLogger } from '../logger.js'"
      );
      modified = true;
    }
    
    if (content.includes("import { Logger } from './logger.js'")) {
      content = content.replace(
        "import { Logger } from './logger.js'",
        "import { getLogger } from './logger.js'"
      );
      modified = true;
    }
    
    if (content.includes("import { Logger } from '../core/logger.js'")) {
      content = content.replace(
        "import { Logger } from '../core/logger.js'",
        "import { getLogger } from '../core/logger.js'"
      );
      modified = true;
    }
    
    if (content.includes("import { Logger } from './core/logger.js'")) {
      content = content.replace(
        "import { Logger } from './core/logger.js'",
        "import { getLogger } from './core/logger.js'"
      );
      modified = true;
    }
    
    // Fix new Logger() instantiations
    const loggerPattern = /new Logger\(['"]([^'"]+)['"]\)/g;
    const matches = content.match(loggerPattern);
    
    if (matches) {
      // Add logger declaration after imports if not exists
      const importEndPattern = /^import .+$/gm;
      const imports = content.match(importEndPattern);
      if (imports) {
        const lastImport = imports[imports.length - 1];
        const lastImportIndex = content.lastIndexOf(lastImport) + lastImport.length;
        
        // Extract logger name from the first new Logger() call
        const firstMatch = matches[0];
        const loggerNameMatch = firstMatch.match(/new Logger\(['"]([^'"]+)['"]\)/);
        const loggerName = loggerNameMatch ? loggerNameMatch[1] : 'App';
        
        // Check if logger const already exists
        if (!content.includes(`const logger = getLogger(`)) {
          const loggerDeclaration = `\n\nconst logger = getLogger('${loggerName}');`;
          content = content.slice(0, lastImportIndex) + loggerDeclaration + content.slice(lastImportIndex);
        }
      }
      
      // Replace all new Logger() with logger
      content = content.replace(loggerPattern, 'logger');
      modified = true;
    }
    
    // Fix this.logger assignments that use new Logger
    const thisLoggerPattern = /this\.logger = options\.logger \|\| new Logger\(['"]([^'"]+)['"]\);/g;
    if (thisLoggerPattern.test(content)) {
      content = content.replace(thisLoggerPattern, 'this.logger = options.logger || logger;');
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
fixLoggerImports().catch(console.error);