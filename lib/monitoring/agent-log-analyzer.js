import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import { agentManager } from '../agents/agent-manager.js';
import { agentMetricsCollector } from './agent-metrics-collector.js';

/**
 * Advanced Agent Log Analyzer
 * Analyzes agent logs, detects patterns, and generates insights
 */
export class AgentLogAnalyzer {
  constructor(options = {}) {
    this.logDirectory = options.logDirectory || 'logs';
    this.analysisInterval = options.analysisInterval || 300000; // 5 minutes
    this.patternHistory = new Map();
    this.anomalies = [];
    this.insights = [];
    this.reports = new Map();
    
    this.patterns = {
      errors: /ERROR|Error|error/g,
      warnings: /WARN|Warning|warning/g,
      performance: /slow|timeout|performance|latency/gi,
      security: /security|threat|attack|breach|unauthorized/gi,
      memory: /memory|heap|oom|out of memory/gi,
      network: /network|connection|socket|timeout/gi
    };
    
    this.severityLevels = {
      critical: ['error', 'security', 'memory'],
      high: ['performance', 'network'],
      medium: ['warnings'],
      low: ['info', 'debug']
    };
    
    this.isAnalyzing = false;
    this.analysisTimer = null;
    
    this.setupAnalysisRules();
  }

  setupAnalysisRules() {
    this.analysisRules = [
      {
        name: 'HighErrorRate',
        description: 'Detects when error rate exceeds threshold',
        condition: (data) => {
          const errorRate = data.errors / (data.total || 1);
          return errorRate > 0.1; // 10% error rate
        },
        severity: 'critical',
        action: 'alert'
      },
      {
        name: 'PerformanceDegradation',
        description: 'Detects performance issues',
        condition: (data) => {
          return data.averageExecutionTime > 5000; // 5 seconds
        },
        severity: 'high',
        action: 'investigate'
      },
      {
        name: 'SecurityConcerns',
        description: 'Detects security-related events',
        condition: (data) => {
          return data.securityEvents > 0;
        },
        severity: 'critical',
        action: 'immediate'
      },
      {
        name: 'MemoryLeaks',
        description: 'Detects potential memory leaks',
        condition: (data) => {
          return data.memoryTrend && data.memoryTrend === 'increasing';
        },
        severity: 'high',
        action: 'monitor'
      },
      {
        name: 'NetworkIssues',
        description: 'Detects network connectivity problems',
        condition: (data) => {
          return data.networkErrors > 5;
        },
        severity: 'medium',
        action: 'investigate'
      }
    ];
  }

  async startAnalysis() {
    if (this.isAnalyzing) {
      logger.warn('Log analysis already started');
      return;
    }

    this.isAnalyzing = true;
    
    // Perform initial analysis
    await this.performAnalysis();
    
    // Set up periodic analysis
    this.analysisTimer = setInterval(async () => {
      try {
        await this.performAnalysis();
      } catch (error) {
        logger.error('Error during log analysis:', error);
      }
    }, this.analysisInterval);

    logger.info('Agent log analysis started');
  }

  stopAnalysis() {
    if (!this.isAnalyzing) {
      return;
    }

    this.isAnalyzing = false;
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }

