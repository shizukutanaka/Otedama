#!/usr/bin/env pwsh
<#
.SYNOPSIS
    PowerShell script to resolve Go module dependency issues for Otedama mining software
.DESCRIPTION
    This script systematically resolves Go module dependency issues, cleans up the go.mod file,
    and ensures all dependencies are properly resolved for Windows environments.
.AUTHOR
    Otedama Development Team
#>

param(
    [switch]$Force,
    [switch]$Verbose,
    [string]$GoVersion = "1.23"
)

# Set error handling
$ErrorActionPreference = "Stop"

# Colors for output
$Colors = @{
    Success = "Green"
    Warning = "Yellow"
    Error = "Red"
    Info = "Cyan"
}

function Write-Status {
    param(
        [string]$Message,
        [string]$Type = "Info"
    )
    
    $color = $Colors[$Type]
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $Message" -ForegroundColor $color
}

function Test-GoInstallation {
    try {
        $goVersion = go version
        Write-Status "Go installation detected: $goVersion" "Success"
        return $true
    } catch {
        Write-Status "Go installation not found. Please install Go from https://golang.org/dl/" "Error"
        return $false
    }
}

function Clear-GoCache {
    Write-Status "Clearing Go module cache..." "Info"
    try {
        go clean -modcache
        go clean -cache
        go clean -testcache
        Write-Status "Go cache cleared successfully" "Success"
    } catch {
        Write-Status "Error clearing Go cache: $_" "Warning"
    }
}

function Repair-GoMod {
    Write-Status "Repairing go.mod file..." "Info"
    
    $goModPath = "..\go.mod"
    if (Test-Path $goModPath) {
        Write-Status "Backing up original go.mod..." "Info"
        Copy-Item $goModPath "$goModPath.backup" -Force
        
        Write-Status "Running go mod tidy..." "Info"
        go mod tidy -compat=$GoVersion
        
        Write-Status "Verifying module integrity..." "Info"
        go mod verify
        
        Write-Status "Downloading missing dependencies..." "Info"
        go mod download
        
        Write-Status "Validating module structure..." "Info"
        go list -m all
        
        Write-Status "go.mod repair completed successfully" "Success"
    } else {
        Write-Status "go.mod file not found at $goModPath" "Error"
    }
}

function Test-Build {
    Write-Status "Testing build process..." "Info"
    try {
        Write-Status "Building all packages..." "Info"
        go build -v ./...
        
        Write-Status "Running go vet..." "Info"
        go vet ./...
        
        Write-Status "Testing packages..." "Info"
        go test -v ./...
        
        Write-Status "Build test completed successfully" "Success"
    } catch {
        Write-Status "Build test failed: $_" "Error"
        throw
    }
}

function Resolve-ImportPaths {
    Write-Status "Resolving import path issues..." "Info"
    
    # Check for common import path issues
    $importIssues = @()
    
    # Scan for problematic imports
    $files = Get-ChildItem -Path "..\internal" -Recurse -Filter "*.go" | Select-Object -First 10
    
    foreach ($file in $files) {
        $content = Get-Content $file.FullName -Raw
        if ($content -match "github\.com/otedama/otedama") {
            $importIssues += "Found legacy import path in $($file.FullName)"
        }
    }
    
    if ($importIssues.Count -gt 0) {
        Write-Status "Found import path issues:" "Warning"
        $importIssues | ForEach-Object { Write-Status $_ "Warning" }
    } else {
        Write-Status "No import path issues detected" "Success"
    }
}

function Generate-BuildReport {
    Write-Status "Generating build report..." "Info"
    
    $report = @{
        Timestamp = Get-Date
        GoVersion = go version
        ModuleStatus = go list -m all
        BuildStatus = "Unknown"
    }
    
    try {
        go build -v ./... 2>&1 | Out-Null
        $report.BuildStatus = "Success"
    } catch {
        $report.BuildStatus = "Failed"
    }
    
    $reportPath = "..\build\dependency-report.json"
    $report | ConvertTo-Json -Depth 3 | Out-File $reportPath -Encoding UTF8
    
    Write-Status "Build report saved to $reportPath" "Success"
}

function Main {
    Write-Status "Starting Otedama dependency resolution..." "Info"
    Write-Status "Target Go version: $GoVersion" "Info"
    
    # Check Go installation
    if (-not (Test-GoInstallation)) {
        exit 1
    }
    
    # Create build directory
    if (-not (Test-Path "..\build")) {
        New-Item -ItemType Directory -Path "..\build" -Force | Out-Null
    }
    
    # Clear cache if forced
    if ($Force) {
        Clear-GoCache
    }
    
    # Resolve dependencies
    Repair-GoMod
    Resolve-ImportPaths
    
    # Test build
    try {
        Test-Build
    } catch {
        Write-Status "Build failed, but dependencies are resolved. Check build report for details." "Warning"
    }
    
    # Generate report
    Generate-BuildReport
    
    Write-Status "Dependency resolution completed!" "Success"
    Write-Status "Next steps:"
    Write-Status "1. Review build report in build/dependency-report.json"
    Write-Status "2. Run 'go run cmd/otedama/main.go' to test the application"
    Write-Status "3. Check Makefile for additional build targets"
}

# Execute main function
Main
