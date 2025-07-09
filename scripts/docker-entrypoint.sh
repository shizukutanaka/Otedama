#!/bin/sh
# Docker entrypoint script for Otedama Pool
# Handles initialization, configuration validation, and graceful startup

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

error() {
    echo "${RED}[ERROR]${NC} $1" >&2
}

warn() {
    echo "${YELLOW}[WARN]${NC} $1"
}

success() {
    echo "${GREEN}[SUCCESS]${NC} $1"
}

# Wait for dependencies
wait_for_service() {
    local host=$1
    local port=$2
    local service_name=$3
    local timeout=${4:-30}
    
    log "Waiting for ${service_name} at ${host}:${port}..."
    
    for i in $(seq 1 $timeout); do
        if nc -z "$host" "$port" 2>/dev/null; then
            success "${service_name} is ready"
            return 0
        fi
        sleep 1
    done
    
    error "${service_name} is not available after ${timeout} seconds"
    return 1
}

# Validate environment
validate_environment() {
    log "Validating environment configuration..."
    
    # Required environment variables
    local required_vars="POOL_ADDRESS RPC_URL RPC_USER RPC_PASSWORD"
    
    for var in $required_vars; do
        if [ -z "$(eval echo \$$var)" ]; then
            error "Required environment variable $var is not set"
            exit 1
        fi
    done
    
    # Validate Bitcoin address format (basic check)
    if ! echo "$POOL_ADDRESS" | grep -qE '^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$'; then
        error "Invalid Bitcoin address format: $POOL_ADDRESS"
        exit 1
    fi
    
    success "Environment validation passed"
}

# Setup CPU affinity if enabled
setup_cpu_affinity() {
    if [ "$CPU_AFFINITY_ENABLED" = "true" ]; then
        log "Setting up CPU affinity..."
        
        # Get available CPU cores
        local cpu_count=$(nproc)
        local pool_cores=$((cpu_count / 2))
        
        if [ $pool_cores -lt 1 ]; then
            pool_cores=1
        fi
        
        # Set CPU affinity for the pool process
        export UV_THREADPOOL_SIZE=$pool_cores
        export NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=$(($(free -m | awk 'NR==2{print $2}') * 3 / 4))"
        
        success "CPU affinity configured: $pool_cores cores allocated"
    fi
}

# Wait for dependencies if in production mode
wait_for_dependencies() {
    if [ "$NODE_ENV" = "production" ]; then
        if [ -n "$REDIS_HOST" ]; then
            wait_for_service "$REDIS_HOST" "${REDIS_PORT:-6379}" "Redis"
        fi
        
        if [ -n "$POSTGRES_HOST" ]; then
            wait_for_service "$POSTGRES_HOST" "${POSTGRES_PORT:-5432}" "PostgreSQL"
        fi
        
        if [ -n "$BITCOIN_RPC_HOST" ]; then
            wait_for_service "$BITCOIN_RPC_HOST" "${BITCOIN_RPC_PORT:-8332}" "Bitcoin Node"
        fi
    fi
}

# Initialize data directories
setup_directories() {
    log "Setting up data directories..."
    
    mkdir -p /app/data/shares
    mkdir -p /app/data/miners
    mkdir -p /app/data/blocks
    mkdir -p /app/logs
    mkdir -p /app/backups
    
    # Set proper permissions
    chmod 755 /app/data /app/logs /app/backups
    chmod 750 /app/data/shares /app/data/miners /app/data/blocks
    
    success "Data directories created"
}

# Generate configuration if not exists
generate_config() {
    if [ ! -f "/app/.env" ] && [ ! -f "/app/config/pool.json" ]; then
        log "Generating default configuration..."
        
        cat > /app/.env << EOF
# Generated configuration for Otedama Pool
NODE_ENV=${NODE_ENV:-production}

# Pool Configuration
POOL_ADDRESS=${POOL_ADDRESS}
POOL_FEE=${POOL_FEE:-1.0}
STRATUM_PORT=${STRATUM_PORT:-3333}
API_PORT=${API_PORT:-8080}
DASHBOARD_PORT=${DASHBOARD_PORT:-8081}

# Bitcoin Node Configuration
RPC_URL=${RPC_URL}
RPC_USER=${RPC_USER}
RPC_PASSWORD=${RPC_PASSWORD}

# Performance Settings
ENABLE_PARALLEL_VALIDATION=${ENABLE_PARALLEL_VALIDATION:-true}
PARALLEL_WORKERS=${PARALLEL_WORKERS:-4}
CPU_AFFINITY_ENABLED=${CPU_AFFINITY_ENABLED:-false}

# Security Settings
SSL_ENABLED=${SSL_ENABLED:-false}
AUTH_ENABLED=${AUTH_ENABLED:-true}
DDOS_PROTECTION=${DDOS_PROTECTION:-true}

# Database Configuration
DB_TYPE=${DB_TYPE:-sqlite}
REDIS_HOST=${REDIS_HOST:-}
REDIS_PORT=${REDIS_PORT:-6379}

# Monitoring
MONITORING_ENABLED=${MONITORING_ENABLED:-true}
DASHBOARD_ENABLED=${DASHBOARD_ENABLED:-true}
API_ENABLED=${API_ENABLED:-true}

# Backup
BACKUP_ENABLED=${BACKUP_ENABLED:-true}
BACKUP_INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:-24}
EOF
        
        success "Configuration file generated"
    fi
}

# Handle graceful shutdown
cleanup() {
    log "Received shutdown signal, initiating graceful shutdown..."
    
    if [ -n "$POOL_PID" ]; then
        kill -TERM "$POOL_PID" 2>/dev/null || true
        wait "$POOL_PID" 2>/dev/null || true
    fi
    
    success "Graceful shutdown completed"
    exit 0
}

# Set up signal handlers
trap cleanup TERM INT

# Main initialization
main() {
    log "Starting Otedama Pool initialization..."
    
    validate_environment
    setup_directories
    generate_config
    setup_cpu_affinity
    wait_for_dependencies
    
    log "Initialization completed, starting pool..."
    
    # Start the pool process
    exec "$@" &
    POOL_PID=$!
    
    # Wait for the pool process
    wait $POOL_PID
}

# Run main function with all arguments
main "$@"
