/**
 * Otedama Mining Pool - User Behavior Analytics Report Generator
 * Analyzes user patterns and generates actionable insights
 */

import { createLogger } from '../lib/core/logger.js';
import { Database } from '../lib/storage/database.js';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('AnalyticsReporter');

class UserBehaviorAnalytics {
  constructor(databasePath = '../data/otedama.db') {
    this.db = new Database({ filename: path.resolve(databasePath) });
  }

  async initialize() {
    await this.db.open();
    logger.info('Analytics database connection established');
  }

  async close() {
    await this.db.close();
  }

  // ========== Core Analytics Functions ==========

  async getUserEngagementMetrics() {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    
    // Daily Active Users
    const dauQuery = `
      SELECT 
        DATE(datetime(lastSeen, 'unixepoch')) as activity_date,
        COUNT(DISTINCT id) as daily_active_users,
        SUM(hashrate) as total_hashrate,
        AVG(hashrate) as avg_hashrate_per_user
      FROM miners
      WHERE lastSeen > ?
      GROUP BY activity_date
      ORDER BY activity_date DESC
      LIMIT 30
    `;
    
    const dauData = await this.db.all(dauQuery, [thirtyDaysAgo]);
    
    // Calculate trends
    const avgDAU = dauData.reduce((sum, day) => sum + day.daily_active_users, 0) / dauData.length;
    const recentDAU = dauData.slice(0, 7).reduce((sum, day) => sum + day.daily_active_users, 0) / 7;
    const dauTrend = ((recentDAU - avgDAU) / avgDAU * 100).toFixed(2);
    
    return {
      dailyActiveUsers: dauData,
      averageDAU: avgDAU.toFixed(0),
      recentDAU: recentDAU.toFixed(0),
      dauTrend: dauTrend,
      totalUniqueUsers: await this.getTotalUniqueUsers(thirtyDaysAgo)
    };
  }

  async getTotalUniqueUsers(since) {
    const result = await this.db.get(
      'SELECT COUNT(DISTINCT id) as total FROM miners WHERE lastSeen > ?',
      [since]
    );
    return result.total;
  }

  async getUserSegmentation() {
    const segments = await this.db.all(`
      WITH user_metrics AS (
        SELECT 
          id,
          address,
          hashrate,
          totalShares,
          validShares,
          balance,
          paid,
          CAST(validShares AS REAL) / NULLIF(totalShares, 0) as validity_rate,
          julianday('now') - julianday(datetime(created, 'unixepoch')) as account_age_days,
          julianday('now') - julianday(datetime(lastSeen, 'unixepoch')) as days_since_active
        FROM miners
        WHERE lastSeen > strftime('%s', 'now', '-90 days')
      ),
      hashrate_percentiles AS (
        SELECT 
          (SELECT hashrate FROM user_metrics ORDER BY hashrate DESC LIMIT 1 OFFSET (SELECT COUNT(*) * 0.1 FROM user_metrics)) as p90,
          (SELECT hashrate FROM user_metrics ORDER BY hashrate DESC LIMIT 1 OFFSET (SELECT COUNT(*) * 0.5 FROM user_metrics)) as p50
      )
      SELECT 
        CASE 
          WHEN um.hashrate > hp.p90 THEN 'Power Users (Top 10%)'
          WHEN um.hashrate > hp.p50 THEN 'Regular Users (50-90%)'
          WHEN um.days_since_active > 30 THEN 'Dormant Users'
          WHEN um.account_age_days < 7 THEN 'New Users'
          ELSE 'Casual Users'
        END as user_segment,
        COUNT(*) as user_count,
        AVG(um.hashrate) as avg_hashrate,
        AVG(um.validity_rate) * 100 as avg_validity_rate,
        SUM(um.balance) as total_pending_balance,
        SUM(um.paid) as total_paid_out
      FROM user_metrics um
      CROSS JOIN hashrate_percentiles hp
      GROUP BY user_segment
      ORDER BY user_count DESC
    `);
    
    return segments;
  }

