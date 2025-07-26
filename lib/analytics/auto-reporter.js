/**
 * Automated Reporting & Analytics System - Otedama
 * Real-time analytics with automated report generation
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import PDFDocument from 'pdfkit';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

const logger = createStructuredLogger('AutoReporter');

export class AutoReporter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Report configuration
      reportsPath: options.reportsPath || './reports',
      templatePath: options.templatePath || './templates',
      
      // Schedule configuration
      schedules: {
        daily: options.dailySchedule || '0 1 * * *', // 1 AM daily
        weekly: options.weeklySchedule || '0 2 * * 1', // 2 AM Monday
        monthly: options.monthlySchedule || '0 3 1 * *', // 3 AM 1st of month
        realtime: options.realtimeInterval || 300000 // 5 minutes
      },
      
      // Report types
      enabledReports: {
        performance: options.performanceReport !== false,
        financial: options.financialReport !== false,
        security: options.securityReport !== false,
        operations: options.operationsReport !== false,
        custom: options.customReports || []
      },
      
      // Analytics configuration
      metricsRetention: options.metricsRetention || 90, // days
      aggregationIntervals: ['1m', '5m', '1h', '1d'],
      
      // Distribution configuration
      email: {
        enabled: options.emailEnabled || false,
        smtp: options.smtp || {},
        recipients: options.recipients || []
      },
      
      // Alerting
      alerts: {
        enabled: options.alertsEnabled !== false,
        thresholds: options.alertThresholds || {},
        channels: options.alertChannels || ['email', 'webhook']
      },
      
      // Features
      predictiveAnalytics: options.predictiveAnalytics !== false,
      anomalyDetection: options.anomalyDetection !== false,
      trendAnalysis: options.trendAnalysis !== false,
      
      ...options
    };
    
    // Data stores
    this.metrics = new Map();
    this.aggregatedData = new Map();
    this.reports = new Map();
    
    // Analytics state
    this.analytics = {
      trends: new Map(),
      anomalies: [],
      predictions: new Map(),
      correlations: new Map()
    };
    
    // Alert state
    this.alertState = {
      active: new Map(),
      history: [],
      cooldowns: new Map()
    };
    
    // Statistics
    this.stats = {
      reportsGenerated: 0,
      alertsSent: 0,
      metricsProcessed: 0,
      anomaliesDetected: 0,
      predictionsAccuracy: 0
    };
    
    // Chart renderer
    this.chartRenderer = new ChartJSNodeCanvas({
      width: 800,
      height: 400,
      backgroundColour: 'white'
    });
    
    // Scheduled jobs
    this.scheduledJobs = new Map();
    
    // Email transporter
    this.emailTransporter = null;
  }
  
  /**
   * Initialize reporting system
   */
  async initialize() {
    logger.info('Initializing automated reporting system');
    
    try {
      // Create directories
      await this.ensureDirectories();
      
      // Load historical data
      await this.loadHistoricalData();
      
      // Setup email if enabled
      if (this.options.email.enabled) {
        this.setupEmailTransporter();
      }
      
      // Schedule reports
      this.scheduleReports();
      
      // Start real-time processing
      this.startRealtimeProcessing();
      
      logger.info('Reporting system initialized', {
        enabledReports: Object.keys(this.options.enabledReports).filter(k => this.options.enabledReports[k])
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize reporting system', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Record metric data
   */
  recordMetric(name, value, tags = {}) {
    const timestamp = Date.now();
    const key = this.getMetricKey(name, tags);
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }
    
    const metric = {
      timestamp,
      value,
      tags
    };
    
    this.metrics.get(key).push(metric);
    this.stats.metricsProcessed++;
    
    // Check for alerts
    if (this.options.alerts.enabled) {
      this.checkAlerts(name, value, tags);
    }
    
    // Detect anomalies
    if (this.options.anomalyDetection) {
      this.detectAnomaly(name, value, tags);
    }
    
    // Update predictions
    if (this.options.predictiveAnalytics) {
      this.updatePredictions(name, value, tags);
    }
  }
  
  /**
   * Generate report
   */
  async generateReport(type, period = 'daily') {
    const startTime = Date.now();
    const reportId = `${type}_${period}_${startTime}`;
    
    logger.info('Generating report', { type, period, reportId });
    
    try {
      // Collect data for report
      const data = await this.collectReportData(type, period);
      
      // Analyze data
      const analysis = await this.analyzeData(data, type);
      
      // Generate charts
      const charts = await this.generateCharts(data, analysis, type);
      
      // Create report document
      const report = await this.createReportDocument({
        type,
        period,
        data,
        analysis,
        charts,
        timestamp: startTime
      });
      
      // Save report
      await this.saveReport(reportId, report);
      
      // Distribute report
      await this.distributeReport(reportId, report);
      
      this.stats.reportsGenerated++;
      
      const duration = Date.now() - startTime;
      
      logger.info('Report generated', {
        reportId,
        type,
        period,
        duration,
        size: report.size
      });
      
      this.emit('report:generated', {
        reportId,
        type,
        period,
        duration
      });
      
      return reportId;
      
    } catch (error) {
      logger.error('Report generation failed', {
        type,
        period,
        error: error.message
      });
      
      this.emit('report:failed', {
        type,
        period,
        error
      });
      
      throw error;
    }
  }
  
  /**
   * Collect report data
   */
  async collectReportData(type, period) {
    const timeRange = this.getTimeRange(period);
    const data = {
      metrics: {},
      aggregations: {},
      trends: {},
      anomalies: []
    };
    
    // Collect metrics based on report type
    switch (type) {
      case 'performance':
        data.metrics = {
          hashrate: await this.getMetricData('hashrate', timeRange),
          efficiency: await this.getMetricData('efficiency', timeRange),
          uptime: await this.getMetricData('uptime', timeRange),
          latency: await this.getMetricData('latency', timeRange),
          throughput: await this.getMetricData('throughput', timeRange)
        };
        break;
        
      case 'financial':
        data.metrics = {
          revenue: await this.getMetricData('revenue', timeRange),
          costs: await this.getMetricData('costs', timeRange),
          profitability: await this.getMetricData('profitability', timeRange),
          powerCost: await this.getMetricData('power_cost', timeRange),
          poolFees: await this.getMetricData('pool_fees', timeRange)
        };
        break;
        
      case 'security':
        data.metrics = {
          attacks: await this.getMetricData('attacks_blocked', timeRange),
          vulnerabilities: await this.getMetricData('vulnerabilities', timeRange),
          authFailures: await this.getMetricData('auth_failures', timeRange),
          incidents: await this.getMetricData('security_incidents', timeRange)
        };
        break;
        
      case 'operations':
        data.metrics = {
          minerCount: await this.getMetricData('active_miners', timeRange),
          shareRate: await this.getMetricData('shares_per_second', timeRange),
          blockFinds: await this.getMetricData('blocks_found', timeRange),
          poolHashrate: await this.getMetricData('pool_hashrate', timeRange)
        };
        break;
    }
    
    // Add aggregations
    for (const [metric, values] of Object.entries(data.metrics)) {
      data.aggregations[metric] = this.aggregateMetrics(values);
    }
    
    // Add trends
    data.trends = this.analytics.trends.get(type) || {};
    
    // Add anomalies for period
    data.anomalies = this.analytics.anomalies.filter(
      a => a.timestamp >= timeRange.start && a.timestamp <= timeRange.end
    );
    
    return data;
  }
  
  /**
   * Analyze data
   */
  async analyzeData(data, type) {
    const analysis = {
      summary: {},
      insights: [],
      recommendations: [],
      predictions: {}
    };
    
    // Generate summary statistics
    for (const [metric, aggregation] of Object.entries(data.aggregations)) {
      analysis.summary[metric] = {
        average: aggregation.avg,
        peak: aggregation.max,
        low: aggregation.min,
        trend: this.calculateTrend(data.metrics[metric]),
        volatility: this.calculateVolatility(data.metrics[metric])
      };
    }
    
    // Generate insights
    analysis.insights = this.generateInsights(data, type);
    
    // Generate recommendations
    analysis.recommendations = this.generateRecommendations(data, type);
    
    // Add predictions if enabled
    if (this.options.predictiveAnalytics) {
      analysis.predictions = this.getPredictions(type);
    }
    
    // Correlation analysis
    if (type === 'performance') {
      analysis.correlations = this.analyzeCorrelations(data.metrics);
    }
    
    return analysis;
  }
  
  /**
   * Generate charts
   */
  async generateCharts(data, analysis, type) {
    const charts = [];
    
    // Time series chart for main metrics
    for (const [metric, values] of Object.entries(data.metrics)) {
      if (values && values.length > 0) {
        const chartBuffer = await this.createTimeSeriesChart(metric, values);
        charts.push({
          title: `${metric} Over Time`,
          type: 'timeseries',
          data: chartBuffer
        });
      }
    }
    
    // Pie chart for distributions
    if (type === 'financial') {
      const costBreakdown = await this.createPieChart('Cost Breakdown', {
        'Power': data.aggregations.powerCost?.total || 0,
        'Pool Fees': data.aggregations.poolFees?.total || 0,
        'Maintenance': data.aggregations.maintenance?.total || 0,
        'Other': data.aggregations.other?.total || 0
      });
      charts.push({
        title: 'Cost Distribution',
        type: 'pie',
        data: costBreakdown
      });
    }
    
    // Correlation heatmap
    if (analysis.correlations) {
      const heatmap = await this.createHeatmap('Metric Correlations', analysis.correlations);
      charts.push({
        title: 'Correlation Analysis',
        type: 'heatmap',
        data: heatmap
      });
    }
    
    return charts;
  }
  
  /**
   * Create time series chart
   */
  async createTimeSeriesChart(title, data) {
    const chartData = {
      type: 'line',
      data: {
        labels: data.map(d => new Date(d.timestamp).toLocaleString()),
        datasets: [{
          label: title,
          data: data.map(d => d.value),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title
          },
          legend: {
            display: true
          }
        },
        scales: {
          y: {
            beginAtZero: true
          }
        }
      }
    };
    
    return await this.chartRenderer.renderToBuffer(chartData);
  }
  
  /**
   * Create pie chart
   */
  async createPieChart(title, data) {
    const chartData = {
      type: 'pie',
      data: {
        labels: Object.keys(data),
        datasets: [{
          data: Object.values(data),
          backgroundColor: [
            'rgba(255, 99, 132, 0.8)',
            'rgba(54, 162, 235, 0.8)',
            'rgba(255, 205, 86, 0.8)',
            'rgba(75, 192, 192, 0.8)'
          ]
        }]
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: title
          },
          legend: {
            display: true,
            position: 'bottom'
          }
        }
      }
    };
    
    return await this.chartRenderer.renderToBuffer(chartData);
  }
  
  /**
   * Create report document
   */
  async createReportDocument(reportData) {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    
    doc.on('data', buffers.push.bind(buffers));
    
    // Header
    doc.fontSize(24).text('Otedama Mining Pool Report', { align: 'center' });
    doc.fontSize(14).text(`${reportData.type.toUpperCase()} - ${reportData.period}`, { align: 'center' });
    doc.fontSize(10).text(`Generated: ${new Date(reportData.timestamp).toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);
    
    // Executive Summary
    doc.fontSize(16).text('Executive Summary', { underline: true });
    doc.fontSize(10);
    for (const [metric, summary] of Object.entries(reportData.analysis.summary)) {
      doc.text(`${metric}: Avg ${summary.average.toFixed(2)}, Trend: ${summary.trend > 0 ? '↑' : '↓'} ${Math.abs(summary.trend).toFixed(1)}%`);
    }
    doc.moveDown();
    
    // Key Insights
    if (reportData.analysis.insights.length > 0) {
      doc.fontSize(16).text('Key Insights', { underline: true });
      doc.fontSize(10);
      reportData.analysis.insights.forEach((insight, i) => {
        doc.text(`${i + 1}. ${insight}`);
      });
      doc.moveDown();
    }
    
    // Recommendations
    if (reportData.analysis.recommendations.length > 0) {
      doc.fontSize(16).text('Recommendations', { underline: true });
      doc.fontSize(10);
      reportData.analysis.recommendations.forEach((rec, i) => {
        doc.text(`${i + 1}. ${rec.action} - ${rec.reason}`);
      });
      doc.moveDown();
    }
    
    // Add charts
    doc.addPage();
    doc.fontSize(16).text('Charts & Visualizations', { underline: true });
    
    for (const chart of reportData.charts) {
      if (doc.y > 600) doc.addPage();
      doc.fontSize(12).text(chart.title, { align: 'center' });
      doc.image(chart.data, { width: 500, align: 'center' });
      doc.moveDown();
    }
    
    // Detailed Metrics
    doc.addPage();
    doc.fontSize(16).text('Detailed Metrics', { underline: true });
    doc.fontSize(10);
    
    for (const [metric, agg] of Object.entries(reportData.data.aggregations)) {
      doc.text(`${metric}:`);
      doc.text(`  Min: ${agg.min}, Max: ${agg.max}, Avg: ${agg.avg.toFixed(2)}`);
      doc.text(`  Total: ${agg.total.toFixed(2)}, Count: ${agg.count}`);
      doc.moveDown(0.5);
    }
    
    // Anomalies
    if (reportData.data.anomalies.length > 0) {
      doc.addPage();
      doc.fontSize(16).text('Detected Anomalies', { underline: true });
      doc.fontSize(10);
      reportData.data.anomalies.forEach(anomaly => {
        doc.text(`${new Date(anomaly.timestamp).toLocaleString()}: ${anomaly.metric} - ${anomaly.description}`);
      });
    }
    
    doc.end();
    
    return new Promise((resolve) => {
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve({
          buffer: pdfBuffer,
          size: pdfBuffer.length,
          format: 'pdf'
        });
      });
    });
  }
  
  /**
   * Check alerts
   */
  checkAlerts(metric, value, tags) {
    const thresholds = this.options.alerts.thresholds[metric];
    if (!thresholds) return;
    
    const alertKey = `${metric}_${JSON.stringify(tags)}`;
    
    // Check high threshold
    if (thresholds.high && value > thresholds.high) {
      this.triggerAlert({
        type: 'high',
        metric,
        value,
        threshold: thresholds.high,
        tags,
        message: `${metric} exceeded high threshold: ${value} > ${thresholds.high}`
      });
    }
    
    // Check low threshold
    if (thresholds.low && value < thresholds.low) {
      this.triggerAlert({
        type: 'low',
        metric,
        value,
        threshold: thresholds.low,
        tags,
        message: `${metric} below low threshold: ${value} < ${thresholds.low}`
      });
    }
    
    // Check rate of change
    if (thresholds.changeRate) {
      const history = this.metrics.get(this.getMetricKey(metric, tags)) || [];
      if (history.length > 1) {
        const previous = history[history.length - 2].value;
        const changeRate = Math.abs((value - previous) / previous * 100);
        
        if (changeRate > thresholds.changeRate) {
          this.triggerAlert({
            type: 'change_rate',
            metric,
            value,
            changeRate,
            threshold: thresholds.changeRate,
            tags,
            message: `${metric} change rate exceeded: ${changeRate.toFixed(1)}% > ${thresholds.changeRate}%`
          });
        }
      }
    }
  }
  
  /**
   * Trigger alert
   */
  async triggerAlert(alert) {
    const alertKey = `${alert.metric}_${alert.type}`;
    
    // Check cooldown
    const lastAlert = this.alertState.cooldowns.get(alertKey);
    if (lastAlert && Date.now() - lastAlert < 300000) { // 5 minute cooldown
      return;
    }
    
    alert.timestamp = Date.now();
    alert.id = `alert_${alert.timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Record alert
    this.alertState.active.set(alert.id, alert);
    this.alertState.history.push(alert);
    this.alertState.cooldowns.set(alertKey, Date.now());
    this.stats.alertsSent++;
    
    logger.warn('Alert triggered', alert);
    
    // Send notifications
    for (const channel of this.options.alerts.channels) {
      try {
        await this.sendAlert(channel, alert);
      } catch (error) {
        logger.error('Failed to send alert', {
          channel,
          error: error.message
        });
      }
    }
    
    this.emit('alert:triggered', alert);
  }
  
  /**
   * Send alert via channel
   */
  async sendAlert(channel, alert) {
    switch (channel) {
      case 'email':
        if (this.emailTransporter && this.options.email.recipients.length > 0) {
          await this.emailTransporter.sendMail({
            from: this.options.email.from || 'otedama@mining.pool',
            to: this.options.email.recipients.join(','),
            subject: `[ALERT] ${alert.metric} - ${alert.type}`,
            text: alert.message,
            html: this.formatAlertEmail(alert)
          });
        }
        break;
        
      case 'webhook':
        if (this.options.alerts.webhookUrl) {
          await fetch(this.options.alerts.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(alert)
          });
        }
        break;
        
      case 'slack':
        if (this.options.alerts.slackWebhook) {
          await fetch(this.options.alerts.slackWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: alert.message,
              attachments: [{
                color: alert.type === 'high' ? 'danger' : 'warning',
                fields: [
                  { title: 'Metric', value: alert.metric, short: true },
                  { title: 'Value', value: alert.value, short: true },
                  { title: 'Threshold', value: alert.threshold, short: true },
                  { title: 'Type', value: alert.type, short: true }
                ]
              }]
            })
          });
        }
        break;
    }
  }
  
  /**
   * Detect anomalies
   */
  detectAnomaly(metric, value, tags) {
    const key = this.getMetricKey(metric, tags);
    const history = this.metrics.get(key) || [];
    
    if (history.length < 20) return; // Need sufficient history
    
    // Calculate statistics
    const values = history.slice(-100).map(m => m.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(
      values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
    );
    
    // Z-score based anomaly detection
    const zScore = Math.abs((value - mean) / stdDev);
    
    if (zScore > 3) { // 3 standard deviations
      const anomaly = {
        metric,
        value,
        mean,
        stdDev,
        zScore,
        tags,
        timestamp: Date.now(),
        description: `Anomalous value detected: ${value} (z-score: ${zScore.toFixed(2)})`
      };
      
      this.analytics.anomalies.push(anomaly);
      this.stats.anomaliesDetected++;
      
      logger.warn('Anomaly detected', anomaly);
      this.emit('anomaly:detected', anomaly);
    }
  }
  
  /**
   * Generate insights
   */
  generateInsights(data, type) {
    const insights = [];
    
    // Performance insights
    if (type === 'performance') {
      const hashrateTrend = this.calculateTrend(data.metrics.hashrate);
      if (hashrateTrend < -5) {
        insights.push(`Hashrate declining by ${Math.abs(hashrateTrend).toFixed(1)}% - investigate hardware issues`);
      }
      
      const efficiency = data.aggregations.efficiency;
      if (efficiency && efficiency.avg < 0.9) {
        insights.push('Pool efficiency below 90% - consider optimizing share validation');
      }
    }
    
    // Financial insights
    if (type === 'financial') {
      const profitability = data.aggregations.profitability;
      if (profitability && profitability.avg < 0) {
        insights.push('Mining operating at a loss - review electricity costs and algorithm selection');
      }
      
      const costTrend = this.calculateTrend(data.metrics.costs);
      if (costTrend > 10) {
        insights.push(`Operating costs increased by ${costTrend.toFixed(1)}% - analyze cost drivers`);
      }
    }
    
    // Security insights
    if (type === 'security') {
      const attacks = data.aggregations.attacks;
      if (attacks && attacks.total > 100) {
        insights.push(`${attacks.total} attacks blocked - consider strengthening security measures`);
      }
    }
    
    // Anomaly insights
    if (data.anomalies.length > 5) {
      insights.push(`${data.anomalies.length} anomalies detected - investigate unusual patterns`);
    }
    
    return insights;
  }
  
  /**
   * Generate recommendations
   */
  generateRecommendations(data, type) {
    const recommendations = [];
    
    // Performance recommendations
    if (type === 'performance') {
      const latency = data.aggregations.latency;
      if (latency && latency.avg > 100) {
        recommendations.push({
          priority: 'high',
          action: 'Optimize network latency',
          reason: 'Average latency exceeds 100ms',
          impact: 'Improve miner experience and reduce stales'
        });
      }
    }
    
    // Financial recommendations
    if (type === 'financial') {
      const powerCost = data.aggregations.powerCost;
      const revenue = data.aggregations.revenue;
      
      if (powerCost && revenue && powerCost.total > revenue.total * 0.7) {
        recommendations.push({
          priority: 'critical',
          action: 'Reduce power consumption or switch to more efficient hardware',
          reason: 'Power costs exceed 70% of revenue',
          impact: 'Improve profitability'
        });
      }
    }
    
    // Operational recommendations
    if (type === 'operations') {
      const minerCount = data.aggregations.minerCount;
      if (minerCount && minerCount.avg < 10) {
        recommendations.push({
          priority: 'medium',
          action: 'Implement marketing campaign to attract miners',
          reason: 'Low average miner count',
          impact: 'Increase pool hashrate and stability'
        });
      }
    }
    
    return recommendations;
  }
  
  /**
   * Calculate trend
   */
  calculateTrend(data) {
    if (!data || data.length < 2) return 0;
    
    const values = data.map(d => d.value);
    const n = values.length;
    
    // Simple linear regression
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const mean = sumY / n;
    
    return (slope / mean) * 100; // Percentage change
  }
  
  /**
   * Calculate volatility
   */
  calculateVolatility(data) {
    if (!data || data.length < 2) return 0;
    
    const values = data.map(d => d.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    
    return Math.sqrt(variance) / mean; // Coefficient of variation
  }
  
  /**
   * Analyze correlations
   */
  analyzeCorrelations(metrics) {
    const correlations = {};
    const metricNames = Object.keys(metrics);
    
    for (let i = 0; i < metricNames.length; i++) {
      correlations[metricNames[i]] = {};
      
      for (let j = 0; j < metricNames.length; j++) {
        const correlation = this.calculateCorrelation(
          metrics[metricNames[i]],
          metrics[metricNames[j]]
        );
        correlations[metricNames[i]][metricNames[j]] = correlation;
      }
    }
    
    return correlations;
  }
  
  /**
   * Calculate correlation coefficient
   */
  calculateCorrelation(data1, data2) {
    if (!data1 || !data2 || data1.length !== data2.length) return 0;
    
    const values1 = data1.map(d => d.value);
    const values2 = data2.map(d => d.value);
    const n = values1.length;
    
    const mean1 = values1.reduce((a, b) => a + b, 0) / n;
    const mean2 = values2.reduce((a, b) => a + b, 0) / n;
    
    let numerator = 0;
    let denominator1 = 0;
    let denominator2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = values1[i] - mean1;
      const diff2 = values2[i] - mean2;
      
      numerator += diff1 * diff2;
      denominator1 += diff1 * diff1;
      denominator2 += diff2 * diff2;
    }
    
    const denominator = Math.sqrt(denominator1 * denominator2);
    
    return denominator === 0 ? 0 : numerator / denominator;
  }
  
  /**
   * Schedule reports
   */
  scheduleReports() {
    // Daily reports
    if (this.options.schedules.daily) {
      const dailyJob = cron.schedule(this.options.schedules.daily, async () => {
        for (const reportType of Object.keys(this.options.enabledReports)) {
          if (this.options.enabledReports[reportType]) {
            await this.generateReport(reportType, 'daily');
          }
        }
      });
      this.scheduledJobs.set('daily', dailyJob);
    }
    
    // Weekly reports
    if (this.options.schedules.weekly) {
      const weeklyJob = cron.schedule(this.options.schedules.weekly, async () => {
        for (const reportType of Object.keys(this.options.enabledReports)) {
          if (this.options.enabledReports[reportType]) {
            await this.generateReport(reportType, 'weekly');
          }
        }
      });
      this.scheduledJobs.set('weekly', weeklyJob);
    }
    
    // Monthly reports
    if (this.options.schedules.monthly) {
      const monthlyJob = cron.schedule(this.options.schedules.monthly, async () => {
        for (const reportType of Object.keys(this.options.enabledReports)) {
          if (this.options.enabledReports[reportType]) {
            await this.generateReport(reportType, 'monthly');
          }
        }
      });
      this.scheduledJobs.set('monthly', monthlyJob);
    }
    
    logger.info('Report schedules configured', {
      schedules: Array.from(this.scheduledJobs.keys())
    });
  }
  
  /**
   * Start real-time processing
   */
  startRealtimeProcessing() {
    this.realtimeInterval = setInterval(() => {
      this.processRealtimeAnalytics();
    }, this.options.schedules.realtime);
  }
  
  /**
   * Process real-time analytics
   */
  async processRealtimeAnalytics() {
    try {
      // Aggregate recent metrics
      for (const [key, metrics] of this.metrics) {
        const recent = metrics.filter(
          m => Date.now() - m.timestamp < this.options.schedules.realtime
        );
        
        if (recent.length > 0) {
          const aggregation = this.aggregateMetrics(recent);
          this.aggregatedData.set(key, aggregation);
        }
      }
      
      // Update trends
      this.updateTrends();
      
      // Update predictions
      if (this.options.predictiveAnalytics) {
        await this.updateAllPredictions();
      }
      
      // Emit real-time update
      this.emit('realtime:update', {
        metrics: this.getCurrentMetrics(),
        alerts: Array.from(this.alertState.active.values()),
        anomalies: this.analytics.anomalies.slice(-10)
      });
      
    } catch (error) {
      logger.error('Real-time processing error', { error: error.message });
    }
  }
  
  /**
   * Update trends
   */
  updateTrends() {
    for (const reportType of Object.keys(this.options.enabledReports)) {
      if (!this.options.enabledReports[reportType]) continue;
      
      const trends = {};
      const data = this.collectReportData(reportType, 'realtime');
      
      for (const [metric, values] of Object.entries(data.metrics)) {
        trends[metric] = {
          current: values[values.length - 1]?.value || 0,
          trend: this.calculateTrend(values),
          volatility: this.calculateVolatility(values)
        };
      }
      
      this.analytics.trends.set(reportType, trends);
    }
  }
  
  /**
   * Update predictions
   */
  async updatePredictions(metric, value, tags) {
    // Simple time series prediction
    // In production, use proper ML models
    
    const key = this.getMetricKey(metric, tags);
    const history = this.metrics.get(key) || [];
    
    if (history.length < 10) return;
    
    const recent = history.slice(-10).map(m => m.value);
    const trend = this.calculateTrend(history.slice(-10));
    const lastValue = recent[recent.length - 1];
    
    // Simple linear projection
    const prediction = {
      metric,
      tags,
      predictions: {
        next5min: lastValue * (1 + trend / 100 * 0.083),
        next1hour: lastValue * (1 + trend / 100),
        next24hours: lastValue * (1 + trend / 100 * 24),
        confidence: Math.max(0, 1 - this.calculateVolatility(history.slice(-10)))
      },
      timestamp: Date.now()
    };
    
    this.analytics.predictions.set(key, prediction);
  }
  
  /**
   * Get current metrics
   */
  getCurrentMetrics() {
    const current = {};
    
    for (const [key, aggregation] of this.aggregatedData) {
      const [metric] = key.split('_');
      if (!current[metric]) {
        current[metric] = [];
      }
      current[metric].push(aggregation);
    }
    
    return current;
  }
  
  /**
   * Utility methods
   */
  
  getMetricKey(name, tags) {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    return `${name}_${tagStr}`;
  }
  
  getTimeRange(period) {
    const end = Date.now();
    let start;
    
    switch (period) {
      case 'realtime':
        start = end - 300000; // 5 minutes
        break;
      case 'hourly':
        start = end - 3600000; // 1 hour
        break;
      case 'daily':
        start = end - 86400000; // 24 hours
        break;
      case 'weekly':
        start = end - 604800000; // 7 days
        break;
      case 'monthly':
        start = end - 2592000000; // 30 days
        break;
      default:
        start = end - 86400000; // Default to daily
    }
    
    return { start, end };
  }
  
  async getMetricData(metric, timeRange) {
    const data = [];
    
    for (const [key, values] of this.metrics) {
      if (key.startsWith(metric)) {
        const filtered = values.filter(
          v => v.timestamp >= timeRange.start && v.timestamp <= timeRange.end
        );
        data.push(...filtered);
      }
    }
    
    return data.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  aggregateMetrics(data) {
    if (!data || data.length === 0) {
      return { min: 0, max: 0, avg: 0, total: 0, count: 0 };
    }
    
    const values = data.map(d => d.value);
    
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      total: values.reduce((a, b) => a + b, 0),
      count: values.length
    };
  }
  
  async ensureDirectories() {
    await fs.mkdir(this.options.reportsPath, { recursive: true });
    await fs.mkdir(path.join(this.options.reportsPath, 'daily'), { recursive: true });
    await fs.mkdir(path.join(this.options.reportsPath, 'weekly'), { recursive: true });
    await fs.mkdir(path.join(this.options.reportsPath, 'monthly'), { recursive: true });
  }
  
  async loadHistoricalData() {
    // Load recent metrics from storage
    // Implement based on your storage backend
  }
  
  setupEmailTransporter() {
    this.emailTransporter = nodemailer.createTransport(this.options.email.smtp);
  }
  
  formatAlertEmail(alert) {
    return `
      <h2>Alert: ${alert.metric}</h2>
      <p><strong>${alert.message}</strong></p>
      <table>
        <tr><td>Type:</td><td>${alert.type}</td></tr>
        <tr><td>Value:</td><td>${alert.value}</td></tr>
        <tr><td>Threshold:</td><td>${alert.threshold}</td></tr>
        <tr><td>Time:</td><td>${new Date(alert.timestamp).toLocaleString()}</td></tr>
      </table>
    `;
  }
  
  async saveReport(reportId, report) {
    const [type, period] = reportId.split('_');
    const filename = `${reportId}.pdf`;
    const filepath = path.join(this.options.reportsPath, period, filename);
    
    await fs.writeFile(filepath, report.buffer);
    
    this.reports.set(reportId, {
      id: reportId,
      path: filepath,
      size: report.size,
      timestamp: Date.now()
    });
  }
  
  async distributeReport(reportId, report) {
    if (this.options.email.enabled && this.emailTransporter) {
      const [type, period] = reportId.split('_');
      
      await this.emailTransporter.sendMail({
        from: this.options.email.from || 'otedama@mining.pool',
        to: this.options.email.recipients.join(','),
        subject: `Otedama ${type} Report - ${period}`,
        text: `Please find attached the ${type} ${period} report.`,
        attachments: [{
          filename: `${reportId}.pdf`,
          content: report.buffer
        }]
      });
    }
  }
  
  getPredictions(type) {
    const predictions = {};
    
    for (const [key, prediction] of this.analytics.predictions) {
      const [metric] = key.split('_');
      if (!predictions[metric]) {
        predictions[metric] = prediction.predictions;
      }
    }
    
    return predictions;
  }
  
  async updateAllPredictions() {
    for (const [key, metrics] of this.metrics) {
      if (metrics.length > 0) {
        const lastMetric = metrics[metrics.length - 1];
        const [name] = key.split('_');
        await this.updatePredictions(name, lastMetric.value, lastMetric.tags || {});
      }
    }
  }
  
  createHeatmap(title, correlations) {
    // Placeholder - implement heatmap generation
    return Buffer.from('Heatmap placeholder');
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      metrics: {
        total: this.metrics.size,
        processed: this.stats.metricsProcessed
      },
      reports: {
        generated: this.stats.reportsGenerated,
        scheduled: Array.from(this.scheduledJobs.keys())
      },
      alerts: {
        sent: this.stats.alertsSent,
        active: this.alertState.active.size
      },
      anomalies: {
        detected: this.stats.anomaliesDetected,
        recent: this.analytics.anomalies.slice(-5)
      },
      predictions: {
        accuracy: this.stats.predictionsAccuracy,
        count: this.analytics.predictions.size
      }
    };
  }
  
  /**
   * Shutdown reporter
   */
  async shutdown() {
    // Stop scheduled jobs
    for (const job of this.scheduledJobs.values()) {
      job.stop();
    }
    
    // Stop real-time processing
    if (this.realtimeInterval) {
      clearInterval(this.realtimeInterval);
    }
    
    // Close email transporter
    if (this.emailTransporter) {
      await this.emailTransporter.close();
    }
    
    logger.info('Auto-reporter shutdown', this.stats);
  }
}

export default AutoReporter;