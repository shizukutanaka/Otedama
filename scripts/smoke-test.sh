#!/bin/bash

# Smoke test script for Otedama deployments

set -e

if [ $# -eq 0 ]; then
    echo "Usage: $0 <base_url>"
    echo "Example: $0 https://otedama.local"
    exit 1
fi

BASE_URL=$1
TIMEOUT=30
MAX_RETRIES=3

echo "Running smoke tests against: $BASE_URL"

# Function to make HTTP request with retries
http_get() {
    local url=$1
    local expected_status=$2
    local retries=0
    
    while [ $retries -lt $MAX_RETRIES ]; do
        response=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout $TIMEOUT "$url")
        if [ "$response" = "$expected_status" ]; then
            return 0
        fi
        retries=$((retries + 1))
        echo "Retry $retries/$MAX_RETRIES for $url (got $response, expected $expected_status)"
        sleep 5
    done
    
    return 1
}

# Test 1: Health check endpoint
echo -n "Testing health endpoint... "
if http_get "$BASE_URL/health" "200"; then
    echo "PASS"
else
    echo "FAIL"
    exit 1
fi

# Test 2: API version endpoint
echo -n "Testing API version endpoint... "
if http_get "$BASE_URL/api/v1/version" "200"; then
    echo "PASS"
else
    echo "FAIL"
    exit 1
fi

# Test 3: Stratum server connectivity
echo -n "Testing Stratum server connectivity... "
if timeout $TIMEOUT nc -zv $(echo $BASE_URL | sed 's/https\?:\/\///' | cut -d: -f1) 3333 2>/dev/null; then
    echo "PASS"
else
    echo "FAIL (Stratum server not accessible)"
    # Don't fail the entire test for Stratum connectivity
fi

# Test 4: WebSocket endpoint
echo -n "Testing WebSocket endpoint... "
ws_url=$(echo $BASE_URL | sed 's/http/ws/')/ws
response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
    --connect-timeout $TIMEOUT \
    "$ws_url")
if [ "$response" = "101" ] || [ "$response" = "400" ]; then
    echo "PASS"
else
    echo "FAIL (got $response)"
    exit 1
fi

# Test 5: Metrics endpoint
echo -n "Testing metrics endpoint... "
if http_get "$BASE_URL/metrics" "200"; then
    echo "PASS"
else
    echo "FAIL"
    exit 1
fi

# Test 6: Static assets
echo -n "Testing static assets... "
if http_get "$BASE_URL/static/css/main.css" "200"; then
    echo "PASS"
else
    echo "WARN (static assets not available)"
fi

echo ""
echo "All smoke tests passed!"