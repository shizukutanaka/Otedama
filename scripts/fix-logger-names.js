#!/usr/bin/env node

/**
 * Script to fix logger names with invalid escape sequences
 */

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

async function fixLoggerNames() {
  console.log('Fixing logger names with invalid escape sequences...\n');
  
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
    
    // Find logger declarations with backslashes
    const loggerPattern = /const logger = getLogger\(['"]([^'"]+)['"]\);/g;
    const matches = content.match(loggerPattern);
    
    if (matches) {
      matches.forEach(match => {
        const nameMatch = match.match(/getLogger\(['"]([^'"]+)['"]\)/);
        if (nameMatch && nameMatch[1].includes('\\')) {
          // Extract a simple name from the file
          const fileName = basename(file, '.js');
          const simpleName = fileName.split('-').map(part => 
            part.charAt(0).toUpperCase() + part.slice(1)
          ).join('');
          
          const newMatch = match.replace(nameMatch[1], simpleName);
          content = content.replace(match, newMatch);
          modified = true;
        }
      });
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
fixLoggerNames().catch(console.error);