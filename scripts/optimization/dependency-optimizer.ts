/**
 * Dependency Optimizer - Following Carmack/Martin/Pike principles
 * - Simple and efficient
 * - No unnecessary abstractions
 * - Clear purpose and functionality
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface DependencyInfo {
  name: string;
  version: string;
  isDev: boolean;
  size?: number;
  usageCount?: number;
}

interface OptimizationResult {
  unused: string[];
  duplicates: string[];
  suggestions: string[];
  sizeAnalysis: { [key: string]: number };
}

class DependencyOptimizer {
  private projectRoot: string;
  private srcPath: string;
  private packageJson: any;
  private fileContents: Map<string, string> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.srcPath = path.join(projectRoot, 'src');
    this.packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
  }

  /**
   * Main optimization function
   */
  async optimize(): Promise<OptimizationResult> {
    console.log('🔍 Analyzing dependencies...');
    
    // Load all source files
    this.loadSourceFiles();
    
    // Analyze dependencies
    const unused = this.findUnusedDependencies();
    const duplicates = this.findDuplicates();
    const sizeAnalysis = await this.analyzeSizes();
    const suggestions = this.generateSuggestions(unused, duplicates, sizeAnalysis);
    
    return {
      unused,
      duplicates,
      suggestions,
      sizeAnalysis
    };
  }

  /**
   * Load all TypeScript/JavaScript files
   */
  private loadSourceFiles(dir: string = this.srcPath): void {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        this.loadSourceFiles(fullPath);
      } else if (file.endsWith('.ts') || file.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        this.fileContents.set(fullPath, content);
      }
    }
  }

  /**
   * Find unused dependencies
   */
  private findUnusedDependencies(): string[] {
    const allDeps = {
      ...this.packageJson.dependencies,
      ...this.packageJson.devDependencies
    };
    
    const unused: string[] = [];
    
    for (const dep of Object.keys(allDeps)) {
      if (this.isBuiltinDep(dep)) continue;
      
      let isUsed = false;
      
      // Check if dependency is imported anywhere
      for (const [filePath, content] of this.fileContents) {
        if (this.isDependencyUsed(dep, content)) {
          isUsed = true;
          break;
        }
      }
      
      // Check if it's used in scripts
      if (!isUsed && this.isUsedInScripts(dep)) {
        isUsed = true;
      }
      
      if (!isUsed) {
        unused.push(dep);
      }
    }
    
    return unused;
  }

  /**
   * Check if dependency is used in content
   */
  private isDependencyUsed(dep: string, content: string): boolean {
    // Direct import patterns
    const patterns = [
      `from ['"]${dep}`,
      `require\\(['"]${dep}`,
      `import\\s+.*${dep}`,
      `@${dep}/`  // Scoped packages
    ];
    
    return patterns.some(pattern => new RegExp(pattern).test(content));
  }

  /**
   * Check if dependency is used in npm scripts
   */
  private isUsedInScripts(dep: string): boolean {
    const scripts = this.packageJson.scripts || {};
    const scriptContent = Object.values(scripts).join(' ');
    
    // Common script dependencies
    const scriptDeps = [
      'typescript', 'ts-node', 'jest', 'eslint', 'prettier',
      'nodemon', 'typedoc', 'npm-check-updates'
    ];
    
    return scriptDeps.includes(dep) && scriptContent.includes(dep);
  }

  /**
   * Check if dependency is built-in or essential
   */
  private isBuiltinDep(dep: string): boolean {
    const essentialDeps = [
      '@types/node', 'typescript', 'ts-node', 'jest', 'ts-jest'
    ];
    return essentialDeps.includes(dep);
  }

  /**
   * Find duplicate dependencies
   */
  private findDuplicates(): string[] {
    const duplicates: string[] = [];
    const deps = Object.keys(this.packageJson.dependencies || {});
    const devDeps = Object.keys(this.packageJson.devDependencies || {});
    
    // Check for dependencies in both prod and dev
    for (const dep of deps) {
      if (devDeps.includes(dep)) {
        duplicates.push(dep);
      }
    }
    
    return duplicates;
  }

  /**
   * Analyze dependency sizes
   */
  private async analyzeSizes(): Promise<{ [key: string]: number }> {
    const sizes: { [key: string]: number } = {};
    
    try {
      // Get size info using du command (cross-platform with fallback)
      const nodeModulesPath = path.join(this.projectRoot, 'node_modules');
      const deps = fs.readdirSync(nodeModulesPath);
      
      for (const dep of deps.slice(0, 20)) { // Analyze top 20 for performance
        const depPath = path.join(nodeModulesPath, dep);
        if (fs.statSync(depPath).isDirectory()) {
          sizes[dep] = this.getDirectorySize(depPath);
        }
      }
    } catch (error) {
      console.warn('Could not analyze sizes:', error);
    }
    
    return sizes;
  }

  /**
   * Get directory size
   */
  private getDirectorySize(dirPath: string): number {
    let size = 0;
    
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          size += this.getDirectorySize(fullPath);
        } else {
          size += stat.size;
        }
      }
    } catch {
      // Ignore errors
    }
    
    return size;
  }

  /**
   * Generate optimization suggestions
   */
  private generateSuggestions(
    unused: string[],
    duplicates: string[],
    sizes: { [key: string]: number }
  ): string[] {
    const suggestions: string[] = [];
    
    // Unused dependencies
    if (unused.length > 0) {
      suggestions.push(`Remove ${unused.length} unused dependencies: ${unused.join(', ')}`);
    }
    
    // Duplicate dependencies
    if (duplicates.length > 0) {
      suggestions.push(`Move ${duplicates.length} dependencies from both to devDependencies: ${duplicates.join(', ')}`);
    }
    
    // Large dependencies
    const largeDeps = Object.entries(sizes)
      .filter(([_, size]) => size > 10 * 1024 * 1024) // > 10MB
      .sort(([_, a], [__, b]) => b - a);
    
    if (largeDeps.length > 0) {
      suggestions.push(`Consider alternatives for large dependencies:`);
      largeDeps.forEach(([dep, size]) => {
        suggestions.push(`  - ${dep}: ${(size / 1024 / 1024).toFixed(1)}MB`);
      });
    }
    
    // Specific optimization suggestions
    this.addSpecificSuggestions(suggestions);
    
    return suggestions;
  }

  /**
   * Add specific optimization suggestions based on common patterns
   */
  private addSpecificSuggestions(suggestions: string[]): void {
    const deps = Object.keys(this.packageJson.dependencies || {});
    
    // Check for multiple HTTP clients
    const httpClients = ['axios', 'node-fetch', 'request', 'got'];
    const usedHttpClients = httpClients.filter(client => deps.includes(client));
    if (usedHttpClients.length > 1) {
      suggestions.push(`Multiple HTTP clients detected: ${usedHttpClients.join(', ')}. Consider using only one.`);
    }
    
    // Check for multiple test frameworks
    const testFrameworks = ['jest', 'mocha', 'jasmine', 'ava'];
    const usedTestFrameworks = testFrameworks.filter(framework => 
      Object.keys({...this.packageJson.dependencies, ...this.packageJson.devDependencies}).includes(framework)
    );
    if (usedTestFrameworks.length > 1) {
      suggestions.push(`Multiple test frameworks detected: ${usedTestFrameworks.join(', ')}. Consider using only one.`);
    }
  }

  /**
   * Generate optimized package.json
   */
  generateOptimizedPackageJson(result: OptimizationResult): void {
    const optimized = JSON.parse(JSON.stringify(this.packageJson));
    
    // Remove unused dependencies
    for (const dep of result.unused) {
      delete optimized.dependencies[dep];
      delete optimized.devDependencies[dep];
    }
    
    // Move duplicates to devDependencies
    for (const dep of result.duplicates) {
      if (optimized.dependencies[dep]) {
        optimized.devDependencies[dep] = optimized.dependencies[dep];
        delete optimized.dependencies[dep];
      }
    }
    
    // Clean up scripts - remove redundant ones
    optimized.scripts = this.optimizeScripts(optimized.scripts);
    
    // Write optimized package.json
    const outputPath = path.join(this.projectRoot, 'package.optimized.json');
    fs.writeFileSync(outputPath, JSON.stringify(optimized, null, 2));
    
    console.log(`✅ Optimized package.json written to: ${outputPath}`);
  }

  /**
   * Optimize npm scripts
   */
  private optimizeScripts(scripts: any): any {
    const optimized: any = {};
    const essentialScripts = [
      'build', 'start', 'dev', 'test', 'lint', 'format',
      'docker:build', 'docker:run'
    ];
    
    // Keep essential scripts
    for (const script of essentialScripts) {
      if (scripts[script]) {
        optimized[script] = scripts[script];
      }
    }
    
    // Add commonly used scripts that exist
    const commonScripts = [
      'test:unit', 'test:integration', 'test:coverage',
      'lint:fix', 'format:check', 'type-check',
      'clean', 'docs:generate'
    ];
    
    for (const script of commonScripts) {
      if (scripts[script]) {
        optimized[script] = scripts[script];
      }
    }
    
    return optimized;
  }

  /**
   * Generate report
   */
  generateReport(result: OptimizationResult): void {
    const report = `
# Dependency Optimization Report

## Summary
- Unused dependencies: ${result.unused.length}
- Duplicate dependencies: ${result.duplicates.length}
- Total suggestions: ${result.suggestions.length}

## Unused Dependencies
${result.unused.length > 0 ? result.unused.map(d => `- ${d}`).join('\n') : 'None found'}

## Duplicate Dependencies (in both dependencies and devDependencies)
${result.duplicates.length > 0 ? result.duplicates.map(d => `- ${d}`).join('\n') : 'None found'}

## Size Analysis (Top 10)
${Object.entries(result.sizeAnalysis)
  .sort(([_, a], [__, b]) => b - a)
  .slice(0, 10)
  .map(([dep, size]) => `- ${dep}: ${(size / 1024 / 1024).toFixed(1)}MB`)
  .join('\n')}

## Suggestions
${result.suggestions.map(s => `- ${s}`).join('\n')}

## Next Steps
1. Review the optimized package.json at package.optimized.json
2. Test the application with optimized dependencies
3. Run \`npm install\` after replacing package.json
4. Run tests to ensure nothing is broken
`;

    const reportPath = path.join(this.projectRoot, 'dependency-optimization-report.md');
    fs.writeFileSync(reportPath, report);
    console.log(`📊 Report written to: ${reportPath}`);
  }
}

// Run the optimizer
async function main() {
  const projectRoot = path.resolve(__dirname, '../..');
  const optimizer = new DependencyOptimizer(projectRoot);
  
  try {
    const result = await optimizer.optimize();
    optimizer.generateOptimizedPackageJson(result);
    optimizer.generateReport(result);
    
    console.log('\n✨ Optimization complete!');
    console.log(`Found ${result.unused.length} unused dependencies`);
    console.log(`Found ${result.duplicates.length} duplicate dependencies`);
    console.log(`Generated ${result.suggestions.length} suggestions`);
  } catch (error) {
    console.error('Error during optimization:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { DependencyOptimizer };
