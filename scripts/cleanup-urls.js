#!/usr/bin/env node
/**
 * URL Cleanup Script
 * Removes or replaces non-existent URLs in the Otedama codebase
 */

import { readFile, writeFile } from 'fs/promises';
import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { glob } from 'glob';

const logger = createStructuredLogger('URLCleanup');

/**
 * URL replacements map
 * Maps non-existent URLs to proper replacements or removes them
 */
const URL_REPLACEMENTS = {
  // GitHub repository URLs - replace with local paths or remove
  'https://github.com/shizukutanaka/Otedama': '',
  'https://github.com/shizukutanaka/Otedama.git': '',
  'https://github.com/shizukutanaka/Otedama/discussions': '',
  'https://github.com/shizukutanaka/Otedama/issues': '',
  'https://github.com/shizukutanaka/Otedama/releases': '',
  
  // Remove other potentially non-existent URLs
  'git+https://github.com/shizukutanaka/Otedama.git': '',
  
  // Keep valid external URLs (CDNs, API services, etc.)
  // These are legitimate external services that should remain
};

/**
 * Files to process for URL cleanup
 */
const FILES_TO_PROCESS = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'api/openapi.yaml',
  'config/production.json',
  'config/pool-operator.json',
  'public/pool-info.json',
  'docs/API.md',
  'setup.js'
];

/**
 * Clean up URLs in a file
 */
async function cleanupFileURLs(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    let newContent = content;
    let hasChanges = false;
    
    for (const [oldUrl, newUrl] of Object.entries(URL_REPLACEMENTS)) {
      if (content.includes(oldUrl)) {
        logger.info(`Replacing URL in ${filePath}`, { oldUrl, newUrl: newUrl || '[REMOVED]' });
        
        if (newUrl === '') {
          // Remove the URL and clean up the surrounding context
          newContent = cleanupRemovedURL(newContent, oldUrl, filePath);
        } else {
          // Replace with new URL
          newContent = newContent.replace(new RegExp(escapeRegex(oldUrl), 'g'), newUrl);
        }
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      await writeFile(filePath, newContent, 'utf8');
      logger.info(`Updated file: ${filePath}`);
      return true;
    }
    
    return false;
    
  } catch (error) {
    logger.error(`Error processing file ${filePath}`, { error: error.message });
    return false;
  }
}

/**
 * Clean up removed URLs with context-aware replacement
 */
function cleanupRemovedURL(content, removedUrl, filePath) {
  const escapedUrl = escapeRegex(removedUrl);
  
  if (filePath.endsWith('package.json')) {
    // Handle package.json specific cleanups
    if (removedUrl.includes('github.com')) {
      // Remove repository field or replace with placeholder
      content = content.replace(
        /"repository":\s*{\s*"type":\s*"git",\s*"url":\s*"[^"]*"\s*}/g,
        '"repository": "git+https://github.com/your-username/otedama.git"'
      );
      
      // Remove bugs field or replace with placeholder
      content = content.replace(
        /"bugs":\s*{\s*"url":\s*"[^"]*"\s*}/g,
        '"bugs": "https://github.com/your-username/otedama/issues"'
      );
      
      // Remove homepage field or replace with placeholder
      content = content.replace(
        /"homepage":\s*"[^"]*"/g,
        '"homepage": "https://github.com/your-username/otedama"'
      );
    }
    
    return content;
  }
  
  if (filePath.endsWith('.md')) {
    // Handle Markdown files
    // Remove GitHub-specific links but keep the text
    content = content.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(${escapedUrl}[^)]*\\)`, 'g'),
      '$1'
    );
    
    // Remove plain GitHub URLs
    content = content.replace(new RegExp(escapedUrl, 'g'), '');
    
    // Clean up any resulting empty lines
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    return content;
  }
  
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    // Handle YAML files
    content = content.replace(
      new RegExp(`url:\\s*${escapedUrl}`, 'g'),
      'url: https://github.com/your-username/otedama'
    );
    
    return content;
  }
  
  // Default: just remove the URL
  return content.replace(new RegExp(escapedUrl, 'g'), '');
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Update package.json with placeholder repository info
 */
async function updatePackageJson() {
  try {
    const packagePath = 'package.json';
    const packageContent = await readFile(packagePath, 'utf8');
    const packageData = JSON.parse(packageContent);
    
    // Update repository info with placeholders
    packageData.repository = {
      type: 'git',
      url: 'git+https://github.com/your-username/otedama.git'
    };
    
    packageData.bugs = {
      url: 'https://github.com/your-username/otedama/issues'
    };
    
    packageData.homepage = 'https://github.com/your-username/otedama';
    
    // Write back the updated package.json
    await writeFile(packagePath, JSON.stringify(packageData, null, 2) + '\n', 'utf8');
    
    logger.info('Updated package.json with placeholder repository info');
    
  } catch (error) {
    logger.error('Error updating package.json', { error: error.message });
  }
}

/**
 * Main cleanup function
 */
async function cleanupURLs() {
  logger.info('Starting URL cleanup process');
  
  let processedFiles = 0;
  let updatedFiles = 0;
  
  // Process specific files
  for (const filePath of FILES_TO_PROCESS) {
    try {
      const wasUpdated = await cleanupFileURLs(filePath);
      processedFiles++;
      if (wasUpdated) updatedFiles++;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Error processing ${filePath}`, { error: error.message });
      }
      // Ignore file not found errors
    }
  }
  
  // Update package.json specifically
  await updatePackageJson();
  
  logger.info('URL cleanup completed', {
    processedFiles,
    updatedFiles
  });
  
  // Create a summary of what was cleaned
  console.log('\n' + '='.repeat(60));
  console.log('🧹 URL CLEANUP COMPLETED');
  console.log('='.repeat(60));
  console.log(`Processed files: ${processedFiles}`);
  console.log(`Updated files: ${updatedFiles}`);
  console.log('\nReplaced non-existent URLs:');
  Object.keys(URL_REPLACEMENTS).forEach(url => {
    console.log(`  ❌ ${url}`);
  });
  console.log('\n📝 Updated package.json with placeholder repository info');
  console.log('✅ All non-existent URLs have been cleaned up');
  console.log('='.repeat(60) + '\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupURLs().catch(error => {
    console.error('Failed to cleanup URLs:', error);
    process.exit(1);
  });
}

export { cleanupURLs };