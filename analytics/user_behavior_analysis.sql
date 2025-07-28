-- Otedama Mining Pool User Behavior Analysis
-- This script analyzes user patterns, engagement metrics, and provides insights
-- for improving the mining pool system

-- ============================================================================
-- 1. USER ENGAGEMENT OVERVIEW
-- ============================================================================

-- Daily Active Users (DAU) and Monthly Active Users (MAU)
WITH user_activity AS (
  SELECT 
    DATE(TIMESTAMP_SECONDS(lastSeen)) as activity_date,
    id as miner_id,
    address,
    hashrate,
    totalShares,
    validShares
  FROM miners
  WHERE lastSeen > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)
),
daily_stats AS (
  SELECT 
    activity_date,
    COUNT(DISTINCT miner_id) as daily_active_users,
    SUM(hashrate) as total_daily_hashrate,
    AVG(hashrate) as avg_hashrate_per_user
  FROM user_activity
  GROUP BY activity_date
)
SELECT 
  activity_date,
  daily_active_users,
  total_daily_hashrate,
  avg_hashrate_per_user,
  -- Calculate 7-day moving average
  AVG(daily_active_users) OVER (
    ORDER BY activity_date 
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) as dau_7day_avg,
  -- Month-over-month growth
  LAG(daily_active_users, 30) OVER (ORDER BY activity_date) as users_30days_ago,
  SAFE_DIVIDE(
    daily_active_users - LAG(daily_active_users, 30) OVER (ORDER BY activity_date),
    LAG(daily_active_users, 30) OVER (ORDER BY activity_date)
  ) * 100 as mom_growth_rate
FROM daily_stats
ORDER BY activity_date DESC;

-- ============================================================================
-- 2. USER RETENTION ANALYSIS
-- ============================================================================

-- Cohort retention analysis
WITH user_cohorts AS (
  SELECT 
    id as miner_id,
    DATE(TIMESTAMP_SECONDS(created)) as cohort_date,
    DATE(TIMESTAMP_SECONDS(lastSeen)) as last_active_date
  FROM miners
),
cohort_activity AS (
  SELECT 
    cohort_date,
    DATE_DIFF(last_active_date, cohort_date, DAY) as days_since_signup,
    COUNT(DISTINCT miner_id) as active_users
  FROM user_cohorts
  GROUP BY cohort_date, days_since_signup
),
cohort_sizes AS (
  SELECT 
    cohort_date,
    COUNT(DISTINCT miner_id) as cohort_size
  FROM user_cohorts
  GROUP BY cohort_date
)
SELECT 
  ca.cohort_date,
  cs.cohort_size,
  ca.days_since_signup,
  ca.active_users,
  ROUND(ca.active_users / cs.cohort_size * 100, 2) as retention_rate
FROM cohort_activity ca
JOIN cohort_sizes cs ON ca.cohort_date = cs.cohort_date
WHERE ca.days_since_signup IN (1, 7, 14, 30, 60, 90)
ORDER BY ca.cohort_date DESC, ca.days_since_signup;

-- ============================================================================
-- 3. MINING PATTERNS AND EFFICIENCY
-- ============================================================================

-- User mining patterns by hour of day and day of week
WITH share_patterns AS (
  SELECT 
    s.miner_id,
    EXTRACT(HOUR FROM TIMESTAMP_SECONDS(s.timestamp)) as hour_of_day,
    EXTRACT(DAYOFWEEK FROM TIMESTAMP_SECONDS(s.timestamp)) as day_of_week,
    s.difficulty,
    s.valid,
    m.hashrate
  FROM shares s
  JOIN miners m ON s.miner_id = m.id
  WHERE s.timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)
)
SELECT 
  hour_of_day,
  day_of_week,
  COUNT(DISTINCT miner_id) as active_miners,
  COUNT(*) as total_shares,
  SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid_shares,
  ROUND(SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) / COUNT(*) * 100, 2) as validity_rate,
  AVG(difficulty) as avg_difficulty,
  SUM(difficulty * hashrate) / SUM(difficulty) as weighted_avg_hashrate
FROM share_patterns
GROUP BY hour_of_day, day_of_week
ORDER BY hour_of_day, day_of_week;

-- ============================================================================
-- 4. USER SEGMENTATION
-- ============================================================================

