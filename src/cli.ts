#!/usr/bin/env node

/**
 * Otedama CLI Entry Point v2.1.0
 * 設計思想: John Carmack (実用的), Robert C. Martin (クリーン), Rob Pike (シンプル)
 */

const { quickStart, demoStart } = require('./dist/index');

async function main() {
  const args = process.argv.slice(2);
  
  console.log('🌟 Otedama v2.1.0 - World\'s First True Zero-Fee Mining Pool');
  console.log('🚀 Unified Mining System with AI Optimization\n');

  try {
    if (args.includes('--demo')) {
      console.log('🎮 Starting demo mode...');
      await demoStart();
    } else if (args.includes('--help') || args.includes('-h')) {
      showHelp();
    } else {
      console.log('⚡ Starting full mining system...');
      const options = parseArgs(args);
      await quickStart(options);
    }
  } catch (error) {
    console.error('❌ Failed to start Otedama:', error.message);
    process.exit(1);
  }
}

function parseArgs(args) {
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--lang':
      case '-l':
        options.language = args[++i];
        break;
      case '--no-setup':
        options.autoSetup = false;
        break;
      case '--electricity':
      case '-e':
        options.electricityCost = parseFloat(args[++i]);
        break;
      case '--algorithms':
      case '-a':
        options.algorithms = args[++i].split(',');
        break;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Usage: otedama [options]

Options:
  --demo              Start in demo mode (limited features)
  --lang, -l <code>   Set language (en, ja, zh-CN, es, etc.)
  --no-setup          Skip automatic setup
  --electricity, -e   Set electricity cost (USD/kWh)
  --algorithms, -a    Comma-separated algorithms (randomx,kawpow,ethash)
  --help, -h          Show this help

Examples:
  otedama                           # Start with auto-setup
  otedama --demo                    # Demo mode
  otedama --lang ja --no-setup      # Japanese, manual setup
  otedama -e 0.08 -a randomx,kawpow # Custom electricity and algorithms

Features:
  ✅ Zero-fee P2P mining pool
  ✅ Stratum V2 protocol (95% bandwidth reduction)
  ✅ AI optimization engine
  ✅ 100 languages support
  ✅ Hardware monitoring & safety
  ✅ Multi-pool management
  ✅ Enterprise security

For more information: https://github.com/otedama/mining-app
  `);
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs, showHelp };