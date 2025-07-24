/**
 * Renderer Process - UI Logic
 */

// State management
const state = {
  isMining: false,
  stats: {
    hashrate: 0,
    shares: { accepted: 0, rejected: 0, total: 0 },
    earnings: { today: 0, total: 0, pending: 0 },
    uptime: 0,
    temperature: { cpu: 0, gpu: 0 }
  },
  settings: {},
  pools: [],
  logs: []
};

// DOM Elements
const elements = {
  // Navigation
  navItems: document.querySelectorAll('.nav-item'),
  pages: document.querySelectorAll('.page'),
  
  // Mining controls
  mainMiningButton: document.getElementById('main-mining-button'),
  miningControlButton: document.getElementById('mining-control-button'),
  
  // Status elements
  miningStatus: document.getElementById('mining-status'),
  currentPool: document.getElementById('current-pool'),
  miningUptime: document.getElementById('mining-uptime'),
  
  // Stats elements
  currentHashrate: document.getElementById('current-hashrate'),
  sharesAccepted: document.getElementById('shares-accepted'),
  sharesRejected: document.getElementById('shares-rejected'),
  shareRatio: document.getElementById('share-ratio'),
  shareProgress: document.getElementById('share-progress'),
  
  // Earnings elements
  earningsToday: document.getElementById('earnings-today'),
  earningsTotal: document.getElementById('earnings-total'),
  earningsPending: document.getElementById('earnings-pending'),
  
  // Hardware elements
  cpuTemp: document.getElementById('cpu-temp'),
  gpuTemp: document.getElementById('gpu-temp'),
  cpuUsage: document.getElementById('cpu-usage'),
  gpuUsage: document.getElementById('gpu-usage'),
  
  // Settings elements
  btcAddress: document.getElementById('btc-address'),
  poolSelect: document.getElementById('pool-select'),
  useCpu: document.getElementById('use-cpu'),
  useGpu: document.getElementById('use-gpu'),
  cpuThreads: document.getElementById('cpu-threads'),
  cpuThreadsValue: document.getElementById('cpu-threads-value'),
  gpuIntensity: document.getElementById('gpu-intensity'),
  gpuIntensityValue: document.getElementById('gpu-intensity-value'),
  
  // Modal elements
  logModal: document.getElementById('log-modal'),
  logContent: document.getElementById('log-content'),
  
  // Notification
  notificationToast: document.getElementById('notification-toast')
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadSettings();
  await loadPools();
  setupCharts();
  startUIUpdater();
});

// Event Listeners
function setupEventListeners() {
  // Navigation
  elements.navItems.forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      navigateToPage(page);
    });
  });
  
  // Title bar controls
  document.getElementById('minimize-btn').addEventListener('click', () => {
    window.api.minimizeWindow();
  });
  
  document.getElementById('maximize-btn').addEventListener('click', () => {
    window.api.maximizeWindow();
  });
  
  document.getElementById('close-btn').addEventListener('click', () => {
    window.api.closeWindow();
  });
  
  // Mining controls
  elements.mainMiningButton.addEventListener('click', toggleMining);
  elements.miningControlButton.addEventListener('click', toggleMining);
  
  // Quick actions
  document.getElementById('pause-mining').addEventListener('click', pauseMining);
  document.getElementById('view-logs').addEventListener('click', showLogs);
  document.getElementById('open-calculator').addEventListener('click', openCalculator);
  document.getElementById('refresh-stats').addEventListener('click', refreshStats);
  
  // Settings
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('reset-settings').addEventListener('click', resetSettings);
  
  // Pool testing
  document.getElementById('test-pool').addEventListener('click', testPoolConnection);
  
  // Wallet
  document.getElementById('copy-address').addEventListener('click', copyAddress);
  document.getElementById('request-payout').addEventListener('click', requestPayout);
  document.getElementById('view-transactions').addEventListener('click', viewTransactions);
  
  // Sliders
  elements.cpuThreads.addEventListener('input', (e) => {
    const value = e.target.value;
    elements.cpuThreadsValue.textContent = value === '0' ? 'Auto' : value;
  });
  
  elements.gpuIntensity.addEventListener('input', (e) => {
    elements.gpuIntensityValue.textContent = `${e.target.value}%`;
  });
  
  // Settings toggles
  document.getElementById('idle-mining-toggle').addEventListener('change', (e) => {
    document.getElementById('idle-threshold-setting').style.display = 
      e.target.checked ? 'flex' : 'none';
  });
  
  // Log modal
  document.getElementById('close-log-modal').addEventListener('click', () => {
    elements.logModal.classList.remove('active');
  });
  
  document.getElementById('clear-logs').addEventListener('click', clearLogs);
  document.getElementById('export-logs').addEventListener('click', exportLogs);
  
  // Time filter buttons
  document.querySelectorAll('.filter-button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      updateChartsForPeriod(e.target.dataset.period);
    });
  });
}

