/**
 * Analyze duplicate files in Otedama project
 * Following Carmack's principle: measure first, optimize second
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Patterns to identify potential duplicates
const duplicatePatterns = [
  { pattern: /^advanced-(.+)\.js$/, base: '$1.js' },
  { pattern: /^enhanced-(.+)\.js$/, base: '$1.js' },
  { pattern: /^unified-(.+)\.js$/, base: '$1.js' },
  { pattern: /^(.+)-optimized\.js$/, base: '$1.js' },
  { pattern: /^(.+)-improved\.js$/, base: '$1.js' },
  { pattern: /^(.+)\.js\.bak$/, base: '$1.js' },
  { pattern: /^_old_(.+)$/, base: '$1' }
];

class DuplicateAnalyzer {
  constructor() {
    this.filesByContent = new Map();
    this.filesByFunction = new Map();
    this.duplicateGroups = [];
    this.filesToDelete = new Set();
  }

  async analyze() {
    console.log('Analyzing project structure...\n');
    
    // Scan all JavaScript files
    await this.scanDirectory(path.join(projectRoot, 'lib'));
    await this.scanDirectory(path.join(projectRoot, 'services'));
    await this.scanDirectory(path.join(projectRoot, 'scripts'));
    await this.scanDirectory(path.join(projectRoot, 'old_files'));
    
    // Analyze duplicates
    this.findContentDuplicates();
    this.findFunctionalDuplicates();
    this.identifyObsoleteFiles();
    
    // Generate report
    this.generateReport();
    
    return {
      duplicateGroups: this.duplicateGroups,
      filesToDelete: Array.from(this.filesToDelete),
      totalFiles: this.filesByContent.size,
      duplicateCount: this.duplicateGroups.length
    };
  }

  async scanDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    
    const items = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      
      if (item.isDirectory()) {
        // Skip node_modules and .git
        if (item.name === 'node_modules' || item.name === '.git') continue;
        await this.scanDirectory(fullPath);
      } else if (item.isFile() && (item.name.endsWith('.js') || item.name.endsWith('.bak'))) {
        await this.analyzeFile(fullPath);
      }
    }
  }

  async analyzeFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      
      // Store by content hash
      if (!this.filesByContent.has(hash)) {
        this.filesByContent.set(hash, []);
      }
      this.filesByContent.get(hash).push(filePath);
      
      // Extract main functions/classes
      const functions = this.extractFunctions(content);
      functions.forEach(func => {
        if (!this.filesByFunction.has(func)) {
          this.filesByFunction.set(func, []);
        }
        this.filesByFunction.get(func).push(filePath);
      });
      
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error.message);
    }
  }

  extractFunctions(content) {
    const functions = new Set();
    
    // Extract class names
    const classMatches = content.matchAll(/class\s+(\w+)/g);
    for (const match of classMatches) {
      functions.add(`class:${match[1]}`);
    }
    
    // Extract exported functions
    const funcMatches = content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
    for (const match of funcMatches) {
      functions.add(`function:${match[1]}`);
    }
    
    // Extract exported classes
    const exportMatches = content.matchAll(/export\s+(?:default\s+)?class\s+(\w+)/g);
    for (const match of exportMatches) {
      functions.add(`class:${match[1]}`);
    }
    
    return Array.from(functions);
  }

  findContentDuplicates() {
    // Find files with identical content
    for (const [hash, files] of this.filesByContent) {
      if (files.length > 1) {
        this.duplicateGroups.push({
          type: 'identical_content',
          files: files.map(f => path.relative(projectRoot, f)),
          recommendation: this.recommendAction(files)
        });
      }
    }
  }

  findFunctionalDuplicates() {
    // Find files that implement similar functionality
    const processed = new Set();
    
    for (const [func, files] of this.filesByFunction) {
      if (files.length > 1) {
        const key = files.sort().join('|');
        if (!processed.has(key)) {
          processed.add(key);
          
          // Check if these are variations of the same module
          const relativeFiles = files.map(f => path.relative(projectRoot, f));
          const similarityGroups = this.groupBySimilarity(relativeFiles);
          
          similarityGroups.forEach(group => {
            if (group.length > 1) {
              this.duplicateGroups.push({
                type: 'functional_duplicate',
                function: func,
                files: group,
                recommendation: this.recommendAction(group.map(f => path.join(projectRoot, f)))
              });
            }
          });
        }
      }
    }
  }

  groupBySimilarity(files) {
    const groups = [];
    const used = new Set();
    
    for (const file of files) {
      if (used.has(file)) continue;
      
      const group = [file];
      used.add(file);
      
      for (const other of files) {
        if (used.has(other)) continue;
        
        if (this.areSimilar(file, other)) {
          group.push(other);
          used.add(other);
        }
      }
      
      groups.push(group);
    }
    
    return groups;
  }

  areSimilar(file1, file2) {
    const base1 = path.basename(file1);
    const base2 = path.basename(file2);
    
    // Check if one is a variation of the other
    for (const { pattern, base } of duplicatePatterns) {
      const match1 = base1.match(pattern);
      const match2 = base2.match(pattern);
      
      if (match1 && base2 === base.replace('$1', match1[1])) return true;
      if (match2 && base1 === base.replace('$1', match2[1])) return true;
    }
    
    // Check if they're in old_files
    if (file1.includes('old_files') || file2.includes('old_files')) return true;
    
    return false;
  }

  identifyObsoleteFiles() {
    // Files to definitely delete
    const obsoletePatterns = [
      /\.bak$/,
      /^_old_/,
      /\/old_files\//,
      /\/old_.*_to_delete\//,
      /-old\./,
      /\.old$/
    ];
    
    for (const [hash, files] of this.filesByContent) {
      for (const file of files) {
        const relativePath = path.relative(projectRoot, file);
        
        // Check if file matches obsolete patterns
        if (obsoletePatterns.some(pattern => pattern.test(relativePath))) {
          this.filesToDelete.add(relativePath);
        }
      }
    }
  }

  recommendAction(files) {
    const relativeFiles = files.map(f => path.relative(projectRoot, f));
    
    // Sort by priority (newer/enhanced versions first)
    const prioritized = relativeFiles.sort((a, b) => {
      // old_files directory has lowest priority
      if (a.includes('old_files')) return 1;
      if (b.includes('old_files')) return -1;
      
      // .bak files have low priority
      if (a.endsWith('.bak')) return 1;
      if (b.endsWith('.bak')) return -1;
      
      // Enhanced/unified versions have higher priority
      if (a.includes('enhanced-') || a.includes('unified-')) return -1;
      if (b.includes('enhanced-') || b.includes('unified-')) return 1;
      
      return a.localeCompare(b);
    });
    
    return {
      keep: prioritized[0],
      delete: prioritized.slice(1),
      action: 'merge_and_delete'
    };
  }

  generateReport() {
    console.log('=== DUPLICATE FILE ANALYSIS REPORT ===\n');
    
    console.log(`Total files analyzed: ${this.filesByContent.size}`);
    console.log(`Duplicate groups found: ${this.duplicateGroups.length}`);
    console.log(`Files marked for deletion: ${this.filesToDelete.size}\n`);
    
    // Group by directory
    const byDirectory = new Map();
    
    for (const group of this.duplicateGroups) {
      group.files.forEach(file => {
        const dir = path.dirname(file);
        if (!byDirectory.has(dir)) {
          byDirectory.set(dir, []);
        }
        byDirectory.get(dir).push({
          file,
          group,
          recommendation: group.recommendation
        });
      });
    }
    
    // Report by directory
    for (const [dir, items] of byDirectory) {
      console.log(`\nDirectory: ${dir}`);
      console.log('─'.repeat(50));
      
      const groups = new Map();
      items.forEach(item => {
        const key = item.group.files.join(' | ');
        if (!groups.has(key)) {
          groups.set(key, item.group);
        }
      });
      
      for (const group of groups.values()) {
        console.log(`\nType: ${group.type}`);
        if (group.function) {
          console.log(`Function: ${group.function}`);
        }
        console.log('Files:');
        group.files.forEach(f => {
          const shouldDelete = group.recommendation.delete.includes(f);
          console.log(`  ${shouldDelete ? '❌' : '✅'} ${f}`);
        });
        console.log(`Action: Keep "${group.recommendation.keep}", delete others`);
      }
    }
    
    // Files to delete
    console.log('\n\n=== FILES TO DELETE ===');
    console.log('─'.repeat(50));
    
    const deleteByDir = new Map();
    this.filesToDelete.forEach(file => {
      const dir = path.dirname(file);
      if (!deleteByDir.has(dir)) {
        deleteByDir.set(dir, []);
      }
      deleteByDir.get(dir).push(file);
    });
    
    for (const [dir, files] of deleteByDir) {
      console.log(`\n${dir}:`);
      files.forEach(f => console.log(`  - ${path.basename(f)}`));
    }
    
    console.log('\n\n=== SUMMARY ===');
    console.log(`Total space that can be freed: ${this.estimateSpaceSaved()} MB`);
  }

  estimateSpaceSaved() {
    let totalSize = 0;
    
    for (const file of this.filesToDelete) {
      try {
        const fullPath = path.join(projectRoot, file);
        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
        }
      } catch (error) {
        // Ignore errors
      }
    }
    
    // Also add duplicate content files
    for (const group of this.duplicateGroups) {
      group.recommendation.delete.forEach(file => {
        try {
          const fullPath = path.join(projectRoot, file);
          if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            totalSize += stats.size;
          }
        } catch (error) {
          // Ignore errors
        }
      });
    }
    
    return (totalSize / 1024 / 1024).toFixed(2);
  }
}

// Run analysis
async function main() {
  const analyzer = new DuplicateAnalyzer();
  const results = await analyzer.analyze();
  
  console.log('\n\nAnalysis complete!');
  console.log(`Found ${results.duplicateCount} duplicate groups`);
  console.log(`Identified ${results.filesToDelete.length} files for deletion`);
  
  // Save results
  const reportPath = path.join(projectRoot, 'duplicate-analysis-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed report saved to: ${reportPath}`);
}

main().catch(console.error);