-- Segment users by performance and engagement
WITH user_metrics AS (
  SELECT 
    m.id as miner_id,
    m.address,
    m.hashrate,
    m.totalShares,
    m.validShares,
    m.balance,
    m.paid,
    SAFE_DIVIDE(m.validShares, m.totalShares) as validity_rate,
    DATE_DIFF(CURRENT_DATE, DATE(TIMESTAMP_SECONDS(m.created)), DAY) as account_age_days,
    DATE_DIFF(CURRENT_DATE, DATE(TIMESTAMP_SECONDS(m.lastSeen)), DAY) as days_since_active,
    -- Calculate share submission frequency
    SAFE_DIVIDE(m.totalShares, GREATEST(1, DATE_DIFF(
      DATE(TIMESTAMP_SECONDS(m.lastSeen)), 
      DATE(TIMESTAMP_SECONDS(m.created)), 
      DAY
    ))) as shares_per_day
  FROM miners m
  WHERE m.lastSeen > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 90 DAY)
)
SELECT 
  CASE 
    WHEN hashrate > (SELECT PERCENTILE_CONT(hashrate, 0.9) OVER() FROM user_metrics LIMIT 1) 
      THEN 'Power Users (Top 10%)'
    WHEN hashrate > (SELECT PERCENTILE_CONT(hashrate, 0.5) OVER() FROM user_metrics LIMIT 1)
      THEN 'Regular Users (50-90%)'
    WHEN days_since_active > 30 
      THEN 'Dormant Users'
    WHEN account_age_days < 7 
      THEN 'New Users'
    ELSE 'Casual Users'
  END as user_segment,
  COUNT(*) as user_count,
  AVG(hashrate) as avg_hashrate,
  AVG(validity_rate) * 100 as avg_validity_rate,
  AVG(shares_per_day) as avg_shares_per_day,
  SUM(balance) as total_pending_balance,
  SUM(paid) as total_paid_out
FROM user_metrics
GROUP BY user_segment
ORDER BY user_count DESC;

-- ============================================================================
-- 5. REVENUE AND PAYOUT ANALYSIS
-- ============================================================================

-- Transaction patterns and payment preferences
WITH transaction_analysis AS (
  SELECT 
    t.minerId,
    t.type,
    t.currency,
    t.amount,
    t.btcAmount,
    t.fee,
    t.status,
    DATE(TIMESTAMP_SECONDS(t.timestamp)) as transaction_date,
    m.hashrate,
    m.totalShares
  FROM transactions t
  JOIN miners m ON t.minerId = m.id
  WHERE t.timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)
)
SELECT 
  currency,
  COUNT(DISTINCT minerId) as unique_users,
  COUNT(*) as transaction_count,
  SUM(amount) as total_amount,
  AVG(amount) as avg_transaction_amount,
  SUM(fee) as total_fees_collected,
  AVG(fee) as avg_fee_per_transaction,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) / COUNT(*) * 100 as success_rate
FROM transaction_analysis
GROUP BY currency
ORDER BY transaction_count DESC;

-- ============================================================================
-- 6. PERFORMANCE BOTTLENECKS AND SYSTEM HEALTH
-- ============================================================================

-- API performance by endpoint
WITH api_performance AS (
  SELECT 
    action,
    responseTime,
    statusCode,
    DATE(TIMESTAMP_SECONDS(timestamp)) as request_date
  FROM performance_logs
  WHERE timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 7 DAY)
)
SELECT 
  action as api_endpoint,
  COUNT(*) as request_count,
  AVG(responseTime) as avg_response_time_ms,
  PERCENTILE_CONT(responseTime, 0.5) OVER (PARTITION BY action) as median_response_time,
  PERCENTILE_CONT(responseTime, 0.95) OVER (PARTITION BY action) as p95_response_time,
  PERCENTILE_CONT(responseTime, 0.99) OVER (PARTITION BY action) as p99_response_time,
  SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) / COUNT(*) * 100 as error_rate
FROM api_performance
GROUP BY action
HAVING COUNT(*) > 100  -- Only show endpoints with significant traffic
ORDER BY request_count DESC;

-- ============================================================================
-- 7. FEATURE ADOPTION AND USAGE
-- ============================================================================

