# PowerShell script to test the Otedama database integration

Write-Host "Testing Otedama Database Integration..." -ForegroundColor Green

# Check if data directory exists
if (Test-Path "./data") {
    Write-Host "✓ Data directory exists" -ForegroundColor Green
} else {
    Write-Host "✗ Data directory does not exist" -ForegroundColor Red
}

# Check if database file exists
if (Test-Path "./data/otedama.db") {
    Write-Host "✓ Database file exists" -ForegroundColor Green
} else {
    Write-Host "✗ Database file does not exist" -ForegroundColor Red
}

# Check if documentation exists
if (Test-Path "./docs/database.md") {
    Write-Host "✓ Database documentation exists" -ForegroundColor Green
} else {
    Write-Host "✗ Database documentation does not exist" -ForegroundColor Red
}

# Check if database components exist
$components = @(
    "./internal/database/config.go",
    "./internal/database/manager.go",
    "./internal/database/repository.go",
    "./internal/database/worker_repository.go",
    "./internal/database/share_repository.go",
    "./internal/database/block_repository.go",
    "./internal/database/payout_repository.go",
    "./internal/database/factory.go",
    "./internal/database/init.go",
    "./internal/database/migrate.go",
    "./internal/database/service.go",
    "./cmd/dbtest/main.go"
)

$allExist = $true
foreach ($component in $components) {
    if (Test-Path $component) {
        Write-Host "✓ $component exists" -ForegroundColor Green
    } else {
        Write-Host "✗ $component does not exist" -ForegroundColor Red
        $allExist = $false
    }
}

if ($allExist) {
    Write-Host "✓ All database components are present" -ForegroundColor Green
} else {
    Write-Host "✗ Some database components are missing" -ForegroundColor Red
}

Write-Host "Database integration test completed." -ForegroundColor Green
