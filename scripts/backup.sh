#!/bin/bash
# Otedama backup script

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/backup}"
S3_BUCKET="${BACKUP_S3_BUCKET:-otedama-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="otedama_backup_${TIMESTAMP}"

# Logging function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Error handling
error_exit() {
    log "ERROR: $1"
    exit 1
}

# Create backup directory
mkdir -p "${BACKUP_DIR}"

log "Starting Otedama backup process..."

# Backup database
if [ ! -z "${DATABASE_URL}" ]; then
    log "Backing up PostgreSQL database..."
    
    # Parse database URL
    DB_HOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\):.*/\1/p')
    DB_PORT=$(echo $DATABASE_URL | sed -n 's/.*:\([0-9]*\)\/.*/\1/p')
    DB_NAME=$(echo $DATABASE_URL | sed -n 's/.*\/\([^?]*\).*/\1/p')
    DB_USER=$(echo $DATABASE_URL | sed -n 's/.*:\/\/\([^:]*\):.*/\1/p')
    DB_PASS=$(echo $DATABASE_URL | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p')
    
    # Create database backup
    PGPASSWORD="${DB_PASS}" pg_dump \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --no-password \
        --verbose \
        --format=custom \
        --compress=9 \
        > "${BACKUP_DIR}/${BACKUP_NAME}_database.dump" \
        || error_exit "Database backup failed"
    
    log "Database backup completed successfully"
fi

# Backup configuration files
log "Backing up configuration files..."
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}_config.tar.gz" \
    -C /app \
    config/ \
    .env.production \
    2>/dev/null || true

# Backup logs (last 7 days)
log "Backing up recent logs..."
find /app/logs -name "*.log" -mtime -7 -print0 | \
    tar -czf "${BACKUP_DIR}/${BACKUP_NAME}_logs.tar.gz" \
    --null -T - 2>/dev/null || true

# Create backup manifest
cat > "${BACKUP_DIR}/${BACKUP_NAME}_manifest.json" <<EOF
{
    "timestamp": "${TIMESTAMP}",
    "version": "$(cat /app/VERSION 2>/dev/null || echo 'unknown')",
    "files": [
        "${BACKUP_NAME}_database.dump",
        "${BACKUP_NAME}_config.tar.gz",
        "${BACKUP_NAME}_logs.tar.gz"
    ],
    "size_bytes": $(du -cb ${BACKUP_DIR}/${BACKUP_NAME}_* | tail -1 | awk '{print $1}')
}
EOF

# Create compressed archive
log "Creating compressed backup archive..."
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
    -C "${BACKUP_DIR}" \
    "${BACKUP_NAME}_database.dump" \
    "${BACKUP_NAME}_config.tar.gz" \
    "${BACKUP_NAME}_logs.tar.gz" \
    "${BACKUP_NAME}_manifest.json" \
    || error_exit "Failed to create backup archive"

# Upload to S3 if configured
if [ ! -z "${AWS_ACCESS_KEY_ID}" ] && [ ! -z "${S3_BUCKET}" ]; then
    log "Uploading backup to S3..."
    
    aws s3 cp \
        "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
        "s3://${S3_BUCKET}/daily/${BACKUP_NAME}.tar.gz" \
        --storage-class STANDARD_IA \
        || error_exit "S3 upload failed"
    
    log "Backup uploaded to S3 successfully"
    
    # Clean up old S3 backups
    log "Cleaning up old S3 backups..."
    aws s3 ls "s3://${S3_BUCKET}/daily/" | \
        awk '{print $4}' | \
        while read -r file; do
            file_date=$(echo $file | grep -oP '\d{8}' | head -1)
            if [ ! -z "$file_date" ]; then
                file_timestamp=$(date -d "${file_date}" +%s 2>/dev/null || echo 0)
                cutoff_timestamp=$(date -d "${RETENTION_DAYS} days ago" +%s)
                
                if [ $file_timestamp -lt $cutoff_timestamp ] && [ $file_timestamp -gt 0 ]; then
                    log "Deleting old backup: $file"
                    aws s3 rm "s3://${S3_BUCKET}/daily/$file"
                fi
            fi
        done
fi

# Clean up local files
log "Cleaning up local backup files..."
rm -f "${BACKUP_DIR}/${BACKUP_NAME}_"*.{dump,tar.gz,json}

# Clean up old local backups
find "${BACKUP_DIR}" -name "otedama_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete

# Calculate backup size
BACKUP_SIZE=$(du -h "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" | cut -f1)
log "Backup completed successfully. Size: ${BACKUP_SIZE}"

# Send notification if webhook is configured
if [ ! -z "${BACKUP_WEBHOOK_URL}" ]; then
    curl -X POST "${BACKUP_WEBHOOK_URL}" \
        -H "Content-Type: application/json" \
        -d "{
            \"text\": \"Otedama backup completed\",
            \"timestamp\": \"${TIMESTAMP}\",
            \"size\": \"${BACKUP_SIZE}\",
            \"status\": \"success\"
        }" 2>/dev/null || true
fi

exit 0