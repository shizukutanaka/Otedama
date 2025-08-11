#!/bin/bash
# Simple build check script

echo "Checking Go installation..."
if command -v go &> /dev/null; then
    echo "Go found at: $(which go)"
    go version
else
    echo "Go not found in PATH, trying /usr/local/go/bin/go"
    if [ -f /usr/local/go/bin/go ]; then
        /usr/local/go/bin/go version
        GO_CMD="/usr/local/go/bin/go"
    else
        echo "Go not found at /usr/local/go/bin/go either"
        echo "Trying Windows Go installation..."
        if [ -f "/mnt/c/Program Files/Go/bin/go.exe" ]; then
            "/mnt/c/Program Files/Go/bin/go.exe" version
            GO_CMD="/mnt/c/Program Files/Go/bin/go.exe"
        else
            echo "ERROR: Go installation not found"
            exit 1
        fi
    fi
fi

# Set Go command if not already set
GO_CMD=${GO_CMD:-go}

echo ""
echo "Building Otedama..."
cd /mnt/c/Users/irosa/Desktop/Otedama
"$GO_CMD" build -o otedama.exe ./cmd/otedama

if [ $? -eq 0 ]; then
    echo "Build successful!"
    ls -la otedama.exe
else
    echo "Build failed. Checking for errors..."
    "$GO_CMD" build ./cmd/otedama 2>&1 | head -50
fi