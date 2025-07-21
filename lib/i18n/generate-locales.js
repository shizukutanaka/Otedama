/**
 * Generate locale files for all 50 supported languages
 * This creates placeholder files with basic structure
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Base template for new locale files
const baseTemplate = {
  app: {
    name: "Otedama",
    description: "P2P Mining Pool & DeFi Platform",
    version: "Version {{version}}"
  },
  common: {
    loading: "Loading...",
    error: "Error",
    success: "Success",
    confirm: "Confirm",
    cancel: "Cancel",
    save: "Save",
    close: "Close"
  },
  mining: {
    title: "Mining",
    hashrate: "Hashrate",
    shares: "Shares",
    blocks: "Blocks"
  },
  dex: {
    title: "DEX",
    buy: "Buy",
    sell: "Sell",
    swap: "Swap"
  },
  wallet: {
    balance: "Balance",
    send: "Send",
    receive: "Receive"
  }
};

async function generateLocaleFiles() {
  const localesDir = join(__dirname, 'locales');
  
  // Ensure locales directory exists
  await mkdir(localesDir, { recursive: true });
  
  // Skip languages we've already created detailed translations for
  const existingLanguages = ['en', 'ja', 'zh'];
  
  for (const lang of SUPPORTED_LANGUAGES) {
    if (existingLanguages.includes(lang)) {
      console.log(`Skipping ${lang} - already exists with full translations`);
      continue;
    }
    
    const filePath = join(localesDir, `${lang}.json`);
    
    // Create a copy of base template with language name
    const localeData = JSON.parse(JSON.stringify(baseTemplate));
    localeData.language = {
      code: lang,
      name: LANGUAGE_NAMES[lang] || lang.toUpperCase(),
      direction: ['ar', 'he', 'fa', 'ur'].includes(lang) ? 'rtl' : 'ltr'
    };
    
    // Add a note that this needs translation
    localeData._note = `This file needs translation to ${LANGUAGE_NAMES[lang]}`;
    
    await writeFile(filePath, JSON.stringify(localeData, null, 2));
    console.log(`Generated placeholder for ${lang} (${LANGUAGE_NAMES[lang]})`);
  }
  
  console.log(`\nGenerated ${SUPPORTED_LANGUAGES.length - existingLanguages.length} placeholder locale files`);
  console.log('Full translations exist for:', existingLanguages.join(', '));
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateLocaleFiles().catch(console.error);
}

export default generateLocaleFiles;