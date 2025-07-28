# Otedama Mining Pool - User Behavior Analytics

This analytics system provides comprehensive insights into user behavior patterns, engagement metrics, and system performance for the Otedama mining pool.

## Overview

The analytics system consists of three main components:

1. **SQL Analytics Queries** (`user_behavior_analysis.sql`) - Advanced SQL queries for deep analysis
2. **BigQuery Integration** (`export_to_bigquery.sh`) - Export and analyze data at scale
3. **Automated Report Generator** (`generate_insights_report.js`) - Generate HTML reports with insights

## Key Metrics Analyzed

### 1. User Engagement
- Daily Active Users (DAU) and Monthly Active Users (MAU)
- User growth trends and momentum
- Peak usage times and patterns
- Geographic distribution (if available)

### 2. User Retention
- Cohort-based retention analysis
- Day 1, 7, and 30 retention rates
- Churn prediction and risk assessment
- Re-engagement opportunities

### 3. Mining Performance
- Hashrate distribution across users
- Share submission patterns
- Mining efficiency by user segment
- Hardware utilization metrics

### 4. User Segmentation
- **Power Users**: Top 10% by hashrate contribution
- **Regular Users**: Consistent daily miners
- **New Users**: Accounts < 7 days old
- **Dormant Users**: Inactive > 30 days
- **Casual Users**: Intermittent activity

### 5. Feature Adoption
- API usage statistics
- Mobile app engagement
- Advanced features utilization
- Security feature adoption rates

### 6. System Performance
- API endpoint response times
- Error rates and bottlenecks
- Database query performance
- Real-time metrics processing

## Quick Start

### Generate Local Analytics Report

```bash
cd analytics
node generate_insights_report.js
```

This will create an HTML report with all key metrics and insights.

### Export to BigQuery (Advanced Analytics)

```bash
# Set up BigQuery credentials
export BIGQUERY_PROJECT_ID="your-project-id"
export BIGQUERY_DATASET="mining_analytics"

# Run export script
./export_to_bigquery.sh
```

### Run SQL Analytics Queries

```bash
# Using BigQuery
bq query --use_legacy_sql=false < user_behavior_analysis.sql

# Using SQLite (local)
sqlite3 ../data/otedama.db < user_behavior_analysis.sql
```

## Key Insights Generated

### 1. Growth Insights
- User acquisition trends
- Growth rate analysis
- Seasonal patterns

### 2. Retention Insights
- Identify factors affecting retention
- Cohort performance comparison
- Critical drop-off points

### 3. Performance Insights
- System bottlenecks
- Optimization opportunities
- Capacity planning data

### 4. Revenue Insights
- Payout patterns
- Fee optimization opportunities
- Currency preferences

### 5. Risk Insights
- Churn risk indicators
- Security concerns
- Performance degradation

## Actionable Recommendations

Based on the analysis, the system provides specific recommendations:

### For User Growth
1. **Optimize Onboarding**: Reduce friction in first-time setup
2. **Referral Programs**: Leverage power users for growth
3. **Geographic Expansion**: Target underserved regions

### For Retention
1. **Engagement Campaigns**: Target users showing declining activity
2. **Milestone Rewards**: Celebrate user achievements
3. **Personalized Communication**: Segment-specific messaging

### For Performance
1. **Infrastructure Scaling**: Based on peak usage patterns
2. **Feature Optimization**: Focus on high-impact features
3. **API Performance**: Cache frequently accessed data

### For Revenue
1. **Dynamic Fee Adjustment**: Based on market conditions
2. **Payout Optimization**: Reduce transaction costs
3. **Premium Features**: Monetize advanced capabilities

## Monitoring Dashboard Integration

The analytics can be integrated with existing monitoring:

```javascript
// In your monitoring dashboard
import { UserBehaviorAnalytics } from './analytics/generate_insights_report.js';

const analytics = new UserBehaviorAnalytics();
await analytics.initialize();

// Get real-time metrics
const engagement = await analytics.getUserEngagementMetrics();
const segments = await analytics.getUserSegmentation();
```

## Best Practices

1. **Regular Analysis**: Run reports weekly/monthly
2. **Track Trends**: Compare metrics over time
3. **A/B Testing**: Measure impact of changes
4. **Alert Setup**: Configure alerts for anomalies
5. **Data Privacy**: Ensure user privacy compliance

## Advanced Analytics

For more sophisticated analysis:

1. **Machine Learning**: Predict user lifetime value
2. **Anomaly Detection**: Identify unusual patterns
3. **Recommendation Engine**: Suggest optimal mining strategies
4. **Predictive Maintenance**: Anticipate system issues

## Data Schema

Key tables analyzed:

- `miners`: User accounts and statistics
- `shares`: Mining work submissions
- `transactions`: Financial transactions
- `audit_logs`: User actions and events
- `performance_logs`: System performance metrics

## Troubleshooting

Common issues and solutions:

1. **No data in report**: Check database connectivity
2. **Slow queries**: Add indexes on timestamp columns
3. **BigQuery errors**: Verify credentials and permissions
4. **Missing metrics**: Ensure data collection is active

## Future Enhancements

Planned improvements:

1. Real-time analytics dashboard
2. Mobile app analytics
3. Predictive analytics models
4. Automated insight generation
5. Integration with business intelligence tools

## Support

For questions or issues:
- Check logs in `analytics/logs/`
- Review SQL query documentation
- Contact support team

Remember: Good analytics drive better decisions!