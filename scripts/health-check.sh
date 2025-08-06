#!/bin/bash
# Otedama health check script

set -euo pipefail

# Configuration
API_URL="${API_URL:-http://localhost:8080}"
STRATUM_PORTS=(3333 3334 3335 3336 3337)
FEDERATION_PORT=4444
MAX_RETRIES=3
TIMEOUT=5

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Health status
HEALTH_STATUS="healthy"
HEALTH_ISSUES=()

# Check function with retries
check_endpoint() {
    local url=$1
    local description=$2
    local retries=0
    
    while [ $retries -lt $MAX_RETRIES ]; do
        if curl -sfS --max-time $TIMEOUT "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} $description"
            return 0
        fi
        retries=$((retries + 1))
        sleep 1
    done
    
    echo -e "${RED}✗${NC} $description"
    HEALTH_STATUS="unhealthy"
    HEALTH_ISSUES+=("$description failed")
    return 1
}

# Check TCP port
check_port() {
    local port=$1
    local description=$2
    
    if nc -z -w$TIMEOUT localhost $port 2>/dev/null; then
        echo -e "${GREEN}✓${NC} $description (port $port)"
        return 0
    else
        echo -e "${RED}✗${NC} $description (port $port)"
        HEALTH_STATUS="unhealthy"
        HEALTH_ISSUES+=("$description on port $port is not accessible")
        return 1
    fi
}

# Check process
check_process() {
    local process=$1
    local description=$2
    
    if pgrep -f "$process" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $description"
        return 0
    else
        echo -e "${RED}✗${NC} $description"
        HEALTH_STATUS="unhealthy"
        HEALTH_ISSUES+=("$description is not running")
        return 1
    fi
}

# Check disk space
check_disk_space() {
    local threshold=80
    local usage=$(df -h / | awk 'NR==2 {print int($5)}')
    
    if [ $usage -lt $threshold ]; then
        echo -e "${GREEN}✓${NC} Disk space: ${usage}% used"
        return 0
    else
        echo -e "${YELLOW}⚠${NC} Disk space: ${usage}% used (threshold: ${threshold}%)"
        if [ $usage -gt 90 ]; then
            HEALTH_STATUS="unhealthy"
            HEALTH_ISSUES+=("Disk space critical: ${usage}% used")
        fi
        return 1
    fi
}

# Check memory usage
check_memory() {
    local threshold=80
    local usage=$(free | awk 'NR==2 {print int($3/$2 * 100)}')
    
    if [ $usage -lt $threshold ]; then
        echo -e "${GREEN}✓${NC} Memory usage: ${usage}%"
        return 0
    else
        echo -e "${YELLOW}⚠${NC} Memory usage: ${usage}% (threshold: ${threshold}%)"
        if [ $usage -gt 90 ]; then
            HEALTH_STATUS="unhealthy"
            HEALTH_ISSUES+=("Memory usage critical: ${usage}%")
        fi
        return 1
    fi
}

# Main health checks
echo "======================================"
echo "Otedama Health Check Report"
echo "Time: $(date)"
echo "======================================"
echo

echo "API Endpoints:"
check_endpoint "${API_URL}/health" "Health endpoint"
check_endpoint "${API_URL}/ready" "Readiness endpoint"
check_endpoint "${API_URL}/api/v1/stats" "Stats API"
echo

echo "Stratum Servers:"
for port in "${STRATUM_PORTS[@]}"; do
    algo=""
    case $port in
        3333) algo="SHA256" ;;
        3334) algo="Ethash" ;;
        3335) algo="RandomX" ;;
        3336) algo="Scrypt" ;;
        3337) algo="KawPow" ;;
    esac
    check_port $port "Stratum server ($algo)"
done
echo

echo "Federation:"
check_port $FEDERATION_PORT "Federation port"
echo

echo "System Resources:"
check_disk_space
check_memory
echo

echo "Services:"
check_process "otedama" "Otedama main process"
check_process "postgres" "PostgreSQL database"
check_process "redis" "Redis cache"
echo

# Database connectivity
echo "Database:"
if PGPASSWORD="${DB_PASSWORD:-}" psql -h "${DB_HOST:-localhost}" -U "${DB_USER:-otedama}" -d "${DB_NAME:-otedama}" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} PostgreSQL connection"
else
    echo -e "${RED}✗${NC} PostgreSQL connection"
    HEALTH_STATUS="unhealthy"
    HEALTH_ISSUES+=("Database connection failed")
fi

# Redis connectivity
echo
echo "Cache:"
if redis-cli -h "${REDIS_HOST:-localhost}" ping > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Redis connection"
else
    echo -e "${RED}✗${NC} Redis connection"
    HEALTH_STATUS="unhealthy"
    HEALTH_ISSUES+=("Redis connection failed")
fi

# Summary
echo
echo "======================================"
echo "Health Status: $([ "$HEALTH_STATUS" = "healthy" ] && echo -e "${GREEN}HEALTHY${NC}" || echo -e "${RED}UNHEALTHY${NC}")"

if [ ${#HEALTH_ISSUES[@]} -gt 0 ]; then
    echo
    echo "Issues detected:"
    for issue in "${HEALTH_ISSUES[@]}"; do
        echo "  - $issue"
    done
fi

echo "======================================"

# Exit with appropriate code
[ "$HEALTH_STATUS" = "healthy" ] && exit 0 || exit 1