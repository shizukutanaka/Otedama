# Cleans up documentation URLs across usage READMEs and generator script
# - Replaces github.com/otedama/otedama -> github.com/shizukutanaka/Otedama
# - Replaces https://docs.otedama.io -> ../README.md
# - Replaces wget GitHub release install -> bash ./scripts/install.sh
# - Removes chmod line for otedama-linux-amd64

$ErrorActionPreference = 'Stop'

function Update-File {
    param(
        [string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $orig = Get-Content -LiteralPath $Path -Raw
    $updated = $orig

    # Canonical GitHub repo
    $updated = $updated -replace 'https://github\.com/otedama/otedama', 'https://github.com/shizukutanaka/Otedama'

    # Docs site -> local docs index (from docs/usage -> docs)
    $updated = $updated -replace 'https://docs\.otedama\.io', '../README.md'

    # Install lines
    $updated = $updated -replace '(?mi)^\s*wget\s+https://github\.com/otedama/releases/latest/otedama-linux-amd64\s*$', 'bash ./scripts/install.sh'
    $updated = $updated -replace '(?mi)^\s*chmod \+x otedama-linux-amd64\s*$', ''
    # Normalize pool URL examples to localhost
    $updated = $updated -replace 'stratum\+tcp://pool\.example\.com:3333', 'stratum+tcp://127.0.0.1:3333'
    # Replace node*.example.com to localhost (preserve optional port)
    $updated = $updated -replace 'node[0-9]+\.example\.com(:[0-9]+)?', '127.0.0.1$1'
    # Replace any subdomain of example.com to localhost (preserve optional port)
    $updated = $updated -replace '[A-Za-z0-9\.-]+\.example\.com(:[0-9]+)?', '127.0.0.1$1'
    # Replace example.com emails with local domain
    $updated = $updated -replace '@example\.com', '@otedama.local'

    # Remove Semantic Versioning lines in any language (lines containing semver.org)
    $updated = $updated -replace '(?mi)^.*semver\.org[^\r\n]*$', ''

    # Convert versioned changelog headings like "## [1.2.3] - 2025-08-06" to date-only "## 2025-08-06"
    $updated = $updated -replace '(?m)^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})\s*$', '## $1'

    # Collapse excessive blank lines created by removals
    $updated = $updated -replace '(?m)^(?:\s*\r?\n){3,}', "`r`n`r`n"

    if ($updated -ne $orig) {
        Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
        Write-Host "Updated: $Path"
    }
}

try {
    $repoRoot = Split-Path -Parent $PSScriptRoot

    # Update all usage READMEs
    $usageDir = Join-Path $repoRoot 'docs/usage'
    if (Test-Path -LiteralPath $usageDir) {
        Get-ChildItem -LiteralPath $usageDir -Filter '*.md' -File | ForEach-Object {
            Update-File -Path $_.FullName
        }
    }

    # Update generator script
    $generator = Join-Path $usageDir 'generate_remaining_docs.sh'
    Update-File -Path $generator

    # Also sanitize all docs subdirectories (e.g., docs/ja/*.md)
    $docsRoot = Join-Path $repoRoot 'docs'
    if (Test-Path -LiteralPath $docsRoot) {
        Get-ChildItem -LiteralPath $docsRoot -Directory | ForEach-Object {
            Get-ChildItem -LiteralPath $_.FullName -Filter '*.md' -File | ForEach-Object {
                Update-File -Path $_.FullName
            }
        }
    }

    Write-Host 'Documentation URL cleanup complete.'
}
catch {
    Write-Error $_
    exit 1
}
