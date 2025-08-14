param(
    [string]$DocsPath = (Join-Path $PSScriptRoot "..\docs")
)

Write-Host "Scanning changelogs under: $DocsPath" -ForegroundColor Cyan

# Collect files like CHANGELOG.md, CHANGELOG_JA.md, CHANGELOG_TR.md, etc.
$files = Get-ChildItem -Path $DocsPath -Recurse -File -Include "CHANGELOG*.md"

if (-not $files -or $files.Count -eq 0) {
    Write-Host "No changelog files found." -ForegroundColor Yellow
    exit 0
}

$semverPattern = 'semver\.org'
# Headings with versions like: ## [2.1.6] - 2025-08-06 (any heading level >=2)
$versionHeadingPattern = '^(#{2,6})\s*\[[^\]]+\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$'
$versionHeadingReplacement = '$1 $2'
# Optional: normalize Unreleased heading (remove brackets only)
$unreleasedPattern = '^(#{2,6})\s*\[U?nreleased\]\s*$'
$unreleasedReplacement = '$1 Unreleased'

$changed = 0
foreach ($f in $files) {
    $orig = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    $c = $orig

    # Remove any line containing semver.org (any language)
    $c = ($c -split "\r?\n") | Where-Object { $_ -notmatch $semverPattern } | ForEach-Object { $_ } | Out-String
    # Out-String adds a trailing newline; trim once here
    $c = $c.TrimEnd()

    # Replace versioned headings with date-only
    $c = [regex]::Replace($c, $versionHeadingPattern, $versionHeadingReplacement, [System.Text.RegularExpressions.RegexOptions]::Multiline)

    # Normalize Unreleased heading brackets (optional)
    $c = [regex]::Replace($c, $unreleasedPattern, $unreleasedReplacement, [System.Text.RegularExpressions.RegexOptions]::Multiline)

    if ($c -ne $orig) {
        Set-Content -LiteralPath $f.FullName -Value $c -Encoding UTF8 -NoNewline
        Write-Host "Sanitized: $($f.FullName)" -ForegroundColor Green
        $changed++
    }
}

Write-Host "Done. Files updated: $changed" -ForegroundColor Cyan