// Navigation
function navigateToPage(pageName) {
  // Update nav
  elements.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  
  // Update pages
  elements.pages.forEach(page => {
    page.classList.toggle('active', page.id === `${pageName}-page`);
  });
}

// Mining Control
async function toggleMining() {
  if (state.isMining) {
    const result = await window.api.stopMining();
    if (result.success) {
      updateMiningButton(false);
    }
  } else {
    const result = await window.api.startMining();
    if (result.success) {
      updateMiningButton(true);
    }
  }
}

function updateMiningButton(isMining) {
  state.isMining = isMining;
  
  const buttons = [elements.mainMiningButton, elements.miningControlButton];
  buttons.forEach(btn => {
    if (isMining) {
      btn.querySelector('.button-icon').textContent = '⏸';
      btn.querySelector('.button-text').textContent = 'Stop Mining';
      btn.classList.add('mining');
    } else {
      btn.querySelector('.button-icon').textContent = '▶';
      btn.querySelector('.button-text').textContent = 'Start Mining';
      btn.classList.remove('mining');
    }
  });
  
  // Update status indicator
  const statusDot = elements.miningStatus.querySelector('.status-dot');
  const statusText = elements.miningStatus.querySelector('.status-text');
  
  if (isMining) {
    statusDot.classList.remove('offline');
    statusDot.classList.add('online');
    statusText.textContent = 'Mining';
  } else {
    statusDot.classList.remove('online');
    statusDot.classList.add('offline');
    statusText.textContent = 'Not Mining';
  }
}

function pauseMining() {
  // Implement pause functionality
  showNotification('Mining paused', 'info');
}

// Settings Management
async function loadSettings() {
  state.settings = await window.api.getSettings();
  
  // Update UI with settings
  elements.btcAddress.value = state.settings.btcAddress || '';
  elements.useCpu.checked = state.settings.useCPU;
  elements.useGpu.checked = state.settings.useGPU;
  elements.cpuThreads.value = state.settings.cpuThreads || 0;
  elements.gpuIntensity.value = state.settings.gpuIntensity || 75;
  
  // Update slider displays
  elements.cpuThreadsValue.textContent = state.settings.cpuThreads === 0 ? 'Auto' : state.settings.cpuThreads;
  elements.gpuIntensityValue.textContent = `${state.settings.gpuIntensity || 75}%`;
  
  // Update toggle switches
  document.getElementById('auto-start-toggle').checked = state.settings.autoStart;
  document.getElementById('start-minimized-toggle').checked = state.settings.startMinimized;
  document.getElementById('minimize-tray-toggle').checked = state.settings.minimizeToTray;
  document.getElementById('idle-mining-toggle').checked = state.settings.idleMining;
  document.getElementById('idle-threshold').value = state.settings.idleThreshold || 5;
  document.getElementById('notifications-toggle').checked = state.settings.notifications;
  document.getElementById('auto-update-toggle').checked = state.settings.autoUpdate;
  document.getElementById('language-select').value = state.settings.language || 'en';
  document.getElementById('theme-select').value = state.settings.theme || 'dark';
  
  // Show/hide idle threshold
  document.getElementById('idle-threshold-setting').style.display = 
    state.settings.idleMining ? 'flex' : 'none';
}

