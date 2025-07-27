/**
 * Dependency Update Script
 * Updates outdated dependencies safely
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('🔄 Starting dependency update process...\n');

// Backup package.json
const packageJsonPath = path.join(process.cwd(), 'package.json');
const packageJsonBackup = path.join(process.cwd(), 'package.json.backup');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

fs.copyFileSync(packageJsonPath, packageJsonBackup);
console.log('✅ Backed up package.json\n');

// Dependencies to update with specific versions
const updates = {
  // Production dependencies - conservative updates
  'better-sqlite3': '^11.0.0', // Major update but stable
  'commander': '^12.0.0', // One major version up for stability
  'dotenv': '^16.4.0', // Stay on v16 for compatibility
  'express': '^4.19.0', // Stay on v4 for stability
  'prom-client': '^15.1.0', // Minor update
  'rate-limiter-flexible': '^5.0.0', // Conservative update
  
  // Dev dependencies - can be more aggressive
  '@types/node': '^20.11.0', // Match Node.js requirement
  'eslint': '^8.57.0', // Stay on v8 for plugin compatibility
  'jest': '^29.7.0', // Keep current
  'prettier': '^3.2.0', // Minor update
  'typescript': '^5.4.0' // Minor update
};

console.log('📦 Updating dependencies...\n');

// Update each dependency
for (const [dep, version] of Object.entries(updates)) {
  try {
    const isDev = packageJson.devDependencies && packageJson.devDependencies[dep];
    const flag = isDev ? '--save-dev' : '--save';
    
    console.log(`Updating ${dep} to ${version}...`);
    execSync(`npm install ${dep}@${version} ${flag}`, { stdio: 'inherit' });
    console.log(`✅ ${dep} updated successfully\n`);
  } catch (error) {
    console.error(`❌ Failed to update ${dep}: ${error.message}\n`);
  }
}

console.log('🔍 Running npm audit...\n');
try {
  execSync('npm audit', { stdio: 'inherit' });
} catch (error) {
  console.log('⚠️  Some vulnerabilities found. Run "npm audit fix" to resolve.\n');
}

console.log('✅ Dependency update complete!\n');
console.log('📋 Next steps:');
console.log('1. Run "npm test" to ensure everything works');
console.log('2. If tests fail, restore with: cp package.json.backup package.json && npm install');
console.log('3. Run "npm audit fix" if vulnerabilities were found');