  async getMiningPatterns() {
    const patterns = await this.db.all(`
      SELECT 
        CAST(strftime('%H', datetime(timestamp, 'unixepoch')) AS INTEGER) as hour_of_day,
        CAST(strftime('%w', datetime(timestamp, 'unixepoch')) AS INTEGER) as day_of_week,
        COUNT(DISTINCT miner_id) as active_miners,
        COUNT(*) as total_shares,
        SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid_shares,
        ROUND(CAST(SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 2) as validity_rate,
        AVG(difficulty) as avg_difficulty
      FROM shares
      WHERE timestamp > strftime('%s', 'now', '-30 days')
      GROUP BY hour_of_day, day_of_week
      ORDER BY hour_of_day, day_of_week
    `);
    
    // Find peak hours
    const hourlyActivity = {};
    patterns.forEach(p => {
      if (!hourlyActivity[p.hour_of_day]) {
        hourlyActivity[p.hour_of_day] = { shares: 0, miners: 0 };
      }
      hourlyActivity[p.hour_of_day].shares += p.total_shares;
      hourlyActivity[p.hour_of_day].miners += p.active_miners;
    });
    
    const peakHour = Object.entries(hourlyActivity)
      .sort((a, b) => b[1].shares - a[1].shares)[0][0];
    
    return {
      patterns,
      peakHour: parseInt(peakHour),
      hourlyActivity
    };
  }

  async getRetentionMetrics() {
    const cohortRetention = await this.db.all(`
      WITH user_cohorts AS (
        SELECT 
          id,
          DATE(datetime(created, 'unixepoch')) as cohort_date,
          DATE(datetime(lastSeen, 'unixepoch')) as last_active_date,
          julianday(datetime(lastSeen, 'unixepoch')) - julianday(datetime(created, 'unixepoch')) as days_active
        FROM miners
        WHERE created > strftime('%s', 'now', '-90 days')
      ),
      cohort_sizes AS (
        SELECT 
          cohort_date,
          COUNT(DISTINCT id) as cohort_size
        FROM user_cohorts
        GROUP BY cohort_date
      )
      SELECT 
        uc.cohort_date,
        cs.cohort_size,
        SUM(CASE WHEN uc.days_active >= 1 THEN 1 ELSE 0 END) as day1_retained,
        SUM(CASE WHEN uc.days_active >= 7 THEN 1 ELSE 0 END) as day7_retained,
        SUM(CASE WHEN uc.days_active >= 30 THEN 1 ELSE 0 END) as day30_retained
      FROM user_cohorts uc
      JOIN cohort_sizes cs ON uc.cohort_date = cs.cohort_date
      GROUP BY uc.cohort_date, cs.cohort_size
      ORDER BY uc.cohort_date DESC
      LIMIT 30
    `);
    
    // Calculate average retention rates
    const avgRetention = {
      day1: 0,
      day7: 0,
      day30: 0
    };
    
    cohortRetention.forEach(cohort => {
      avgRetention.day1 += (cohort.day1_retained / cohort.cohort_size);
      avgRetention.day7 += (cohort.day7_retained / cohort.cohort_size);
      avgRetention.day30 += (cohort.day30_retained / cohort.cohort_size);
    });
    
    const cohortCount = cohortRetention.length;
    avgRetention.day1 = (avgRetention.day1 / cohortCount * 100).toFixed(2);
    avgRetention.day7 = (avgRetention.day7 / cohortCount * 100).toFixed(2);
    avgRetention.day30 = (avgRetention.day30 / cohortCount * 100).toFixed(2);
    
    return {
      cohortRetention,
      averageRetention: avgRetention
    };
  }