async function saveSettings() {
  const newSettings = {
    btcAddress: elements.btcAddress.value,
    poolUrl: elements.poolSelect.value,
    useCPU: elements.useCpu.checked,
    useGPU: elements.useGpu.checked,
    cpuThreads: parseInt(elements.cpuThreads.value),
    gpuIntensity: parseInt(elements.gpuIntensity.value),
    autoStart: document.getElementById('auto-start-toggle').checked,
    startMinimized: document.getElementById('start-minimized-toggle').checked,
    minimizeToTray: document.getElementById('minimize-tray-toggle').checked,
    idleMining: document.getElementById('idle-mining-toggle').checked,
    idleThreshold: parseInt(document.getElementById('idle-threshold').value),
    notifications: document.getElementById('notifications-toggle').checked,
    autoUpdate: document.getElementById('auto-update-toggle').checked,
    language: document.getElementById('language-select').value,
    theme: document.getElementById('theme-select').value
  };
  
  const result = await window.api.saveSettings(newSettings);
  if (result.success) {
    showNotification('Settings saved successfully', 'success');
  } else {
    showNotification('Failed to save settings', 'error');
  }
}

async function resetSettings() {
  if (confirm('Are you sure you want to reset all settings to defaults?')) {
    // Reset to defaults
    await loadSettings();
    showNotification('Settings reset to defaults', 'info');
  }
}

// Pool Management
async function loadPools() {
  state.pools = await window.api.getPools();
  
  // Populate pool select
  elements.poolSelect.innerHTML = '';
  state.pools.forEach(pool => {
    const option = document.createElement('option');
    option.value = pool.url;
    option.textContent = `${pool.name} (${pool.region}) - ${pool.fee}`;
    if (pool.recommended) {
      option.textContent += ' ⭐';
    }
    elements.poolSelect.appendChild(option);
  });
  
  // Select current pool
  if (state.settings.poolUrl) {
    elements.poolSelect.value = state.settings.poolUrl;
  }
}

async function testPoolConnection() {
  const poolUrl = elements.poolSelect.value;
  if (!poolUrl) {
    showNotification('Please select a pool', 'warning');
    return;
  }
  
  showNotification('Testing pool connection...', 'info');
  
  const result = await window.api.testPool(poolUrl);
  if (result.success) {
    showNotification(`Pool connection successful! Latency: ${result.latency}ms`, 'success');
  } else {
    showNotification(`Pool connection failed: ${result.error}`, 'error');
  }
}

// Stats Updates
function startUIUpdater() {
  // Update stats every second
  setInterval(() => {
    updateStats();
    updateUptime();
  }, 1000);
}

async function updateStats() {
  const stats = await window.api.getStats();
  state.stats = stats;
  
  // Update hashrate
  const { value, unit } = formatHashrate(stats.hashrate);
  elements.currentHashrate.textContent = value;
  elements.currentHashrate.nextElementSibling.textContent = unit;
  
  // Update shares
  elements.sharesAccepted.textContent = stats.shares.accepted;
  elements.sharesRejected.textContent = stats.shares.rejected;
  
  const ratio = stats.shares.total > 0 
    ? ((stats.shares.accepted / stats.shares.total) * 100).toFixed(1)
    : 0;
  elements.shareRatio.textContent = `${ratio}%`;
  elements.shareProgress.style.width = `${ratio}%`;
  
  // Update earnings
  elements.earningsToday.textContent = formatBTC(stats.earnings.today);
  elements.earningsTotal.textContent = formatBTC(stats.earnings.total);
  elements.earningsPending.textContent = formatBTC(stats.earnings.pending);
  
  // Update hardware
  elements.cpuTemp.textContent = `${stats.temperature.cpu}°C`;
  elements.gpuTemp.textContent = `${stats.temperature.gpu}°C`;
  
  // Update charts
  updateCharts(stats);
}

function updateUptime() {
  if (!state.isMining) {
    elements.miningUptime.textContent = '0h 0m 0s';
    return;
  }
  
  const hours = Math.floor(state.stats.uptime / 3600);
  const minutes = Math.floor((state.stats.uptime % 3600) / 60);
  const seconds = state.stats.uptime % 60;
  
  elements.miningUptime.textContent = `${hours}h ${minutes}m ${seconds}s`;
}

async function refreshStats() {
  await updateStats();
  showNotification('Stats refreshed', 'success');
}

// Wallet Functions
async function copyAddress() {
  const address = elements.btcAddress.value;
  if (!address) {
    showNotification('No Bitcoin address configured', 'warning');
    return;
  }
  
  await navigator.clipboard.writeText(address);
  showNotification('Address copied to clipboard', 'success');
}

async function requestPayout() {
  const result = await window.api.requestPayout();
  if (result.success) {
    showNotification('Payout requested successfully', 'success');
  } else {
    showNotification(`Payout request failed: ${result.error}`, 'error');
  }
}

