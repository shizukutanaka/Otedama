/**
 * Security Testing Example - Otedama
 * Demonstrates automated security testing
 */

import { createSecurityTester } from '../lib/security/security-tester.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const logger = createStructuredLogger('SecurityTestExample');

/**
 * Run security test suite
 */
async function runSecurityTests() {
  logger.info('Starting automated security test suite');
  
  // Create security tester
  const tester = createSecurityTester({
    baseUrl: process.env.TEST_URL || 'http://localhost:8080',
    apiKey: process.env.API_KEY,
    enableDestructiveTests: false, // Safety first
    testTimeout: 30000
  });
  
  try {
    // Run all tests
    const report = await tester.runAllTests();
    
    // Display summary
    console.log('\n=== Security Test Summary ===');
    console.log(`Total Tests: ${report.summary.totalTests}`);
    console.log(`Passed: ${report.summary.passed}`);
    console.log(`Failed: ${report.summary.failed}`);
    console.log(`Vulnerabilities Found: ${report.summary.vulnerabilities}`);
    console.log(`Duration: ${report.summary.duration}ms`);
    
    // Display vulnerabilities
    if (report.vulnerabilities.length > 0) {
      console.log('\n=== Vulnerabilities Found ===');
      for (const vuln of report.vulnerabilities) {
        console.log(`\n[${vuln.severity.toUpperCase()}] ${vuln.type}`);
        console.log(`Description: ${vuln.description}`);
        console.log(`Recommendation: ${vuln.recommendation}`);
        console.log(`Found in test: ${vuln.test}`);
      }
    } else {
      console.log('\n✓ No vulnerabilities found!');
    }
    
    // Display recommendations
    if (report.recommendations.length > 0) {
      console.log('\n=== Security Recommendations ===');
      for (const rec of report.recommendations) {
        console.log(`\n[${rec.priority.toUpperCase()}] ${rec.title}`);
        console.log(`${rec.description}`);
      }
    }
    
    // Save detailed report
    const reportPath = join(process.cwd(), 'security-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    logger.info(`Detailed report saved to: ${reportPath}`);
    
    // Generate HTML report
    const htmlReport = generateHTMLReport(report);
    const htmlPath = join(process.cwd(), 'security-report.html');
    await fs.writeFile(htmlPath, htmlReport);
    logger.info(`HTML report saved to: ${htmlPath}`);
    
    // Exit with appropriate code
    process.exit(report.vulnerabilities.length > 0 ? 1 : 0);
    
  } catch (error) {
    logger.error('Security testing failed:', error);
    process.exit(2);
  }
}

/**
 * Generate HTML security report
 */
function generateHTMLReport(report) {
  const severityColors = {
    critical: '#dc2626',
    high: '#f59e0b',
    medium: '#3b82f6',
    low: '#10b981'
  };
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Otedama Security Report - ${new Date().toLocaleDateString()}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 20px;
      background: #f9fafb;
      color: #111827;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1, h2, h3 {
      margin-top: 0;
      color: #1f2937;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }
    .stat {
      background: #f3f4f6;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      color: #3b82f6;
    }
    .stat-label {
      color: #6b7280;
      font-size: 0.9em;
    }
    .vulnerability {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .severity {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      color: white;
      font-weight: bold;
      font-size: 0.8em;
    }
    .recommendation {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .test-result {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #e5e7eb;
    }
    .test-result:last-child {
      border-bottom: none;
    }
    .passed {
      color: #10b981;
    }
    .failed {
      color: #ef4444;
    }
    .priority {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 0.8em;
      background: #e5e7eb;
      color: #374151;
    }
    .priority.critical {
      background: #dc2626;
      color: white;
    }
    .priority.high {
      background: #f59e0b;
      color: white;
    }
    .timestamp {
      color: #6b7280;
      font-size: 0.9em;
      margin-top: 30px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Otedama Security Test Report</h1>
    
    <div class="summary">
      <div class="stat">
        <div class="stat-value">${report.summary.totalTests}</div>
        <div class="stat-label">Total Tests</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: #10b981">${report.summary.passed}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: #ef4444">${report.summary.failed}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: ${report.summary.vulnerabilities > 0 ? '#f59e0b' : '#10b981'}">
          ${report.summary.vulnerabilities}
        </div>
        <div class="stat-label">Vulnerabilities</div>
      </div>
    </div>
    
    ${report.vulnerabilities.length > 0 ? `
      <h2>Vulnerabilities Found</h2>
      ${report.vulnerabilities.map(vuln => `
        <div class="vulnerability">
          <div style="margin-bottom: 10px">
            <span class="severity" style="background: ${severityColors[vuln.severity]}">
              ${vuln.severity.toUpperCase()}
            </span>
            <strong style="margin-left: 10px">${vuln.type.replace(/_/g, ' ').toUpperCase()}</strong>
          </div>
          <p><strong>Description:</strong> ${vuln.description}</p>
          <p><strong>Recommendation:</strong> ${vuln.recommendation}</p>
          <p style="color: #6b7280; font-size: 0.9em">Found in test: ${vuln.test}</p>
        </div>
      `).join('')}
    ` : '<h2 style="color: #10b981">✓ No vulnerabilities found!</h2>'}
    
    <h2>Recommendations</h2>
    ${report.recommendations.map(rec => `
      <div class="recommendation">
        <div style="margin-bottom: 10px">
          <span class="priority ${rec.priority}">${rec.priority.toUpperCase()}</span>
          <strong style="margin-left: 10px">${rec.title}</strong>
        </div>
        <p>${rec.description}</p>
      </div>
    `).join('')}
    
    <h2>Test Results</h2>
    <div style="background: #f9fafb; padding: 20px; border-radius: 8px">
      ${report.testResults.map(test => `
        <div class="test-result">
          <span>${test.name}</span>
          <span class="${test.passed ? 'passed' : 'failed'}">
            ${test.passed ? '✓ PASSED' : '✗ FAILED'}
          </span>
        </div>
      `).join('')}
    </div>
    
    <div class="timestamp">
      Report generated on ${new Date(report.summary.timestamp).toLocaleString()}<br>
      Test duration: ${report.summary.duration}ms
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Run specific test category
 */
async function runCategoryTests(category) {
  logger.info(`Running ${category} security tests`);
  
  const tester = createSecurityTester({
    baseUrl: process.env.TEST_URL || 'http://localhost:8080'
  });
  
  // Run specific category
  switch (category) {
    case 'injection':
      await tester.testInjectionVulnerabilities();
      break;
    case 'auth':
      await tester.testAuthentication();
      break;
    case 'crypto':
      await tester.testCryptography();
      break;
    default:
      logger.error(`Unknown category: ${category}`);
      process.exit(1);
  }
  
  const report = tester.generateReport();
  console.log(JSON.stringify(report, null, 2));
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

if (command === 'category' && args[1]) {
  runCategoryTests(args[1]).catch(console.error);
} else {
  runSecurityTests().catch(console.error);
}

export { runSecurityTests, runCategoryTests };