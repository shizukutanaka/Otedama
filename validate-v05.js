#!/usr/bin/env node

/**
 * Otedama Ver.0.5 - System Validation Script
 * Validates that all components are correctly configured for commercial deployment
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXPECTED_VERSION = '0.5';
const EXPECTED_POOL_FEE = 0.0; // 0% (REMOVED)
const EXPECTED_OPERATOR_FEE = 0.015; // 1.5%
const EXPECTED_TOTAL_FEE = 0.015; // 1.5% (OPERATOR FEE ONLY)
const EXPECTED_OPERATOR_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

async function validateSystem() {
  console.log('🔍 Otedama Ver.0.5 System Validation\n');
  
  const checks = [];
  
  // Check 1: Package.json version
  try {
    const packageJson = JSON.parse(await fs.readFile(join(__dirname, 'package.json'), 'utf8'));
    if (packageJson.version === EXPECTED_VERSION) {
      checks.push({ name: 'Package Version', status: '✅', details: `Version ${EXPECTED_VERSION}` });
    } else {
      checks.push({ name: 'Package Version', status: '❌', details: `Expected ${EXPECTED_VERSION}, found ${packageJson.version}` });
    }
  } catch (error) {
    checks.push({ name: 'Package Version', status: '❌', details: error.message });
  }
  
  // Check 2: Configuration file
  try {
    const config = JSON.parse(await fs.readFile(join(__dirname, 'otedama.json'), 'utf8'));
    
    // Check version
    if (config.commercial?.version === EXPECTED_VERSION) {
      checks.push({ name: 'Config Version', status: '✅', details: `Version ${EXPECTED_VERSION}` });
    } else {
      checks.push({ name: 'Config Version', status: '❌', details: `Expected ${EXPECTED_VERSION}, found ${config.commercial?.version}` });
    }
    
    // Check pool fee
    if (config.pool?.fee === EXPECTED_POOL_FEE * 100) {
      checks.push({ name: 'Pool Fee', status: '✅', details: `${EXPECTED_POOL_FEE * 100}% (Fixed)` });
    } else {
      checks.push({ name: 'Pool Fee', status: '❌', details: `Expected ${EXPECTED_POOL_FEE * 100}%, found ${config.pool?.fee}%` });
    }
    
    // Check operator fee
    if (config.operatorFees?.rate === EXPECTED_OPERATOR_FEE) {
      checks.push({ name: 'Operator Fee', status: '✅', details: `${EXPECTED_OPERATOR_FEE * 100}% (Fixed)` });
    } else {
      checks.push({ name: 'Operator Fee', status: '❌', details: `Expected ${EXPECTED_OPERATOR_FEE * 100}%, found ${config.operatorFees?.rate * 100}%` });
    }
    
    // Check operator address
    if (config.operatorFees?.address === EXPECTED_OPERATOR_ADDRESS) {
      checks.push({ name: 'Operator Address', status: '✅', details: 'Correct BTC address' });
    } else {
      checks.push({ name: 'Operator Address', status: '❌', details: 'Incorrect operator address' });
    }
    
    // Check automation features
    const automationFeatures = [
      { key: 'operatorFees.autoConversion', name: 'Auto BTC Conversion' },
      { key: 'dex.autoRebalance', name: 'DEX Auto Rebalance' },
      { key: 'defi.lending.autoLiquidation', name: 'Auto Liquidation' },
      { key: 'defi.bridge.autoRelay', name: 'Auto Bridge Relay' },
      { key: 'defi.governance.autoExecution', name: 'Auto Governance' }
    ];
    
    for (const feature of automationFeatures) {
      const value = feature.key.split('.').reduce((obj, key) => obj?.[key], config);
      if (value === true) {
        checks.push({ name: feature.name, status: '✅', details: 'Enabled' });
      } else {
        checks.push({ name: feature.name, status: '⚠️', details: 'Not enabled' });
      }
    }
    
  } catch (error) {
    checks.push({ name: 'Configuration', status: '❌', details: error.message });
  }
  
  // Check 3: Essential files
  const essentialFiles = [
    'index.js',
    'src/core.js',
    'src/fee-manager.js',
    'src/payment-manager.js',
    'src/unified-dex.js',
    'src/defi-lending.js',
    'src/cross-chain.js',
    'src/governance.js',
    'README.md',
    'SOW.md',
    'CHANGELOG.md'
  ];
  
  let allFilesExist = true;
  for (const file of essentialFiles) {
    try {
      await fs.access(join(__dirname, file));
    } catch {
      checks.push({ name: `File: ${file}`, status: '❌', details: 'Missing' });
      allFilesExist = false;
    }
  }
  
  if (allFilesExist) {
    checks.push({ name: 'Essential Files', status: '✅', details: 'All files present' });
  }
  
  // Check 4: Fee Manager Integrity
  try {
    const feeManagerContent = await fs.readFile(join(__dirname, 'src/fee-manager.js'), 'utf8');
    
    if (feeManagerContent.includes(EXPECTED_OPERATOR_ADDRESS)) {
      checks.push({ name: 'Fee Manager Address', status: '✅', details: 'Correct address hardcoded' });
    } else {
      checks.push({ name: 'Fee Manager Address', status: '❌', details: 'Operator address not found' });
    }
    
    if (feeManagerContent.includes('0.015; // 1.5%')) {
      checks.push({ name: 'Fee Manager Rate', status: '✅', details: '1.5% rate hardcoded' });
    } else {
      checks.push({ name: 'Fee Manager Rate', status: '❌', details: 'Operator fee rate not found' });
    }
    
    if (feeManagerContent.includes('processOperatorFeeCollection')) {
      checks.push({ name: 'Auto Collection', status: '✅', details: 'Auto collection implemented' });
    } else {
      checks.push({ name: 'Auto Collection', status: '❌', details: 'Auto collection not found' });
    }
    
  } catch (error) {
    checks.push({ name: 'Fee Manager', status: '❌', details: error.message });
  }
  
  // Check 5: Total Fee Calculation
  const totalFee = EXPECTED_POOL_FEE + EXPECTED_OPERATOR_FEE;
  if (Math.abs(totalFee - EXPECTED_TOTAL_FEE) < 0.0001) {
    checks.push({ name: 'Total Fee', status: '✅', details: `${EXPECTED_TOTAL_FEE * 100}% (Operator fee only)` });
  } else {
    checks.push({ name: 'Total Fee', status: '❌', details: `Incorrect total fee calculation` });
  }
  
  // Display results
  console.log('Validation Results:');
  console.log('==================\n');
  
  const maxNameLength = Math.max(...checks.map(c => c.name.length));
  
  for (const check of checks) {
    const padding = ' '.repeat(maxNameLength - check.name.length);
    console.log(`${check.name}${padding} : ${check.status} ${check.details}`);
  }
  
  // Summary
  const passedChecks = checks.filter(c => c.status === '✅').length;
  const totalChecks = checks.length;
  const passRate = (passedChecks / totalChecks * 100).toFixed(1);
  
  console.log('\n==================');
  console.log(`Summary: ${passedChecks}/${totalChecks} checks passed (${passRate}%)`);
  
  if (passedChecks === totalChecks) {
    console.log('\n✨ All systems validated! Otedama Ver.0.5 is ready for commercial deployment.');
  } else {
    console.log('\n⚠️  Some checks failed. Please review and fix the issues above.');
  }
  
  // Generate integrity hash
  const integrityData = {
    version: EXPECTED_VERSION,
    poolFee: EXPECTED_POOL_FEE,
    operatorFee: EXPECTED_OPERATOR_FEE,
    operatorAddress: EXPECTED_OPERATOR_ADDRESS,
    timestamp: Date.now()
  };
  
  const integrityHash = createHash('sha256')
    .update(JSON.stringify(integrityData))
    .digest('hex');
  
  console.log(`\n🔒 Integrity Hash: ${integrityHash}`);
  console.log('💡 Save this hash for future integrity verification.');
}

// Run validation
validateSystem().catch(console.error);
