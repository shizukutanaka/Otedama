/**
 * Version Update Script
 * Updates version in various project files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const version = process.argv[2];

if (!version) {
  console.error('Version not provided');
  process.exit(1);
}

console.log(`📦 Updating version to ${version}...`);

// Update Helm Chart
try {
  const chartPath = path.join(__dirname, '../helm/Chart.yaml');
  if (fs.existsSync(chartPath)) {
    const chart = yaml.load(fs.readFileSync(chartPath, 'utf8')) as any;
    chart.version = version;
    chart.appVersion = version;
    fs.writeFileSync(chartPath, yaml.dump(chart));
    console.log('✅ Updated Helm Chart');
  }
} catch (error) {
  console.error('Failed to update Helm Chart:', error);
}

// Update Kubernetes manifests
try {
  const k8sPath = path.join(__dirname, '../k8s');
  if (fs.existsSync(k8sPath)) {
    const files = fs.readdirSync(k8sPath).filter(f => f.endsWith('.yaml'));
    
    for (const file of files) {
      const filePath = path.join(k8sPath, file);
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Update image tags
      content = content.replace(
        /image:\s*otedama\/pool:[\w.-]+/g,
        `image: otedama/pool:${version}`
      );
      
      fs.writeFileSync(filePath, content);
    }
    
    console.log('✅ Updated Kubernetes manifests');
  }
} catch (error) {
  console.error('Failed to update Kubernetes manifests:', error);
}

// Update Docker Compose
try {
  const composePath = path.join(__dirname, '../docker-compose.yml');
  if (fs.existsSync(composePath)) {
    let content = fs.readFileSync(composePath, 'utf8');
    content = content.replace(
      /image:\s*otedama\/pool:[\w.-]+/g,
      `image: otedama/pool:${version}`
    );
    fs.writeFileSync(composePath, content);
    console.log('✅ Updated Docker Compose');
  }
} catch (error) {
  console.error('Failed to update Docker Compose:', error);
}

// Update version in source code
try {
  const versionFile = path.join(__dirname, '../src/version.ts');
  const content = `// Auto-generated version file
export const VERSION = '${version}';
export const BUILD_TIME = '${new Date().toISOString()}';
`;
  fs.writeFileSync(versionFile, content);
  console.log('✅ Updated version.ts');
} catch (error) {
  console.error('Failed to update version.ts:', error);
}

console.log('\n✨ Version update complete!');
