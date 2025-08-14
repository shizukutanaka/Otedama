# PowerShell script to initialize the Otedama database

# Create data directory if it doesn't exist
$dataDir = "./data"
if (!(Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force
    Write-Host "Created data directory: $dataDir"
}

# Check if database file exists
$dbPath = "$dataDir/otedama.db"
if (!(Test-Path $dbPath)) {
    # Create empty database file
    New-Item -ItemType File -Path $dbPath -Force
    Write-Host "Created database file: $dbPath"
} else {
    Write-Host "Database file already exists: $dbPath"
}

Write-Host "Database initialization completed successfully!"
