/**
 * Test Runner for Otedama
 * Runs all test suites and provides comprehensive coverage reporting
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Test configuration
const testConfig = {
  timeout: 10000,
  recursive: true,
  reporter: 'spec',
  colors: true
};

// Test files to run
const testFiles = [
  'test/crypto-utils.test.js',
  'test/comprehensive-validator.test.js',
  'test/optimized-order-book.test.js',
  'test/enhanced-rate-limiter.test.js'
];

/**
 * Run tests with Mocha
 */
async function runTests() {
  console.log('🚀 Starting Otedama Test Suite...\n');

  // Check if test files exist
  const missingFiles = testFiles.filter(file => !existsSync(join(projectRoot, file)));
  if (missingFiles.length > 0) {
    console.error('❌ Missing test files:');
    missingFiles.forEach(file => console.error(`   ${file}`));
    process.exit(1);
  }

  // Build Mocha command
  const mochaArgs = [
    '--timeout', testConfig.timeout.toString(),
    '--reporter', testConfig.reporter,
    '--experimental-loader', './test/esm-loader.js',
    ...testFiles
  ];

  if (testConfig.colors) {
    mochaArgs.push('--colors');
  }

  console.log('📋 Running tests:');
  testFiles.forEach(file => console.log(`   ✓ ${file}`));
  console.log('');

  return new Promise((resolve, reject) => {
    const mocha = spawn('npx', ['mocha', ...mochaArgs], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    mocha.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ All tests passed!');
        resolve(code);
      } else {
        console.log('\n❌ Some tests failed.');
        resolve(code);
      }
    });

    mocha.on('error', (error) => {
      console.error('\n❌ Error running tests:', error.message);
      reject(error);
    });
  });
}

/**
 * Run specific test file
 */
async function runSpecificTest(testFile) {
  if (!testFile) {
    console.error('❌ Please specify a test file to run');
    process.exit(1);
  }

  const fullPath = testFile.startsWith('test/') ? testFile : `test/${testFile}`;
  
  if (!existsSync(join(projectRoot, fullPath))) {
    console.error(`❌ Test file not found: ${fullPath}`);
    process.exit(1);
  }

  console.log(`🎯 Running specific test: ${fullPath}\n`);

  const mochaArgs = [
    '--timeout', testConfig.timeout.toString(),
    '--reporter', testConfig.reporter,
    '--experimental-loader', './test/esm-loader.js',
    '--colors',
    fullPath
  ];

  return new Promise((resolve, reject) => {
    const mocha = spawn('npx', ['mocha', ...mochaArgs], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    mocha.on('close', resolve);
    mocha.on('error', reject);
  });
}

/**
 * Run tests with coverage
 */
async function runWithCoverage() {
  console.log('📊 Running tests with coverage...\n');

  const c8Args = [
    '--reporter', 'text',
    '--reporter', 'html',
    '--reporter', 'json',
    '--exclude', 'test/**',
    '--exclude', 'node_modules/**',
    '--exclude', 'coverage/**',
    'npx', 'mocha',
    '--timeout', testConfig.timeout.toString(),
    '--experimental-loader', './test/esm-loader.js',
    ...testFiles
  ];

  return new Promise((resolve, reject) => {
    const c8 = spawn('npx', ['c8', ...c8Args], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    c8.on('close', (code) => {
      if (code === 0) {
        console.log('\n📊 Coverage report generated in ./coverage/');
      }
      resolve(code);
    });

    c8.on('error', reject);
  });
}

/**
 * Watch mode for continuous testing
 */
async function runWatchMode() {
  console.log('👀 Running tests in watch mode...\n');
  console.log('Press Ctrl+C to stop\n');

  const mochaArgs = [
    '--watch',
    '--timeout', testConfig.timeout.toString(),
    '--reporter', testConfig.reporter,
    '--experimental-loader', './test/esm-loader.js',
    '--colors',
    ...testFiles
  ];

  return new Promise((resolve, reject) => {
    const mocha = spawn('npx', ['mocha', ...mochaArgs], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    mocha.on('close', resolve);
    mocha.on('error', reject);

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      console.log('\n\n👋 Stopping test watcher...');
      mocha.kill('SIGTERM');
      process.exit(0);
    });
  });
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    let exitCode = 0;

    switch (command) {
      case 'coverage':
        exitCode = await runWithCoverage();
        break;
      case 'watch':
        exitCode = await runWatchMode();
        break;
      case 'file':
        exitCode = await runSpecificTest(args[1]);
        break;
      case '--help':
      case 'help':
        console.log('Otedama Test Runner');
        console.log('');
        console.log('Usage:');
        console.log('  node test/test-runner.js              Run all tests');
        console.log('  node test/test-runner.js coverage     Run tests with coverage');
        console.log('  node test/test-runner.js watch        Run tests in watch mode');
        console.log('  node test/test-runner.js file <name>  Run specific test file');
        console.log('  node test/test-runner.js help         Show this help');
        console.log('');
        console.log('Examples:');
        console.log('  node test/test-runner.js file crypto-utils.test.js');
        console.log('  node test/test-runner.js coverage');
        break;
      default:
        exitCode = await runTests();
        break;
    }

    process.exit(exitCode);
  } catch (error) {
    console.error('\n💥 Test runner error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { runTests, runSpecificTest, runWithCoverage, runWatchMode };