  async getChurnRiskAnalysis() {
    const atRiskUsers = await this.db.all(`
      WITH user_activity AS (
        SELECT 
          m.id,
          m.address,
          m.hashrate,
          julianday('now') - julianday(datetime(m.lastSeen, 'unixepoch')) as days_inactive,
          (SELECT COUNT(*) FROM shares WHERE miner_id = m.id 
           AND timestamp > strftime('%s', 'now', '-7 days')) as shares_last_7d,
          (SELECT COUNT(*) FROM shares WHERE miner_id = m.id 
           AND timestamp BETWEEN strftime('%s', 'now', '-14 days') 
           AND strftime('%s', 'now', '-7 days')) as shares_prev_7d
        FROM miners m
        WHERE m.totalShares > 100
      )
      SELECT 
        CASE
          WHEN days_inactive > 7 THEN 'High Risk - Already Inactive'
          WHEN shares_last_7d < shares_prev_7d * 0.5 THEN 'High Risk - Declining Activity'
          WHEN days_inactive > 3 THEN 'Medium Risk - Recent Inactivity'
          ELSE 'Low Risk - Active'
        END as risk_level,
        COUNT(*) as user_count,
        AVG(hashrate) as avg_hashrate,
        AVG(days_inactive) as avg_days_inactive
      FROM user_activity
      GROUP BY risk_level
    `);
    
    return atRiskUsers;
  }

  async getFeatureAdoption() {
    const featureUsage = await this.db.all(`
      SELECT 
        CASE 
          WHEN action LIKE '%api%' THEN 'API Usage'
          WHEN action LIKE '%mobile%' THEN 'Mobile Access'
          WHEN action LIKE '%webhook%' THEN 'Webhook Integration'
          WHEN action LIKE '%2fa%' OR action LIKE '%auth%' THEN 'Security Features'
          WHEN resource LIKE '%solo%' THEN 'Solo Mining'
          WHEN resource LIKE '%multi%' THEN 'Multi-coin Features'
          ELSE 'Standard Mining'
        END as feature,
        COUNT(DISTINCT userId) as unique_users,
        COUNT(*) as usage_count
      FROM audit_logs
      WHERE timestamp > strftime('%s', 'now', '-30 days')
      GROUP BY feature
      ORDER BY unique_users DESC
    `);
    
    return featureUsage;
  }

  async getPerformanceMetrics() {
    const apiPerformance = await this.db.all(`
      SELECT 
        action as endpoint,
        COUNT(*) as request_count,
        AVG(responseTime) as avg_response_time,
        MAX(responseTime) as max_response_time,
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) as error_count,
        ROUND(CAST(SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 2) as error_rate
      FROM performance_logs
      WHERE timestamp > strftime('%s', 'now', '-7 days')
      GROUP BY action
      HAVING COUNT(*) > 10
      ORDER BY request_count DESC
      LIMIT 20
    `);
    
    return apiPerformance;
  }

  // ========== Report Generation ==========

