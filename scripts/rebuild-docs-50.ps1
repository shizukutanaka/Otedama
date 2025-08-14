param(
    [string]$DocsRoot = (Join-Path $PSScriptRoot "..\docs"),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Ok($msg)   { Write-Host "[OK]  $msg" -ForegroundColor Green }

# Define the 50 language codes (lowercase ISO 639-1 where possible)
# en is the source reference and will be preserved.
$languages = @(
  'en','ja','zh','ko','de','fr','es','it','pt','ru',
  'nl','sv','no','da','fi','pl','cs','sk','sl','ro',
  'hu','bg','uk','el','tr','ar','he','fa','hi','bn',
  'ur','ta','te','ml','mr','th','vi','id','ms','tl',
  'sr','hr','lt','lv','et','az','ka','kk','ne','si'
)

$docsEn = Join-Path $DocsRoot 'en'
if (-not (Test-Path -LiteralPath $docsEn)) {
  throw "English reference docs not found at: $docsEn"
}

$multiEn = Join-Path (Join-Path $DocsRoot 'multilingual') 'en'

Info "Docs root: $DocsRoot"
Info "English reference: $docsEn"
if (Test-Path -LiteralPath $multiEn) { Info "Found multilingual English extras: $multiEn" }

# 1) Remove all non-English language directories under docs/
$existingLangDirs = Get-ChildItem -Path $DocsRoot -Directory -Force | Where-Object {
  $_.Name -in $languages -and $_.Name -ne 'en'
}

foreach ($dir in $existingLangDirs) {
  if ($DryRun) { Warn "Would remove: $($dir.FullName)" }
  else {
    Remove-Item -LiteralPath $dir.FullName -Recurse -Force
    Ok "Removed: $($dir.FullName)"
  }
}

# Remove deprecated trees if present
$deprecated = @(
  (Join-Path $DocsRoot 'usage'),
  (Join-Path $DocsRoot 'multilingual')
)
foreach ($p in $deprecated) {
  if (Test-Path -LiteralPath $p) {
    if ($DryRun) { Warn "Would remove deprecated: $p" }
    else { Remove-Item -LiteralPath $p -Recurse -Force; Ok "Removed deprecated: $p" }
  }
}

# 2) Recreate language directories and copy English reference
foreach ($lang in $languages) {
  if ($lang -eq 'en') { continue }
  $target = Join-Path $DocsRoot $lang
  if ($DryRun) {
    Warn "Would create: $target"
    Warn "Would copy from: $docsEn -> $target"
    if (Test-Path -LiteralPath $multiEn) { Warn "Would copy extras: $multiEn -> $target" }
    continue
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path (Join-Path $docsEn '*') -Destination $target -Recurse -Force
  if (Test-Path -LiteralPath $multiEn) {
    Copy-Item -Path (Join-Path $multiEn '*') -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
  }
  Ok "Rebuilt: $lang"
}

# 3) Summary
Ok ("Languages rebuilt: " + ($languages -ne 'en' | Where-Object { $_ }).Count)
Info "Done. Verify no version numbers and URLs comply with policy."
