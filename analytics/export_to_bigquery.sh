#!/bin/bash

# Otedama Mining Pool - BigQuery Data Export and Analysis Script
# This script exports SQLite data to BigQuery for advanced analytics

# Configuration
PROJECT_ID="${BIGQUERY_PROJECT_ID:-otedama-mining}"
DATASET_NAME="${BIGQUERY_DATASET:-mining_analytics}"
SQLITE_DB="../data/otedama.db"
TEMP_DIR="./temp_exports"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Otedama Mining Pool - BigQuery Analytics Export${NC}"
echo "================================================"

# Check if bq command is available
if ! command -v bq &> /dev/null; then
    echo -e "${RED}Error: BigQuery CLI (bq) is not installed${NC}"
    echo "Please install Google Cloud SDK: https://cloud.google.com/sdk/install"
    exit 1
fi

# Check if sqlite3 is available
if ! command -v sqlite3 &> /dev/null; then
    echo -e "${RED}Error: sqlite3 is not installed${NC}"
    exit 1
fi

# Create temp directory
mkdir -p "$TEMP_DIR"

# Function to export table to CSV
export_table_to_csv() {
    local table_name=$1
    local output_file="$TEMP_DIR/${table_name}.csv"
    
    echo -e "${YELLOW}Exporting $table_name...${NC}"
    
    # Export with headers
    sqlite3 -header -csv "$SQLITE_DB" "SELECT * FROM $table_name;" > "$output_file"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Exported $table_name successfully${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to export $table_name${NC}"
        return 1
    fi
}

# Function to create BigQuery dataset
create_bigquery_dataset() {
    echo -e "${YELLOW}Creating BigQuery dataset...${NC}"
    
    bq mk --dataset \
        --description "Otedama Mining Pool Analytics Dataset" \
        --location=US \
        "$PROJECT_ID:$DATASET_NAME"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Dataset created/verified${NC}"
    fi
}

# Function to upload table to BigQuery
upload_to_bigquery() {
    local table_name=$1
    local csv_file="$TEMP_DIR/${table_name}.csv"
    
    echo -e "${YELLOW}Uploading $table_name to BigQuery...${NC}"
    
    # Detect schema automatically and upload
    bq load \
        --autodetect \
        --source_format=CSV \
        --skip_leading_rows=1 \
        --replace \
        "$PROJECT_ID:$DATASET_NAME.$table_name" \
        "$csv_file"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Uploaded $table_name successfully${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to upload $table_name${NC}"
        return 1
    fi
}

# Main export process
echo -e "\n${YELLOW}Starting data export process...${NC}\n"

# Create dataset
create_bigquery_dataset

# List of tables to export
TABLES=(
    "miners"
    "shares"
    "transactions"
    "audit_logs"
    "performance_logs"
    "sessions"
    "api_keys"
    "pending_payouts"
    "orders"
    "trades"
)

# Export and upload each table
for table in "${TABLES[@]}"; do
    if export_table_to_csv "$table"; then
        upload_to_bigquery "$table"
    fi
    echo ""
done

# Create views for common queries
echo -e "\n${YELLOW}Creating BigQuery views for analytics...${NC}"

# Daily Active Users view
bq mk --use_legacy_sql=false --view \
"SELECT 
  DATE(TIMESTAMP_SECONDS(lastSeen)) as date,
  COUNT(DISTINCT id) as daily_active_users,
  SUM(hashrate) as total_hashrate,
  AVG(hashrate) as avg_hashrate
FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
WHERE lastSeen > UNIX_SECONDS(CURRENT_TIMESTAMP() - INTERVAL 30 DAY)
GROUP BY date
ORDER BY date DESC" \
"$PROJECT_ID:$DATASET_NAME.daily_active_users"

# User segments view
bq mk --use_legacy_sql=false --view \
"WITH user_stats AS (
  SELECT 
    id,
    address,
    hashrate,
    totalShares,
    validShares,
    SAFE_DIVIDE(validShares, totalShares) as validity_rate,
    DATE_DIFF(CURRENT_DATE(), DATE(TIMESTAMP_SECONDS(created)), DAY) as account_age_days,
    DATE_DIFF(CURRENT_DATE(), DATE(TIMESTAMP_SECONDS(lastSeen)), DAY) as days_inactive
  FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
)
SELECT 
  CASE 
    WHEN hashrate > (SELECT APPROX_QUANTILES(hashrate, 100)[OFFSET(90)] FROM user_stats)
      THEN 'Power Users'
    WHEN days_inactive > 30 THEN 'Dormant Users'
    WHEN account_age_days < 7 THEN 'New Users'
    ELSE 'Regular Users'
  END as user_segment,
  COUNT(*) as count,
  AVG(hashrate) as avg_hashrate,
  AVG(validity_rate) as avg_validity_rate
FROM user_stats
GROUP BY user_segment" \
"$PROJECT_ID:$DATASET_NAME.user_segments"

echo -e "${GREEN}✓ Views created successfully${NC}"

# Run analysis queries
echo -e "\n${YELLOW}Running analysis queries...${NC}\n"

# Query 1: User Growth Trend
echo "1. User Growth Trend (Last 30 Days)"
bq query --use_legacy_sql=false --format=pretty \
"SELECT 
  DATE(TIMESTAMP_SECONDS(created)) as signup_date,
  COUNT(*) as new_users,
  SUM(COUNT(*)) OVER (ORDER BY DATE(TIMESTAMP_SECONDS(created))) as cumulative_users
FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
WHERE created > UNIX_SECONDS(CURRENT_TIMESTAMP() - INTERVAL 30 DAY)
GROUP BY signup_date
ORDER BY signup_date DESC
LIMIT 10"

echo -e "\n2. Top Performing Miners"
bq query --use_legacy_sql=false --format=pretty \
"SELECT 
  address,
  hashrate,
  totalShares,
  validShares,
  ROUND(SAFE_DIVIDE(validShares, totalShares) * 100, 2) as validity_rate_percent,
  ROUND(balance, 4) as pending_balance
FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
ORDER BY hashrate DESC
LIMIT 10"

echo -e "\n3. Hourly Mining Activity Pattern"
bq query --use_legacy_sql=false --format=pretty \
"SELECT 
  EXTRACT(HOUR FROM TIMESTAMP_SECONDS(timestamp)) as hour_of_day,
  COUNT(*) as share_count,
  COUNT(DISTINCT miner_id) as active_miners,
  ROUND(AVG(difficulty), 2) as avg_difficulty
FROM \`$PROJECT_ID.$DATASET_NAME.shares\`
WHERE timestamp > UNIX_SECONDS(CURRENT_TIMESTAMP() - INTERVAL 7 DAY)
GROUP BY hour_of_day
ORDER BY hour_of_day"

# Generate report
echo -e "\n${YELLOW}Generating analytics report...${NC}"

REPORT_FILE="$TEMP_DIR/analytics_report_$(date +%Y%m%d_%H%M%S).txt"

cat > "$REPORT_FILE" << EOF
Otedama Mining Pool Analytics Report
Generated: $(date)
=====================================

EXECUTIVE SUMMARY
-----------------
$(bq query --use_legacy_sql=false --format=csv --max_rows=1 \
"SELECT 
  COUNT(DISTINCT id) as total_miners,
  ROUND(SUM(hashrate), 2) as total_hashrate,
  ROUND(AVG(hashrate), 2) as avg_hashrate
FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
WHERE lastSeen > UNIX_SECONDS(CURRENT_TIMESTAMP() - INTERVAL 7 DAY)")

USER ENGAGEMENT METRICS
-----------------------
$(bq query --use_legacy_sql=false --format=csv \
"SELECT 
  'DAU (7-day avg)' as metric,
  ROUND(AVG(user_count), 0) as value
FROM (
  SELECT DATE(TIMESTAMP_SECONDS(lastSeen)) as date, COUNT(DISTINCT id) as user_count
  FROM \`$PROJECT_ID.$DATASET_NAME.miners\`
  WHERE lastSeen > UNIX_SECONDS(CURRENT_TIMESTAMP() - INTERVAL 7 DAY)
  GROUP BY date
)")

RECOMMENDATIONS
---------------
1. Peak Usage Optimization: Schedule maintenance during low-activity hours
2. User Retention: Implement engagement campaigns for dormant users
3. Performance: Optimize for power users who contribute most hashrate
4. Feature Adoption: Promote underutilized features to increase engagement

For detailed analysis, run: bq query --use_legacy_sql=false < user_behavior_analysis.sql
EOF

echo -e "${GREEN}✓ Report generated: $REPORT_FILE${NC}"

# Cleanup option
echo -e "\n${YELLOW}Cleanup temporary files? (y/n)${NC}"
read -r cleanup
if [[ $cleanup =~ ^[Yy]$ ]]; then
    rm -rf "$TEMP_DIR"/*.csv
    echo -e "${GREEN}✓ Cleaned up temporary CSV files${NC}"
fi

echo -e "\n${GREEN}BigQuery export complete!${NC}"
echo "Dataset: $PROJECT_ID:$DATASET_NAME"
echo "You can now run advanced queries using the BigQuery console or CLI"