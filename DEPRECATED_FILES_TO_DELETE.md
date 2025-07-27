# Deprecated Files to Delete

The following files have been identified as duplicates or deprecated and should be deleted manually:

## Bilingual Markdown Files (Already Consolidated)
- `docs/MINER-ADDRESS-SETUP.ja.md` - Consolidated into `docs/MINER-ADDRESS-SETUP.md`
- `DONATE.ja.md` - Consolidated into `DONATE.md`
- `README-SETUP.ja.md` - Consolidated into `README-SETUP.md`
- `README.ja.md` - Keep this as main Japanese README is separate from English

## Deprecated Library Files
- `lib/dex/dex-engine.js` - Replaced by unified system
- `lib/dex/engine-v2.js` - Replaced by unified system
- `lib/security/csrf-protection.js` - Replaced by `csrf-protection-unified.js`
- `lib/security/csrf-and-signing.js` - Replaced by `csrf-protection-unified.js`
- `lib/zkp/zero-knowledge-auth.js` - Replaced by `unified-zkp-system.js`
- `lib/zkp/enhanced-zkp-system.js` - Replaced by `unified-zkp-system.js`
- `lib/zkp/zkp-compliance.js` - Replaced by `unified-zkp-system.js`

## Commands to Delete Files

### Windows (PowerShell)
```powershell
Remove-Item "docs\MINER-ADDRESS-SETUP.ja.md"
Remove-Item "DONATE.ja.md"
Remove-Item "README-SETUP.ja.md"
Remove-Item "lib\dex\dex-engine.js"
Remove-Item "lib\dex\engine-v2.js"
Remove-Item "lib\security\csrf-protection.js"
Remove-Item "lib\security\csrf-and-signing.js"
Remove-Item "lib\zkp\zero-knowledge-auth.js"
Remove-Item "lib\zkp\enhanced-zkp-system.js"
Remove-Item "lib\zkp\zkp-compliance.js"
```

### Linux/macOS (Bash)
```bash
rm docs/MINER-ADDRESS-SETUP.ja.md
rm DONATE.ja.md
rm README-SETUP.ja.md
rm lib/dex/dex-engine.js
rm lib/dex/engine-v2.js
rm lib/security/csrf-protection.js
rm lib/security/csrf-and-signing.js
rm lib/zkp/zero-knowledge-auth.js
rm lib/zkp/enhanced-zkp-system.js
rm lib/zkp/zkp-compliance.js
```

## Notes
- These files have been replaced by unified/consolidated versions
- The consolidated files contain both English and Japanese content
- No functionality has been lost - all content has been preserved in the new files