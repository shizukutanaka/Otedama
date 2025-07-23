/**
 * Setup Wizard
 * Interactive setup for beginners and advanced users
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs').promises;
const { createLogger } = require('../core/logger');
const crypto = require('crypto');
const AddressValidator = require('../security/address-validator');

const logger = createLogger('setup-wizard');

// Supported languages
const LANGUAGES = {
  en: 'English',
  ja: '日本語',
  zh: '中文',
  ko: '한국어'
};

// User experience levels
const EXPERIENCE_LEVELS = {
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced'
};

// Operation modes
const OPERATION_MODES = {
  STANDALONE: 'standalone',
  POOL: 'pool',
  MINER: 'miner'
};

class SetupWizard {
  constructor(options = {}) {
    this.options = {
      configPath: options.configPath || './config/otedama.json',
      language: options.language || 'en',
      ...options
    };
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    this.config = {
      language: this.options.language,
      experienceLevel: EXPERIENCE_LEVELS.BEGINNER,
      mode: OPERATION_MODES.STANDALONE,
      pool: {
        port: 3333,
        difficulty: 16,
        fee: 1.0, // 1% total (includes creator fee)
        minPayout: 0.001,
        payoutInterval: 3600000
      },
      api: {
        port: 8080,
        enabled: true
      },
      p2p: {
        port: 6633,
        maxPeers: 50
      },
      wallet: {
        address: '',
        paymentAddress: ''
      },
      blockchain: {
        url: 'http://localhost:8332',
        user: '',
        pass: ''
      },
      creator: {
        address: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa', // Fixed address
        feeEnabled: true,
        dynamicFees: true
      },
      security: {
        apiKey: this.generateApiKey(),
        twoFactorEnabled: false
      }
    };
    
    // Load translations
    this.translations = {};
    this.loadTranslations();
  }
  
  /**
   * Load translations
   */
  async loadTranslations() {
    try {
      for (const lang of Object.keys(LANGUAGES)) {
        const filePath = path.join(__dirname, '../i18n/locales', `${lang}.json`);
        const content = await fs.readFile(filePath, 'utf8');
        this.translations[lang] = JSON.parse(content);
      }
    } catch (error) {
      logger.error('Failed to load translations:', error);
    }
  }
  
  /**
   * Get translated text
   */
  t(key, params = {}) {
    const keys = key.split('.');
    let value = this.translations[this.config.language];
    
    for (const k of keys) {
      if (value && value[k]) {
        value = value[k];
      } else {
        return key; // Return key if translation not found
      }
    }
    
    // Replace parameters
    if (typeof value === 'string') {
      Object.keys(params).forEach(param => {
        value = value.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
      });
    }
    
    return value;
  }
  
  /**
   * Generate API key
   */
  generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  /**
   * Ask question
   */
  async ask(question, defaultValue = '') {
    return new Promise((resolve) => {
      const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
      this.rl.question(prompt, (answer) => {
        resolve(answer || defaultValue);
      });
    });
  }
  
  /**
   * Ask yes/no question
   */
  async askYesNo(question, defaultValue = true) {
    const defaultText = defaultValue ? 'Y/n' : 'y/N';
    const answer = await this.ask(`${question} (${defaultText})`, defaultValue ? 'y' : 'n');
    return answer.toLowerCase() === 'y';
  }
  
  /**
   * Ask multiple choice
   */
  async askChoice(question, choices, defaultIndex = 0) {
    console.log(`\n${question}`);
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. ${choice.label}`);
      if (choice.description) {
        console.log(`     ${choice.description}`);
      }
    });
    
    const answer = await this.ask('Select option', String(defaultIndex + 1));
    const index = parseInt(answer) - 1;
    
    if (index >= 0 && index < choices.length) {
      return choices[index].value;
    }
    
    return choices[defaultIndex].value;
  }
  
  /**
   * Display banner
   */
  displayBanner() {
    console.clear();
    console.log(`
    ╔═══════════════════════════════════════════╗
    ║                                           ║
    ║              OTEDAMA v0.1.8               ║
    ║                                           ║
    ║     P2P Mining Pool Software              ║
    ║     Simple, Efficient, Scalable           ║
    ║                                           ║
    ╚═══════════════════════════════════════════╝
    `);
  }
  
  /**
   * Select language
   */
  async selectLanguage() {
    console.log('\nSelect Language / 言語選択 / 选择语言 / 언어 선택\n');
    
    const choices = Object.entries(LANGUAGES).map(([value, label]) => ({
      value,
      label
    }));
    
    this.config.language = await this.askChoice('', choices, 0);
  }
  
  /**
   * Select experience level
   */
  async selectExperienceLevel() {
    const choices = [
      {
        value: EXPERIENCE_LEVELS.BEGINNER,
        label: this.t('setup.userLevel.beginner'),
        description: this.t('setup.userLevel.beginnerDesc')
      },
      {
        value: EXPERIENCE_LEVELS.INTERMEDIATE,
        label: this.t('setup.userLevel.intermediate'),
        description: this.t('setup.userLevel.intermediateDesc')
      },
      {
        value: EXPERIENCE_LEVELS.ADVANCED,
        label: this.t('setup.userLevel.advanced'),
        description: this.t('setup.userLevel.advancedDesc')
      }
    ];
    
    this.config.experienceLevel = await this.askChoice(
      this.t('setup.userLevel.title'),
      choices,
      0
    );
  }
  
  /**
   * Select operation mode
   */
  async selectOperationMode() {
    const choices = [
      {
        value: OPERATION_MODES.STANDALONE,
        label: this.t('setup.mode.standalone'),
        description: this.t('setup.mode.standaloneDesc')
      },
      {
        value: OPERATION_MODES.POOL,
        label: this.t('setup.mode.pool'),
        description: this.t('setup.mode.poolDesc')
      },
      {
        value: OPERATION_MODES.MINER,
        label: this.t('setup.mode.miner'),
        description: this.t('setup.mode.minerDesc')
      }
    ];
    
    this.config.mode = await this.askChoice(
      this.t('setup.mode.title'),
      choices,
      0
    );
  }
  
  /**
   * Configure wallet
   */
  async configureWallet() {
    console.log(`\n${this.t('setup.wallet.title')}\n`);
    
    // Bitcoin address for rewards
    this.config.wallet.address = await this.ask(
      this.t('setup.wallet.address'),
      ''
    );
    
    // Validate address
    if (this.config.wallet.address) {
      const isValid = this.validateBitcoinAddress(this.config.wallet.address);
      if (isValid) {
        console.log(`✓ ${this.t('setup.wallet.valid')}`);
      } else {
        console.log(`✗ ${this.t('setup.wallet.invalid')}`);
        this.config.wallet.address = '';
      }
    }
    
    // Payment address (optional)
    if (this.config.experienceLevel !== EXPERIENCE_LEVELS.BEGINNER) {
      const useCustomPayment = await this.askYesNo(
        'Use different address for payments?',
        false
      );
      
      if (useCustomPayment) {
        this.config.wallet.paymentAddress = await this.ask(
          'Payment Bitcoin address',
          ''
        );
      }
    }
  }
  
  /**
   * Configure pool connection
   */
  async configurePoolConnection() {
    if (this.config.mode !== OPERATION_MODES.MINER) return;
    
    console.log(`\n${this.t('setup.pool.title')}\n`);
    
    this.config.pool.address = await this.ask(
      this.t('setup.pool.address'),
      'pool.example.com:3333'
    );
  }
  
  /**
   * Configure blockchain
   */
  async configureBlockchain() {
    if (this.config.mode === OPERATION_MODES.MINER) return;
    
    console.log(`\n${this.t('setup.blockchain.title')}\n`);
    
    if (this.config.experienceLevel === EXPERIENCE_LEVELS.BEGINNER) {
      // Use defaults for beginners
      console.log('Using default blockchain settings...');
      return;
    }
    
    this.config.blockchain.url = await this.ask(
      this.t('setup.blockchain.nodeUrl'),
      this.config.blockchain.url
    );
    
    this.config.blockchain.user = await this.ask(
      this.t('setup.blockchain.rpcUser'),
      'user'
    );
    
    this.config.blockchain.pass = await this.ask(
      this.t('setup.blockchain.rpcPassword'),
      ''
    );
  }
  
  /**
   * Configure advanced settings
   */
  async configureAdvanced() {
    if (this.config.experienceLevel !== EXPERIENCE_LEVELS.ADVANCED) return;
    
    console.log('\n=== Advanced Settings ===\n');
    
    // Pool settings
    if (this.config.mode !== OPERATION_MODES.MINER) {
      this.config.pool.port = parseInt(await this.ask('Stratum port', '3333'));
      this.config.pool.difficulty = parseInt(await this.ask('Initial difficulty', '16'));
      this.config.pool.minPayout = parseFloat(await this.ask('Minimum payout (BTC)', '0.001'));
      
      // Fee configuration
      console.log('\n--- Fee Configuration ---');
      console.log('Otedama uses industry-lowest fees (0.3-0.9%)');
      console.log('Competitors average: 2-2.5%\n');
      
      this.config.pool.fee = parseFloat(await this.ask('Total pool fee (%)', '1.0'));
      this.config.creator.feeEnabled = await this.askYesNo('Enable creator fee?', true);
      this.config.creator.dynamicFees = await this.askYesNo('Enable dynamic fee adjustment?', true);
    }
    
    // API settings
    this.config.api.enabled = await this.askYesNo('Enable API?', true);
    if (this.config.api.enabled) {
      this.config.api.port = parseInt(await this.ask('API port', '8080'));
    }
    
    // P2P settings
    this.config.p2p.port = parseInt(await this.ask('P2P port', '6633'));
    this.config.p2p.maxPeers = parseInt(await this.ask('Max peers', '50'));
    
    // Security
    this.config.security.twoFactorEnabled = await this.askYesNo('Enable 2FA?', false);
  }
  
  /**
   * Validate Bitcoin address
   */
  validateBitcoinAddress(address) {
    // Basic validation for P2PKH, P2SH, and Bech32
    const patterns = [
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, // P2PKH, P2SH
      /^(bc1|tb1)[a-z0-9]{39,59}$/ // Bech32
    ];
    
    return patterns.some(pattern => pattern.test(address));
  }
  
  /**
   * Show summary
   */
  showSummary() {
    console.log('\n=== Configuration Summary ===\n');
    console.log(`Language: ${LANGUAGES[this.config.language]}`);
    console.log(`Experience Level: ${this.config.experienceLevel}`);
    console.log(`Operation Mode: ${this.config.mode}`);
    console.log(`Wallet Address: ${this.config.wallet.address || 'Not set'}`);
    
    if (this.config.mode !== OPERATION_MODES.MINER) {
      console.log(`\nPool Settings:`);
      console.log(`  Port: ${this.config.pool.port}`);
      console.log(`  Total Fee: ${this.config.pool.fee}%`);
      console.log(`  Min Payout: ${this.config.pool.minPayout} BTC`);
      
      if (this.config.creator.feeEnabled) {
        console.log(`  Creator Fee: 0.3-0.9% (dynamic)`);
        console.log(`  Competitor Average: 2-2.5%`);
        console.log(`  Your Savings: ~1.5-2%`);
      }
    }
    
    console.log(`\nAPI: ${this.config.api.enabled ? `Enabled (port ${this.config.api.port})` : 'Disabled'}`);
    console.log(`P2P: Port ${this.config.p2p.port}, Max ${this.config.p2p.maxPeers} peers`);
  }
  
  /**
   * Save configuration
   */
  async saveConfiguration() {
    try {
      const configDir = path.dirname(this.options.configPath);
      await fs.mkdir(configDir, { recursive: true });
      
      await fs.writeFile(
        this.options.configPath,
        JSON.stringify(this.config, null, 2)
      );
      
      console.log(`\n✓ Configuration saved to ${this.options.configPath}`);
    } catch (error) {
      console.error('Failed to save configuration:', error);
      throw error;
    }
  }
  
  /**
   * Create start script
   */
  async createStartScript() {
    const isWindows = process.platform === 'win32';
    const scriptName = isWindows ? 'start-otedama.bat' : 'start-otedama.sh';
    
    let scriptContent;
    
    if (isWindows) {
      scriptContent = `@echo off
cd /d "%~dp0"
node index.js --config "${this.options.configPath}" --mode ${this.config.mode}
pause`;
    } else {
      scriptContent = `#!/bin/bash
cd "$(dirname "$0")"
node index.js --config "${this.options.configPath}" --mode ${this.config.mode}`;
    }
    
    await fs.writeFile(scriptName, scriptContent);
    
    if (!isWindows) {
      const { chmod } = require('fs').promises;
      await chmod(scriptName, '755');
    }
    
    console.log(`✓ Start script created: ${scriptName}`);
  }
  
  /**
   * Run setup wizard
   */
  async run() {
    try {
      // Validate creator address first
      AddressValidator.enforce(this.config.creator.address);
      
      // Display banner
      this.displayBanner();
      
      // Select language
      await this.selectLanguage();
      
      // Welcome message
      console.log(`\n${this.t('setup.welcome')}`);
      console.log(this.t('setup.subtitle'));
      
      // Select experience level
      await this.selectExperienceLevel();
      
      // Select operation mode
      await this.selectOperationMode();
      
      // Configure wallet
      await this.configureWallet();
      
      // Configure pool connection (for miners)
      await this.configurePoolConnection();
      
      // Configure blockchain (for pool/standalone)
      await this.configureBlockchain();
      
      // Advanced settings
      await this.configureAdvanced();
      
      // Show summary
      this.showSummary();
      
      // Confirm
      const proceed = await this.askYesNo('\nSave configuration and create start script?', true);
      
      if (proceed) {
        await this.saveConfiguration();
        await this.createStartScript();
        
        console.log(`\n${this.t('setup.complete.title')}`);
        console.log(this.t('setup.complete.message'));
        console.log(`\nTo start mining, run: ${process.platform === 'win32' ? 'start-otedama.bat' : './start-otedama.sh'}`);
      } else {
        console.log('\nSetup cancelled.');
      }
      
    } catch (error) {
      console.error('\nSetup failed:', error);
    } finally {
      this.rl.close();
    }
  }
}

// Run if called directly
if (require.main === module) {
  const wizard = new SetupWizard();
  wizard.run();
}

module.exports = SetupWizard;