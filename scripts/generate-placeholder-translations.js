const fs = require('fs').promises;
const path = require('path');

/**
 * Script: generate-placeholder-translations.js
 *
 * Goal: Ensure that placeholder translation JSON files exist for the target list
 * of 100 languages. It copies the existing English (`en.json`) file as a
 * template for any missing locale and writes it to `src/locales/<lang>.json`.
 *
 * Usage (from repo root):
 *   node scripts/generate-placeholder-translations.js
 */

// 100 ISO-639-1 language codes we aim to support.
const LANGUAGE_CODES = [
  'aa', 'ab', 'af', 'am', 'ar', 'az', 'be', 'bg', 'bn', 'bs',
  'ca', 'cs', 'cy', 'da', 'de', 'dv', 'el', 'en', 'eo', 'es',
  'et', 'eu', 'fa', 'fi', 'fr', 'ga', 'gd', 'gl', 'gu', 'ha',
  'he', 'hi', 'hr', 'hu', 'hy', 'id', 'ig', 'is', 'it', 'ja',
  'jv', 'ka', 'kk', 'km', 'kn', 'ko', 'ku', 'ky', 'la', 'lb',
  'lg', 'lo', 'lt', 'lv', 'mg', 'mk', 'ml', 'mn', 'mr', 'ms',
  'mt', 'my', 'ne', 'nl', 'no', 'ny', 'pa', 'pl', 'ps', 'pt',
  'ro', 'ru', 'rw', 'sa', 'sd', 'si', 'sk', 'sl', 'so', 'sq',
  'sr', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl',
  'tr', 'uk', 'ur', 'uz', 'vi', 'xh', 'yi', 'yo', 'zh', 'zu'
];

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const localesDir = path.join(projectRoot, 'src', 'locales');
  const templatePath = path.join(localesDir, 'en.json');

  console.log('Starting placeholder generation...');
  console.log(`Template file: ${templatePath}`);

  // Load and pretty-print the English template (2-space indent)
  const templateJson = await fs.readFile(templatePath, 'utf-8');
  const templateObj = JSON.parse(templateJson);
  const templateString = JSON.stringify(templateObj, null, 2) + '\n';

  let createdCount = 0;
  let existingCount = 0;

  for (const code of LANGUAGE_CODES) {
    const targetPath = path.join(localesDir, `${code}.json`);
    try {
      await fs.access(targetPath);
      existingCount++;
    } catch {
      // File does not exist – create placeholder.
      await fs.writeFile(targetPath, templateString, 'utf-8');
      createdCount++;
      console.log(` -> Created placeholder for locale "${code}".`);
    }
  }

  console.log(`\nGeneration complete.`);
  console.log(`- ${createdCount} new placeholder file(s) created.`);
  console.log(`- ${existingCount} file(s) already existed.`);
}

main().catch((err) => {
  console.error('Error while generating placeholder translations:', err);
  process.exit(1);
});