  async generateInsights() {
    const insights = [];
    
    // Get all metrics
    const engagement = await this.getUserEngagementMetrics();
    const segments = await this.getUserSegmentation();
    const patterns = await this.getMiningPatterns();
    const retention = await this.getRetentionMetrics();
    const churnRisk = await this.getChurnRiskAnalysis();
    const features = await this.getFeatureAdoption();
    const performance = await this.getPerformanceMetrics();
    
    // Generate insights based on data
    
    // Engagement insights
    if (parseFloat(engagement.dauTrend) > 0) {
      insights.push({
        category: 'Growth',
        type: 'positive',
        message: `Daily active users are trending up by ${engagement.dauTrend}%`,
        recommendation: 'Continue current engagement strategies and consider scaling infrastructure'
      });
    } else if (parseFloat(engagement.dauTrend) < -10) {
      insights.push({
        category: 'Growth',
        type: 'concern',
        message: `Daily active users are declining by ${Math.abs(engagement.dauTrend)}%`,
        recommendation: 'Implement retention campaigns and investigate causes of user churn'
      });
    }
    
    // Segment insights
    const powerUsers = segments.find(s => s.user_segment.includes('Power Users'));
    if (powerUsers && powerUsers.user_count > 0) {
      const powerUserPercent = (powerUsers.user_count / segments.reduce((sum, s) => sum + s.user_count, 0) * 100).toFixed(1);
      insights.push({
        category: 'User Segments',
        type: 'info',
        message: `Power users represent ${powerUserPercent}% of users but likely contribute >50% of hashrate`,
        recommendation: 'Create VIP programs or dedicated support for power users'
      });
    }
    
    // Retention insights
    if (parseFloat(retention.averageRetention.day7) < 40) {
      insights.push({
        category: 'Retention',
        type: 'concern',
        message: `Only ${retention.averageRetention.day7}% of new users remain active after 7 days`,
        recommendation: 'Improve onboarding experience and provide early rewards/achievements'
      });
    }
    
    // Performance insights
    const slowEndpoints = performance.filter(p => p.avg_response_time > 1000);
    if (slowEndpoints.length > 0) {
      insights.push({
        category: 'Performance',
        type: 'warning',
        message: `${slowEndpoints.length} API endpoints have response times >1 second`,
        recommendation: 'Optimize slow endpoints or implement caching strategies'
      });
    }
    
    // Churn risk insights
    const highRiskUsers = churnRisk.filter(c => c.risk_level.includes('High Risk'));
    const totalHighRisk = highRiskUsers.reduce((sum, c) => sum + c.user_count, 0);
    if (totalHighRisk > 0) {
      insights.push({
        category: 'Churn Risk',
        type: 'warning',
        message: `${totalHighRisk} users are at high risk of churning`,
        recommendation: 'Launch re-engagement campaign targeting inactive users with incentives'
      });
    }
    
    // Feature adoption insights
    const underutilizedFeatures = features.filter(f => f.unique_users < 10);
    if (underutilizedFeatures.length > 0) {
      insights.push({
        category: 'Feature Adoption',
        type: 'opportunity',
        message: `${underutilizedFeatures.length} features have low adoption (<10 users)`,
        recommendation: 'Create tutorials and promote underutilized features to increase value'
      });
    }
    
    return insights;
  }

