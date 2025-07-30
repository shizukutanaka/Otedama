#!/bin/bash

# Cleanup script - Remove unnecessary complex directories
# Following Rob Pike's simplicity principles

echo "Cleaning up unnecessary directories..."

# List of directories to remove (keeping only essential ones)
DIRS_TO_REMOVE=(
    "agents"
    "analytics" 
    "automation"
    "backup"
    "blockchain"
    "currency"
    "database"
    "datastructures"
    "distributed"
    "failover"
    "logging"
    "middleware"
    "monitoring"
    "network"
    "optimization"
    "privacy"
    "security"
    "storage"
    "stratum"
)

cd "C:\Users\irosa\Desktop\Otedama\internal" || exit

for dir in "${DIRS_TO_REMOVE[@]}"; do
    if [ -d "$dir" ]; then
        echo "Removing directory: $dir"
        rm -rf "$dir"
    fi
done

echo "Cleanup completed. Remaining essential directories:"
ls -la
