#!/usr/bin/env node

import { program } from 'commander';
import { agentReportGenerator } from '../lib/monitoring/agent-report-generator.js';
import { agentMetricsCollector } from '../lib/monitoring/agent-metrics-collector.js';
import { agentLogAnalyzer } from '../lib/monitoring/agent-log-analyzer.js';
import { agentManager } from '../lib/agents/agent-manager.js';
import { logger } from '../lib/core/logger.js';
import { config } from '../config/config.js';

/**
 * Standalone Agent Report Generator
 * Command-line tool for generating agent system reports
 */

program
  .name('generate-agent-report')
  .description('Generate comprehensive reports for the Otedama agent system')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate a report')
  .option('-t, --type <type>', 'Report type (summary, comprehensive, performance)', 'comprehensive')
  .option('-f, --format <format>', 'Output format (json, html, markdown, csv)', 'html')
  .option('-r, --range <hours>', 'Time range in hours', '24')
  .option('-o, --output <file>', 'Output file path')
  .option('--no-metrics', 'Exclude metrics data')
  .option('--no-logs', 'Exclude log analysis')
  .option('--no-analysis', 'Exclude anomaly analysis')
  .option('--no-recommendations', 'Exclude recommendations')
  .option('--charts', 'Include charts (HTML format only)')
  .option('--agents <agents>', 'Filter specific agents (comma-separated)')
  .option('--save', 'Save report to reports directory')
  .action(async (options) => {
    try {
      await generateReport(options);
    } catch (error) {
      logger.error('Failed to generate report:', error);
      process.exit(1);
    }
  });

program
  .command('schedule')
  .description('Start scheduled report generation')
  .option('-d, --daemon', 'Run as daemon')
  .action(async (options) => {
    try {
      await startScheduledGeneration(options);
    } catch (error) {
      logger.error('Failed to start scheduled generation:', error);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Run log analysis only')
  .option('-r, --range <hours>', 'Time range in hours', '24')
  .option('-f, --format <format>', 'Output format (json, summary, csv)', 'summary')
  .action(async (options) => {
    try {
      await runAnalysisOnly(options);
    } catch (error) {
      logger.error('Failed to run analysis:', error);
      process.exit(1);
    }
  });

program
  .command('history')
  .description('Show report generation history')
  .option('-t, --type <type>', 'Report type filter')
  .option('-l, --limit <number>', 'Limit results', '10')
  .action(async (options) => {
    try {
      await showReportHistory(options);
    } catch (error) {
      logger.error('Failed to show history:', error);
      process.exit(1);
    }
  });

async function generateReport(options) {
  logger.info('🚀 Starting report generation...');
  
  // Initialize systems
  await initializeSystems();
  
  const timeRange = parseInt(options.range) * 3600000; // Convert hours to milliseconds
  const agentFilter = options.agents ? options.agents.split(',').map(a => a.trim()) : null;
  
  const reportOptions = {
    type: options.type,
    timeRange,
    format: options.format,
    includeMetrics: options.metrics,
    includeLogs: options.logs,
    includeAnalysis: options.analysis,
    includeRecommendations: options.recommendations,
    includeCharts: options.charts,
    agentFilter
  };
  
  logger.info('Generating report with options:', {
    type: reportOptions.type,
    format: reportOptions.format,
    timeRangeHours: options.range,
    agentFilter: agentFilter?.length || 'all'
  });
  
  const report = await agentReportGenerator.generateReport(reportOptions);
  
  if (options.output) {
    // Save to specified file
    await saveReportToFile(report, options.output);
    logger.info(`✅ Report saved to: ${options.output}`);
  } else if (options.save) {
    // Save to reports directory
    const filename = `adhoc_report_${Date.now()}.${options.format}`;
    const filepath = await agentReportGenerator.saveReport(report, filename);
    logger.info(`✅ Report saved to: ${filepath}`);
  } else {
    // Output to console
    if (options.format === 'json') {
      console.log(JSON.stringify(report.data, null, 2));
    } else {
      console.log(report.content);
    }
  }
  
  logger.info('📊 Report generation completed', {
    size: `${Math.round(report.metadata.size / 1024)}KB`,
    format: report.metadata.format
  });
  
  await shutdownSystems();
}

async function startScheduledGeneration(options) {
  logger.info('🔄 Starting scheduled report generation...');
  
  await initializeSystems();
  
  agentReportGenerator.startAutoGeneration();
  
  logger.info('✅ Scheduled generation started');
  
  if (options.daemon) {
    logger.info('Running as daemon. Press Ctrl+C to stop.');
    
    process.on('SIGINT', async () => {
      logger.info('Stopping scheduled generation...');
      await shutdownSystems();
      process.exit(0);
    });
    
    // Keep process alive
    setInterval(() => {
      logger.debug('Scheduled generation running...');
    }, 60000);
  } else {
    await shutdownSystems();
  }
}

async function runAnalysisOnly(options) {
  logger.info('🔍 Running log analysis...');
  
  await initializeSystems();
  
  const timeRange = parseInt(options.range) * 3600000;
  
  // Start analysis
  agentLogAnalyzer.startAnalysis();
  
  // Wait for analysis to complete
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const report = agentLogAnalyzer.generateReport({ 
    timeRange, 
    includeDetails: true 
  });
  
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const exported = agentLogAnalyzer.exportAnalysis(options.format, { timeRange });
    console.log(exported);
  }
  
  logger.info('✅ Analysis completed', {
    anomalies: report.summary.anomaliesDetected,
    insights: report.summary.insightsGenerated
  });
  
  await shutdownSystems();
}

async function showReportHistory(options) {
  logger.info('📚 Retrieving report history...');
  
  const limit = parseInt(options.limit);
  const history = await agentReportGenerator.getReportHistory(options.type, limit);
  
  if (history.length === 0) {
    console.log('No reports found.');
    return;
  }
  
  console.log('\n=== Report History ===\n');
  
  history.forEach((report, index) => {
    console.log(`${index + 1}. ${report.filename}`);
    console.log(`   Type: ${report.type}`);
    console.log(`   Created: ${report.created.toLocaleString()}`);
    console.log(`   Size: ${Math.round(report.size / 1024)}KB`);
    console.log(`   Path: ${report.filepath}`);
    console.log('');
  });
  
  logger.info(`Found ${history.length} reports`);
}

async function initializeSystems() {
  // Initialize agent manager if not already initialized
  if (!agentManager.initialized) {
    logger.info('Initializing agent manager...');
    await agentManager.initialize(config.agents || {});
  }
  
  // Start metrics collection
  if (!agentMetricsCollector.isCollecting) {
    agentMetricsCollector.startCollection();
  }
  
  // Start log analysis
  if (!agentLogAnalyzer.isAnalyzing) {
    agentLogAnalyzer.startAnalysis();
  }
  
  // Allow some time for data collection
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function shutdownSystems() {
  agentMetricsCollector.stopCollection();
  agentLogAnalyzer.stopAnalysis();
  agentReportGenerator.stopAutoGeneration();
  await agentManager.shutdown();
}

async function saveReportToFile(report, filepath) {
  const fs = await import('fs/promises');
  await fs.writeFile(filepath, report.content, 'utf-8');
}

// Handle process termination
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await shutdownSystems();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await shutdownSystems();
  process.exit(0);
});

// Parse command line arguments
program.parse();