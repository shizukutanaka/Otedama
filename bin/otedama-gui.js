#!/usr/bin/env node

/**
 * Otedama GUI Launcher
 * Starts the Electron-based mining application
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Check if Electron is installed
try {
  require.resolve('electron');
} catch (error) {
  console.error('Electron is not installed. Installing now...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawn(npm, ['install', 'electron', '--save-dev'], {
    stdio: 'inherit',
    shell: true
  });
  
  install.on('close', (code) => {
    if (code !== 0) {
      console.error('Failed to install Electron');
      process.exit(1);
    }
    launchApp();
  });
} 

function launchApp() {
  const electron = require('electron');
  const appPath = path.join(__dirname, '..', 'lib', 'gui', 'miner-app.js');
  
  // Launch Electron app
  const child = spawn(electron, [appPath], {
    stdio: 'inherit',
    shell: false
  });
  
  child.on('close', (code) => {
    process.exit(code);
  });
}

// Launch immediately if Electron is already installed
if (require.resolve('electron')) {
  launchApp();
}