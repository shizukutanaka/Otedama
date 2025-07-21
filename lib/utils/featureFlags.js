/*
 * Feature flag utility for staged rollouts / alpha & beta testing.
 * Flags are controlled via environment variables or config file.
 */

import fs from 'node:fs';
import path from 'node:path';

const configPath = process.env.FEATURE_FLAGS_PATH || path.join(process.cwd(), 'feature-flags.json');
let fileFlags = {};
if (fs.existsSync(configPath)) {
  try {
    fileFlags = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // ignore malformed JSON, fallback to env only
  }
}

function flagEnabled(name, defaultVal = false) {
  const env = process.env[`FLAG_${name.toUpperCase()}`];
  if (env !== undefined) {
    return env === '1' || env.toLowerCase() === 'true';
  }
  if (fileFlags[name] !== undefined) {
    return !!fileFlags[name];
  }
  return defaultVal;
}

export const FeatureFlags = {
  alpha: flagEnabled('alpha'),
  beta: flagEnabled('beta'),
  newDexEngine: flagEnabled('newDexEngine'),
  experimentalMiningAlgo: flagEnabled('experimentalMiningAlgo'),
};

export default flagEnabled;
