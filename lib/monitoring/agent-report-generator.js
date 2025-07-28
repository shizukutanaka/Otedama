import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import { agentManager } from '../agents/agent-manager.js';
import { agentMetricsCollector } from './agent-metrics-collector.js';
import { agentLogAnalyzer } from './agent-log-analyzer.js';

/**
 * Comprehensive Agent Report Generator
 * Generates detailed reports combining metrics, logs, and analysis
 */
export class AgentReportGenerator {
  constructor(options = {}) {
    this.reportsDirectory = options.reportsDirectory || 'reports';
    this.templatesDirectory = options.templatesDirectory || 'templates';
    this.autoGenerateInterval = options.autoGenerateInterval || 3600000; // 1 hour
    this.retentionDays = options.retentionDays || 30;
    
    this.reportTypes = {
      daily: { interval: 86400000, retention: 30 },
      weekly: { interval: 604800000, retention: 12 },
      monthly: { interval: 2592000000, retention: 12 },
      adhoc: { interval: null, retention: 90 }
    };
    
    this.isGenerating = false;
    this.generationTimer = null;
    this.scheduledReports = new Map();
    
    this.ensureDirectories();
  }

  async ensureDirectories() {
    try {
      await fs.mkdir(this.reportsDirectory, { recursive: true });
      await fs.mkdir(path.join(this.reportsDirectory, 'daily'), { recursive: true });
      await fs.mkdir(path.join(this.reportsDirectory, 'weekly'), { recursive: true });
      await fs.mkdir(path.join(this.reportsDirectory, 'monthly'), { recursive: true });
      await fs.mkdir(path.join(this.reportsDirectory, 'adhoc'), { recursive: true });
    } catch (error) {
      logger.error('Error creating report directories:', error);
    }
  }

  startAutoGeneration() {
    if (this.isGenerating) {
      logger.warn('Auto report generation already started');
      return;
    }

    this.isGenerating = true;
    
    // Schedule daily reports
    this.scheduleReport('daily', 0, 0); // Midnight
    
    // Schedule weekly reports  
    this.scheduleReport('weekly', 1, 2); // Monday 2 AM
    
    // Schedule monthly reports
    this.scheduleReport('monthly', 1, 3); // 1st day 3 AM
    
    logger.info('Auto report generation started');
  }

  stopAutoGeneration() {
    if (!this.isGenerating) {
      return;
    }

    this.isGenerating = false;
    
    // Clear all scheduled reports
    for (const timer of this.scheduledReports.values()) {
      clearInterval(timer);
    }
    this.scheduledReports.clear();
    
    logger.info('Auto report generation stopped');
  }