  async generateHTMLReport() {
    const engagement = await this.getUserEngagementMetrics();
    const segments = await this.getUserSegmentation();
    const patterns = await this.getMiningPatterns();
    const retention = await this.getRetentionMetrics();
    const churnRisk = await this.getChurnRiskAnalysis();
    const features = await this.getFeatureAdoption();
    const performance = await this.getPerformanceMetrics();
    const insights = await this.generateInsights();
    
    const reportDate = new Date().toISOString();
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Pool - User Analytics Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        h1, h2, h3 { color: #333; }
        .metric-card { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .metric-value { font-size: 24px; font-weight: bold; color: #007bff; }
        .positive { color: #28a745; }
        .negative { color: #dc3545; }
        .warning { color: #ffc107; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #007bff; color: white; }
        .insight { padding: 15px; margin: 10px 0; border-left: 4px solid #007bff; background: #e7f3ff; }
        .insight.concern { border-color: #dc3545; background: #f8d7da; }
        .insight.warning { border-color: #ffc107; background: #fff3cd; }
        .insight.positive { border-color: #28a745; background: #d4edda; }
        .chart { margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Otedama Mining Pool - User Analytics Report</h1>
        <p>Generated: ${reportDate}</p>
        
        <h2>Executive Summary</h2>
        <div class="metric-card">
            <h3>Key Metrics (Last 30 Days)</h3>
            <p>Average Daily Active Users: <span class="metric-value">${engagement.averageDAU}</span></p>
            <p>Recent DAU Trend: <span class="metric-value ${parseFloat(engagement.dauTrend) > 0 ? 'positive' : 'negative'}">${engagement.dauTrend}%</span></p>
            <p>Total Unique Users: <span class="metric-value">${engagement.totalUniqueUsers}</span></p>
        </div>
        
        <h2>Key Insights & Recommendations</h2>
        ${insights.map(insight => `
            <div class="insight ${insight.type}">
                <strong>${insight.category}:</strong> ${insight.message}
                <br><em>Recommendation:</em> ${insight.recommendation}
            </div>
        `).join('')}
        
        <h2>User Segmentation</h2>
        <table>
            <tr>
                <th>Segment</th>
                <th>User Count</th>
                <th>Avg Hashrate</th>
                <th>Validity Rate</th>
                <th>Pending Balance</th>
            </tr>
            ${segments.map(s => `
                <tr>
                    <td>${s.user_segment}</td>
                    <td>${s.user_count}</td>
                    <td>${s.avg_hashrate?.toFixed(2) || 0}</td>
                    <td>${s.avg_validity_rate?.toFixed(2) || 0}%</td>
                    <td>${s.total_pending_balance?.toFixed(4) || 0}</td>
                </tr>
            `).join('')}
        </table>
        
        <h2>Retention Analysis</h2>
        <div class="metric-card">
            <h3>Average Retention Rates</h3>
            <p>Day 1: <span class="metric-value">${retention.averageRetention.day1}%</span></p>
            <p>Day 7: <span class="metric-value">${retention.averageRetention.day7}%</span></p>
            <p>Day 30: <span class="metric-value">${retention.averageRetention.day30}%</span></p>
        </div>
        
        <h2>Churn Risk Analysis</h2>
        <table>
            <tr>
                <th>Risk Level</th>
                <th>User Count</th>
                <th>Avg Hashrate</th>
                <th>Days Inactive</th>
            </tr>
            ${churnRisk.map(r => `
                <tr>
                    <td>${r.risk_level}</td>
                    <td>${r.user_count}</td>
                    <td>${r.avg_hashrate?.toFixed(2) || 0}</td>
                    <td>${r.avg_days_inactive?.toFixed(1) || 0}</td>
                </tr>
            `).join('')}
        </table>
        
        <h2>Feature Adoption</h2>
        <table>
            <tr>
                <th>Feature</th>
                <th>Unique Users</th>
                <th>Total Usage</th>
            </tr>
            ${features.map(f => `
                <tr>
                    <td>${f.feature}</td>
                    <td>${f.unique_users}</td>
                    <td>${f.usage_count}</td>
                </tr>
            `).join('')}
        </table>
        
        <h2>System Performance</h2>
        <table>
            <tr>
                <th>Endpoint</th>
                <th>Requests</th>
                <th>Avg Response (ms)</th>
                <th>Error Rate</th>
            </tr>
            ${performance.slice(0, 10).map(p => `
                <tr>
                    <td>${p.endpoint}</td>
                    <td>${p.request_count}</td>
                    <td class="${p.avg_response_time > 1000 ? 'warning' : ''}">${p.avg_response_time.toFixed(0)}</td>
                    <td class="${p.error_rate > 5 ? 'negative' : ''}">${p.error_rate}%</td>
                </tr>
            `).join('')}
        </table>
        
        <h2>Mining Activity Patterns</h2>
        <p>Peak mining hour: <strong>${patterns.peakHour}:00</strong></p>
        <p>This information can be used to schedule maintenance during low-activity periods.</p>
    </div>
</body>
</html>
    `;
    
    return html;
  }

  async saveReport(outputPath = './analytics_report.html') {
    const html = await this.generateHTMLReport();
    await fs.writeFile(outputPath, html);
    logger.info(`Report saved to ${outputPath}`);
  }
}

// Main execution
async function main() {
  const analytics = new UserBehaviorAnalytics();
  
  try {
    await analytics.initialize();
    
    // Generate and save report
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = `./analytics_report_${timestamp}.html`;
    await analytics.saveReport(reportPath);
    
    // Also generate insights summary
    const insights = await analytics.generateInsights();
    
    console.log('\n=== OTEDAMA MINING POOL - ANALYTICS INSIGHTS ===\n');
    
    insights.forEach(insight => {
      console.log(`[${insight.type.toUpperCase()}] ${insight.category}`);
      console.log(`  ${insight.message}`);
      console.log(`  → ${insight.recommendation}\n`);
    });
    
    console.log(`\nFull report saved to: ${reportPath}`);
    
  } catch (error) {
    logger.error('Failed to generate analytics report:', error);
  } finally {
    await analytics.close();
  }
}

// Run if called directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error);
}

export { UserBehaviorAnalytics };