-- Analyze adoption of different pool features
WITH feature_usage AS (
  SELECT 
    userId,
    action,
    resource,
    DATE(TIMESTAMP_SECONDS(timestamp)) as usage_date
  FROM audit_logs
  WHERE timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)
)
SELECT 
  CASE 
    WHEN action LIKE '%api%' THEN 'API Usage'
    WHEN action LIKE '%mobile%' THEN 'Mobile Access'
    WHEN action LIKE '%webhook%' THEN 'Webhook Integration'
    WHEN action LIKE '%2fa%' OR action LIKE '%auth%' THEN 'Security Features'
    WHEN resource LIKE '%solo%' THEN 'Solo Mining'
    WHEN resource LIKE '%multi-coin%' THEN 'Multi-coin Payouts'
    ELSE 'Standard Mining'
  END as feature_category,
  COUNT(DISTINCT userId) as unique_users,
  COUNT(*) as usage_count,
  COUNT(*) / COUNT(DISTINCT usage_date) as avg_daily_usage
FROM feature_usage
GROUP BY feature_category
ORDER BY unique_users DESC;

-- ============================================================================
-- 8. CHURN PREDICTION INDICATORS
-- ============================================================================

-- Identify users at risk of churning
WITH user_activity_trends AS (
  SELECT 
    m.id as miner_id,
    m.address,
    m.hashrate as current_hashrate,
    DATE_DIFF(CURRENT_DATE, DATE(TIMESTAMP_SECONDS(m.lastSeen)), DAY) as days_inactive,
    -- Calculate historical averages
    (SELECT AVG(difficulty) FROM shares WHERE miner_id = m.id 
     AND timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)) as avg_recent_difficulty,
    (SELECT AVG(difficulty) FROM shares WHERE miner_id = m.id 
     AND timestamp BETWEEN UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 60 DAY) 
     AND UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 30 DAY)) as avg_previous_difficulty,
    -- Share submission trends
    (SELECT COUNT(*) FROM shares WHERE miner_id = m.id 
     AND timestamp > UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 7 DAY)) as shares_last_7d,
    (SELECT COUNT(*) FROM shares WHERE miner_id = m.id 
     AND timestamp BETWEEN UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 14 DAY) 
     AND UNIX_TIMESTAMP(CURRENT_DATE - INTERVAL 7 DAY)) as shares_prev_7d
  FROM miners m
  WHERE m.totalShares > 100  -- Only analyze users with meaningful history
)
SELECT 
  CASE
    WHEN days_inactive > 7 THEN 'High Risk - Already Inactive'
    WHEN shares_last_7d < shares_prev_7d * 0.5 THEN 'High Risk - Declining Activity'
    WHEN avg_recent_difficulty < avg_previous_difficulty * 0.7 THEN 'Medium Risk - Reducing Effort'
    WHEN days_inactive > 3 THEN 'Medium Risk - Recent Inactivity'
    ELSE 'Low Risk - Active'
  END as churn_risk_level,
  COUNT(*) as user_count,
  AVG(current_hashrate) as avg_hashrate,
  AVG(days_inactive) as avg_days_inactive,
  AVG(SAFE_DIVIDE(shares_last_7d, GREATEST(1, shares_prev_7d))) as activity_trend_ratio
FROM user_activity_trends
GROUP BY churn_risk_level
ORDER BY 
  CASE churn_risk_level
    WHEN 'High Risk - Already Inactive' THEN 1
    WHEN 'High Risk - Declining Activity' THEN 2
    WHEN 'Medium Risk - Reducing Effort' THEN 3
    WHEN 'Medium Risk - Recent Inactivity' THEN 4
    ELSE 5
  END;

-- ============================================================================
-- 9. RECOMMENDATIONS SUMMARY
-- ============================================================================

-- Generate actionable insights based on the analysis
WITH insights AS (
  SELECT 'User Engagement' as category, 
    CONCAT('Average DAU in last 30 days: ', 
      CAST((SELECT AVG(daily_active_users) FROM daily_stats) AS STRING)) as insight
  UNION ALL
  SELECT 'Peak Usage Times' as category,
    CONCAT('Highest activity at hour ', 
      CAST((SELECT hour_of_day FROM share_patterns 
            GROUP BY hour_of_day 
            ORDER BY COUNT(*) DESC LIMIT 1) AS STRING)) as insight
  UNION ALL
  SELECT 'User Segments' as category,
    CONCAT('Power users represent ', 
      CAST((SELECT ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM miners), 2) 
            FROM user_metrics 
            WHERE hashrate > (SELECT PERCENTILE_CONT(hashrate, 0.9) OVER() 
                             FROM user_metrics LIMIT 1)) AS STRING), 
      '% of users') as insight
)
SELECT * FROM insights;