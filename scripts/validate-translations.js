const fs = require('fs').promises;
const path = require('path');

/**
 * Script: validate-translations.js
 *
 * Goal: Validates all locale files in `src/locales` against the English
 * template (`en.json`). It checks for two main things:
 *   1. Is the file valid JSON?
 *   2. Do all keys match the English template exactly?
 *
 * Usage (from repo root):
 *   node scripts/validate-translations.js
 */

// Helper function to recursively get all keys from an object
function getKeys(obj, prefix = '') {
  return Object.keys(obj).reduce((res, el) => {
    if (typeof obj[el] === 'object' && obj[el] !== null) {
      return [...res, ...getKeys(obj[el], prefix + el + '.')];
    } else {
      return [...res, prefix + el];
    }
  }, []);
}

async function main() {
  console.log('Starting translation file validation...');

  const localesDir = path.resolve(__dirname, '..', 'src', 'locales');
  const templatePath = path.join(localesDir, 'en.json');

  let templateKeys;
  try {
    const templateContent = await fs.readFile(templatePath, 'utf-8');
    const templateJson = JSON.parse(templateContent);
    templateKeys = new Set(getKeys(templateJson));
    console.log(`Loaded English template with ${templateKeys.size} keys.`);
  } catch (error) {
    console.error('CRITICAL: Could not load or parse the English template file (en.json).', error);
    process.exit(1);
  }

  const allFiles = await fs.readdir(localesDir);
  const localeFiles = allFiles.filter(f => f.endsWith('.json') && f !== 'en.json');

  let errorCount = 0;
  let validatedCount = 0;

  for (const file of localeFiles) {
    const filePath = path.join(localesDir, file);
    let hasError = false;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(content);
      const keys = new Set(getKeys(json));

      const missingKeys = [...templateKeys].filter(k => !keys.has(k));
      const extraKeys = [...keys].filter(k => !templateKeys.has(k));

      if (missingKeys.length > 0) {
        console.error(`ERROR in ${file}: Missing ${missingKeys.length} key(s): ${missingKeys.slice(0, 5).join(', ')}...`);
        hasError = true;
      }

      if (extraKeys.length > 0) {
        console.error(`ERROR in ${file}: Found ${extraKeys.length} extra key(s): ${extraKeys.slice(0, 5).join(', ')}...`);
        hasError = true;
      }

    } catch (e) {
      console.error(`ERROR in ${file}: Invalid JSON format.`);
      hasError = true;
    }

    if (hasError) {
      errorCount++;
    } else {
      validatedCount++;
    }
  }

  console.log('\nValidation complete.');
  console.log(`- ${validatedCount} files validated successfully.`);
  console.log(`- ${errorCount} files have errors.`);

  if (errorCount > 0) {
    console.error('\nPlease fix the errors listed above.');
    process.exit(1);
  }

  console.log('\nAll translation files are valid! ✨');
}

main().catch(err => {
  console.error('An unexpected error occurred:', err);
  process.exit(1);
});
