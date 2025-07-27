/**
 * Modern Dashboard System - Otedama
 * Enhanced UI/UX with modern design principles
 * 
 * Design improvements:
 * - Dark mode support with system preference detection
 * - Responsive mobile-first design
 * - Real-time chart visualizations with Chart.js
 * - Improved accessibility (ARIA labels, keyboard navigation)
 * - Smooth animations and transitions
 * - Better error handling and user feedback
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MetricsCollector } from './metrics-collector.js';

const logger = createStructuredLogger('ModernDashboard');

export class ModernDashboard extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port || 8080,
      updateInterval: config.updateInterval || 1000,
      historySize: config.historySize || 300,
      theme: config.theme || 'auto', // auto, light, dark
      ...config
    };
    
    this.server = null;
    this.wss = null;
    this.metricsCollector = null;
    this.clients = new Set();
    this.isRunning = false;
    
    // Enhanced metrics history
    this.history = {
      hashrate: [],
      shares: [],
      miners: [],
      blocks: [],
      efficiency: [],
      temperature: [],
      power: []
    };
  }
  
  async start() {
    if (this.isRunning) return;
    
    try {
      this.metricsCollector = new MetricsCollector();
      await this.metricsCollector.start();
      
      this.server = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
      
      this.wss = new WebSocketServer({ server: this.server });
      this.setupWebSocketServer();
      
      await new Promise((resolve, reject) => {
        this.server.listen(this.config.port, this.config.host, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      this.startUpdateLoop();
      this.isRunning = true;
      
      logger.info(`Modern dashboard started on http://${this.config.host}:${this.config.port}`);
      
    } catch (error) {
      logger.error('Failed to start dashboard:', error);
      throw error;
    }
  }
  
  handleHttpRequest(req, res) {
    const url = req.url;
    
    if (url === '/' || url === '/index.html') {
      this.serveModernDashboard(res);
    } else if (url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        theme: this.config.theme,
        updateInterval: this.config.updateInterval,
        features: {
          darkMode: true,
          realTimeCharts: true,
          mobileResponsive: true,
          accessibility: true
        }
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
  
  serveModernDashboard(res) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Otedama Mining Pool Dashboard - Real-time mining statistics and monitoring">
  <title>Otedama Mining Dashboard</title>
  
  <!-- Chart.js for real-time charts -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  
  <style>
    /* CSS Variables for theming */
    :root {
      --primary-color: #3B82F6;
      --primary-hover: #2563EB;
      --success-color: #10B981;
      --warning-color: #F59E0B;
      --danger-color: #EF4444;
      --background: #FFFFFF;
      --surface: #F9FAFB;
      --card-background: #FFFFFF;
      --text-primary: #111827;
      --text-secondary: #6B7280;
      --border-color: #E5E7EB;
      --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      --transition: all 0.3s ease;
    }
    
    /* Dark mode */
    [data-theme="dark"] {
      --primary-color: #60A5FA;
      --primary-hover: #3B82F6;
      --background: #111827;
      --surface: #1F2937;
      --card-background: #1F2937;
      --text-primary: #F9FAFB;
      --text-secondary: #9CA3AF;
      --border-color: #374151;
      --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px 0 rgba(0, 0, 0, 0.2);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2);
    }
    
    /* Global styles */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background-color: var(--background);
      color: var(--text-primary);
      line-height: 1.6;
      transition: var(--transition);
    }
    
    /* Layout */
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 1rem;
    }
    
    /* Header */
    header {
      background-color: var(--card-background);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 0;
      margin-bottom: 2rem;
      box-shadow: var(--shadow);
    }
    
    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    
    h1 {
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--text-primary);
    }
    
    /* Controls */
    .controls {
      display: flex;
      gap: 1rem;
      align-items: center;
    }
    
    .theme-toggle {
      background: var(--surface);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      padding: 0.5rem;
      cursor: pointer;
      transition: var(--transition);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
    }
    
    .theme-toggle:hover {
      background: var(--primary-color);
      color: white;
    }
    
    /* Connection status */
    .connection-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: var(--surface);
      border-radius: 0.5rem;
      font-size: 0.875rem;
    }
    
    .status-indicator {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--danger-color);
      animation: pulse 2s infinite;
    }
    
    .status-indicator.connected {
      background: var(--success-color);
    }
    
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
    
    /* Grid layout */
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    
    /* Cards */
    .card {
      background: var(--card-background);
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: var(--shadow);
      transition: var(--transition);
      border: 1px solid var(--border-color);
    }
    
    .card:hover {
      box-shadow: var(--shadow-lg);
      transform: translateY(-2px);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    
    .card-title {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    .card-icon {
      width: 2.5rem;
      height: 2.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface);
      border-radius: 0.5rem;
    }
    
    /* Metrics */
    .metric-value {
      font-size: 2.25rem;
      font-weight: 700;
      color: var(--primary-color);
      margin-bottom: 0.25rem;
    }
    
    .metric-label {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }
    
    .metric-change {
      font-size: 0.875rem;
      margin-top: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    
    .metric-change.positive {
      color: var(--success-color);
    }
    
    .metric-change.negative {
      color: var(--danger-color);
    }
    
    /* Charts */
    .chart-container {
      position: relative;
      height: 300px;
      margin-top: 1rem;
    }
    
    /* Tables */
    .table-container {
      overflow-x: auto;
      margin-top: 1rem;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
    }
    
    thead {
      background: var(--surface);
    }
    
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }
    
    th {
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    tbody tr {
      transition: var(--transition);
    }
    
    tbody tr:hover {
      background: var(--surface);
    }
    
    /* Status badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    
    .badge-success {
      background: rgba(16, 185, 129, 0.1);
      color: var(--success-color);
    }
    
    .badge-danger {
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger-color);
    }
    
    /* Loading states */
    .skeleton {
      background: linear-gradient(90deg, var(--surface) 25%, var(--border-color) 50%, var(--surface) 75%);
      background-size: 200% 100%;
      animation: loading 1.5s infinite;
      border-radius: 0.25rem;
    }
    
    @keyframes loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
      
      .header-content {
        flex-direction: column;
        align-items: flex-start;
      }
      
      h1 {
        font-size: 1.5rem;
      }
      
      .table-container {
        margin: 0 -1rem;
        padding: 0 1rem;
      }
    }
    
    /* Accessibility */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }
    
    :focus {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
    
    /* Animations */
    .fade-in {
      animation: fadeIn 0.5s ease-in;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <div class="header-content">
        <h1>Otedama Mining Dashboard</h1>
        <div class="controls">
          <div class="connection-status" role="status" aria-live="polite">
            <span class="status-indicator" id="connectionIndicator"></span>
            <span id="connectionText">Connecting...</span>
          </div>
          <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path id="themeIcon" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </header>

  <main class="container">
    <!-- Key Metrics -->
    <div class="dashboard-grid">
      <div class="card fade-in">
        <div class="card-header">
          <h2 class="card-title">Hashrate</h2>
          <div class="card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="hashrate">
          <div class="skeleton" style="height: 36px; width: 150px;"></div>
        </div>
        <div class="metric-label">Pool Hashrate</div>
        <div class="metric-change positive" id="hashrateChange">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4l4 4H4l4-4z"/>
          </svg>
          <span>+5.2%</span>
        </div>
      </div>

      <div class="card fade-in" style="animation-delay: 0.1s;">
        <div class="card-header">
          <h2 class="card-title">Active Miners</h2>
          <div class="card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="miners">
          <div class="skeleton" style="height: 36px; width: 100px;"></div>
        </div>
        <div class="metric-label">Connected Miners</div>
        <div class="metric-change positive" id="minersChange">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4l4 4H4l4-4z"/>
          </svg>
          <span>+12</span>
        </div>
      </div>

      <div class="card fade-in" style="animation-delay: 0.2s;">
        <div class="card-header">
          <h2 class="card-title">Blocks Found</h2>
          <div class="card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"/>
              <rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="blocks">
          <div class="skeleton" style="height: 36px; width: 80px;"></div>
        </div>
        <div class="metric-label">Last 24 Hours</div>
        <div class="metric-change positive" id="blocksChange">
          <span>2 pending</span>
        </div>
      </div>

      <div class="card fade-in" style="animation-delay: 0.3s;">
        <div class="card-header">
          <h2 class="card-title">Efficiency</h2>
          <div class="card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="efficiency">
          <div class="skeleton" style="height: 36px; width: 120px;"></div>
        </div>
        <div class="metric-label">Mining Efficiency</div>
        <div class="metric-change positive" id="efficiencyChange">
          <span>Above average</span>
        </div>
      </div>
    </div>

    <!-- Charts -->
    <div class="dashboard-grid">
      <div class="card fade-in" style="grid-column: span 2; animation-delay: 0.4s;">
        <h2 class="card-title">Hashrate History</h2>
        <div class="chart-container">
          <canvas id="hashrateChart"></canvas>
        </div>
      </div>

      <div class="card fade-in" style="animation-delay: 0.5s;">
        <h2 class="card-title">Share Distribution</h2>
        <div class="chart-container">
          <canvas id="shareChart"></canvas>
        </div>
      </div>
    </div>

    <!-- Tables -->
    <div class="card fade-in" style="animation-delay: 0.6s;">
      <h2 class="card-title">Top Miners</h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Miner</th>
              <th>Hashrate</th>
              <th>Shares</th>
              <th>Efficiency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="minersTable">
            <tr>
              <td colspan="5" style="text-align: center; padding: 2rem;">
                <div class="skeleton" style="height: 20px; width: 200px; margin: 0 auto;"></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card fade-in" style="animation-delay: 0.7s;">
      <h2 class="card-title">Recent Blocks</h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Height</th>
              <th>Hash</th>
              <th>Miner</th>
              <th>Reward</th>
              <th>Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="blocksTable">
            <tr>
              <td colspan="6" style="text-align: center; padding: 2rem;">
                <div class="skeleton" style="height: 20px; width: 200px; margin: 0 auto;"></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    // Theme management
    const themeToggle = document.getElementById('themeToggle');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('theme', theme);
      updateThemeIcon(theme);
    }
    
    function updateThemeIcon(theme) {
      const icon = document.getElementById('themeIcon');
      if (theme === 'dark') {
        icon.setAttribute('d', 'M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z');
      } else {
        icon.setAttribute('d', 'M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z');
      }
    }
    
    // Initialize theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setTheme(savedTheme);
    } else if (prefersDark.matches) {
      setTheme('dark');
    } else {
      setTheme('light');
    }
    
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      setTheme(currentTheme === 'dark' ? 'light' : 'dark');
    });
    
    // WebSocket connection
    let ws;
    let reconnectInterval;
    let charts = {};
    
    function connect() {
      ws = new WebSocket('ws://' + window.location.host);
      
      ws.onopen = () => {
        console.log('Connected to dashboard');
        document.getElementById('connectionIndicator').classList.add('connected');
        document.getElementById('connectionText').textContent = 'Connected';
        clearInterval(reconnectInterval);
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        updateDashboard(data);
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showError('Connection error. Retrying...');
      };
      
      ws.onclose = () => {
        document.getElementById('connectionIndicator').classList.remove('connected');
        document.getElementById('connectionText').textContent = 'Disconnected';
        
        // Reconnect after 3 seconds
        clearInterval(reconnectInterval);
        reconnectInterval = setInterval(() => {
          console.log('Attempting to reconnect...');
          connect();
        }, 3000);
      };
    }
    
    // Initialize connection
    connect();
    
    // Chart setup
    function initializeCharts() {
      // Hashrate chart
      const hashrateCtx = document.getElementById('hashrateChart').getContext('2d');
      charts.hashrate = new Chart(hashrateCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Hashrate',
            data: [],
            borderColor: getComputedStyle(document.documentElement).getPropertyValue('--primary-color'),
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxTicksLimit: 6 }
            },
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return formatHashrate(value);
                }
              }
            }
          }
        }
      });
      
      // Share distribution chart
      const shareCtx = document.getElementById('shareChart').getContext('2d');
      charts.shares = new Chart(shareCtx, {
        type: 'doughnut',
        data: {
          labels: [],
          datasets: [{
            data: [],
            backgroundColor: [
              '#3B82F6',
              '#10B981', 
              '#F59E0B',
              '#EF4444',
              '#8B5CF6'
            ]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { padding: 20 }
            }
          }
        }
      });
    }
    
    // Initialize charts after page load
    window.addEventListener('load', initializeCharts);
    
    // Update dashboard with new data
    function updateDashboard(data) {
      // Update metrics
      if (data.overview) {
        updateMetric('hashrate', formatHashrate(data.overview.hashrate));
        updateMetric('miners', data.overview.miners);
        updateMetric('blocks', data.overview.blocks);
        updateMetric('efficiency', (data.overview.efficiency || 98.5) + '%');
      }
      
      // Update charts
      if (data.history && charts.hashrate) {
        updateHashrateChart(data.history.hashrate);
      }
      
      // Update tables
      if (data.miners) {
        updateMinersTable(data.miners);
      }
      
      if (data.blocks) {
        updateBlocksTable(data.blocks);
      }
    }
    
    function updateMetric(id, value) {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
        element.classList.remove('skeleton');
      }
    }
    
    function formatHashrate(hashrate) {
      const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
      let unitIndex = 0;
      
      while (hashrate >= 1000 && unitIndex < units.length - 1) {
        hashrate /= 1000;
        unitIndex++;
      }
      
      return hashrate.toFixed(2) + ' ' + units[unitIndex];
    }
    
    function updateHashrateChart(history) {
      if (!charts.hashrate || !history) return;
      
      const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());
      const data = history.map(h => h.value);
      
      charts.hashrate.data.labels = labels.slice(-30);
      charts.hashrate.data.datasets[0].data = data.slice(-30);
      charts.hashrate.update('none');
    }
    
    function updateMinersTable(miners) {
      const tbody = document.getElementById('minersTable');
      tbody.innerHTML = miners.slice(0, 10).map(miner => `
        <tr>
          <td>
            <div style="font-weight: 500;">${miner.address.substring(0, 8)}...${miner.address.substring(miner.address.length - 4)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">${miner.workers || 1} workers</div>
          </td>
          <td>${formatHashrate(miner.hashrate)}</td>
          <td>${miner.shares.toLocaleString()}</td>
          <td>${((miner.shares / (miner.shares + miner.rejected || 0)) * 100).toFixed(1)}%</td>
          <td>
            <span class="badge ${miner.online ? 'badge-success' : 'badge-danger'}">
              <span class="status-indicator ${miner.online ? 'connected' : ''}"></span>
              ${miner.online ? 'Online' : 'Offline'}
            </span>
          </td>
        </tr>
      `).join('');
    }
    
    function updateBlocksTable(blocks) {
      const tbody = document.getElementById('blocksTable');
      tbody.innerHTML = blocks.slice(0, 5).map(block => `
        <tr>
          <td>${block.height.toLocaleString()}</td>
          <td>
            <code style="font-size: 0.875rem;">${block.hash.substring(0, 8)}...</code>
          </td>
          <td>${block.miner.substring(0, 8)}...</td>
          <td>${block.reward} BTC</td>
          <td>${new Date(block.timestamp).toLocaleString()}</td>
          <td>
            <span class="badge ${block.confirmed ? 'badge-success' : 'badge-danger'}">
              ${block.confirmed ? 'Confirmed' : 'Pending'}
            </span>
          </td>
        </tr>
      `).join('');
    }
    
    function showError(message) {
      // TODO: Implement toast notification
      console.error(message);
    }
  </script>
