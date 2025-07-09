import { Language } from './index';

export const languageData: Array<[string, Language]> = [
  ['en', {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    region: 'US',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'MM/DD/YYYY',
    numberFormat: { decimal: '.', thousands: ',', currency: '$' }
  }],
  ['ja', {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    region: 'JP',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'YYYY/MM/DD',
    numberFormat: { decimal: '.', thousands: ',', currency: '¥' }
  }],
  ['zh-CN', {
    code: 'zh-CN',
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
    region: 'CN',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'YYYY/MM/DD',
    numberFormat: { decimal: '.', thousands: ',', currency: '¥' }
  }],
  ['zh-TW', {
    code: 'zh-TW',
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    region: 'TW',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'YYYY/MM/DD',
    numberFormat: { decimal: '.', thousands: ',', currency: 'NT$' }
  }],
  ['ko', {
    code: 'ko',
    name: 'Korean',
    nativeName: '한국어',
    region: 'KR',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'YYYY.MM.DD',
    numberFormat: { decimal: '.', thousands: ',', currency: '₩' }
  }],
  ['es', {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    region: 'ES',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: ',', thousands: '.', currency: '€' }
  }],
  ['fr', {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    region: 'FR',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: ',', thousands: ' ', currency: '€' }
  }],
  ['de', {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    region: 'DE',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD.MM.YYYY',
    numberFormat: { decimal: ',', thousands: '.', currency: '€' }
  }],
  ['ru', {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    region: 'RU',
    rtl: false,
    pluralRules: ['one', 'few', 'many', 'other'],
    dateFormat: 'DD.MM.YYYY',
    numberFormat: { decimal: ',', thousands: ' ', currency: '₽' }
  }],
  ['pt', {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    region: 'PT',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: ',', thousands: '.', currency: '€' }
  }],
  ['it', {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    region: 'IT',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: ',', thousands: '.', currency: '€' }
  }],
  ['ar', {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    region: 'SA',
    rtl: true,
    pluralRules: ['zero', 'one', 'two', 'few', 'many', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: '.', thousands: ',', currency: 'ر.س' }
  }],
  ['hi', {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    region: 'IN',
    rtl: false,
    pluralRules: ['one', 'other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: '.', thousands: ',', currency: '₹' }
  }],
  ['th', {
    code: 'th',
    name: 'Thai',
    nativeName: 'ไทย',
    region: 'TH',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: '.', thousands: ',', currency: '฿' }
  }],
  ['vi', {
    code: 'vi',
    name: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    region: 'VN',
    rtl: false,
    pluralRules: ['other'],
    dateFormat: 'DD/MM/YYYY',
    numberFormat: { decimal: ',', thousands: '.', currency: '₫' }
  }]
];
