#!/bin/sh
set -e

# Otedama Docker Entrypoint Script
# Handles configuration and initialization for containerized deployment

# Function to log messages
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Check if config file exists, if not create from example
if [ ! -f "${OTEDAMA_CONFIG_PATH:-/app/config/config.yaml}" ]; then
    if [ -f "/app/config/config.example.yaml" ]; then
        log "Creating config from example..."
        cp /app/config/config.example.yaml "${OTEDAMA_CONFIG_PATH:-/app/config/config.yaml}"
    else
        log "Warning: No configuration file found"
    fi
fi

# Create necessary directories
mkdir -p "${OTEDAMA_DATA_PATH:-/app/data}"
mkdir -p "${OTEDAMA_LOG_PATH:-/app/logs}"

# Wait for database if configured
if [ -n "$DATABASE_URL" ]; then
    log "Waiting for database..."
    for i in $(seq 1 30); do
        if /app/otedama health --database 2>/dev/null; then
            log "Database is ready"
            break
        fi
        if [ $i -eq 30 ]; then
            log "Error: Database connection timeout"
            exit 1
        fi
        sleep 2
    done
fi

# Run database migrations if requested
if [ "$RUN_MIGRATIONS" = "true" ] && [ -n "$DATABASE_URL" ]; then
    log "Running database migrations..."
    /app/otedama migrate up
fi

# Handle different commands
case "$1" in
    start)
        log "Starting Otedama..."
        exec /app/otedama serve \
            --config "${OTEDAMA_CONFIG_PATH:-/app/config/config.yaml}" \
            --log-level "${OTEDAMA_LOG_LEVEL:-info}"
        ;;
    
    worker)
        log "Starting Otedama worker..."
        exec /app/otedama worker \
            --config "${OTEDAMA_CONFIG_PATH:-/app/config/config.yaml}"
        ;;
    
    migrate)
        log "Running migrations..."
        exec /app/otedama migrate "$@"
        ;;
    
    backup)
        log "Running backup..."
        exec /app/otedama backup "$@"
        ;;
    
    sh|bash)
        exec "$@"
        ;;
    
    *)
        exec /app/otedama "$@"
        ;;
esac