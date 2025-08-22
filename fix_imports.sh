#!/bin/bash

# Fix incorrect imports in all Go files
find /mnt/c/Users/irosa/Desktop/Otedama -name "*.go" -type f -exec sed -i 's|github\.com/shizukutanaka/Otedama|github.com/otedama/otedama|g' {} \;

# Remove example.com URLs
find /mnt/c/Users/irosa/Desktop/Otedama -name "*.go" -type f -exec sed -i 's|stratum+tcp://pool\.example\.com:3333|stratum+tcp://localhost:3333|g' {} \;

echo "Fixed imports and URLs"