async function viewTransactions() {
  // Navigate to transactions page or open modal
  showNotification('Opening transaction history...', 'info');
}

// Logging
function showLogs() {
  elements.logModal.classList.add('active');
  updateLogDisplay();
}

function updateLogDisplay() {
  elements.logContent.innerHTML = state.logs
    .map(log => `<div class="log-entry ${log.level}">[${log.time}] ${log.message}</div>`)
    .join('');
  elements.logContent.scrollTop = elements.logContent.scrollHeight;
}

function clearLogs() {
  state.logs = [];
  updateLogDisplay();
  showNotification('Logs cleared', 'info');
}

async function exportLogs() {
  const logsText = state.logs
    .map(log => `[${log.time}] [${log.level.toUpperCase()}] ${log.message}`)
    .join('\n');
  
  const blob = new Blob([logsText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `otedama-logs-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  showNotification('Logs exported', 'success');
}

// Charts
let charts = {};

function setupCharts() {
  // Hashrate chart
  const hashrateCtx = document.getElementById('hashrate-chart').getContext('2d');
  charts.hashrate = createLineChart(hashrateCtx, 'Hashrate', '#00d4ff');
  
  // Hashrate history chart
  const hashrateHistoryCtx = document.getElementById('hashrate-history-chart').getContext('2d');
  charts.hashrateHistory = createLineChart(hashrateHistoryCtx, 'Hashrate History', '#00d4ff');
  
  // Shares history chart
  const sharesHistoryCtx = document.getElementById('shares-history-chart').getContext('2d');
  charts.sharesHistory = createBarChart(sharesHistoryCtx, 'Shares', ['#00ff88', '#ff4444']);
  
  // Earnings history chart
  const earningsHistoryCtx = document.getElementById('earnings-history-chart').getContext('2d');
  charts.earningsHistory = createLineChart(earningsHistoryCtx, 'Earnings', '#ffaa00');
}

function createLineChart(ctx, label, color) {
  // Simplified chart creation - in production, use Chart.js
  return {
    update: (data) => {
      // Update chart data
    }
  };
}

function createBarChart(ctx, label, colors) {
  // Simplified chart creation - in production, use Chart.js
  return {
    update: (data) => {
      // Update chart data
    }
  };
}

function updateCharts(stats) {
  // Update chart data
  if (charts.hashrate) {
    charts.hashrate.update(stats.hashrate);
  }
}

function updateChartsForPeriod(period) {
  // Load and display data for selected period
  showNotification(`Loading ${period} data...`, 'info');
}

// Utilities
function formatHashrate(hashrate) {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let unitIndex = 0;
  let value = hashrate;
  
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  
  return {
    value: value.toFixed(2),
    unit: units[unitIndex]
  };
}

function formatBTC(satoshis) {
  const btc = satoshis / 100000000;
  return btc.toFixed(8) + ' BTC';
}

function showNotification(message, type = 'info') {
  elements.notificationToast.textContent = message;
  elements.notificationToast.className = `notification-toast ${type} show`;
  
  setTimeout(() => {
    elements.notificationToast.classList.remove('show');
  }, 3000);
}

function openCalculator() {
  window.api.openExternal('https://www.coinwarz.com/mining-calculators/bitcoin-mining-calculator');
}

// IPC Event Handlers
window.api.on('mining-status', (isMining) => {
  updateMiningButton(isMining);
});

window.api.on('stats-update', (stats) => {
  state.stats = stats;
  updateStats();
});

window.api.on('notification', ({ message, type }) => {
  showNotification(message, type);
});

window.api.on('navigate', (page) => {
  navigateToPage(page);
});

window.api.on('theme-change', (theme) => {
  document.body.className = `theme-${theme}`;
});

window.api.on('connection-state', (state) => {
  elements.currentPool.textContent = state === 'connected' 
    ? elements.poolSelect.selectedOptions[0]?.textContent || 'Connected'
    : 'Not connected';
});

// Add log entry
window.api.on('log', (log) => {
  state.logs.push({
    time: new Date().toLocaleTimeString(),
    level: log.level || 'info',
    message: log.message
  });
  
  if (state.logs.length > 1000) {
    state.logs.shift();
  }
  
  if (elements.logModal.classList.contains('active')) {
    updateLogDisplay();
  }
});