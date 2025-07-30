# URL Update Summary

## Updated URLs

All references to the old repository URL have been updated to the correct one:
- Old: `https://github.com/otedama/otedama`
- New: `https://github.com/shizukutanaka/Otedama`

## Files Updated

### Documentation
- `README.md` - Updated all GitHub URLs and Docker Hub references
- `README_JP.md` - Updated all GitHub URLs and Docker Hub references
- `CHANGELOG.md` - Version updated to 2.0.0
- `CHANGELOG_JP.md` - Version updated to 2.0.0

### Code Files
- `go.mod` - Updated module path from `github.com/otedama/otedama` to `github.com/shizukutanaka/Otedama`
- All Go source files (*.go) - Updated import paths to use the new module path
- `version.go` - Updated to version 2.0.0

### Configuration Files
- `docker-compose.yml` - Updated Docker image to `shizukutanaka/otedama:2.0.0`
- `install.sh` - Updated Git clone URL

### Backup Files
- `_backup_unused_modules/main_old.go` - Updated website URL

## Docker Hub Reference
- Old: `otedama/otedama:2.0.0`
- New: `shizukutanaka/otedama:2.0.0`

## Valid External URLs Kept
- `https://golang.org` - Go language website
- `https://keepachangelog.com` - Changelog format reference
- `https://semver.org` - Semantic versioning reference
- `https://bitcoin.org/en/download` - Bitcoin Core download page

## Notes
- All localhost URLs (http://localhost:8080) were kept as they are valid for local development
- The version has been updated to 2.0.0 throughout all files
- Import paths in all Go files have been updated to use the new repository URL