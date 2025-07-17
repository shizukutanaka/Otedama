#!/usr/bin/env node

/**
 * Otedama Performance Reporter
 * Automated performance monitoring and reporting system for commercial operations
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

class OtedamaPerformanceReporter {
    constructor() {
        this.config = {
            prometheusURL: process.env.PROMETHEUS_URL || 'http://localhost:9090',
            grafanaURL: process.env.GRAFANA_URL || 'http://localhost:3000',
            apiURL: process.env.API_URL || 'http://localhost:8080',
            reportInterval: parseInt(process.env.REPORT_INTERVAL) || 3600000, // 1 hour
            dailyReportTime: process.env.DAILY_REPORT_TIME || '06:00',
            weeklyReportDay: process.env.WEEKLY_REPORT_DAY || 'monday',
            monthlyReportDate: parseInt(process.env.MONTHLY_REPORT_DATE) || 1,
            slackWebhook: process.env.SLACK_WEBHOOK_URL,
            emailConfig: {
                enabled: process.env.EMAIL_ENABLED === 'true',
                smtp: process.env.SMTP_SERVER || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT) || 587,
                username: process.env.EMAIL_USERNAME,
                password: process.env.EMAIL_PASSWORD,
                from: process.env.EMAIL_FROM || 'noreply@otedama.io',
                to: process.env.EMAIL_TO || 'admin@otedama.io'
            }
        };
        
        this.metrics = {
            system: {},
            application: {},
            business: {},
            security: {},
            defi: {},
            mining: {}
        };
        
        this.trends = {
            hourly: [],
            daily: [],
            weekly: [],
            monthly: []
        };
        
        this.thresholds = {
            performance: {
                responseTime: 1000, // ms
                throughput: 1000,   // req/s
                errorRate: 0.01,    // 1%
                uptime: 99.9        // %
            },
            business: {
                minRevenue: 0.001,  // BTC/hour
                minUsers: 100,      // active users
                minHashrate: 1000000 // H/s
            },
            security: {
                maxFailedLogins: 50,
                maxSuspiciousTransactions: 5,
                maxRateLimitExceeded: 100
            }
        };
        
        this.alerts = [];
        this.recommendations = [];
    }

    // Data Collection Methods
    async collectSystemMetrics() {
        try {
            const queries = [
                'up{job="otedama-pool"}',
                'rate(otedama_http_requests_total[5m])',
                'histogram_quantile(0.95, rate(otedama_http_request_duration_seconds_bucket[5m]))',
                'rate(otedama_errors_total[5m])',
                'otedama_database_connections_active',
                'node_memory_MemAvailable_bytes',
                'node_memory_MemTotal_bytes',
                'rate(node_cpu_seconds_total{mode="idle"}[5m])',
                'node_filesystem_avail_bytes',
                'node_filesystem_size_bytes'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.system = {
                uptime: results[0]?.value || 0,
                throughput: results[1]?.value || 0,
                responseTime: results[2]?.value || 0,
                errorRate: results[3]?.value || 0,
                dbConnections: results[4]?.value || 0,
                memoryUsage: ((results[6]?.value - results[5]?.value) / results[6]?.value * 100) || 0,
                cpuUsage: (100 - (results[7]?.value * 100)) || 0,
                diskUsage: ((results[9]?.value - results[8]?.value) / results[9]?.value * 100) || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting system metrics:', error);
        }
    }

    async collectApplicationMetrics() {
        try {
            const queries = [
                'otedama_active_users_total',
                'otedama_total_requests',
                'otedama_cache_hit_ratio',
                'otedama_queue_size',
                'otedama_worker_threads_active',
                'otedama_websocket_connections_active',
                'otedama_api_endpoints_available'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.application = {
                activeUsers: results[0]?.value || 0,
                totalRequests: results[1]?.value || 0,
                cacheHitRatio: results[2]?.value || 0,
                queueSize: results[3]?.value || 0,
                workerThreads: results[4]?.value || 0,
                websocketConnections: results[5]?.value || 0,
                apiEndpoints: results[6]?.value || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting application metrics:', error);
        }
    }

    async collectBusinessMetrics() {
        try {
            const queries = [
                'otedama_revenue_total',
                'otedama_fees_collected_total',
                'otedama_payouts_total',
                'otedama_user_registrations_total',
                'otedama_active_miners_total',
                'otedama_pool_blocks_found_total',
                'otedama_dex_volume_total',
                'otedama_defi_total_value_locked'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.business = {
                revenue: results[0]?.value || 0,
                fees: results[1]?.value || 0,
                payouts: results[2]?.value || 0,
                userRegistrations: results[3]?.value || 0,
                activeMiners: results[4]?.value || 0,
                blocksFound: results[5]?.value || 0,
                dexVolume: results[6]?.value || 0,
                tvl: results[7]?.value || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting business metrics:', error);
        }
    }

    async collectSecurityMetrics() {
        try {
            const queries = [
                'otedama_auth_failures_total',
                'otedama_suspicious_transactions_total',
                'otedama_rate_limit_exceeded_total',
                'otedama_blocked_ips_total',
                'otedama_failed_2fa_attempts_total',
                'otedama_security_alerts_total'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.security = {
                authFailures: results[0]?.value || 0,
                suspiciousTransactions: results[1]?.value || 0,
                rateLimitExceeded: results[2]?.value || 0,
                blockedIPs: results[3]?.value || 0,
                failed2FA: results[4]?.value || 0,
                securityAlerts: results[5]?.value || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting security metrics:', error);
        }
    }

    async collectDeFiMetrics() {
        try {
            const queries = [
                'otedama_defi_pools_active',
                'otedama_defi_liquidity_providers_total',
                'otedama_defi_farming_participants_total',
                'otedama_defi_flash_loans_total',
                'otedama_defi_arbitrage_opportunities_total',
                'otedama_defi_yield_rate_average',
                'otedama_defi_impermanent_loss_total'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.defi = {
                activePools: results[0]?.value || 0,
                liquidityProviders: results[1]?.value || 0,
                farmingParticipants: results[2]?.value || 0,
                flashLoans: results[3]?.value || 0,
                arbitrageOpportunities: results[4]?.value || 0,
                averageYieldRate: results[5]?.value || 0,
                impermanentLoss: results[6]?.value || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting DeFi metrics:', error);
        }
    }

    async collectMiningMetrics() {
        try {
            const queries = [
                'otedama_pool_hashrate_total',
                'otedama_miners_active_total',
                'otedama_shares_submitted_total',
                'otedama_shares_accepted_total',
                'otedama_shares_rejected_total',
                'otedama_pool_difficulty_current',
                'otedama_pool_luck_percent',
                'otedama_stratum_connections_active'
            ];
            
            const results = await Promise.all(
                queries.map(query => this.queryPrometheus(query))
            );
            
            this.metrics.mining = {
                hashrate: results[0]?.value || 0,
                activeMiners: results[1]?.value || 0,
                sharesSubmitted: results[2]?.value || 0,
                sharesAccepted: results[3]?.value || 0,
                sharesRejected: results[4]?.value || 0,
                difficulty: results[5]?.value || 0,
                luck: results[6]?.value || 0,
                stratumConnections: results[7]?.value || 0,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.error('Error collecting mining metrics:', error);
        }
    }

    // Prometheus Query Helper
    async queryPrometheus(query) {
        return new Promise((resolve, reject) => {
            const url = `${this.config.prometheusURL}/api/v1/query?query=${encodeURIComponent(query)}`;
            
            http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.status === 'success' && result.data.result.length > 0) {
                            resolve({
                                value: parseFloat(result.data.result[0].value[1]) || 0,
                                timestamp: result.data.result[0].value[0]
                            });
                        } else {
                            resolve({ value: 0, timestamp: Date.now() / 1000 });
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            }).on('error', reject);
        });
    }

    // Analysis Methods
    analyzePerformance() {
        const alerts = [];
        const recommendations = [];
        
        // System performance analysis
        if (this.metrics.system.responseTime > this.thresholds.performance.responseTime) {
            alerts.push({
                severity: 'warning',
                category: 'performance',
                message: `High response time: ${this.metrics.system.responseTime}ms`,
                threshold: this.thresholds.performance.responseTime
            });
            recommendations.push('Consider implementing caching and database optimization');
        }
        
        if (this.metrics.system.throughput < this.thresholds.performance.throughput) {
            alerts.push({
                severity: 'warning',
                category: 'performance',
                message: `Low throughput: ${this.metrics.system.throughput} req/s`,
                threshold: this.thresholds.performance.throughput
            });
            recommendations.push('Scale horizontally or optimize request handling');
        }
        
        if (this.metrics.system.errorRate > this.thresholds.performance.errorRate) {
            alerts.push({
                severity: 'critical',
                category: 'performance',
                message: `High error rate: ${(this.metrics.system.errorRate * 100).toFixed(2)}%`,
                threshold: this.thresholds.performance.errorRate * 100
            });
            recommendations.push('Investigate and fix application errors');
        }
        
        // Business metrics analysis
        if (this.metrics.business.revenue < this.thresholds.business.minRevenue) {
            alerts.push({
                severity: 'warning',
                category: 'business',
                message: `Low revenue: ${this.metrics.business.revenue} BTC/hour`,
                threshold: this.thresholds.business.minRevenue
            });
            recommendations.push('Review fee structure and pool marketing');
        }
        
        if (this.metrics.application.activeUsers < this.thresholds.business.minUsers) {
            alerts.push({
                severity: 'info',
                category: 'business',
                message: `Low user activity: ${this.metrics.application.activeUsers} users`,
                threshold: this.thresholds.business.minUsers
            });
            recommendations.push('Implement user engagement strategies');
        }
        
        // Security analysis
        if (this.metrics.security.authFailures > this.thresholds.security.maxFailedLogins) {
            alerts.push({
                severity: 'warning',
                category: 'security',
                message: `High authentication failures: ${this.metrics.security.authFailures}`,
                threshold: this.thresholds.security.maxFailedLogins
            });
            recommendations.push('Implement enhanced security measures');
        }
        
        this.alerts = alerts;
        this.recommendations = recommendations;
        
        return { alerts, recommendations };
    }

    calculateTrends() {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        const dayAgo = now - (24 * 60 * 60 * 1000);
        const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const monthAgo = now - (30 * 24 * 60 * 60 * 1000);
        
        // Load historical data
        const historicalData = this.loadHistoricalData();
        
        // Calculate trends
        this.trends = {
            hourly: this.calculateTrendForPeriod(historicalData, hourAgo),
            daily: this.calculateTrendForPeriod(historicalData, dayAgo),
            weekly: this.calculateTrendForPeriod(historicalData, weekAgo),
            monthly: this.calculateTrendForPeriod(historicalData, monthAgo)
        };
        
        return this.trends;
    }

    calculateTrendForPeriod(data, periodStart) {
        const periodData = data.filter(d => d.timestamp >= periodStart);
        
        if (periodData.length < 2) return { trend: 'insufficient_data', change: 0 };
        
        const first = periodData[0];
        const last = periodData[periodData.length - 1];
        
        const changes = {};
        
        // Calculate percentage changes for key metrics
        ['revenue', 'activeUsers', 'hashrate', 'throughput'].forEach(metric => {
            if (first[metric] && last[metric]) {
                const change = ((last[metric] - first[metric]) / first[metric]) * 100;
                changes[metric] = {
                    change: change.toFixed(2),
                    trend: change > 0 ? 'increasing' : change < 0 ? 'decreasing' : 'stable'
                };
            }
        });
        
        return changes;
    }

    // Report Generation
    generateHourlyReport() {
        const report = {
            timestamp: new Date().toISOString(),
            period: 'hourly',
            metrics: this.metrics,
            analysis: this.analyzePerformance(),
            trends: this.calculateTrends(),
            summary: {
                uptime: this.metrics.system.uptime,
                performance: this.assessPerformance(),
                business: this.assessBusiness(),
                security: this.assessSecurity()
            }
        };
        
        return report;
    }

    generateDailyReport() {
        const report = {
            timestamp: new Date().toISOString(),
            period: 'daily',
            metrics: this.metrics,
            analysis: this.analyzePerformance(),
            trends: this.calculateTrends(),
            summary: {
                totalRevenue: this.metrics.business.revenue,
                totalUsers: this.metrics.application.activeUsers,
                totalHashrate: this.metrics.mining.hashrate,
                averageResponseTime: this.metrics.system.responseTime,
                uptime: this.metrics.system.uptime,
                blocksFound: this.metrics.business.blocksFound
            },
            recommendations: this.recommendations,
            alerts: this.alerts
        };
        
        return report;
    }

    generateWeeklyReport() {
        const report = {
            timestamp: new Date().toISOString(),
            period: 'weekly',
            metrics: this.metrics,
            analysis: this.analyzePerformance(),
            trends: this.calculateTrends(),
            summary: {
                performanceScore: this.calculatePerformanceScore(),
                businessScore: this.calculateBusinessScore(),
                securityScore: this.calculateSecurityScore(),
                overallScore: this.calculateOverallScore()
            },
            topIssues: this.getTopIssues(),
            achievements: this.getAchievements(),
            recommendations: this.recommendations
        };
        
        return report;
    }

    generateMonthlyReport() {
        const report = {
            timestamp: new Date().toISOString(),
            period: 'monthly',
            metrics: this.metrics,
            analysis: this.analyzePerformance(),
            trends: this.calculateTrends(),
            summary: {
                totalRevenue: this.metrics.business.revenue,
                totalUsers: this.metrics.application.activeUsers,
                growthRate: this.calculateGrowthRate(),
                efficiency: this.calculateEfficiency(),
                roi: this.calculateROI()
            },
            strategicRecommendations: this.getStrategicRecommendations(),
            roadmap: this.generateRoadmap()
        };
        
        return report;
    }

    // Assessment Methods
    assessPerformance() {
        let score = 100;
        
        if (this.metrics.system.responseTime > this.thresholds.performance.responseTime) score -= 20;
        if (this.metrics.system.throughput < this.thresholds.performance.throughput) score -= 20;
        if (this.metrics.system.errorRate > this.thresholds.performance.errorRate) score -= 30;
        if (this.metrics.system.uptime < this.thresholds.performance.uptime) score -= 30;
        
        return Math.max(0, score);
    }

    assessBusiness() {
        let score = 100;
        
        if (this.metrics.business.revenue < this.thresholds.business.minRevenue) score -= 25;
        if (this.metrics.application.activeUsers < this.thresholds.business.minUsers) score -= 25;
        if (this.metrics.mining.hashrate < this.thresholds.business.minHashrate) score -= 25;
        if (this.metrics.business.blocksFound === 0) score -= 25;
        
        return Math.max(0, score);
    }

    assessSecurity() {
        let score = 100;
        
        if (this.metrics.security.authFailures > this.thresholds.security.maxFailedLogins) score -= 30;
        if (this.metrics.security.suspiciousTransactions > this.thresholds.security.maxSuspiciousTransactions) score -= 30;
        if (this.metrics.security.rateLimitExceeded > this.thresholds.security.maxRateLimitExceeded) score -= 20;
        if (this.metrics.security.securityAlerts > 0) score -= 20;
        
        return Math.max(0, score);
    }

    calculatePerformanceScore() {
        return (this.assessPerformance() + this.assessBusiness() + this.assessSecurity()) / 3;
    }

    calculateBusinessScore() {
        return this.assessBusiness();
    }

    calculateSecurityScore() {
        return this.assessSecurity();
    }

    calculateOverallScore() {
        return (this.assessPerformance() + this.assessBusiness() + this.assessSecurity()) / 3;
    }

    // Utility Methods
    getTopIssues() {
        return this.alerts
            .filter(alert => alert.severity === 'critical' || alert.severity === 'warning')
            .sort((a, b) => {
                const severityOrder = { critical: 3, warning: 2, info: 1 };
                return severityOrder[b.severity] - severityOrder[a.severity];
            })
            .slice(0, 5);
    }

    getAchievements() {
        const achievements = [];
        
        if (this.metrics.system.uptime > 99.9) {
            achievements.push('High availability maintained (>99.9% uptime)');
        }
        
        if (this.metrics.business.revenue > this.thresholds.business.minRevenue * 2) {
            achievements.push('Revenue target exceeded by 100%');
        }
        
        if (this.metrics.security.authFailures === 0) {
            achievements.push('Zero authentication failures');
        }
        
        return achievements;
    }

    getStrategicRecommendations() {
        const recommendations = [];
        
        // Performance recommendations
        if (this.assessPerformance() < 80) {
            recommendations.push({
                category: 'performance',
                priority: 'high',
                recommendation: 'Implement performance optimization plan',
                impact: 'Improved user experience and operational efficiency'
            });
        }
        
        // Business recommendations
        if (this.assessBusiness() < 80) {
            recommendations.push({
                category: 'business',
                priority: 'medium',
                recommendation: 'Review business strategy and market positioning',
                impact: 'Increased revenue and user acquisition'
            });
        }
        
        // Security recommendations
        if (this.assessSecurity() < 90) {
            recommendations.push({
                category: 'security',
                priority: 'high',
                recommendation: 'Enhance security posture and monitoring',
                impact: 'Reduced risk and improved compliance'
            });
        }
        
        return recommendations;
    }

    generateRoadmap() {
        const roadmap = [];
        
        // Next 30 days
        roadmap.push({
            timeframe: '30 days',
            goals: [
                'Optimize database performance',
                'Implement additional monitoring',
                'Enhance user experience'
            ]
        });
        
        // Next 90 days
        roadmap.push({
            timeframe: '90 days',
            goals: [
                'Scale infrastructure',
                'Launch new features',
                'Expand market reach'
            ]
        });
        
        // Next 12 months
        roadmap.push({
            timeframe: '12 months',
            goals: [
                'Achieve commercial-grade reliability',
                'Implement advanced DeFi features',
                'Establish market leadership'
            ]
        });
        
        return roadmap;
    }

    // Data Persistence
    saveReport(report) {
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `performance-report-${report.period}-${timestamp}.json`;
        const reportPath = path.join(__dirname, '..', 'reports', filename);
        
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        // Also save to historical data
        this.saveHistoricalData(report);
        
        return reportPath;
    }

    saveHistoricalData(report) {
        const dataPath = path.join(__dirname, '..', 'data', 'historical-performance.json');
        
        let historical = [];
        if (fs.existsSync(dataPath)) {
            historical = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        }
        
        historical.push({
            timestamp: Date.now(),
            ...report.metrics
        });
        
        // Keep only last 1000 entries
        if (historical.length > 1000) {
            historical = historical.slice(-1000);
        }
        
        fs.writeFileSync(dataPath, JSON.stringify(historical, null, 2));
    }

    loadHistoricalData() {
        const dataPath = path.join(__dirname, '..', 'data', 'historical-performance.json');
        
        if (fs.existsSync(dataPath)) {
            return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        }
        
        return [];
    }

    // Notification Methods
    async sendNotification(report) {
        const message = this.formatNotificationMessage(report);
        
        // Send to Slack
        if (this.config.slackWebhook) {
            await this.sendSlackNotification(message);
        }
        
        // Send email
        if (this.config.emailConfig.enabled) {
            await this.sendEmailNotification(message);
        }
    }

    formatNotificationMessage(report) {
        return `
🔔 Otedama ${report.period} Performance Report

📊 Overall Score: ${report.summary.overallScore || 'N/A'}/100
⚡ Performance: ${this.assessPerformance()}/100
💰 Business: ${this.assessBusiness()}/100
🔐 Security: ${this.assessSecurity()}/100

${this.alerts.length > 0 ? '🚨 Active Alerts: ' + this.alerts.length : '✅ No active alerts'}

Top Issues:
${this.getTopIssues().map(issue => `• ${issue.message}`).join('\n')}

Achievements:
${this.getAchievements().map(achievement => `• ${achievement}`).join('\n')}
        `;
    }

    async sendSlackNotification(message) {
        // Implementation for Slack webhook
        // This would require the actual Slack webhook integration
        console.log('Slack notification:', message);
    }

    async sendEmailNotification(message) {
        // Implementation for email notification
        // This would require nodemailer or similar email library
        console.log('Email notification:', message);
    }

    // Main Runner
    async collectAllMetrics() {
        console.log('🔄 Collecting performance metrics...');
        
        await Promise.all([
            this.collectSystemMetrics(),
            this.collectApplicationMetrics(),
            this.collectBusinessMetrics(),
            this.collectSecurityMetrics(),
            this.collectDeFiMetrics(),
            this.collectMiningMetrics()
        ]);
        
        console.log('✅ Metrics collection complete');
    }

    async generateAndSaveReport(type = 'hourly') {
        let report;
        
        switch (type) {
            case 'daily':
                report = this.generateDailyReport();
                break;
            case 'weekly':
                report = this.generateWeeklyReport();
                break;
            case 'monthly':
                report = this.generateMonthlyReport();
                break;
            default:
                report = this.generateHourlyReport();
        }
        
        const reportPath = this.saveReport(report);
        
        // Send notifications for important reports
        if (type !== 'hourly' || this.alerts.length > 0) {
            await this.sendNotification(report);
        }
        
        console.log(`📊 ${type} report generated: ${reportPath}`);
        console.log(`Overall Score: ${report.summary.overallScore || 'N/A'}/100`);
        
        return report;
    }

    async run() {
        console.log('🚀 Starting Otedama Performance Reporter...');
        
        try {
            await this.collectAllMetrics();
            const report = await this.generateAndSaveReport('hourly');
            
            console.log('\n📋 Performance Summary:');
            console.log(`System Performance: ${this.assessPerformance()}/100`);
            console.log(`Business Performance: ${this.assessBusiness()}/100`);
            console.log(`Security Performance: ${this.assessSecurity()}/100`);
            console.log(`Active Alerts: ${this.alerts.length}`);
            console.log(`Recommendations: ${this.recommendations.length}`);
            
            return report;
            
        } catch (error) {
            console.error('❌ Performance reporting failed:', error);
            throw error;
        }
    }
}

// CLI Interface
if (require.main === module) {
    const reporter = new OtedamaPerformanceReporter();
    const reportType = process.argv[2] || 'hourly';
    
    reporter.run()
        .then(() => {
            if (reportType !== 'hourly') {
                return reporter.generateAndSaveReport(reportType);
            }
        })
        .then(() => {
            console.log('✅ Performance reporting complete');
            process.exit(0);
        })
        .catch(error => {
            console.error('Performance reporting failed:', error);
            process.exit(1);
        });
}

module.exports = OtedamaPerformanceReporter;