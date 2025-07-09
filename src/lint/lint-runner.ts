// Lint runner with custom checks for mining pool project
// Robert C. Martin: "Clean code reads like well-written prose"

import { ESLint } from 'eslint';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../logging/logger';

interface LintResult {
  filePath: string;
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  messages: Array<{
    severity: number;
    message: string;
    line: number;
    column: number;
    ruleId: string | null;
  }>;
}

/**
 * Custom lint runner with project-specific checks
 */
export class LintRunner {
  private eslint: ESLint;
  private logger: Logger;
  private customChecks: Array<(content: string, filePath: string) => string[]> = [];

  constructor() {
    this.logger = new Logger('LintRunner');
    this.eslint = new ESLint({
      fix: false,
      cache: true,
      cacheLocation: '.eslintcache',
    });

    // Register custom checks
    this.registerCustomChecks();
  }

  /**
   * Run linting on the project
   */
  async run(fix: boolean = false): Promise<void> {
    this.logger.info('Starting lint check...');

    try {
      // Update ESLint config for fix mode
      if (fix) {
        this.eslint = new ESLint({
          fix: true,
          cache: true,
          cacheLocation: '.eslintcache',
        });
      }

      // Get all TypeScript files
      const files = await this.getTypeScriptFiles();
      this.logger.info(`Found ${files.length} TypeScript files to lint`);

      // Run ESLint
      const results = await this.eslint.lintFiles(files);

      // Apply fixes if requested
      if (fix) {
        await ESLint.outputFixes(results);
        this.logger.info('Applied automatic fixes');
      }

      // Run custom checks
      const customIssues = await this.runCustomChecks(files);

      // Format and display results
      await this.displayResults(results, customIssues);

      // Determine exit code
      const hasErrors = results.some(r => r.errorCount > 0) || customIssues.length > 0;
      if (hasErrors) {
        process.exit(1);
      }

    } catch (error) {
      this.logger.error('Linting failed:', error as Error);
      process.exit(1);
    }
  }

  /**
   * Register custom checks specific to mining pool
   */
  private registerCustomChecks(): void {
    // Check for hardcoded addresses
    this.customChecks.push((content, filePath) => {
      const issues: string[] = [];
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Check for hardcoded Bitcoin addresses
        const btcAddressRegex = /[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59}/g;
        const matches = line.match(btcAddressRegex);
        
        if (matches && !line.includes('test') && !line.includes('example')) {
          issues.push(
            `${filePath}:${index + 1}: Possible hardcoded Bitcoin address found: ${matches[0]}`
          );
        }

        // Check for hardcoded pool fees
        if (line.includes('feePercent') && /\d+\.?\d*/.test(line) && !line.includes('env')) {
          issues.push(
            `${filePath}:${index + 1}: Pool fee should be configurable, not hardcoded`
          );
        }

        // Check for missing error handling in RPC calls
        if (line.includes('rpc') && line.includes('await') && !content.includes('try')) {
          issues.push(
            `${filePath}:${index + 1}: RPC calls should have error handling`
          );
        }
      });

      return issues;
    });

    // Check for proper resource cleanup
    this.customChecks.push((content, filePath) => {
      const issues: string[] = [];
      
      // Check if file has resources that need cleanup
      const hasServer = content.includes('createServer') || content.includes('new Server');
      const hasConnection = content.includes('connect(') || content.includes('createConnection');
      const hasInterval = content.includes('setInterval');
      
      if (hasServer || hasConnection || hasInterval) {
        const hasCleanup = content.includes('close()') || 
                          content.includes('disconnect()') || 
                          content.includes('clearInterval');
        
        if (!hasCleanup) {
          issues.push(
            `${filePath}: File creates resources but may not properly clean them up`
          );
        }
      }

      return issues;
    });

    // Check for security issues
    this.customChecks.push((content, filePath) => {
      const issues: string[] = [];
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Check for eval usage
        if (line.includes('eval(')) {
          issues.push(
            `${filePath}:${index + 1}: Avoid using eval() for security reasons`
          );
        }

        // Check for plain HTTP in production
        if (line.includes('http://') && !line.includes('localhost') && !line.includes('127.0.0.1')) {
          issues.push(
            `${filePath}:${index + 1}: Use HTTPS instead of HTTP for external connections`
          );
        }

        // Check for missing input validation
        if (line.includes('parseInt') || line.includes('parseFloat')) {
          if (!content.includes('isNaN') && !content.includes('Number.isNaN')) {
            issues.push(
              `${filePath}:${index + 1}: Add validation after parsing numbers`
            );
          }
        }
      });

      return issues;
    });
  }

  /**
   * Get all TypeScript files in the project
   */
  private async getTypeScriptFiles(): Promise<string[]> {
    const srcDir = path.join(process.cwd(), 'src');
    const files: string[] = [];

    async function walkDir(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip test and node_modules directories
          if (!entry.name.includes('test') && entry.name !== 'node_modules') {
            await walkDir(fullPath);
          }
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    }

    await walkDir(srcDir);
    return files;
  }

  /**
   * Run custom checks on files
   */
  private async runCustomChecks(files: string[]): Promise<string[]> {
    const allIssues: string[] = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        
        for (const check of this.customChecks) {
          const issues = check(content, file);
          allIssues.push(...issues);
        }
      } catch (error) {
        this.logger.error(`Failed to read ${file}:`, error as Error);
      }
    }

    return allIssues;
  }

  /**
   * Display linting results
   */
  private async displayResults(
    eslintResults: ESLint.LintResult[],
    customIssues: string[]
  ): Promise<void> {
    // Format ESLint results
    const formatter = await this.eslint.loadFormatter('stylish');
    const resultText = formatter.format(eslintResults);
    
    console.log('\n=== ESLint Results ===');
    console.log(resultText);

    // Display custom issues
    if (customIssues.length > 0) {
      console.log('\n=== Custom Lint Checks ===');
      customIssues.forEach(issue => console.log(`  ⚠️  ${issue}`));
    }

    // Summary
    const totalErrors = eslintResults.reduce((sum, r) => sum + r.errorCount, 0);
    const totalWarnings = eslintResults.reduce((sum, r) => sum + r.warningCount, 0);
    const fixableErrors = eslintResults.reduce((sum, r) => sum + r.fixableErrorCount, 0);
    const fixableWarnings = eslintResults.reduce((sum, r) => sum + r.fixableWarningCount, 0);

    console.log('\n=== Summary ===');
    console.log(`✖ ${totalErrors} errors (${fixableErrors} fixable)`);
    console.log(`⚠ ${totalWarnings} warnings (${fixableWarnings} fixable)`);
    console.log(`🔍 ${customIssues.length} custom issues found`);

    if (totalErrors === 0 && totalWarnings === 0 && customIssues.length === 0) {
      console.log('\n✅ No linting issues found!');
    } else if (fixableErrors > 0 || fixableWarnings > 0) {
      console.log('\n💡 Run with --fix to automatically fix some issues');
    }
  }
}

// Run if executed directly
if (require.main === module) {
  const runner = new LintRunner();
  const fix = process.argv.includes('--fix');
  
  runner.run(fix).catch(error => {
    console.error('Lint runner failed:', error);
    process.exit(1);
  });
}
