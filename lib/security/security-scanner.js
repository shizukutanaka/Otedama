/**
 * Advanced Security Scanner
 * 
 * Comprehensive security analysis tool for vulnerability detection
 * Following defensive security principles with automated scanning capabilities
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join, extname, relative } from 'path';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class SecurityScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Scanning configuration
      scanDirectory: options.scanDirectory || '.',
      excludePatterns: options.excludePatterns || [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        'reports/**',
        '*.log',
        '*.tmp'
      ],
      
      // Security check settings
      enableCodeAnalysis: options.enableCodeAnalysis !== false,
      enableDependencyCheck: options.enableDependencyCheck !== false,
      enableConfigurationCheck: options.enableConfigurationCheck !== false,
      enableSecretsScanning: options.enableSecretsScanning !== false,
      enableVulnerabilityDatabase: options.enableVulnerabilityDatabase !== false,
      
      // Output configuration
      outputDirectory: options.outputDirectory || './reports/security',
      reportFormat: options.reportFormat || 'json',
      enableDetailedReports: options.enableDetailedReports !== false,
      
      // Performance settings
      maxConcurrentFiles: options.maxConcurrentFiles || 10,
      chunkSize: options.chunkSize || 100,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.vulnerabilities = [];
    this.scannedFiles = 0;
    this.totalFiles = 0;
    this.scanProgress = 0;
    
    // Security rules and patterns
    this.securityRules = this.initializeSecurityRules();
    this.secretPatterns = this.initializeSecretPatterns();
    this.vulnerabilityDatabase = new Map();
    
    // Metrics
    this.metrics = {
      scanStartTime: 0,
      scanEndTime: 0,
      totalDuration: 0,
      filesScanned: 0,
      vulnerabilitiesFound: 0,
      criticalVulns: 0,
      highVulns: 0,
      mediumVulns: 0,
      lowVulns: 0,
      infoVulns: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize security scanner
   */
  async initialize() {
    try {
      // Ensure output directory exists
      await mkdir(this.options.outputDirectory, { recursive: true });
      
      // Load vulnerability database if enabled
      if (this.options.enableVulnerabilityDatabase) {
        await this.loadVulnerabilityDatabase();
      }
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'security-scanner',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Run comprehensive security scan
   */
  async runScan(target = null) {
    const scanTarget = target || this.options.scanDirectory;
    
    try {
      console.log('🔍 Starting comprehensive security scan...');
      this.metrics.scanStartTime = performance.now();
      
      this.emit('scan:started', { target: scanTarget });
      
      // Reset metrics
      this.resetMetrics();
      
      // Phase 1: Discovery - scan for files
      console.log('📁 Phase 1: File discovery');
      const files = await this.discoverFiles(scanTarget);
      this.totalFiles = files.length;
      
      console.log(`   Found ${files.length} files to scan`);
      
      // Phase 2: Code analysis
      if (this.options.enableCodeAnalysis) {
        console.log('🔍 Phase 2: Code analysis');
        await this.analyzeSourceCode(files);
      }
      
      // Phase 3: Dependency analysis
      if (this.options.enableDependencyCheck) {
        console.log('📦 Phase 3: Dependency analysis');
        await this.analyzeDependencies(scanTarget);
      }
      
      // Phase 4: Configuration analysis
      if (this.options.enableConfigurationCheck) {
        console.log('⚙️  Phase 4: Configuration analysis');
        await this.analyzeConfigurations(files);
      }
      
      // Phase 5: Secrets scanning
      if (this.options.enableSecretsScanning) {
        console.log('🔐 Phase 5: Secrets scanning');
        await this.scanForSecrets(files);
      }
      
      // Calculate final metrics
      this.metrics.scanEndTime = performance.now();
      this.metrics.totalDuration = this.metrics.scanEndTime - this.metrics.scanStartTime;
      this.calculateVulnerabilityCounts();
      
      // Generate reports
      if (this.options.enableDetailedReports) {
        await this.generateReports();
      }
      
      this.emit('scan:completed', {
        metrics: this.metrics,
        vulnerabilities: this.vulnerabilities.length,
        duration: this.metrics.totalDuration
      });
      
      console.log(`✅ Security scan completed in ${(this.metrics.totalDuration / 1000).toFixed(2)}s`);
      console.log(`   Found ${this.vulnerabilities.length} potential issues`);
      
      return {
        success: true,
        metrics: this.metrics,
        vulnerabilities: this.vulnerabilities,
        summary: this.generateSummary()
      };
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'security-scanner',
        category: ErrorCategory.SCAN_EXECUTION,
        target: scanTarget
      });
      throw error;
    }
  }
  
  /**
   * Discover files to scan
   */
  async discoverFiles(directory) {
    const files = [];
    
    const scanDirectory = async (dir) => {
      try {
        const items = await readdir(dir);
        
        for (const item of items) {
          const fullPath = join(dir, item);
          const stats = await stat(fullPath);
          
          if (stats.isDirectory()) {
            // Check if directory should be excluded
            if (!this.shouldExcludePath(fullPath)) {
              await scanDirectory(fullPath);
            }
          } else if (stats.isFile()) {
            // Check if file should be scanned
            if (this.shouldScanFile(fullPath)) {
              files.push(fullPath);
            }
          }
        }
      } catch (error) {
        // Ignore permission errors for directories
      }
    };
    
    await scanDirectory(directory);
    return files;
  }
  
  /**
   * Analyze source code for vulnerabilities
   */
  async analyzeSourceCode(files) {
    const sourceFiles = files.filter(file => this.isSourceFile(file));
    let processed = 0;
    
    // Process files in chunks to avoid overwhelming the system
    for (let i = 0; i < sourceFiles.length; i += this.options.chunkSize) {
      const chunk = sourceFiles.slice(i, i + this.options.chunkSize);
      
      await Promise.all(chunk.map(async (file) => {
        try {
          await this.analyzeFile(file);
          processed++;
          
          this.scanProgress = (processed / sourceFiles.length) * 100;
          this.emit('scan:progress', {
            phase: 'code_analysis',
            progress: this.scanProgress,
            currentFile: file
          });
          
        } catch (error) {
          console.warn(`Failed to analyze ${file}: ${error.message}`);
        }
      }));
    }
  }
  
  /**
   * Analyze individual file for security issues
   */
  async analyzeFile(filePath) {
    try {
      const content = await readFile(filePath, 'utf8');
      const extension = extname(filePath).toLowerCase();
      
      this.scannedFiles++;
      this.metrics.filesScanned++;
      
      // Apply security rules based on file type
      const applicableRules = this.securityRules.filter(rule => 
        !rule.fileTypes || rule.fileTypes.includes(extension)
      );
      
      for (const rule of applicableRules) {
        const matches = this.applySecurityRule(rule, content, filePath);
        this.vulnerabilities.push(...matches);
      }
      
      // Check for hardcoded secrets
      if (this.options.enableSecretsScanning) {
        const secrets = this.scanForSecretsInContent(content, filePath);
        this.vulnerabilities.push(...secrets);
      }
      
    } catch (error) {
      console.warn(`Error analyzing file ${filePath}: ${error.message}`);
    }
  }
  
  /**
   * Apply security rule to content
   */
  applySecurityRule(rule, content, filePath) {
    const vulnerabilities = [];
    
    try {
      const pattern = new RegExp(rule.pattern, rule.flags || 'gi');
      let match;
      
      const lines = content.split('\n');
      
      while ((match = pattern.exec(content)) !== null) {
        // Find line number
        const lineNumber = this.getLineNumber(content, match.index);
        const line = lines[lineNumber - 1] || '';
        
        // Skip if context exclusion matches
        if (rule.excludeContext && rule.excludeContext.test(line)) {
          continue;
        }
        
        vulnerabilities.push({
          id: this.generateVulnerabilityId(),
          type: rule.type,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          file: filePath,
          line: lineNumber,
          column: this.getColumnNumber(content, match.index),
          code: line.trim(),
          match: match[0],
          recommendation: rule.recommendation,
          cwe: rule.cwe,
          owasp: rule.owasp,
          confidence: rule.confidence || 'medium',
          category: rule.category || 'security',
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.warn(`Error applying rule ${rule.id}: ${error.message}`);
    }
    
    return vulnerabilities;
  }
  
  /**
   * Analyze dependencies for known vulnerabilities
   */
  async analyzeDependencies(directory) {
    const packageJsonPath = join(directory, 'package.json');
    
    try {
      const content = await readFile(packageJsonPath, 'utf8');
      const packageData = JSON.parse(content);
      
      // Check dependencies and devDependencies
      const allDeps = {
        ...packageData.dependencies,
        ...packageData.devDependencies
      };
      
      for (const [name, version] of Object.entries(allDeps)) {
        const vulns = await this.checkDependencyVulnerabilities(name, version);
        this.vulnerabilities.push(...vulns);
      }
      
    } catch (error) {
      // package.json not found or invalid
    }
  }
  
  /**
   * Check dependency for known vulnerabilities
   */
  async checkDependencyVulnerabilities(name, version) {
    const vulnerabilities = [];
    
    // Check against vulnerability database
    if (this.vulnerabilityDatabase.has(name)) {
      const vulnData = this.vulnerabilityDatabase.get(name);
      
      for (const vuln of vulnData) {
        if (this.versionInRange(version, vuln.affectedVersions)) {
          vulnerabilities.push({
            id: this.generateVulnerabilityId(),
            type: 'dependency_vulnerability',
            severity: vuln.severity,
            title: `Known vulnerability in ${name}`,
            description: vuln.description,
            file: 'package.json',
            line: 0,
            column: 0,
            code: `"${name}": "${version}"`,
            dependency: name,
            version: version,
            cve: vuln.cve,
            cvss: vuln.cvss,
            recommendation: vuln.recommendation || `Update ${name} to a safe version`,
            category: 'dependency',
            confidence: 'high',
            timestamp: Date.now()
          });
        }
      }
    }
    
    return vulnerabilities;
  }
  
  /**
   * Analyze configuration files
   */
  async analyzeConfigurations(files) {
    const configFiles = files.filter(file => this.isConfigurationFile(file));
    
    for (const file of configFiles) {
      try {
        await this.analyzeConfigurationFile(file);
      } catch (error) {
        console.warn(`Failed to analyze config ${file}: ${error.message}`);
      }
    }
  }
  
  /**
   * Analyze individual configuration file
   */
  async analyzeConfigurationFile(filePath) {
    const content = await readFile(filePath, 'utf8');
    const fileName = join(filePath).toLowerCase();
    
    // Check for common misconfigurations
    const configRules = this.getConfigurationRules(fileName);
    
    for (const rule of configRules) {
      const matches = this.applySecurityRule(rule, content, filePath);
      this.vulnerabilities.push(...matches);
    }
  }
  
  /**
   * Scan for secrets and sensitive information
   */
  async scanForSecrets(files) {
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const secrets = this.scanForSecretsInContent(content, file);
        this.vulnerabilities.push(...secrets);
      } catch (error) {
        // Ignore binary files or permission errors
      }
    }
  }
  
  /**
   * Scan content for secrets
   */
  scanForSecretsInContent(content, filePath) {
    const secrets = [];
    
    for (const pattern of this.secretPatterns) {
      const regex = new RegExp(pattern.pattern, pattern.flags || 'gi');
      let match;
      
      while ((match = regex.exec(content)) !== null) {
        const lineNumber = this.getLineNumber(content, match.index);
        const line = content.split('\n')[lineNumber - 1] || '';
        
        // Skip if it's a comment or example
        if (this.isCommentOrExample(line)) {
          continue;
        }
        
        secrets.push({
          id: this.generateVulnerabilityId(),
          type: 'secret_exposure',
          severity: pattern.severity,
          title: pattern.title,
          description: pattern.description,
          file: filePath,
          line: lineNumber,
          column: this.getColumnNumber(content, match.index),
          code: line.trim(),
          match: '***REDACTED***', // Don't include actual secret
          secretType: pattern.type,
          recommendation: pattern.recommendation,
          category: 'secrets',
          confidence: 'high',
          timestamp: Date.now()
        });
      }
    }
    
    return secrets;
  }
  
  /**
   * Initialize security rules
   */
  initializeSecurityRules() {
    return [
      // SQL Injection
      {
        id: 'sql_injection',
        type: 'sql_injection',
        severity: 'high',
        title: 'Potential SQL Injection',
        description: 'Direct string concatenation in SQL query may lead to SQL injection',
        pattern: '(query|execute)\\s*\\(\\s*["\'].*\\+.*["\']\\s*\\)',
        recommendation: 'Use parameterized queries or prepared statements',
        cwe: 'CWE-89',
        owasp: 'A03:2021',
        fileTypes: ['.js', '.ts', '.sql'],
        confidence: 'medium'
      },
      
      // XSS Vulnerabilities
      {
        id: 'xss_vulnerability',
        type: 'cross_site_scripting',
        severity: 'high',
        title: 'Potential XSS Vulnerability',
        description: 'Direct HTML output without sanitization may lead to XSS',
        pattern: '(\\.innerHTML\\s*=|document\\.write\\s*\\()',
        recommendation: 'Sanitize user input before displaying in HTML',
        cwe: 'CWE-79',
        owasp: 'A03:2021',
        fileTypes: ['.js', '.ts', '.html'],
        confidence: 'medium'
      },
      
      // Command Injection
      {
        id: 'command_injection',
        type: 'command_injection',
        severity: 'critical',
        title: 'Potential Command Injection',
        description: 'Dynamic command execution may lead to command injection',
        pattern: '(exec|spawn|system)\\s*\\([^)]*\\+[^)]*\\)',
        recommendation: 'Validate and sanitize input, use safe command execution methods',
        cwe: 'CWE-78',
        owasp: 'A03:2021',
        fileTypes: ['.js', '.ts', '.py', '.sh'],
        confidence: 'high'
      },
      
      // Path Traversal
      {
        id: 'path_traversal',
        type: 'path_traversal',
        severity: 'high',
        title: 'Potential Path Traversal',
        description: 'User input used in file paths may lead to path traversal attacks',
        pattern: '(readFile|writeFile|createReadStream)\\s*\\([^)]*req\\.',
        recommendation: 'Validate and sanitize file paths, use path.resolve()',
        cwe: 'CWE-22',
        owasp: 'A01:2021',
        fileTypes: ['.js', '.ts'],
        confidence: 'medium'
      },
      
      // Weak Cryptography
      {
        id: 'weak_crypto',
        type: 'weak_cryptography',
        severity: 'medium',
        title: 'Weak Cryptographic Algorithm',
        description: 'Use of weak or deprecated cryptographic algorithms',
        pattern: '(md5|sha1|des|rc4)\\s*\\(',
        recommendation: 'Use strong cryptographic algorithms like SHA-256, AES',
        cwe: 'CWE-327',
        owasp: 'A02:2021',
        fileTypes: ['.js', '.ts', '.py'],
        confidence: 'high'
      },
      
      // Insecure Random
      {
        id: 'insecure_random',
        type: 'insecure_randomness',
        severity: 'medium',
        title: 'Insecure Random Number Generation',
        description: 'Math.random() is not cryptographically secure',
        pattern: 'Math\\.random\\s*\\(\\s*\\)',
        recommendation: 'Use crypto.randomBytes() for security-sensitive randomness',
        cwe: 'CWE-338',
        fileTypes: ['.js', '.ts'],
        confidence: 'medium'
      },
      
      // Hardcoded Credentials
      {
        id: 'hardcoded_credentials',
        type: 'hardcoded_credentials',
        severity: 'critical',
        title: 'Hardcoded Credentials',
        description: 'Hardcoded credentials found in source code',
        pattern: '(password|secret|key)\\s*[=:]\\s*["\'][^"\']{8,}["\']',
        excludeContext: /(example|test|demo|placeholder)/i,
        recommendation: 'Use environment variables or secure configuration management',
        cwe: 'CWE-798',
        owasp: 'A07:2021',
        confidence: 'medium'
      }
    ];
  }
  
  /**
   * Initialize secret patterns
   */
  initializeSecretPatterns() {
    return [
      {
        type: 'api_key',
        pattern: '(?i)(api[_-]?key|apikey)[\\s=:]["\']?([a-zA-Z0-9_-]{20,})["\']?',
        severity: 'high',
        title: 'API Key Detected',
        description: 'Potential API key found in source code',
        recommendation: 'Store API keys in environment variables'
      },
      {
        type: 'jwt_token',
        pattern: 'eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_-]*',
        severity: 'high',
        title: 'JWT Token Detected',
        description: 'JWT token found in source code',
        recommendation: 'Never hardcode JWT tokens'
      },
      {
        type: 'private_key',
        pattern: '-----BEGIN[\\s\\w]*PRIVATE KEY-----',
        severity: 'critical',
        title: 'Private Key Detected',
        description: 'Private key found in source code',
        recommendation: 'Store private keys securely, never in source code'
      },
      {
        type: 'aws_access_key',
        pattern: '(AKIA[0-9A-Z]{16})',
        severity: 'critical',
        title: 'AWS Access Key Detected',
        description: 'AWS access key found in source code',
        recommendation: 'Use AWS IAM roles or environment variables'
      },
      {
        type: 'database_connection',
        pattern: '(mongodb://|mysql://|postgresql://|sqlite://)([^\\s"\'<>]+)',
        severity: 'high',
        title: 'Database Connection String',
        description: 'Database connection string with potential credentials',
        recommendation: 'Use environment variables for connection strings'
      }
    ];
  }
  
  /**
   * Load vulnerability database
   */
  async loadVulnerabilityDatabase() {
    // This would typically load from a vulnerability database like NVD
    // For now, we'll use a simple example database
    this.vulnerabilityDatabase.set('express', [
      {
        cve: 'CVE-2022-24999',
        severity: 'medium',
        description: 'Denial of service vulnerability in Express.js',
        affectedVersions: '<4.18.0',
        cvss: 5.3,
        recommendation: 'Update to Express.js 4.18.0 or later'
      }
    ]);
    
    this.vulnerabilityDatabase.set('lodash', [
      {
        cve: 'CVE-2021-23337',
        severity: 'high',
        description: 'Command injection vulnerability in Lodash',
        affectedVersions: '<4.17.21',
        cvss: 7.2,
        recommendation: 'Update to Lodash 4.17.21 or later'
      }
    ]);
  }
  
  /**
   * Get configuration rules based on file name
   */
  getConfigurationRules(fileName) {
    const rules = [];
    
    if (fileName.includes('nginx') || fileName.includes('.conf')) {
      rules.push({
        id: 'nginx_ssl_config',
        type: 'configuration',
        severity: 'medium',
        title: 'Insecure SSL Configuration',
        description: 'SSL configuration may be insecure',
        pattern: 'ssl_protocols\\s+.*SSLv[23]',
        recommendation: 'Use only TLS 1.2 and higher'
      });
    }
    
    if (fileName.includes('docker')) {
      rules.push({
        id: 'docker_root_user',
        type: 'configuration',
        severity: 'medium',
        title: 'Docker Running as Root',
        description: 'Container running as root user',
        pattern: 'USER\\s+root',
        recommendation: 'Use non-root user in Docker containers'
      });
    }
    
    return rules;
  }
  
  /**
   * Utility functions
   */
  shouldExcludePath(path) {
    return this.options.excludePatterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      return regex.test(path);
    });
  }
  
  shouldScanFile(filePath) {
    const extension = extname(filePath).toLowerCase();
    const scannable = ['.js', '.ts', '.jsx', '.tsx', '.py', '.php', '.java', '.cs', '.go', '.rs', '.rb', '.sql', '.html', '.xml', '.json', '.yaml', '.yml', '.conf', '.config', '.env'];
    return scannable.includes(extension) || this.isConfigurationFile(filePath);
  }
  
  isSourceFile(filePath) {
    const extension = extname(filePath).toLowerCase();
    return ['.js', '.ts', '.jsx', '.tsx', '.py', '.php', '.java', '.cs', '.go', '.rs', '.rb', '.sql'].includes(extension);
  }
  
  isConfigurationFile(filePath) {
    const fileName = join(filePath).toLowerCase();
    return fileName.includes('config') || 
           fileName.includes('.env') || 
           fileName.includes('docker') ||
           fileName.includes('nginx') ||
           fileName.includes('.yml') ||
           fileName.includes('.yaml');
  }
  
  isCommentOrExample(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || 
           trimmed.startsWith('/*') || 
           trimmed.startsWith('#') || 
           trimmed.includes('example') ||
           trimmed.includes('test') ||
           trimmed.includes('demo');
  }
  
  getLineNumber(content, index) {
    return content.substring(0, index).split('\n').length;
  }
  
  getColumnNumber(content, index) {
    const lines = content.substring(0, index).split('\n');
    return lines[lines.length - 1].length + 1;
  }
  
  generateVulnerabilityId() {
    return `vuln_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  versionInRange(version, range) {
    // Simple version range check - in production, use a proper semver library
    return range.includes(version) || range.includes('<');
  }
  
  /**
   * Calculate vulnerability counts by severity
   */
  calculateVulnerabilityCounts() {
    this.metrics.vulnerabilitiesFound = this.vulnerabilities.length;
    this.metrics.criticalVulns = this.vulnerabilities.filter(v => v.severity === 'critical').length;
    this.metrics.highVulns = this.vulnerabilities.filter(v => v.severity === 'high').length;
    this.metrics.mediumVulns = this.vulnerabilities.filter(v => v.severity === 'medium').length;
    this.metrics.lowVulns = this.vulnerabilities.filter(v => v.severity === 'low').length;
    this.metrics.infoVulns = this.vulnerabilities.filter(v => v.severity === 'info').length;
  }
  
  /**
   * Generate security scan reports
   */
  async generateReports() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Generate JSON report
    const jsonReport = {
      metadata: {
        scanDate: new Date().toISOString(),
        scanner: 'Otedama Security Scanner v1.0',
        target: this.options.scanDirectory,
        duration: this.metrics.totalDuration
      },
      metrics: this.metrics,
      vulnerabilities: this.vulnerabilities,
      summary: this.generateSummary()
    };
    
    const jsonPath = join(this.options.outputDirectory, `security-report-${timestamp}.json`);
    await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));
    
    // Generate HTML report
    const htmlReport = this.generateHTMLReport(jsonReport);
    const htmlPath = join(this.options.outputDirectory, `security-report-${timestamp}.html`);
    await writeFile(htmlPath, htmlReport);
    
    // Generate CSV report for vulnerabilities
    const csvReport = this.generateCSVReport();
    const csvPath = join(this.options.outputDirectory, `vulnerabilities-${timestamp}.csv`);
    await writeFile(csvPath, csvReport);
    
    console.log(`📊 Security reports generated:`);
    console.log(`   JSON: ${jsonPath}`);
    console.log(`   HTML: ${htmlPath}`);
    console.log(`   CSV: ${csvPath}`);
  }
  
  /**
   * Generate scan summary
   */
  generateSummary() {
    const riskScore = this.calculateRiskScore();
    
    return {
      riskScore,
      riskLevel: this.getRiskLevel(riskScore),
      totalVulnerabilities: this.vulnerabilities.length,
      severityBreakdown: {
        critical: this.metrics.criticalVulns,
        high: this.metrics.highVulns,
        medium: this.metrics.mediumVulns,
        low: this.metrics.lowVulns,
        info: this.metrics.infoVulns
      },
      topVulnerabilityTypes: this.getTopVulnerabilityTypes(),
      recommendations: this.getTopRecommendations()
    };
  }
  
  /**
   * Calculate overall risk score
   */
  calculateRiskScore() {
    const weights = { critical: 10, high: 7, medium: 4, low: 2, info: 1 };
    const total = this.metrics.criticalVulns * weights.critical +
                  this.metrics.highVulns * weights.high +
                  this.metrics.mediumVulns * weights.medium +
                  this.metrics.lowVulns * weights.low +
                  this.metrics.infoVulns * weights.info;
    
    return Math.min(100, Math.round((total / Math.max(1, this.metrics.filesScanned)) * 10));
  }
  
  /**
   * Get risk level based on score
   */
  getRiskLevel(score) {
    if (score >= 80) return 'CRITICAL';
    if (score >= 60) return 'HIGH';
    if (score >= 40) return 'MEDIUM';
    if (score >= 20) return 'LOW';
    return 'MINIMAL';
  }
  
  /**
   * Get top vulnerability types
   */
  getTopVulnerabilityTypes() {
    const typeCounts = {};
    
    this.vulnerabilities.forEach(vuln => {
      typeCounts[vuln.type] = (typeCounts[vuln.type] || 0) + 1;
    });
    
    return Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));
  }
  
  /**
   * Get top recommendations
   */
  getTopRecommendations() {
    const recommendations = new Set();
    
    this.vulnerabilities
      .filter(v => v.severity === 'critical' || v.severity === 'high')
      .forEach(v => recommendations.add(v.recommendation));
    
    return Array.from(recommendations).slice(0, 5);
  }
  
  /**
   * Generate HTML report
   */
  generateHTMLReport(data) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Security Scan Report - ${data.metadata.scanDate}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .risk-score { font-size: 2em; font-weight: bold; margin: 10px 0; }
        .critical { color: #d32f2f; }
        .high { color: #f57c00; }
        .medium { color: #fbc02d; }
        .low { color: #388e3c; }
        .minimal { color: #1976d2; }
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .metric-card { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; }
        .vuln-list { margin-top: 30px; }
        .vuln-item { border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 5px; }
        .vuln-header { font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .severity-badge { padding: 3px 8px; border-radius: 3px; color: white; font-size: 0.8em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 Security Scan Report</h1>
            <p><strong>Scan Date:</strong> ${data.metadata.scanDate}</p>
            <p><strong>Target:</strong> ${data.metadata.target}</p>
            <p><strong>Duration:</strong> ${(data.metadata.duration / 1000).toFixed(2)}s</p>
        </div>
        
        <div class="risk-score ${data.summary.riskLevel.toLowerCase()}">
            Risk Level: ${data.summary.riskLevel} (Score: ${data.summary.riskScore}/100)
        </div>
        
        <div class="metrics">
            <div class="metric-card">
                <h3>Total Vulnerabilities</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.summary.totalVulnerabilities}</div>
            </div>
            <div class="metric-card">
                <h3>Files Scanned</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.metrics.filesScanned}</div>
            </div>
            <div class="metric-card critical">
                <h3>Critical</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.summary.severityBreakdown.critical}</div>
            </div>
            <div class="metric-card high">
                <h3>High</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.summary.severityBreakdown.high}</div>
            </div>
            <div class="metric-card medium">
                <h3>Medium</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.summary.severityBreakdown.medium}</div>
            </div>
            <div class="metric-card low">
                <h3>Low</h3>
                <div style="font-size: 2em; font-weight: bold;">${data.summary.severityBreakdown.low}</div>
            </div>
        </div>
        
        <div class="vuln-list">
            <h2>🚨 Vulnerabilities Found</h2>
            ${data.vulnerabilities.map(vuln => `
                <div class="vuln-item">
                    <div class="vuln-header">
                        <span>${vuln.title}</span>
                        <span class="severity-badge ${vuln.severity}">${vuln.severity.toUpperCase()}</span>
                    </div>
                    <p>${vuln.description}</p>
                    <p><strong>File:</strong> ${vuln.file}:${vuln.line}</p>
                    <p><strong>Code:</strong> <code>${vuln.code}</code></p>
                    <p><strong>Recommendation:</strong> ${vuln.recommendation}</p>
                </div>
            `).join('')}
        </div>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 0.9em;">
            Generated by Otedama Security Scanner v1.0
        </div>
    </div>
</body>
</html>`;
  }
  
  /**
   * Generate CSV report
   */
  generateCSVReport() {
    const headers = ['ID', 'Type', 'Severity', 'Title', 'File', 'Line', 'Code', 'Recommendation'];
    const rows = [headers.join(',')];
    
    this.vulnerabilities.forEach(vuln => {
      const row = [
        vuln.id,
        vuln.type,
        vuln.severity,
        `"${vuln.title}"`,
        `"${vuln.file}"`,
        vuln.line,
        `"${vuln.code.replace(/"/g, '""')}"`,
        `"${vuln.recommendation.replace(/"/g, '""')}"`
      ];
      rows.push(row.join(','));
    });
    
    return rows.join('\n');
  }
  
  /**
   * Reset metrics for new scan
   */
  resetMetrics() {
    this.vulnerabilities = [];
    this.scannedFiles = 0;
    this.scanProgress = 0;
    
    this.metrics = {
      scanStartTime: 0,
      scanEndTime: 0,
      totalDuration: 0,
      filesScanned: 0,
      vulnerabilitiesFound: 0,
      criticalVulns: 0,
      highVulns: 0,
      mediumVulns: 0,
      lowVulns: 0,
      infoVulns: 0
    };
  }
  
  /**
   * Get current scan status
   */
  getStatus() {
    return {
      isScanning: this.metrics.scanStartTime > 0 && this.metrics.scanEndTime === 0,
      progress: this.scanProgress,
      filesScanned: this.scannedFiles,
      totalFiles: this.totalFiles,
      vulnerabilitiesFound: this.vulnerabilities.length,
      currentPhase: this.getCurrentPhase()
    };
  }
  
  /**
   * Get current scan phase
   */
  getCurrentPhase() {
    if (this.metrics.scanStartTime === 0) return 'not_started';
    if (this.metrics.scanEndTime > 0) return 'completed';
    if (this.scanProgress < 25) return 'discovery';
    if (this.scanProgress < 50) return 'code_analysis';
    if (this.scanProgress < 75) return 'dependency_check';
    return 'final_analysis';
  }
}

export default SecurityScanner;