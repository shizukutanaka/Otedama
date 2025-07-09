#!/bin/bash
# Simple health monitoring script

API_URL="http://localhost:8080/api"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo "Otedama Light - Health Monitor"
echo "=============================="

while true; do
    clear
    echo "Otedama Light - Health Monitor"
    echo "=============================="
    echo "Time: $(date)"
    echo ""
    
    # Check API health
    if curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo -e "API Status: ${GREEN}✓ HEALTHY${NC}"
        
        # Get pool stats
        STATS=$(curl -s "${API_URL}/stats")
        if [ $? -eq 0 ]; then
            echo ""
            echo "Pool Statistics:"
            echo "---------------"
            echo "$STATS" | jq -r '.data | "Active Miners: \(.activeMiners)\nTotal Hashrate: \(.totalHashrate)\nTotal Shares: \(.totalShares)\nBlocks Found: \(.blocksFound)"'
        fi
    else
        echo -e "API Status: ${RED}✗ UNREACHABLE${NC}"
    fi
    
    # Check Stratum port
    echo ""
    if nc -z localhost 3333 2>/dev/null; then
        echo -e "Stratum Port: ${GREEN}✓ OPEN${NC}"
    else
        echo -e "Stratum Port: ${RED}✗ CLOSED${NC}"
    fi
    
    # Check memory usage
    echo ""
    echo "System Resources:"
    echo "----------------"
    free -h | grep Mem | awk '{print "Memory: " $3 " / " $2 " (" int($3/$2 * 100) "%)"}'
    
    # Check disk usage for data directory
    if [ -d "./data" ]; then
        DISK_USAGE=$(du -sh ./data 2>/dev/null | cut -f1)
        echo "Data Directory: $DISK_USAGE"
    fi
    
    echo ""
    echo "Press Ctrl+C to exit"
    sleep 5
done
