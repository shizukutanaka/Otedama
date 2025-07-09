import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import * as path from 'path';

const localesPath = path.resolve(__dirname, '../locales');

i18next
  .use(Backend)
  .init({
    // debug: process.env.NODE_ENV === 'development',
    initImmediate: false, // 初期化を非同期に
    fallbackLng: 'en',
    lng: 'en', // デフォルト言語
    ns: ['translation'],
    defaultNS: 'translation',
    backend: {
      loadPath: path.join(localesPath, '{{lng}}.json'),
    },
    interpolation: {
      escapeValue: false, // Reactでは不要
    },
  });

export default i18next;