    logger.info('Agent log analysis stopped');
  }

  async performAnalysis() {
    try {
      const logFiles = await this.getLogFiles();
      const analysisResults = new Map();

      for (const logFile of logFiles) {
        const analysis = await this.analyzeLogFile(logFile);
        analysisResults.set(logFile, analysis);
      }

      // Analyze agent-specific logs
      for (const [agentName, agent] of agentManager.agents) {
        const agentAnalysis = await this.analyzeAgentLogs(agentName);
        analysisResults.set(`agent:${agentName}`, agentAnalysis);
      }

      // Detect patterns and anomalies
      await this.detectPatterns(analysisResults);
      await this.detectAnomalies(analysisResults);
      
      // Generate insights
      this.generateInsights(analysisResults);
      
      // Store analysis results
      this.storeAnalysisResults(analysisResults);

      logger.debug('Log analysis completed', {
        filesAnalyzed: logFiles.length,
        agentsAnalyzed: agentManager.agents.size,
        anomaliesFound: this.anomalies.length,
        insightsGenerated: this.insights.length
      });

    } catch (error) {
      logger.error('Error performing log analysis:', error);
    }
  }

  async getLogFiles() {
    try {
      const files = await fs.readdir(this.logDirectory);
      return files.filter(file => 
        file.endsWith('.log') || 
        file.endsWith('.txt') ||
        file.includes('agent')
      ).map(file => path.join(this.logDirectory, file));
    } catch (error) {
      logger.warn('Could not read log directory:', error.message);
      return [];
    }
  }

  async analyzeLogFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      const analysis = {
        file: filePath,
        timestamp: Date.now(),
        totalLines: lines.length,
        patterns: {},
        timeRange: this.extractTimeRange(lines),
        summary: {}
      };

      // Analyze patterns
      Object.entries(this.patterns).forEach(([patternName, regex]) => {
        const matches = content.match(regex) || [];
        analysis.patterns[patternName] = matches.length;
      });

      // Extract specific events
      analysis.events = this.extractEvents(lines);
      analysis.errors = this.extractErrors(lines);
      analysis.performance = this.extractPerformanceMetrics(lines);

      // Calculate summary statistics
      analysis.summary = {
        errorRate: analysis.patterns.errors / analysis.totalLines,
        warningRate: analysis.patterns.warnings / analysis.totalLines,
        securityEvents: analysis.patterns.security,
        performanceEvents: analysis.patterns.performance
      };

      return analysis;
    } catch (error) {
      logger.error(`Error analyzing log file ${filePath}:`, error);
      return {
        file: filePath,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  async analyzeAgentLogs(agentName) {
    const agent = agentManager.getAgent(agentName);
    if (!agent) {
      return null;
    }

    const metrics = agentMetricsCollector.getAgentMetrics(agentName);
    const errors = agent.errors || [];
    
    return {
      agentName,
      timestamp: Date.now(),
      state: agent.state,
      runCount: agent.runCount,
      errors: errors.length,
      recentErrors: errors.slice(-10),
      performance: {
        averageExecutionTime: agent.metrics.averageExecutionTime,
        successRate: this.calculateSuccessRate(agent.metrics),
        lastExecutionTime: agent.lastExecutionTime
      },
      patterns: this.analyzeAgentPatterns(agent),
      trends: this.analyzeAgentTrends(metrics)
    };
  }

  extractTimeRange(lines) {
    if (lines.length === 0) return null;
    
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    
    const startTime = this.extractTimestamp(firstLine);
    const endTime = this.extractTimestamp(lastLine);
    
    return {
      start: startTime,
      end: endTime,
      duration: endTime ? endTime - startTime : null
    };
  }

  extractTimestamp(line) {
    // Common timestamp patterns
    const patterns = [
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,  // ISO format
      /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/,  // MM/DD/YYYY format
      /\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}/     // DD-MM-YYYY format
    ];
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return new Date(match[0]).getTime();
      }
    }
    
    return null;
  }

  extractEvents(lines) {
    const events = [];
    
    lines.forEach(line => {
      const timestamp = this.extractTimestamp(line);
      const level = this.extractLogLevel(line);
      const message = this.extractMessage(line);
      
      if (timestamp && level && message) {
        events.push({
          timestamp,
          level,
          message,
          severity: this.determineSeverity(level, message)
        });
      }
    });
    
    return events;
  }

  extractLogLevel(line) {
    const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
    for (const level of levels) {
      if (line.includes(level)) {
        return level;
      }
    }
    return 'UNKNOWN';
  }

  extractMessage(line) {
    // Remove timestamp and log level to get clean message
    return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/, '')
               .replace(/^\[?\w+\]?\s*/, '')
               .trim();
  }

  extractErrors(lines) {
    return lines.filter(line => 
      line.includes('ERROR') || 
      line.includes('Error') || 
      line.includes('Exception') ||
      line.includes('Failed')
    ).map(line => ({
      timestamp: this.extractTimestamp(line),
      message: this.extractMessage(line),
      type: this.classifyError(line)
    }));
  }

  extractPerformanceMetrics(lines) {
    const performanceLines = lines.filter(line =>
      line.includes('ms') ||
      line.includes('execution time') ||
      line.includes('duration') ||
      line.includes('latency')
    );

    return performanceLines.map(line => {
      const timeMatch = line.match(/(\d+)ms/);
      const time = timeMatch ? parseInt(timeMatch[1]) : null;
      
      return {
        timestamp: this.extractTimestamp(line),
        message: this.extractMessage(line),
        executionTime: time
      };
    }).filter(metric => metric.executionTime !== null);
  }

  classifyError(line) {
    if (line.includes('Connection') || line.includes('Network')) return 'network';
    if (line.includes('Memory') || line.includes('Heap')) return 'memory';
    if (line.includes('Security') || line.includes('Auth')) return 'security';
    if (line.includes('Timeout')) return 'timeout';
    if (line.includes('Permission') || line.includes('Access')) return 'permission';
    return 'general';
  }

  determineSeverity(level, message) {
    if (level === 'ERROR') return 'critical';
    if (level === 'WARN' && (message.includes('security') || message.includes('memory'))) return 'high';
    if (level === 'WARN') return 'medium';
    return 'low';
  }

  calculateSuccessRate(metrics) {
    const total = metrics.successCount + metrics.failureCount;
    return total > 0 ? (metrics.successCount / total) * 100 : 0;
  }

  analyzeAgentPatterns(agent) {
    const patterns = {
      executionFrequency: this.calculateExecutionFrequency(agent),
      errorPatterns: this.analyzeErrorPatterns(agent.errors),
      stateTransitions: this.analyzeStateTransitions(agent),
      performancePatterns: this.analyzePerformancePatterns(agent)
    };
    
    return patterns;
  }

  analyzeAgentTrends(metrics) {
    if (!metrics || !metrics.performance) return null;
    
    const recentMetrics = metrics.performance.slice(-10);
    if (recentMetrics.length < 3) return null;
    
    return {
      executionTimeTrend: this.calculateTrend(recentMetrics.map(m => m.executionTime)),
      successRateTrend: this.calculateTrend(recentMetrics.map(m => 
        m.metrics.successCount / (m.metrics.successCount + m.metrics.failureCount) || 0
      )),
      memoryTrend: this.calculateMemoryTrend(recentMetrics)
    };
  }

  calculateTrend(values) {
    if (values.length < 2) return 'stable';
    
    const recent = values.slice(-3);
    const earlier = values.slice(-6, -3);
    
    if (earlier.length === 0) return 'stable';
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    
    const change = (recentAvg - earlierAvg) / earlierAvg;
    
    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }

  calculateMemoryTrend(metrics) {
    // This would analyze memory usage patterns from system metrics
    // For now, return a placeholder
    return 'stable';
  }

  async detectPatterns(analysisResults) {
    const patterns = new Map();
    
    for (const [source, analysis] of analysisResults) {
      if (analysis.error) continue;
      
      // Detect recurring error patterns
      if (analysis.errors && analysis.errors.length > 0) {
        const errorGroups = this.groupErrorsByType(analysis.errors);
        for (const [errorType, errors] of errorGroups) {
          if (errors.length >= 3) {
            patterns.set(`recurring_${errorType}_${source}`, {
              type: 'recurring_error',
              source,
              errorType,
              count: errors.length,
              severity: 'high',
              lastOccurrence: Math.max(...errors.map(e => e.timestamp))
            });
          }
        }
      }
      
      // Detect performance degradation patterns
      if (analysis.performance && analysis.performance.length > 0) {
        const avgTime = analysis.performance.reduce((sum, p) => sum + p.executionTime, 0) / analysis.performance.length;
        if (avgTime > 3000) {
          patterns.set(`performance_degradation_${source}`, {
            type: 'performance_degradation',
            source,
            averageTime: avgTime,
            severity: 'medium',
            timestamp: Date.now()
          });
        }
      }
    }
    
    // Store patterns with timestamp
    this.patternHistory.set(Date.now(), patterns);
    
    // Keep only recent patterns (last 24 hours)
    const oneDayAgo = Date.now() - 86400000;
    for (const [timestamp, _] of this.patternHistory) {
      if (timestamp < oneDayAgo) {
        this.patternHistory.delete(timestamp);
      }
    }
  }

  async detectAnomalies(analysisResults) {
    const newAnomalies = [];
    
    for (const [source, analysis] of analysisResults) {
      if (analysis.error) continue;
      
      // Check against analysis rules
      for (const rule of this.analysisRules) {
        try {
          if (rule.condition(analysis.summary || analysis)) {
            newAnomalies.push({
              id: `${rule.name}_${source}_${Date.now()}`,
              rule: rule.name,
              description: rule.description,
              source,
              severity: rule.severity,
              action: rule.action,
              timestamp: Date.now(),
              data: analysis.summary || analysis
            });
          }
        } catch (error) {
          logger.warn(`Error evaluating rule ${rule.name}:`, error);
        }
      }
    }
    
    // Add new anomalies
    this.anomalies.push(...newAnomalies);
    
    // Keep only recent anomalies (last 7 days)
    const weekAgo = Date.now() - 604800000;
    this.anomalies = this.anomalies.filter(anomaly => anomaly.timestamp > weekAgo);
    
    // Log critical anomalies
    newAnomalies.filter(a => a.severity === 'critical').forEach(anomaly => {
      logger.warn(`Critical anomaly detected: ${anomaly.description}`, {
        source: anomaly.source,
        rule: anomaly.rule
      });
    });
  }

  generateInsights(analysisResults) {
    const newInsights = [];
    
    // Overall system health insight
    const totalErrors = Array.from(analysisResults.values())
      .reduce((sum, analysis) => sum + (analysis.patterns?.errors || 0), 0);
    
    const totalEvents = Array.from(analysisResults.values())
      .reduce((sum, analysis) => sum + (analysis.totalLines || 0), 0);
    
    if (totalEvents > 0) {
      const errorRate = totalErrors / totalEvents;
      newInsights.push({
        type: 'system_health',
        title: 'System Error Rate Analysis',
        description: `Current error rate: ${(errorRate * 100).toFixed(2)}%`,
        severity: errorRate > 0.05 ? 'high' : errorRate > 0.02 ? 'medium' : 'low',
        timestamp: Date.now(),
        recommendations: this.generateErrorRateRecommendations(errorRate)
      });
    }
    
    // Agent performance insights
    const agentAnalyses = Array.from(analysisResults.entries())
      .filter(([key, _]) => key.startsWith('agent:'));
    
    if (agentAnalyses.length > 0) {
      const avgSuccessRate = agentAnalyses.reduce((sum, [_, analysis]) => 
        sum + (analysis.performance?.successRate || 0), 0) / agentAnalyses.length;
      
      newInsights.push({
        type: 'agent_performance',
        title: 'Agent Performance Overview',
        description: `Average success rate: ${avgSuccessRate.toFixed(2)}%`,
        severity: avgSuccessRate < 90 ? 'high' : avgSuccessRate < 95 ? 'medium' : 'low',
        timestamp: Date.now(),
        recommendations: this.generatePerformanceRecommendations(avgSuccessRate)
      });
    }
    
    // Pattern-based insights
    const recentPatterns = Array.from(this.patternHistory.values()).pop();
    if (recentPatterns && recentPatterns.size > 0) {
      newInsights.push({
        type: 'pattern_analysis',
        title: 'Recurring Pattern Detection',
        description: `Found ${recentPatterns.size} recurring patterns`,
        severity: recentPatterns.size > 5 ? 'high' : 'medium',
        timestamp: Date.now(),
        patterns: Array.from(recentPatterns.values())
      });
    }
    
    // Store insights
    this.insights.push(...newInsights);
    
    // Keep only recent insights (last 30 days)
    const monthAgo = Date.now() - 2592000000;
    this.insights = this.insights.filter(insight => insight.timestamp > monthAgo);
  }

  generateErrorRateRecommendations(errorRate) {
    const recommendations = [];
    
    if (errorRate > 0.1) {
      recommendations.push('Critical: Immediate investigation required');
      recommendations.push('Review recent code changes and deployments');
      recommendations.push('Check system resources and dependencies');
    } else if (errorRate > 0.05) {
      recommendations.push('Increase monitoring frequency');
      recommendations.push('Review error patterns for common causes');
    } else if (errorRate > 0.02) {
      recommendations.push('Monitor trends for early warning signs');
    } else {
      recommendations.push('System health is good');
    }
    
    return recommendations;
  }

  generatePerformanceRecommendations(successRate) {
    const recommendations = [];
    
    if (successRate < 85) {
      recommendations.push('Critical: Multiple agents failing');
      recommendations.push('Review agent configurations and dependencies');
      recommendations.push('Check system resources and scaling needs');
    } else if (successRate < 95) {
      recommendations.push('Some agents showing degraded performance');
      recommendations.push('Review individual agent metrics');
    } else {
      recommendations.push('Agent performance is optimal');
    }
    
    return recommendations;
  }

  groupErrorsByType(errors) {
    const groups = new Map();
    
    errors.forEach(error => {
      const type = error.type || 'general';
      if (!groups.has(type)) {
        groups.set(type, []);
      }
      groups.get(type).push(error);
    });
    
    return groups;
  }

  storeAnalysisResults(results) {
    const timestamp = Date.now();
    this.reports.set(timestamp, {
      timestamp,
      results: Array.from(results.entries()),
      summary: {
        filesAnalyzed: results.size,
        totalAnomalies: this.anomalies.length,
        totalInsights: this.insights.length,
        criticalIssues: this.anomalies.filter(a => a.severity === 'critical').length
      }
    });
    
    // Keep only recent reports (last 7 days)
    const weekAgo = Date.now() - 604800000;
    for (const [timestamp, _] of this.reports) {
      if (timestamp < weekAgo) {
        this.reports.delete(timestamp);
      }
    }
  }

  generateReport(options = {}) {
    const timeRange = options.timeRange || 86400000; // 24 hours
    const includeDetails = options.includeDetails !== false;
    const format = options.format || 'detailed';
    
    const cutoff = Date.now() - timeRange;
    
    const recentAnomalies = this.anomalies.filter(a => a.timestamp > cutoff);
    const recentInsights = this.insights.filter(i => i.timestamp > cutoff);
    const recentReports = Array.from(this.reports.values()).filter(r => r.timestamp > cutoff);
    
    const report = {
      generatedAt: Date.now(),
      timeRange,
      summary: {
        anomaliesDetected: recentAnomalies.length,
        criticalAnomalies: recentAnomalies.filter(a => a.severity === 'critical').length,
        insightsGenerated: recentInsights.length,
        analysisRuns: recentReports.length
      },
      anomalies: recentAnomalies,
      insights: recentInsights
    };
    
    if (includeDetails) {
      report.detailedAnalysis = recentReports;
      report.patterns = Array.from(this.patternHistory.entries())
        .filter(([timestamp, _]) => timestamp > cutoff);
    }
    
    if (format === 'summary') {
      return this.formatSummaryReport(report);
    }
    
    return report;
  }

  formatSummaryReport(report) {
    const lines = [
      '=== Agent Log Analysis Report ===',
      `Generated: ${new Date(report.generatedAt).toISOString()}`,
      `Time Range: ${report.timeRange / 3600000} hours`,
      '',
      '== Summary ==',
      `Anomalies Detected: ${report.summary.anomaliesDetected}`,
      `Critical Issues: ${report.summary.criticalAnomalies}`,
      `Insights Generated: ${report.summary.insightsGenerated}`,
      `Analysis Runs: ${report.summary.analysisRuns}`,
      ''
    ];
    
    if (report.anomalies.length > 0) {
      lines.push('== Critical Anomalies ==');
      report.anomalies
        .filter(a => a.severity === 'critical')
        .forEach(anomaly => {
          lines.push(`- ${anomaly.description} (Source: ${anomaly.source})`);
        });
      lines.push('');
    }
    
    if (report.insights.length > 0) {
      lines.push('== Key Insights ==');
      report.insights.forEach(insight => {
        lines.push(`- ${insight.title}: ${insight.description}`);
      });
    }
    
    return lines.join('\n');
  }

  getAnalysisStats() {
    return {
      isAnalyzing: this.isAnalyzing,
      analysisInterval: this.analysisInterval,
      totalAnomalies: this.anomalies.length,
      totalInsights: this.insights.length,
      totalReports: this.reports.size,
      patternHistorySize: this.patternHistory.size,
      rulesConfigured: this.analysisRules.length
    };
  }

  exportAnalysis(format = 'json', options = {}) {
    const report = this.generateReport(options);
    
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(report, null, 2);
      
      case 'csv':
        return this.convertAnalysisToCSV(report);
      
      case 'summary':
        return this.formatSummaryReport(report);
      
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  convertAnalysisToCSV(report) {
    const lines = ['timestamp,type,source,severity,description'];
    
    report.anomalies.forEach(anomaly => {
      lines.push(`${anomaly.timestamp},anomaly,${anomaly.source},${anomaly.severity},"${anomaly.description}"`);
    });
    
    report.insights.forEach(insight => {
      lines.push(`${insight.timestamp},insight,system,${insight.severity},"${insight.title}: ${insight.description}"`);
    });
    
    return lines.join('\n');
  }
}

// Export singleton instance
export const agentLogAnalyzer = new AgentLogAnalyzer();