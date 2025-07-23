/**
 * Multilingual Demo
 * Demonstrates Otedama's support for 100+ languages
 */

const { LanguageManager, SUPPORTED_LANGUAGES } = require('../lib/i18n/language-manager');

async function demonstrateLanguages() {
  console.log('=================================================');
  console.log('     Otedama - 100 Language Support Demo');
  console.log('=================================================\n');
  
  const langManager = new LanguageManager();
  
  // Show total language count
  const languages = Object.keys(SUPPORTED_LANGUAGES);
  console.log(`Total supported languages: ${languages.length}`);
  console.log('');
  
  // Demo: "Welcome to Otedama Mining Pool" in different languages
  const welcomeMessages = {
    en: 'Welcome to Otedama Mining Pool',
    ja: 'Otedamaマイニングプールへようこそ',
    zh: '欢迎来到Otedama矿池',
    'zh-TW': '歡迎來到Otedama礦池',
    es: 'Bienvenido a Otedama Mining Pool',
    ar: 'مرحبا بك في Otedama Mining Pool',
    hi: 'Otedama माइनिंग पूल में आपका स्वागत है',
    ru: 'Добро пожаловать в Otedama Mining Pool',
    fr: 'Bienvenue sur Otedama Mining Pool',
    de: 'Willkommen bei Otedama Mining Pool',
    ko: 'Otedama 마이닝 풀에 오신 것을 환영합니다',
    pt: 'Bem-vindo ao Otedama Mining Pool',
    it: 'Benvenuto in Otedama Mining Pool',
    tr: 'Otedama Mining Pool\'a hoş geldiniz',
    vi: 'Chào mừng đến với Otedama Mining Pool',
    th: 'ยินดีต้อนรับสู่ Otedama Mining Pool',
    pl: 'Witamy w Otedama Mining Pool',
    nl: 'Welkom bij Otedama Mining Pool',
    sv: 'Välkommen till Otedama Mining Pool',
    he: 'ברוכים הבאים ל-Otedama Mining Pool',
    fa: 'به Otedama Mining Pool خوش آمدید',
    bn: 'Otedama মাইনিং পুলে স্বাগতম',
    id: 'Selamat datang di Otedama Mining Pool',
    uk: 'Ласкаво просимо до Otedama Mining Pool',
    el: 'Καλώς ήρθατε στο Otedama Mining Pool',
    hu: 'Üdvözöljük az Otedama Mining Pool-ban',
    cs: 'Vítejte v Otedama Mining Pool',
    fi: 'Tervetuloa Otedama Mining Pooliin',
    da: 'Velkommen til Otedama Mining Pool',
    no: 'Velkommen til Otedama Mining Pool',
    sw: 'Karibu Otedama Mining Pool',
    am: 'ወደ Otedama Mining Pool እንኳን ደህና መጡ'
  };
  
  console.log('Sample welcome messages in different languages:\n');
  
  // Display messages grouped by script/region
  console.log('=== Latin Script ===');
  ['en', 'es', 'fr', 'de', 'pt', 'it', 'pl', 'nl', 'sv', 'tr', 'vi', 'id', 'sw'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]}`);
    }
  });
  
  console.log('\n=== Asian Scripts ===');
  ['ja', 'zh', 'zh-TW', 'ko', 'th'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]}`);
    }
  });
  
  console.log('\n=== Cyrillic Script ===');
  ['ru', 'uk'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]}`);
    }
  });
  
  console.log('\n=== RTL Languages (Right-to-Left) ===');
  ['ar', 'he', 'fa'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]} ←`);
    }
  });
  
  console.log('\n=== Devanagari Script ===');
  ['hi', 'bn'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]}`);
    }
  });
  
  console.log('\n=== Other Scripts ===');
  ['el', 'am'].forEach(lang => {
    if (welcomeMessages[lang]) {
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.nativeName}: ${welcomeMessages[lang]}`);
    }
  });
  
  // Show language statistics
  console.log('\n=================================================');
  console.log('Language Coverage Statistics:');
  console.log('=================================================');
  
  const rtlLanguages = languages.filter(lang => SUPPORTED_LANGUAGES[lang].rtl);
  console.log(`\nRTL Languages: ${rtlLanguages.length}`);
  console.log(rtlLanguages.join(', '));
  
  // Group by regions
  const regions = {
    europe: 0,
    asia: 0,
    africa: 0,
    americas: 0,
    middleEast: 0,
    oceania: 0
  };
  
  // Simple region detection (this is simplified)
  languages.forEach(lang => {
    if (['ar', 'he', 'fa', 'ur', 'ps', 'ku'].includes(lang)) regions.middleEast++;
    else if (['sw', 'am', 'ha', 'yo', 'ig', 'zu', 'xh', 'af', 'so', 'om', 'rw', 'mg'].includes(lang)) regions.africa++;
    else if (['ja', 'ko', 'zh', 'zh-TW', 'th', 'vi', 'id', 'ms', 'fil', 'my', 'km', 'lo', 'hi', 'bn', 'ta', 'te', 'ne', 'si'].includes(lang)) regions.asia++;
    else if (['en', 'es', 'pt-BR'].includes(lang)) regions.americas++;
    else if (['mi', 'haw', 'sm', 'to', 'fj'].includes(lang)) regions.oceania++;
    else regions.europe++;
  });
  
  console.log('\nRegional Distribution:');
  Object.entries(regions).forEach(([region, count]) => {
    console.log(`${region.charAt(0).toUpperCase() + region.slice(1)}: ${count} languages`);
  });
  
  // Demonstrate number formatting
  console.log('\n=================================================');
  console.log('Number Formatting Examples:');
  console.log('=================================================');
  
  const number = 1234567.89;
  const sampleLangs = ['en', 'de', 'fr', 'ja', 'ar', 'hi', 'th'];
  
  console.log(`\nFormatting ${number}:`);
  sampleLangs.forEach(lang => {
    try {
      const formatted = langManager.formatNumber(number, lang);
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.name}: ${formatted}`);
    } catch (e) {
      // Ignore
    }
  });
  
  // Show Bitcoin formatting
  console.log('\n=================================================');
  console.log('Bitcoin Amount Formatting:');
  console.log('=================================================');
  
  const btcAmount = 0.00123456;
  console.log(`\nFormatting ${btcAmount} BTC:`);
  sampleLangs.forEach(lang => {
    try {
      const formatted = langManager.formatNumber(btcAmount, lang);
      const info = SUPPORTED_LANGUAGES[lang];
      console.log(`${info.name}: ${formatted} BTC`);
    } catch (e) {
      // Ignore
    }
  });
  
  console.log('\n=================================================');
  console.log('Otedama supports communication with miners');
  console.log('from around the world in their native languages!');
  console.log('=================================================');
}

// Run demo
if (require.main === module) {
  demonstrateLanguages().catch(console.error);
}

module.exports = demonstrateLanguages;