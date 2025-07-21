/**
 * ESM Loader for Test Environment
 * Handles ES modules in test environment with proper path resolution
 */

import { pathToFileURL } from 'url';
import { resolve } from 'path';

export async function resolve(specifier, context, defaultResolve) {
  // Handle relative imports in test files
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const { parentURL = pathToFileURL(process.cwd() + '/').href } = context;
    return defaultResolve(specifier, { ...context, parentURL }, defaultResolve);
  }

  // Handle lib imports from test files
  if (specifier.startsWith('../lib/')) {
    const resolved = new URL(specifier, context.parentURL);
    return {
      url: resolved.href
    };
  }

  // Default resolution
  return defaultResolve(specifier, context, defaultResolve);
}