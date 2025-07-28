#!/usr/bin/env node
/**
 * Fix agent import issues
 * Temporarily disables external dependencies that don't exist
 */

import fs from 'fs/promises';
import path from 'path';

const agentFiles = [
  'lib/agents/base-agent.js',
  'lib/agents/health-check-agent.js',
  'lib/agents/self-healing-agent.js',
  'lib/agents/scaling-agent.js',
  'lib/agents/event-bus.js',
  'lib/agents/agent-manager.js'
];

const replacements = [
  {
    from: "import { logger } from '../core/logger.js';",
    to: "import { createStructuredLogger } from '../core/structured-logger.js';\n\nconst logger = createStructuredLogger('Agent');"
  },
  {
    from: "import { healthCheck } from '../core/health-check.js';",
    to: "// import { healthCheck } from '../core/health-check.js';"
  },
  {
    from: "import { selfHealingSystem } from '../core/self-healing-system.js';",
    to: "// import { selfHealingSystem } from '../core/self-healing-system.js';"
  },
  {
    from: "import { autoScaler } from '../core/auto-scaling.js';",
    to: "// import { autoScaler } from '../core/auto-scaling.js';"
  }
];

async function fixFile(filePath) {
  try {
    let content = await fs.readFile(filePath, 'utf-8');
    let modified = false;
    
    for (const replacement of replacements) {
      if (content.includes(replacement.from)) {
        content = content.replace(replacement.from, replacement.to);
        modified = true;
      }
    }
    
    if (modified) {
      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`✅ Fixed imports in ${path.basename(filePath)}`);
    }
  } catch (error) {
    console.error(`❌ Error fixing ${filePath}:`, error.message);
  }
}

async function main() {
  console.log('🔧 Fixing agent import issues...\n');
  
  for (const file of agentFiles) {
    await fixFile(file);
  }
  
  console.log('\n✅ Import fixes complete!');
}

main().catch(console.error);