  scheduleReport(type, dayOffset = 0, hour = 0) {
    const now = new Date();
    const nextRun = new Date();
    
    if (type === 'daily') {
      nextRun.setHours(hour, 0, 0, 0);
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }
    } else if (type === 'weekly') {
      const dayOfWeek = nextRun.getDay();
      const daysUntilTarget = (dayOffset - dayOfWeek + 7) % 7;
      nextRun.setDate(nextRun.getDate() + daysUntilTarget);
      nextRun.setHours(hour, 0, 0, 0);
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 7);
      }
    } else if (type === 'monthly') {
      nextRun.setDate(dayOffset);
      nextRun.setHours(hour, 0, 0, 0);
      if (nextRun <= now) {
        nextRun.setMonth(nextRun.getMonth() + 1);
      }
    }

    const timeUntilNext = nextRun.getTime() - now.getTime();
    const interval = this.reportTypes[type].interval;

    const timer = setTimeout(async () => {
      await this.generateScheduledReport(type);
      
      // Set up recurring timer
      const recurringTimer = setInterval(async () => {
        await this.generateScheduledReport(type);
      }, interval);
      
      this.scheduledReports.set(type, recurringTimer);
    }, timeUntilNext);

    logger.info(`Scheduled ${type} report`, {
      nextRun: nextRun.toISOString(),
      timeUntilNext: Math.round(timeUntilNext / 1000 / 60)
    });
  }

  async generateScheduledReport(type) {
    try {
      logger.info(`Generating scheduled ${type} report`);
      
      const timeRange = this.reportTypes[type].interval || 86400000;
      const report = await this.generateReport({
        type: 'comprehensive',
        timeRange,
        format: 'html',
        includeCharts: true,
        includeRecommendations: true
      });

      const filename = this.generateFilename(type);
      const filepath = path.join(this.reportsDirectory, type, filename);
      
      await fs.writeFile(filepath, report.content);
      
      logger.info(`${type} report generated: ${filename}`);
      
      // Clean up old reports
      await this.cleanupOldReports(type);
      
    } catch (error) {
      logger.error(`Error generating ${type} report:`, error);
    }
  }

  async generateReport(options = {}) {
    const {
      type = 'summary',
      timeRange = 86400000, // 24 hours
      format = 'json',
      includeMetrics = true,
      includeLogs = true,
      includeAnalysis = true,
      includeCharts = false,
      includeRecommendations = false,
      agentFilter = null
    } = options;

    logger.info('Generating agent report', {
      type,
      timeRange: timeRange / 3600000,
      format
    });

    const reportData = {
      metadata: {
        generated: new Date().toISOString(),
        timeRange: timeRange,
        type,
        agentCount: agentManager.agents.size
      },
      executive: await this.generateExecutiveSummary(timeRange),
      agents: {},
      system: {},
      analysis: {},
      recommendations: []
    };

    // Collect agent data
    if (includeMetrics || includeLogs) {
      reportData.agents = await this.collectAgentData(timeRange, agentFilter);
    }

    // Collect system metrics
    if (includeMetrics) {
      reportData.system = await this.collectSystemData(timeRange);
    }

    // Include log analysis
    if (includeAnalysis) {
      reportData.analysis = await this.collectAnalysisData(timeRange);
    }

    // Generate recommendations
    if (includeRecommendations) {
      reportData.recommendations = await this.generateRecommendations(reportData);
    }

    // Format the report
    const formattedReport = await this.formatReport(reportData, format, {
      includeCharts,
      type
    });

    return {
      data: reportData,
      content: formattedReport,
      metadata: {
        size: formattedReport.length,
        generatedAt: Date.now(),
        format
      }
    };
  }

  async generateExecutiveSummary(timeRange) {
    const cutoff = Date.now() - timeRange;
    
    // Agent performance summary
    const agents = agentManager.getAllAgents();
    const activeAgents = agents.filter(a => a.state === 'running' || a.state === 'ready');
    const totalExecutions = agents.reduce((sum, a) => sum + a.runCount, 0);
    const totalSuccesses = agents.reduce((sum, a) => sum + a.metrics.successCount, 0);
    const totalFailures = agents.reduce((sum, a) => sum + a.metrics.failureCount, 0);
    
    // Log analysis summary
    const logStats = agentLogAnalyzer.getAnalysisStats();
    const recentAnomalies = agentLogAnalyzer.anomalies.filter(a => a.timestamp > cutoff);
    const criticalAnomalies = recentAnomalies.filter(a => a.severity === 'critical');
    
    // System health
    const systemHealth = this.calculateSystemHealth(agents, recentAnomalies);
    
    return {
      overview: {
        systemHealth,
        totalAgents: agents.length,
        activeAgents: activeAgents.length,
        successRate: totalExecutions > 0 ? (totalSuccesses / totalExecutions) * 100 : 0
      },
      performance: {
        totalExecutions,
        successfulExecutions: totalSuccesses,
        failedExecutions: totalFailures,
        averageExecutionTime: this.calculateAverageExecutionTime(agents)
      },
      issues: {
        totalAnomalies: recentAnomalies.length,
        criticalIssues: criticalAnomalies.length,
        topIssues: this.getTopIssues(recentAnomalies)
      },
      trends: {
        performanceTrend: this.calculatePerformanceTrend(timeRange),
        errorTrend: this.calculateErrorTrend(timeRange),
        resourceTrend: this.calculateResourceTrend(timeRange)
      }
    };
  }

  async collectAgentData(timeRange, agentFilter) {
    const agentData = {};
    
    for (const [name, agent] of agentManager.agents) {
      if (agentFilter && !agentFilter.includes(name)) {
        continue;
      }
      
      const metrics = agentMetricsCollector.getAgentMetrics(name, null, timeRange);
      const status = agent.getStatus();
      
      agentData[name] = {
        basic: {
          name,
          type: agent.type,
          state: agent.state,
          enabled: agent.enabled
        },
        performance: {
          runCount: agent.runCount,
          successCount: agent.metrics.successCount,
          failureCount: agent.metrics.failureCount,
          averageExecutionTime: agent.metrics.averageExecutionTime,
          lastExecutionTime: agent.lastExecutionTime
        },
        metrics: this.summarizeAgentMetrics(metrics),
        issues: agent.errors.slice(-10),
        dependencies: Object.keys(agent.dependencies || {}),
        trends: this.calculateAgentTrends(metrics)
      };
    }
    
    return agentData;
  }

  async collectSystemData(timeRange) {
    const systemMetrics = agentMetricsCollector.getSystemMetrics(null, timeRange);
    const eventBusMetrics = agentMetricsCollector.getEventBusMetrics(timeRange);
    
    return {
      metrics: this.summarizeSystemMetrics(systemMetrics),
      eventBus: this.summarizeEventBusMetrics(eventBusMetrics),
      coordination: this.summarizeCoordinationMetrics(timeRange),
      health: this.assessSystemHealth(systemMetrics)
    };
  }

  async collectAnalysisData(timeRange) {
    const logReport = agentLogAnalyzer.generateReport({ timeRange });
    
    return {
      anomalies: logReport.anomalies,
      insights: logReport.insights,
      patterns: logReport.patterns,
      summary: logReport.summary
    };
  }

  async generateRecommendations(reportData) {
    const recommendations = [];
    
    // Performance recommendations
    if (reportData.executive.overview.successRate < 90) {
      recommendations.push({
        category: 'Performance',
        priority: 'High',
        title: 'Low Success Rate Detected',
        description: `System success rate is ${reportData.executive.overview.successRate.toFixed(1)}%`,
        actions: [
          'Review failing agents and their error logs',
          'Check system resources and scaling requirements',
          'Verify agent configurations and dependencies'
        ]
      });
    }
    
    // Critical issues recommendations
    if (reportData.executive.issues.criticalIssues > 0) {
      recommendations.push({
        category: 'Critical Issues',
        priority: 'Critical',
        title: 'Critical Anomalies Detected',
        description: `${reportData.executive.issues.criticalIssues} critical issues found`,
        actions: [
          'Immediate investigation of critical anomalies required',
          'Review system logs for error patterns',
          'Consider emergency maintenance if necessary'
        ]
      });
    }
    
    // Resource recommendations
    const memoryTrend = reportData.executive.trends.resourceTrend;
    if (memoryTrend === 'increasing') {
      recommendations.push({
        category: 'Resources',
        priority: 'Medium',
        title: 'Memory Usage Increasing',
        description: 'Memory usage showing upward trend',
        actions: [
          'Monitor for potential memory leaks',
          'Review agent memory usage patterns',
          'Consider scaling or optimization'
        ]
      });
    }
    
    // Agent-specific recommendations
    Object.entries(reportData.agents).forEach(([agentName, agentData]) => {
      if (agentData.performance.failureCount > 10) {
        recommendations.push({
          category: 'Agent Issues',
          priority: 'Medium',
          title: `High Failure Rate: ${agentName}`,
          description: `Agent ${agentName} has ${agentData.performance.failureCount} failures`,
          actions: [
            `Review ${agentName} configuration and dependencies`,
            'Check agent-specific logs for error patterns',
            'Consider restarting or reconfiguring the agent'
          ]
        });
      }
    });
    
    return recommendations.sort((a, b) => {
      const priorityOrder = { 'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  async formatReport(data, format, options = {}) {
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(data, null, 2);
      
      case 'html':
        return await this.formatHTMLReport(data, options);
      
      case 'markdown':
        return this.formatMarkdownReport(data);
      
      case 'csv':
        return this.formatCSVReport(data);
      
      case 'summary':
        return this.formatSummaryReport(data);
      
      default:
        throw new Error(`Unsupported report format: ${format}`);
    }
  }

  async formatHTMLReport(data, options = {}) {
    const { includeCharts = false, type = 'comprehensive' } = options;
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Agent Report - ${new Date(data.metadata.generated).toLocaleDateString()}</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: #f5f5f5; 
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            background: white; 
            padding: 30px; 
            border-radius: 8px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
        }
        .header { 
            border-bottom: 2px solid #2196F3; 
            padding-bottom: 20px; 
            margin-bottom: 30px; 
        }
        .header h1 { 
            color: #1976D2; 
            margin: 0; 
        }
        .executive-summary { 
            background: #e3f2fd; 
            padding: 20px; 
            border-radius: 6px; 
            margin-bottom: 30px; 
        }
        .metric-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 15px; 
            margin: 20px 0; 
        }
        .metric-card { 
            background: white; 
            padding: 15px; 
            border-radius: 6px; 
            border-left: 4px solid #4CAF50; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1); 
        }
        .metric-value { 
            font-size: 2em; 
            font-weight: bold; 
            color: #2196F3; 
        }
        .metric-label { 
            color: #666; 
            font-size: 0.9em; 
        }
        .section { 
            margin: 30px 0; 
        }
        .section h2 { 
            color: #1976D2; 
            border-bottom: 1px solid #ddd; 
            padding-bottom: 10px; 
        }
        .agent-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
            gap: 20px; 
        }
        .agent-card { 
            border: 1px solid #ddd; 
            border-radius: 6px; 
            padding: 15px; 
            background: #fafafa; 
        }
        .status-indicator { 
            display: inline-block; 
            width: 12px; 
            height: 12px; 
            border-radius: 50%; 
            margin-right: 8px; 
        }
        .status-running { background: #4CAF50; }
        .status-stopped { background: #f44336; }
        .status-ready { background: #2196F3; }
        .recommendations { 
            background: #fff3e0; 
            padding: 20px; 
            border-radius: 6px; 
            border-left: 4px solid #ff9800; 
        }
        .recommendation { 
            margin: 15px 0; 
            padding: 10px; 
            background: white; 
            border-radius: 4px; 
        }
        .priority-critical { border-left: 4px solid #f44336; }
        .priority-high { border-left: 4px solid #ff9800; }
        .priority-medium { border-left: 4px solid #2196F3; }
        .priority-low { border-left: 4px solid #4CAF50; }
        .chart-container { 
            margin: 20px 0; 
            padding: 20px; 
            background: #fafafa; 
            border-radius: 6px; 
        }
        table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 15px 0; 
        }
        th, td { 
            padding: 10px; 
            text-align: left; 
            border-bottom: 1px solid #ddd; 
        }
        th { 
            background: #f5f5f5; 
            font-weight: 600; 
        }
        .footer { 
            margin-top: 40px; 
            padding-top: 20px; 
            border-top: 1px solid #ddd; 
            text-align: center; 
            color: #666; 
            font-size: 0.9em; 
        }
    </style>
    ${includeCharts ? '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>' : ''}
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 Otedama Agent System Report</h1>
            <p>Generated: ${new Date(data.metadata.generated).toLocaleString()}</p>
            <p>Time Range: ${(data.metadata.timeRange / 3600000).toFixed(1)} hours | Type: ${type}</p>
        </div>

        <div class="executive-summary">
            <h2>📊 Executive Summary</h2>
            <div class="metric-grid">
                <div class="metric-card">
                    <div class="metric-value">${data.executive.overview.systemHealth}</div>
                    <div class="metric-label">System Health</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${data.executive.overview.totalAgents}</div>
                    <div class="metric-label">Total Agents</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${data.executive.overview.successRate.toFixed(1)}%</div>
                    <div class="metric-label">Success Rate</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${data.executive.issues.criticalIssues}</div>
                    <div class="metric-label">Critical Issues</div>
                </div>
            </div>
        </div>

        <div class="section">
            <h2>🤖 Agent Overview</h2>
            <div class="agent-grid">
                ${Object.entries(data.agents).map(([name, agent]) => `
                    <div class="agent-card">
                        <h3>
                            <span class="status-indicator status-${agent.basic.state}"></span>
                            ${name}
                        </h3>
                        <p><strong>Type:</strong> ${agent.basic.type}</p>
                        <p><strong>Success Rate:</strong> ${((agent.performance.successCount / (agent.performance.successCount + agent.performance.failureCount)) * 100 || 0).toFixed(1)}%</p>
                        <p><strong>Executions:</strong> ${agent.performance.runCount}</p>
                        <p><strong>Avg Time:</strong> ${agent.performance.averageExecutionTime}ms</p>
                    </div>
                `).join('')}
            </div>
        </div>

        ${data.recommendations.length > 0 ? `
        <div class="section">
            <h2>💡 Recommendations</h2>
            <div class="recommendations">
                ${data.recommendations.map(rec => `
                    <div class="recommendation priority-${rec.priority.toLowerCase()}">
                        <h4>${rec.title} (${rec.priority})</h4>
                        <p>${rec.description}</p>
                        <ul>
                            ${rec.actions.map(action => `<li>${action}</li>`).join('')}
                        </ul>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}

        <div class="section">
            <h2>🔍 Analysis Summary</h2>
            <table>
                <tr>
                    <th>Metric</th>
                    <th>Value</th>
                    <th>Status</th>
                </tr>
                <tr>
                    <td>Total Anomalies</td>
                    <td>${data.analysis.summary.anomaliesDetected}</td>
                    <td>${data.analysis.summary.anomaliesDetected === 0 ? '✅' : '⚠️'}</td>
                </tr>
                <tr>
                    <td>Critical Issues</td>
                    <td>${data.analysis.summary.criticalAnomalies}</td>
                    <td>${data.analysis.summary.criticalAnomalies === 0 ? '✅' : '🚨'}</td>
                </tr>
                <tr>
                    <td>Insights Generated</td>
                    <td>${data.analysis.summary.insightsGenerated}</td>
                    <td>ℹ️</td>
                </tr>
            </table>
        </div>

        <div class="footer">
            <p>Report generated by Otedama Agent Monitoring System</p>
            <p>For detailed analysis and real-time monitoring, visit the Agent Dashboard</p>
        </div>
    </div>
</body>
</html>`;
    
    return html;
  }

  formatMarkdownReport(data) {
    const md = `# 🎯 Otedama Agent System Report

**Generated:** ${new Date(data.metadata.generated).toLocaleString()}  
**Time Range:** ${(data.metadata.timeRange / 3600000).toFixed(1)} hours  
**Total Agents:** ${data.metadata.agentCount}

## 📊 Executive Summary

| Metric | Value |
|--------|-------|
| System Health | ${data.executive.overview.systemHealth} |
| Active Agents | ${data.executive.overview.activeAgents}/${data.executive.overview.totalAgents} |
| Success Rate | ${data.executive.overview.successRate.toFixed(1)}% |
| Critical Issues | ${data.executive.issues.criticalIssues} |

## 🤖 Agent Performance

${Object.entries(data.agents).map(([name, agent]) => `
### ${name} (${agent.basic.type})

- **Status:** ${agent.basic.state}
- **Executions:** ${agent.performance.runCount}
- **Success Rate:** ${((agent.performance.successCount / (agent.performance.successCount + agent.performance.failureCount)) * 100 || 0).toFixed(1)}%
- **Average Execution Time:** ${agent.performance.averageExecutionTime}ms
- **Recent Issues:** ${agent.issues.length}
`).join('')}

${data.recommendations.length > 0 ? `
## 💡 Recommendations

${data.recommendations.map(rec => `
### ${rec.title} (${rec.priority})

${rec.description}

**Actions:**
${rec.actions.map(action => `- ${action}`).join('\n')}
`).join('')}
` : ''}

## 🔍 Analysis Summary

- **Anomalies Detected:** ${data.analysis.summary.anomaliesDetected}
- **Critical Issues:** ${data.analysis.summary.criticalAnomalies}
- **Insights Generated:** ${data.analysis.summary.insightsGenerated}

---
*Report generated by Otedama Agent Monitoring System*`;

    return md;
  }

  formatCSVReport(data) {
    const lines = [
      'Type,Agent,Metric,Value,Timestamp',
      ...Object.entries(data.agents).flatMap(([name, agent]) => [
        `agent,${name},runCount,${agent.performance.runCount},${data.metadata.generated}`,
        `agent,${name},successCount,${agent.performance.successCount},${data.metadata.generated}`,
        `agent,${name},failureCount,${agent.performance.failureCount},${data.metadata.generated}`,
        `agent,${name},averageExecutionTime,${agent.performance.averageExecutionTime},${data.metadata.generated}`
      ]),
      ...data.analysis.anomalies.map(anomaly => 
        `anomaly,${anomaly.source},${anomaly.rule},${anomaly.severity},${anomaly.timestamp}`
      )
    ];
    
    return lines.join('\n');
  }

  formatSummaryReport(data) {
    return `
=== OTEDAMA AGENT SYSTEM REPORT ===
Generated: ${new Date(data.metadata.generated).toLocaleString()}
Time Range: ${(data.metadata.timeRange / 3600000).toFixed(1)} hours

EXECUTIVE SUMMARY:
- System Health: ${data.executive.overview.systemHealth}
- Total Agents: ${data.executive.overview.totalAgents} (${data.executive.overview.activeAgents} active)
- Success Rate: ${data.executive.overview.successRate.toFixed(1)}%
- Critical Issues: ${data.executive.issues.criticalIssues}

TOP PERFORMING AGENTS:
${Object.entries(data.agents)
  .sort(([,a], [,b]) => b.performance.successCount - a.performance.successCount)
  .slice(0, 5)
  .map(([name, agent]) => `- ${name}: ${agent.performance.successCount} successes`)
  .join('\n')}

${data.recommendations.length > 0 ? `
PRIORITY RECOMMENDATIONS:
${data.recommendations.slice(0, 3).map(rec => `- ${rec.title} (${rec.priority})`).join('\n')}
` : ''}

ANALYSIS SUMMARY:
- Anomalies: ${data.analysis.summary.anomaliesDetected}
- Critical Issues: ${data.analysis.summary.criticalAnomalies}
- Insights: ${data.analysis.summary.insightsGenerated}
    `.trim();
  }

  generateFilename(type) {
    const now = new Date();
    const timestamp = now.toISOString().split('T')[0].replace(/-/g, '');
    return `agent_report_${type}_${timestamp}.html`;
  }

  async cleanupOldReports(type) {
    try {
      const reportDir = path.join(this.reportsDirectory, type);
      const files = await fs.readdir(reportDir);
      const retention = this.reportTypes[type].retention;
      
      if (files.length <= retention) {
        return;
      }
      
      // Sort files by modification time
      const fileStats = await Promise.all(
        files.map(async file => {
          const filepath = path.join(reportDir, file);
          const stats = await fs.stat(filepath);
          return { file, filepath, mtime: stats.mtime };
        })
      );
      
      fileStats.sort((a, b) => b.mtime - a.mtime);
      
      // Remove old files
      const filesToDelete = fileStats.slice(retention);
      for (const { filepath } of filesToDelete) {
        await fs.unlink(filepath);
        logger.debug(`Deleted old report: ${filepath}`);
      }
      
    } catch (error) {
      logger.error(`Error cleaning up ${type} reports:`, error);
    }
  }

  // Utility methods for calculations
  calculateSystemHealth(agents, anomalies) {
    const activeAgents = agents.filter(a => a.state === 'running').length;
    const totalAgents = agents.length;
    const criticalAnomalies = anomalies.filter(a => a.severity === 'critical').length;
    
    let health = 'Good';
    if (criticalAnomalies > 0 || activeAgents / totalAgents < 0.5) {
      health = 'Critical';
    } else if (anomalies.length > 5 || activeAgents / totalAgents < 0.8) {
      health = 'Warning';
    }
    
    return health;
  }

  calculateAverageExecutionTime(agents) {
    const times = agents.map(a => a.metrics.averageExecutionTime).filter(t => t > 0);
    return times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  }

  calculatePerformanceTrend(timeRange) {
    // Placeholder for trend calculation
    return 'stable';
  }

  calculateErrorTrend(timeRange) {
    // Placeholder for error trend calculation
    return 'stable';
  }

  calculateResourceTrend(timeRange) {
    // Placeholder for resource trend calculation
    return 'stable';
  }

  getTopIssues(anomalies) {
    const issueGroups = new Map();
    
    anomalies.forEach(anomaly => {
      const key = anomaly.rule;
      if (!issueGroups.has(key)) {
        issueGroups.set(key, { count: 0, severity: anomaly.severity });
      }
      issueGroups.get(key).count++;
    });
    
    return Array.from(issueGroups.entries())
      .sort(([,a], [,b]) => b.count - a.count)
      .slice(0, 5)
      .map(([rule, data]) => ({ rule, count: data.count, severity: data.severity }));
  }

  summarizeAgentMetrics(metrics) {
    if (!metrics || !metrics.performance) return {};
    
    return {
      totalDataPoints: metrics.performance.length,
      averageExecutionTime: this.calculateAverageFromMetrics(metrics.performance, 'executionTime'),
      successRate: this.calculateSuccessRateFromMetrics(metrics.performance)
    };
  }

  summarizeSystemMetrics(systemMetrics) {
    if (!systemMetrics.length) return {};
    
    return {
      totalSnapshots: systemMetrics.length,
      averageMemoryUsage: this.calculateAverageFromMetrics(systemMetrics, 'memory.heapUsed'),
      averageUptime: this.calculateAverageFromMetrics(systemMetrics, 'uptime')
    };
  }

  summarizeEventBusMetrics(eventBusMetrics) {
    return {
      totalEvents: eventBusMetrics.length,
      messageTypes: [...new Set(eventBusMetrics.map(e => e.messageType))].length
    };
  }

  summarizeCoordinationMetrics(timeRange) {
    const coordMetrics = agentMetricsCollector.getCoordinationMetrics(timeRange);
    
    return {
      totalSnapshots: coordMetrics.length,
      averageRulesCount: this.calculateAverageFromMetrics(coordMetrics, 'rulesCount'),
      averageSubscriptions: this.calculateAverageFromMetrics(coordMetrics, 'eventBusSubscriptions')
    };
  }

  assessSystemHealth(systemMetrics) {
    if (!systemMetrics.length) return 'Unknown';
    
    const latest = systemMetrics[systemMetrics.length - 1];
    const memUsagePercent = (latest.memory.heapUsed / latest.memory.heapTotal) * 100;
    
    if (memUsagePercent > 90) return 'Critical';
    if (memUsagePercent > 75) return 'Warning';
    return 'Good';
  }

  calculateAverageFromMetrics(metrics, path) {
    const values = metrics.map(m => this.getNestedValue(m, path)).filter(v => v != null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }

  calculateSuccessRateFromMetrics(metrics) {
    if (!metrics.length) return 0;
    
    const rates = metrics.map(m => {
      const total = m.metrics.successCount + m.metrics.failureCount;
      return total > 0 ? (m.metrics.successCount / total) * 100 : 0;
    });
    
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current && current[key], obj);
  }

  calculateAgentTrends(metrics) {
    // Placeholder for agent trend calculation
    return {
      performance: 'stable',
      reliability: 'stable',
      efficiency: 'stable'
    };
  }

  async saveReport(report, filename, directory = 'adhoc') {
    const filepath = path.join(this.reportsDirectory, directory, filename);
    await fs.writeFile(filepath, report.content);
    
    logger.info(`Report saved: ${filename}`, {
      size: report.metadata.size,
      format: report.metadata.format
    });
    
    return filepath;
  }

  async getReportHistory(type = null, limit = 10) {
    const reports = [];
    
    const types = type ? [type] : Object.keys(this.reportTypes);
    
    for (const reportType of types) {
      try {
        const reportDir = path.join(this.reportsDirectory, reportType);
        const files = await fs.readdir(reportDir);
        
        const fileInfo = await Promise.all(
          files.map(async file => {
            const filepath = path.join(reportDir, file);
            const stats = await fs.stat(filepath);
            return {
              filename: file,
              filepath,
              type: reportType,
              size: stats.size,
              created: stats.birthtime,
              modified: stats.mtime
            };
          })
        );
        
        reports.push(...fileInfo);
      } catch (error) {
        logger.warn(`Could not read ${reportType} reports:`, error.message);
      }
    }
    
    return reports
      .sort((a, b) => b.created - a.created)
      .slice(0, limit);
  }

  getGenerationStats() {
    return {
      isGenerating: this.isGenerating,
      autoGenerateInterval: this.autoGenerateInterval,
      scheduledReports: Array.from(this.scheduledReports.keys()),
      reportTypes: Object.keys(this.reportTypes),
      reportsDirectory: this.reportsDirectory
    };
  }
}

// Export singleton instance
export const agentReportGenerator = new AgentReportGenerator();