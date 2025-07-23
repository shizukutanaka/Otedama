const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const Chart = require('chart.js');
const { createCanvas } = require('canvas');

class AutoReportSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Report scheduling
      schedules: options.schedules || {
        daily: { hour: 8, minute: 0 },
        weekly: { dayOfWeek: 1, hour: 9, minute: 0 }, // Monday
        monthly: { dayOfMonth: 1, hour: 10, minute: 0 }
      },
      
      // Report types
      enabledReports: options.enabledReports || {
        performance: true,
        financial: true,
        technical: true,
        executive: true
      },
      
      // Delivery settings
      delivery: {
        email: options.email || {
          enabled: true,
          smtp: {
            host: options.smtpHost || 'smtp.gmail.com',
            port: options.smtpPort || 587,
            secure: false,
            auth: {
              user: options.smtpUser,
              pass: options.smtpPass
            }
          },
          recipients: options.emailRecipients || []
        },
        webhook: options.webhook || {
          enabled: true,
          urls: options.webhookUrls || []
        },
        storage: options.storage || {
          enabled: true,
          path: './reports'
        }
      },
      
      // Report settings
      format: options.format || ['pdf', 'json', 'csv'],
      includeCharts: options.includeCharts !== false,
      historicalDays: options.historicalDays || 30,
      
      // Template settings
      templatePath: options.templatePath || './templates/reports',
      branding: options.branding || {
        logo: './assets/logo.png',
        companyName: 'Otedama Mining Pool',
        primaryColor: '#007bff'
      }
    };
    
    // State
    this.scheduledJobs = new Map();
    this.reportQueue = [];
    this.isGenerating = false;
    
    // Email transporter
    if (this.config.delivery.email.enabled) {
      this.emailTransporter = nodemailer.createTransport(this.config.delivery.email.smtp);
    }
  }
  
  async start() {
    this.emit('started');
    
    // Schedule reports
    this.scheduleReports();
    
    // Process queue
    this.startQueueProcessor();
    
    // Generate initial report
    await this.generateReport('daily', true);
  }
  
  stop() {
    // Clear scheduled jobs
    for (const job of this.scheduledJobs.values()) {
      clearInterval(job);
    }
    
    this.scheduledJobs.clear();
    
    if (this.queueProcessor) {
      clearInterval(this.queueProcessor);
    }
    
    this.emit('stopped');
  }
  
  scheduleReports() {
    // Daily reports
    const dailyInterval = setInterval(() => {
      const now = new Date();
      const schedule = this.config.schedules.daily;
      
      if (now.getHours() === schedule.hour && now.getMinutes() === schedule.minute) {
        this.queueReport('daily');
      }
    }, 60000); // Check every minute
    
    this.scheduledJobs.set('daily', dailyInterval);
    
    // Weekly reports
    const weeklyInterval = setInterval(() => {
      const now = new Date();
      const schedule = this.config.schedules.weekly;
      
      if (now.getDay() === schedule.dayOfWeek && 
          now.getHours() === schedule.hour && 
          now.getMinutes() === schedule.minute) {
        this.queueReport('weekly');
      }
    }, 60000);
    
    this.scheduledJobs.set('weekly', weeklyInterval);
    
    // Monthly reports
    const monthlyInterval = setInterval(() => {
      const now = new Date();
      const schedule = this.config.schedules.monthly;
      
      if (now.getDate() === schedule.dayOfMonth && 
          now.getHours() === schedule.hour && 
          now.getMinutes() === schedule.minute) {
        this.queueReport('monthly');
      }
    }, 60000);
    
    this.scheduledJobs.set('monthly', monthlyInterval);
  }
  
  queueReport(type, priority = false) {
    const report = {
      id: `${type}-${Date.now()}`,
      type,
      requestedAt: Date.now(),
      priority
    };
    
    if (priority) {
      this.reportQueue.unshift(report);
    } else {
      this.reportQueue.push(report);
    }
    
    this.emit('reportQueued', report);
  }
  
  startQueueProcessor() {
    this.queueProcessor = setInterval(async () => {
      if (this.reportQueue.length === 0 || this.isGenerating) {
        return;
      }
      
      const report = this.reportQueue.shift();
      await this.generateReport(report.type);
      
    }, 5000); // Process every 5 seconds
  }
  
  async generateReport(type, immediate = false) {
    if (this.isGenerating && !immediate) {
      this.queueReport(type);
      return;
    }
    
    this.isGenerating = true;
    this.emit('generationStarted', { type });
    
    try {
      // Collect data
      const data = await this.collectData(type);
      
      // Generate report content
      const content = await this.generateContent(type, data);
      
      // Create report files
      const files = await this.createReportFiles(type, content, data);
      
      // Deliver report
      await this.deliverReport(type, files, content);
      
      this.emit('generationCompleted', {
        type,
        files: files.map(f => f.path)
      });
      
    } catch (error) {
      this.emit('generationError', { type, error });
    } finally {
      this.isGenerating = false;
    }
  }
  
  async collectData(type) {
    const data = {
      metadata: {
        generatedAt: new Date(),
        reportType: type,
        period: this.getReportPeriod(type)
      },
      mining: await this.collectMiningData(type),
      financial: await this.collectFinancialData(type),
      technical: await this.collectTechnicalData(type),
      alerts: await this.collectAlerts(type)
    };
    
    return data;
  }
  
  getReportPeriod(type) {
    const now = new Date();
    let start, end = now;
    
    switch (type) {
      case 'daily':
        start = new Date(now);
        start.setDate(start.getDate() - 1);
        break;
        
      case 'weekly':
        start = new Date(now);
        start.setDate(start.getDate() - 7);
        break;
        
      case 'monthly':
        start = new Date(now);
        start.setMonth(start.getMonth() - 1);
        break;
        
      default:
        start = new Date(now);
        start.setDate(start.getDate() - 1);
    }
    
    return { start, end };
  }
  
  async collectMiningData(type) {
    // Simulated data collection
    // In production, would query actual databases
    
    const period = this.getReportPeriod(type);
    
    return {
      hashrate: {
        average: 1234567890000, // 1.23 TH/s
        peak: 1345678901234,
        low: 1123456789012,
        current: 1234567890000,
        trend: '+2.5%'
      },
      shares: {
        accepted: 123456,
        rejected: 1234,
        stale: 567,
        efficiency: 98.5
      },
      blocks: {
        found: 3,
        pending: 1,
        confirmed: 2,
        orphaned: 0
      },
      miners: {
        total: 1234,
        active: 1156,
        new: 45,
        left: 12
      },
      uptime: {
        percentage: 99.95,
        totalHours: type === 'daily' ? 23.98 : type === 'weekly' ? 167.91 : 719.64
      }
    };
  }
  
  async collectFinancialData(type) {
    return {
      revenue: {
        total: 12.34567890,
        mining: 11.23456789,
        fees: 1.11111101,
        currency: 'BTC'
      },
      payouts: {
        total: 11.11111111,
        count: 234,
        average: 0.04747476,
        pending: 0.12345678
      },
      costs: {
        electricity: 2345.67,
        maintenance: 123.45,
        other: 67.89,
        currency: 'USD'
      },
      profitability: {
        gross: 617283.45,
        net: 614594.44,
        margin: 0.9956,
        currency: 'USD'
      },
      prices: {
        btc: 50000,
        change24h: 2.5,
        change7d: 5.2
      }
    };
  }
  
  async collectTechnicalData(type) {
    return {
      performance: {
        cpu: {
          average: 65,
          peak: 89,
          current: 67
        },
        memory: {
          average: 72,
          peak: 85,
          current: 74
        },
        network: {
          latency: 25,
          bandwidth: 856,
          packetLoss: 0.01
        }
      },
      errors: {
        total: 23,
        critical: 2,
        warning: 8,
        info: 13,
        resolved: 20
      },
      maintenance: {
        scheduled: 1,
        unscheduled: 0,
        completed: 3,
        upcoming: 1
      },
      security: {
        attacks: 5,
        blocked: 5,
        threats: 0,
        updates: 2
      }
    };
  }
  
  async collectAlerts(type) {
    return [
      {
        level: 'warning',
        category: 'performance',
        message: 'Hashrate dropped 5% in the last hour',
        timestamp: new Date(Date.now() - 3600000)
      },
      {
        level: 'info',
        category: 'financial',
        message: 'New all-time high revenue achieved',
        timestamp: new Date(Date.now() - 7200000)
      },
      {
        level: 'critical',
        category: 'security',
        message: 'DDoS attack detected and mitigated',
        timestamp: new Date(Date.now() - 14400000)
      }
    ];
  }
  
  async generateContent(type, data) {
    const content = {
      title: this.getReportTitle(type, data),
      summary: this.generateSummary(type, data),
      sections: []
    };
    
    // Add enabled sections
    if (this.config.enabledReports.performance) {
      content.sections.push(this.generatePerformanceSection(data));
    }
    
    if (this.config.enabledReports.financial) {
      content.sections.push(this.generateFinancialSection(data));
    }
    
    if (this.config.enabledReports.technical) {
      content.sections.push(this.generateTechnicalSection(data));
    }
    
    if (this.config.enabledReports.executive) {
      content.sections.push(this.generateExecutiveSection(data));
    }
    
    // Add alerts section
    if (data.alerts.length > 0) {
      content.sections.push(this.generateAlertsSection(data));
    }
    
    // Add recommendations
    content.recommendations = this.generateRecommendations(data);
    
    return content;
  }
  
  getReportTitle(type, data) {
    const date = data.metadata.generatedAt.toLocaleDateString();
    
    switch (type) {
      case 'daily':
        return `Daily Mining Report - ${date}`;
      case 'weekly':
        return `Weekly Mining Report - Week of ${date}`;
      case 'monthly':
        return `Monthly Mining Report - ${data.metadata.generatedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
      default:
        return `Mining Report - ${date}`;
    }
  }
  
  generateSummary(type, data) {
    const period = type.charAt(0).toUpperCase() + type.slice(1);
    
    return {
      text: `${period} mining operations summary for ${this.config.branding.companyName}`,
      highlights: [
        `Average hashrate: ${this.formatHashrate(data.mining.hashrate.average)}`,
        `Total revenue: ${data.financial.revenue.total.toFixed(8)} BTC`,
        `Active miners: ${data.mining.miners.active}`,
        `Uptime: ${data.mining.uptime.percentage}%`
      ],
      trend: this.calculateOverallTrend(data)
    };
  }
  
  formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let unitIndex = 0;
    let value = hashrate;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
  
  calculateOverallTrend(data) {
    // Simple trend calculation
    const hashrateChange = parseFloat(data.mining.hashrate.trend);
    const revenueChange = (data.financial.revenue.total - 10) / 10 * 100; // Simulated
    
    const avgChange = (hashrateChange + revenueChange) / 2;
    
    if (avgChange > 5) return 'strong_growth';
    if (avgChange > 0) return 'growth';
    if (avgChange > -5) return 'stable';
    return 'decline';
  }
  
  generatePerformanceSection(data) {
    return {
      title: 'Mining Performance',
      metrics: [
        {
          name: 'Hashrate',
          value: this.formatHashrate(data.mining.hashrate.current),
          change: data.mining.hashrate.trend,
          chart: this.config.includeCharts ? this.generateHashrateChart(data) : null
        },
        {
          name: 'Share Efficiency',
          value: `${data.mining.shares.efficiency}%`,
          details: `${data.mining.shares.accepted} accepted, ${data.mining.shares.rejected} rejected`
        },
        {
          name: 'Blocks Found',
          value: data.mining.blocks.found,
          details: `${data.mining.blocks.confirmed} confirmed, ${data.mining.blocks.orphaned} orphaned`
        }
      ]
    };
  }
  
  generateFinancialSection(data) {
    return {
      title: 'Financial Summary',
      metrics: [
        {
          name: 'Total Revenue',
          value: `${data.financial.revenue.total.toFixed(8)} BTC`,
          usdValue: `$${(data.financial.revenue.total * data.financial.prices.btc).toFixed(2)}`
        },
        {
          name: 'Payouts',
          value: `${data.financial.payouts.total.toFixed(8)} BTC`,
          details: `${data.financial.payouts.count} payments, avg ${data.financial.payouts.average.toFixed(8)} BTC`
        },
        {
          name: 'Net Profit',
          value: `$${data.financial.profitability.net.toFixed(2)}`,
          margin: `${(data.financial.profitability.margin * 100).toFixed(2)}%`
        }
      ],
      chart: this.config.includeCharts ? this.generateRevenueChart(data) : null
    };
  }
  
  generateTechnicalSection(data) {
    return {
      title: 'Technical Status',
      subsections: [
        {
          name: 'System Performance',
          metrics: [
            { name: 'CPU Usage', value: `${data.technical.performance.cpu.average}%` },
            { name: 'Memory Usage', value: `${data.technical.performance.memory.average}%` },
            { name: 'Network Latency', value: `${data.technical.performance.network.latency}ms` }
          ]
        },
        {
          name: 'Error Summary',
          metrics: [
            { name: 'Total Errors', value: data.technical.errors.total },
            { name: 'Critical', value: data.technical.errors.critical, status: 'danger' },
            { name: 'Resolved', value: data.technical.errors.resolved, status: 'success' }
          ]
        },
        {
          name: 'Security',
          metrics: [
            { name: 'Attacks Blocked', value: data.technical.security.blocked },
            { name: 'Active Threats', value: data.technical.security.threats }
          ]
        }
      ]
    };
  }
  
  generateExecutiveSection(data) {
    return {
      title: 'Executive Summary',
      kpis: [
        {
          name: 'Revenue Growth',
          value: '+12.5%',
          target: '+10%',
          status: 'exceeded'
        },
        {
          name: 'Operational Efficiency',
          value: '98.5%',
          target: '95%',
          status: 'exceeded'
        },
        {
          name: 'Cost per TH/s',
          value: '$1,234',
          target: '$1,500',
          status: 'exceeded'
        }
      ],
      narrative: this.generateExecutiveNarrative(data)
    };
  }
  
  generateExecutiveNarrative(data) {
    const trend = this.calculateOverallTrend(data);
    const trendText = {
      strong_growth: 'exceptional growth',
      growth: 'steady growth',
      stable: 'stable performance',
      decline: 'challenges'
    };
    
    return `The mining operation has shown ${trendText[trend]} during this period. ` +
           `With ${data.mining.miners.active} active miners generating ${this.formatHashrate(data.mining.hashrate.average)} ` +
           `and ${data.mining.uptime.percentage}% uptime, the pool has maintained strong operational metrics. ` +
           `Revenue of ${data.financial.revenue.total.toFixed(8)} BTC ` +
           `(${(data.financial.revenue.total * data.financial.prices.btc).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}) ` +
           `represents a solid performance in current market conditions.`;
  }
  
  generateAlertsSection(data) {
    return {
      title: 'Alerts & Notifications',
      alerts: data.alerts.map(alert => ({
        ...alert,
        icon: this.getAlertIcon(alert.level),
        color: this.getAlertColor(alert.level)
      }))
    };
  }
  
  getAlertIcon(level) {
    const icons = {
      critical: '🚨',
      warning: '⚠️',
      info: 'ℹ️'
    };
    return icons[level] || '📌';
  }
  
  getAlertColor(level) {
    const colors = {
      critical: '#dc3545',
      warning: '#ffc107',
      info: '#17a2b8'
    };
    return colors[level] || '#6c757d';
  }
  
  generateRecommendations(data) {
    const recommendations = [];
    
    // Performance recommendations
    if (data.mining.shares.efficiency < 95) {
      recommendations.push({
        category: 'performance',
        priority: 'high',
        action: 'Investigate high reject rate. Consider adjusting difficulty or checking network latency.'
      });
    }
    
    // Financial recommendations
    if (data.financial.payouts.pending > data.financial.revenue.total * 0.1) {
      recommendations.push({
        category: 'financial',
        priority: 'medium',
        action: 'High pending payouts detected. Consider processing payments to improve cash flow.'
      });
    }
    
    // Technical recommendations
    if (data.technical.performance.cpu.peak > 90) {
      recommendations.push({
        category: 'technical',
        priority: 'high',
        action: 'CPU usage peaked above 90%. Consider scaling infrastructure or optimizing processes.'
      });
    }
    
    return recommendations;
  }
  
  async createReportFiles(type, content, data) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const baseFilename = `${type}-report-${timestamp}`;
    const files = [];
    
    // Create report directory
    const reportDir = path.join(this.config.delivery.storage.path, type);
    await fs.mkdir(reportDir, { recursive: true });
    
    // Generate PDF
    if (this.config.format.includes('pdf')) {
      const pdfPath = path.join(reportDir, `${baseFilename}.pdf`);
      await this.generatePDF(pdfPath, content, data);
      files.push({ type: 'pdf', path: pdfPath });
    }
    
    // Generate JSON
    if (this.config.format.includes('json')) {
      const jsonPath = path.join(reportDir, `${baseFilename}.json`);
      await fs.writeFile(jsonPath, JSON.stringify({ content, data }, null, 2));
      files.push({ type: 'json', path: jsonPath });
    }
    
    // Generate CSV
    if (this.config.format.includes('csv')) {
      const csvPath = path.join(reportDir, `${baseFilename}.csv`);
      await this.generateCSV(csvPath, data);
      files.push({ type: 'csv', path: csvPath });
    }
    
    return files;
  }
  
  async generatePDF(filepath, content, data) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const stream = doc.pipe(fs.createWriteStream(filepath));
      
      // Header
      doc.fontSize(24).text(content.title, { align: 'center' });
      doc.moveDown();
      
      // Summary
      doc.fontSize(14).text(content.summary.text);
      doc.moveDown();
      
      // Highlights
      doc.fontSize(12);
      content.summary.highlights.forEach(highlight => {
        doc.text(`• ${highlight}`);
      });
      doc.moveDown();
      
      // Sections
      content.sections.forEach(section => {
        doc.addPage();
        doc.fontSize(18).text(section.title);
        doc.moveDown();
        
        // Add section content
        if (section.metrics) {
          section.metrics.forEach(metric => {
            doc.fontSize(12).text(`${metric.name}: ${metric.value}`);
            if (metric.details) {
              doc.fontSize(10).text(`  ${metric.details}`, { indent: 20 });
            }
          });
        }
        
        doc.moveDown();
      });
      
      // Recommendations
      if (content.recommendations.length > 0) {
        doc.addPage();
        doc.fontSize(18).text('Recommendations');
        doc.moveDown();
        
        content.recommendations.forEach((rec, index) => {
          doc.fontSize(12).text(`${index + 1}. [${rec.priority.toUpperCase()}] ${rec.action}`);
          doc.moveDown(0.5);
        });
      }
      
      // Footer
      doc.fontSize(10).text(
        `Generated by ${this.config.branding.companyName} on ${new Date().toLocaleString()}`,
        50, doc.page.height - 50,
        { align: 'center' }
      );
      
      doc.end();
      
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
  
  async generateCSV(filepath, data) {
    const rows = [];
    
    // Headers
    rows.push(['Metric', 'Value', 'Unit', 'Category']);
    
    // Mining data
    rows.push(['Average Hashrate', data.mining.hashrate.average, 'H/s', 'Mining']);
    rows.push(['Share Efficiency', data.mining.shares.efficiency, '%', 'Mining']);
    rows.push(['Active Miners', data.mining.miners.active, 'count', 'Mining']);
    
    // Financial data
    rows.push(['Total Revenue', data.financial.revenue.total, 'BTC', 'Financial']);
    rows.push(['Total Payouts', data.financial.payouts.total, 'BTC', 'Financial']);
    rows.push(['Net Profit', data.financial.profitability.net, 'USD', 'Financial']);
    
    // Convert to CSV string
    const csv = rows.map(row => row.join(',')).join('\n');
    
    await fs.writeFile(filepath, csv);
  }
  
  generateHashrateChart(data) {
    // Generate base64 chart image
    // Simplified - would use actual charting library
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }
  
  generateRevenueChart(data) {
    // Generate base64 chart image
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }
  
  async deliverReport(type, files, content) {
    const deliveries = [];
    
    // Email delivery
    if (this.config.delivery.email.enabled && this.config.delivery.email.recipients.length > 0) {
      deliveries.push(this.sendEmailReport(type, files, content));
    }
    
    // Webhook delivery
    if (this.config.delivery.webhook.enabled && this.config.delivery.webhook.urls.length > 0) {
      deliveries.push(this.sendWebhookReport(type, files, content));
    }
    
    await Promise.all(deliveries);
  }
  
  async sendEmailReport(type, files, content) {
    const attachments = files.map(file => ({
      filename: path.basename(file.path),
      path: file.path
    }));
    
    const mailOptions = {
      from: this.config.delivery.email.smtp.auth.user,
      to: this.config.delivery.email.recipients.join(', '),
      subject: content.title,
      html: this.generateEmailHTML(content),
      attachments
    };
    
    try {
      await this.emailTransporter.sendMail(mailOptions);
      this.emit('emailSent', {
        recipients: this.config.delivery.email.recipients,
        subject: content.title
      });
    } catch (error) {
      this.emit('emailError', error);
    }
  }
  
  generateEmailHTML(content) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          h1 { color: ${this.config.branding.primaryColor}; }
          .highlight { background-color: #f4f4f4; padding: 10px; margin: 10px 0; }
          .metric { margin: 5px 0; }
          .recommendation { padding: 10px; margin: 10px 0; border-left: 3px solid ${this.config.branding.primaryColor}; }
        </style>
      </head>
      <body>
        <h1>${content.title}</h1>
        <p>${content.summary.text}</p>
        
        <div class="highlight">
          <h3>Key Highlights:</h3>
          ${content.summary.highlights.map(h => `<div class="metric">• ${h}</div>`).join('')}
        </div>
        
        ${content.recommendations.length > 0 ? `
          <h3>Recommendations:</h3>
          ${content.recommendations.map(r => `
            <div class="recommendation">
              <strong>${r.priority.toUpperCase()}:</strong> ${r.action}
            </div>
          `).join('')}
        ` : ''}
        
        <p style="margin-top: 30px; font-size: 12px; color: #666;">
          This report was automatically generated by ${this.config.branding.companyName}.
          For detailed information, please refer to the attached files.
        </p>
      </body>
      </html>
    `;
  }
  
  async sendWebhookReport(type, files, content) {
    const payload = {
      type,
      timestamp: new Date().toISOString(),
      content: content.summary,
      metrics: {
        hashrate: content.sections.find(s => s.title === 'Mining Performance')?.metrics[0]?.value,
        revenue: content.sections.find(s => s.title === 'Financial Summary')?.metrics[0]?.value
      },
      files: files.map(f => ({
        type: f.type,
        url: `https://example.com/reports/${path.basename(f.path)}` // Would be actual URL
      }))
    };
    
    const promises = this.config.delivery.webhook.urls.map(async (url) => {
      try {
        await axios.post(url, payload);
        this.emit('webhookSent', { url, type });
      } catch (error) {
        this.emit('webhookError', { url, error: error.message });
      }
    });
    
    await Promise.all(promises);
  }
  
  // Manual report generation
  
  async generateCustomReport(options) {
    const type = options.type || 'custom';
    const data = await this.collectData(type);
    
    // Apply custom filters
    if (options.dateRange) {
      data.metadata.period = options.dateRange;
    }
    
    if (options.metrics) {
      // Filter to requested metrics
      Object.keys(data).forEach(key => {
        if (!options.metrics.includes(key)) {
          delete data[key];
        }
      });
    }
    
    const content = await this.generateContent(type, data);
    const files = await this.createReportFiles(type, content, data);
    
    if (options.deliver) {
      await this.deliverReport(type, files, content);
    }
    
    return { content, files };
  }
  
  // Configuration
  
  updateSchedule(type, schedule) {
    this.config.schedules[type] = schedule;
    
    // Restart scheduling
    this.stop();
    this.start();
  }
  
  addEmailRecipient(email) {
    if (!this.config.delivery.email.recipients.includes(email)) {
      this.config.delivery.email.recipients.push(email);
    }
  }
  
  removeEmailRecipient(email) {
    const index = this.config.delivery.email.recipients.indexOf(email);
    if (index > -1) {
      this.config.delivery.email.recipients.splice(index, 1);
    }
  }
  
  addWebhookUrl(url) {
    if (!this.config.delivery.webhook.urls.includes(url)) {
      this.config.delivery.webhook.urls.push(url);
    }
  }
  
  getStatus() {
    return {
      running: this.scheduledJobs.size > 0,
      generating: this.isGenerating,
      queueLength: this.reportQueue.length,
      schedules: this.config.schedules,
      delivery: {
        email: {
          enabled: this.config.delivery.email.enabled,
          recipients: this.config.delivery.email.recipients.length
        },
        webhook: {
          enabled: this.config.delivery.webhook.enabled,
          urls: this.config.delivery.webhook.urls.length
        }
      }
    };
  }
}

module.exports = AutoReportSystem;