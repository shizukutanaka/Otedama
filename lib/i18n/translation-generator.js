/**
 * Translation Generator
 * Generates basic translations for all supported languages
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../core/logger');
const { SUPPORTED_LANGUAGES } = require('./language-manager');

const logger = createLogger('translation-generator');

// Basic translations for common mining terms
const BASIC_TRANSLATIONS = {
  // Common terms
  'common.mining': {
    en: 'Mining',
    es: 'Minería',
    fr: 'Minage',
    de: 'Mining',
    it: 'Mining',
    pt: 'Mineração',
    ru: 'Майнинг',
    ja: 'マイニング',
    ko: '채굴',
    zh: '挖矿',
    'zh-TW': '挖礦',
    ar: 'التعدين',
    hi: 'खनन',
    bn: 'খনন',
    vi: 'Khai thác',
    tr: 'Madencilik',
    pl: 'Wydobycie',
    nl: 'Mijnbouw',
    sv: 'Brytning',
    da: 'Minedrift',
    no: 'Gruvedrift',
    fi: 'Louhinta',
    cs: 'Těžba',
    hu: 'Bányászat',
    ro: 'Minerit',
    el: 'Εξόρυξη',
    he: 'כרייה',
    th: 'การขุด',
    id: 'Penambangan',
    ms: 'Perlombongan',
    fil: 'Pagmimina',
    uk: 'Майнінг',
    bg: 'Миньорство',
    hr: 'Rudarenje',
    sr: 'Рударење',
    sk: 'Ťažba',
    sl: 'Rudarjenje',
    lt: 'Kasyba',
    lv: 'Ieguve',
    et: 'Kaevandamine',
    fa: 'استخراج',
    ur: 'کان کنی',
    sw: 'Uchimbaji',
    am: 'ማዕድን',
    ha: 'Haƙar ma\'adinai',
    yo: 'Iwakusa',
    ig: 'Ngwuputa',
    zu: 'Ukumba',
    af: 'Mynbou',
    sq: 'Miniera',
    eu: 'Meatzaritza',
    ca: 'Mineria',
    gl: 'Minería',
    cy: 'Mwyngloddio',
    ga: 'Mianadóireacht',
    is: 'Námuvinnsla',
    mt: 'Tħaffir',
    ka: 'მოპოვება',
    hy: 'Հանքարդյունաբերություն',
    az: 'Mədənçilik',
    kk: 'Тау-кен',
    ky: 'Кен казуу',
    uz: 'Kon qazish',
    tg: 'Истихроҷ',
    tk: 'Magdan',
    mn: 'Уурхай',
    ne: 'खानी',
    si: 'පතල්',
    my: 'သတ္တုတူးခြင်း',
    km: 'ការជីកយករ៉ែ',
    lo: 'ການຂຸດຄົ້ນ',
    ps: 'کان کیندنه',
    ku: 'Kanan',
    sd: 'کان کني',
    gu: 'ખાણકામ',
    ta: 'சுரங்கம்',
    te: 'గనులు',
    kn: 'ಗಣಿಗಾರಿಕೆ',
    ml: 'ഖനനം',
    or: 'ଖଣି',
    as: 'খনন',
    mr: 'खाणकाम',
    pa: 'ਖਣਨ',
    rw: 'Ubucukuzi',
    mg: 'Fitrandrahana',
    so: 'Macdanta',
    xh: 'Umgodi',
    yo: 'Iwakusa',
    ig: 'Ngwuputa',
    zu: 'Ukumba',
    om: 'Albuuda',
    ti: 'ማዕድን',
    gd: 'Mèinneadh',
    lb: 'Biergbau',
    eo: 'Minado',
    la: 'Metallum',
    haw: 'ʻEli',
    sm: 'Eli',
    to: 'Keli',
    fj: 'Keli',
    mi: 'Keri'
  },
  
  'common.pool': {
    en: 'Pool',
    es: 'Piscina',
    fr: 'Pool',
    de: 'Pool',
    it: 'Pool',
    pt: 'Pool',
    ru: 'Пул',
    ja: 'プール',
    ko: '풀',
    zh: '矿池',
    'zh-TW': '礦池',
    ar: 'تجمع',
    hi: 'पूल',
    // ... (abbreviated for brevity, would include all 100 languages)
  },
  
  'common.hashrate': {
    en: 'Hashrate',
    es: 'Tasa de hash',
    fr: 'Taux de hachage',
    de: 'Hashrate',
    it: 'Hashrate',
    pt: 'Taxa de hash',
    ru: 'Хешрейт',
    ja: 'ハッシュレート',
    ko: '해시레이트',
    zh: '算力',
    'zh-TW': '算力',
    ar: 'معدل التجزئة',
    hi: 'हैशरेट',
    // ... (abbreviated for brevity, would include all 100 languages)
  },
  
  'common.bitcoin': {
    en: 'Bitcoin',
    // Bitcoin is generally kept as-is in most languages
    // but some use local scripts
    ar: 'بيتكوين',
    fa: 'بیت‌کوین',
    he: 'ביטקוין',
    hi: 'बिटकॉइन',
    bn: 'বিটকয়েন',
    th: 'บิตคอยน์',
    my: 'ဘစ်ကိုအင်',
    km: 'ប៊ីតខញ',
    lo: 'ບິດຄອຍ',
    ka: 'ბიტკოინი',
    hy: 'Բիթքոյն',
    am: 'ቢትኮይን',
    // Most others use 'Bitcoin'
  },
  
  'common.wallet': {
    en: 'Wallet',
    es: 'Billetera',
    fr: 'Portefeuille',
    de: 'Wallet',
    it: 'Portafoglio',
    pt: 'Carteira',
    ru: 'Кошелек',
    ja: 'ウォレット',
    ko: '지갑',
    zh: '钱包',
    'zh-TW': '錢包',
    ar: 'محفظة',
    hi: 'वॉलेट',
    // ... (abbreviated for brevity, would include all 100 languages)
  }
};

// Number translations
const NUMBER_SYSTEMS = {
  // Arabic-Indic numerals
  ar: ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'],
  fa: ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'],
  ur: ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'],
  // Devanagari numerals
  hi: ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'],
  ne: ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'],
  mr: ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'],
  // Bengali numerals
  bn: ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'],
  as: ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'],
  // Thai numerals
  th: ['๐', '๑', '๒', '๓', '๔', '๕', '๖', '๗', '๘', '๙'],
  // Myanmar numerals
  my: ['၀', '၁', '၂', '၃', '၄', '၅', '၆', '၇', '၈', '၉'],
  // Khmer numerals
  km: ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩'],
  // Lao numerals
  lo: ['໐', '໑', '໒', '໓', '໔', '໕', '໖', '໗', '໘', '໙']
};

class TranslationGenerator {
  constructor(options = {}) {
    this.options = {
      outputPath: options.outputPath || path.join(__dirname, 'locales'),
      baseLanguage: options.baseLanguage || 'en',
      ...options
    };
  }
  
  /**
   * Generate translations for all languages
   */
  async generateAllTranslations() {
    logger.info('Starting translation generation for all languages...');
    
    // Ensure output directory exists
    await fs.mkdir(this.options.outputPath, { recursive: true });
    
    // Load base translation (English)
    const baseTranslation = await this.loadBaseTranslation();
    
    // Generate for each language
    const languages = Object.keys(SUPPORTED_LANGUAGES);
    let generated = 0;
    
    for (const lang of languages) {
      try {
        await this.generateTranslation(lang, baseTranslation);
        generated++;
        
        if (generated % 10 === 0) {
          logger.info(`Generated ${generated}/${languages.length} translations`);
        }
      } catch (error) {
        logger.error(`Failed to generate translation for ${lang}:`, error);
      }
    }
    
    logger.info(`Translation generation complete. Generated ${generated} translations.`);
  }
  
  /**
   * Load base translation
   */
  async loadBaseTranslation() {
    const filePath = path.join(this.options.outputPath, `${this.options.baseLanguage}.json`);
    
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // Return default structure if base doesn't exist
      return this.getDefaultTranslationStructure();
    }
  }
  
  /**
   * Generate translation for a language
   */
  async generateTranslation(lang, baseTranslation) {
    const filePath = path.join(this.options.outputPath, `${lang}.json`);
    
    // Check if already exists
    try {
      await fs.access(filePath);
      logger.debug(`Translation for ${lang} already exists, skipping`);
      return;
    } catch (e) {
      // File doesn't exist, continue
    }
    
    // Generate translation
    const translation = this.createTranslation(lang, baseTranslation);
    
    // Write to file
    await fs.writeFile(filePath, JSON.stringify(translation, null, 2), 'utf8');
    logger.debug(`Generated translation for ${lang}`);
  }
  
  /**
   * Create translation for a language
   */
  createTranslation(lang, baseTranslation) {
    const translation = JSON.parse(JSON.stringify(baseTranslation));
    const langInfo = SUPPORTED_LANGUAGES[lang];
    
    // Apply basic translations
    this.applyBasicTranslations(translation, lang);
    
    // Apply number system if different
    if (NUMBER_SYSTEMS[lang]) {
      this.applyNumberSystem(translation, lang);
    }
    
    // Add language-specific metadata
    translation.metadata = {
      language: lang,
      languageName: langInfo.name,
      nativeName: langInfo.nativeName,
      rtl: langInfo.rtl,
      generated: new Date().toISOString(),
      version: '1.0.0'
    };
    
    return translation;
  }
  
  /**
   * Apply basic translations
   */
  applyBasicTranslations(translation, lang) {
    for (const [key, translations] of Object.entries(BASIC_TRANSLATIONS)) {
      const keys = key.split('.');
      let target = translation;
      
      // Navigate to nested object
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]]) {
          target[keys[i]] = {};
        }
        target = target[keys[i]];
      }
      
      // Set translation
      const lastKey = keys[keys.length - 1];
      if (translations[lang]) {
        target[lastKey] = translations[lang];
      } else if (lang !== 'en' && translations.en) {
        // Fallback to English with language tag
        target[lastKey] = `[${lang}] ${translations.en}`;
      }
    }
  }
  
  /**
   * Apply number system
   */
  applyNumberSystem(translation, lang) {
    const numerals = NUMBER_SYSTEMS[lang];
    
    // Convert numbers in translation values
    const convertNumbers = (obj) => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          // Replace Western numerals with local numerals
          obj[key] = value.replace(/[0-9]/g, (digit) => {
            return numerals[parseInt(digit)];
          });
        } else if (typeof value === 'object' && value !== null) {
          convertNumbers(value);
        }
      }
    };
    
    convertNumbers(translation);
  }
  
  /**
   * Get default translation structure
   */
  getDefaultTranslationStructure() {
    return {
      app: {
        name: 'Otedama',
        description: 'P2P Mining Pool Software',
        version: 'Version {{version}}'
      },
      common: {
        mining: 'Mining',
        pool: 'Pool',
        hashrate: 'Hashrate',
        bitcoin: 'Bitcoin',
        wallet: 'Wallet',
        address: 'Address',
        balance: 'Balance',
        settings: 'Settings',
        help: 'Help',
        language: 'Language',
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        confirm: 'Confirm',
        cancel: 'Cancel',
        save: 'Save',
        close: 'Close',
        yes: 'Yes',
        no: 'No'
      },
      mining: {
        title: 'Mining',
        startMining: 'Start Mining',
        stopMining: 'Stop Mining',
        status: 'Status',
        online: 'Online',
        offline: 'Offline',
        shares: 'Shares',
        difficulty: 'Difficulty',
        earnings: 'Earnings',
        workers: 'Workers'
      },
      setup: {
        title: 'Setup Wizard',
        welcome: 'Welcome to Otedama!',
        selectLanguage: 'Select Language',
        selectMode: 'Select Mode',
        enterWallet: 'Enter Wallet Address',
        complete: 'Setup Complete'
      },
      fees: {
        title: 'Fees',
        poolFee: 'Pool Fee',
        networkFee: 'Network Fee',
        total: 'Total',
        comparison: 'Fee Comparison',
        lowest: 'Industry Lowest'
      },
      errors: {
        general: 'An error occurred',
        network: 'Network error',
        invalid: 'Invalid input',
        required: 'Required field'
      }
    };
  }
}

// Export for use
module.exports = TranslationGenerator;

// Run if called directly
if (require.main === module) {
  const generator = new TranslationGenerator();
  generator.generateAllTranslations().catch(console.error);
}