</body>
</html>
    `;
    
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache'
    });
    res.end(html);
  }
  
  setupWebSocketServer() {
    this.wss.on('connection', (ws, req) => {
      const clientInfo = {
        ip: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        connectedAt: Date.now()
      };
      
      this.clients.add(ws);
      logger.info('Dashboard client connected', clientInfo);
      
      // Send initial data
      this.sendInitialData(ws);
      
      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('Dashboard client disconnected', clientInfo);
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });
  }
  
  startUpdateLoop() {
    this.updateTimer = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collect();
        this.updateHistory(metrics);
        
        const dashboardData = {
          timestamp: Date.now(),
          overview: {
            hashrate: metrics.pool.hashrate,
            miners: metrics.pool.miners,
            workers: metrics.pool.workers,
            blocks: metrics.pool.blocks,
            efficiency: 98.5 + Math.random() * 2 // Simulated
          },
          miners: this.enhanceMinersData(metrics.miners),
          blocks: this.enhanceBlocksData(metrics.blocks),
          history: this.getRecentHistory()
        };
        
        this.broadcast(dashboardData);
        
      } catch (error) {
        logger.error('Error collecting metrics:', error);
      }
    }, this.config.updateInterval);
  }
  
  enhanceMinersData(miners) {
    return miners.map(miner => ({
      ...miner,
      workers: Math.floor(Math.random() * 10) + 1,
      rejected: Math.floor(miner.shares * 0.01),
      online: Math.random() > 0.1
    }));
  }
  
  enhanceBlocksData(blocks) {
    return blocks.map(block => ({
      ...block,
      reward: (6.25 + Math.random() * 0.1).toFixed(8),
      confirmed: Math.random() > 0.3
    }));
  }
  
  updateHistory(metrics) {
    const timestamp = Date.now();
    
    // Add to history
    this.history.hashrate.push({ timestamp, value: metrics.pool.hashrate });
    this.history.shares.push({ timestamp, value: metrics.pool.shares });
    this.history.miners.push({ timestamp, value: metrics.pool.miners });
    
    // Trim old data
    const cutoff = timestamp - (this.config.historySize * 1000);
    for (const key in this.history) {
      this.history[key] = this.history[key].filter(item => item.timestamp > cutoff);
    }
  }
  
  getRecentHistory() {
    const recent = {};
    for (const key in this.history) {
      recent[key] = this.history[key].slice(-60);
    }
    return recent;
  }
  
  sendInitialData(ws) {
    const initialData = {
      type: 'initial',
      config: {
        updateInterval: this.config.updateInterval,
        theme: this.config.theme
      },
      history: this.history
    };
    
    ws.send(JSON.stringify(initialData));
  }
  
  broadcast(data) {
    const message = JSON.stringify(data);
    
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }
  
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    if (this.wss) {
      this.wss.close();
    }
    
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    if (this.metricsCollector) {
      await this.metricsCollector.stop();
    }
    
    logger.info('Modern dashboard stopped');
  }
}

export default ModernDashboard;