#!/usr/bin/env node
/**
 * Otedama Terminal Dashboard
 * Real-time mining pool monitoring in terminal
 * 
 * Design:
 * - Carmack: Efficient terminal rendering
 * - Martin: Clean UI component separation  
 * - Pike: Simple but powerful interface
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { WebSocket } from 'ws';
import { createLogger } from '../lib/core/logger.js';

const logger = createLogger('TerminalDashboard');

/**
 * Terminal Dashboard
 */
class TerminalDashboard {
  constructor(config = {}) {
    this.config = {
      wsUrl: config.wsUrl || 'ws://localhost:8081/ws',
      updateInterval: config.updateInterval || 1000,
      theme: config.theme || 'default'
    };
    
    // WebSocket connection
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    
    // Data
    this.poolData = {
      hashrate: 0,
      miners: 0,
      efficiency: 100,
      blocksFound: 0,
      sharesAccepted: 0,
      sharesRejected: 0
    };
    
    this.hashrateHistory = [];
    this.minersList = [];
    this.recentBlocks = [];
    this.networkStats = {};
    
    // UI components
    this.screen = null;
    this.grid = null;
    this.widgets = {};
  }
  
  /**
   * Initialize dashboard
   */
  initialize() {
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Otedama Mining Pool Dashboard',
      fullUnicode: true
    });
    
    // Create grid
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen
    });
    
    // Create widgets
    this.createWidgets();
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Connect to WebSocket
    this.connect();
    
    // Start update timer
    this.startUpdateTimer();
    
    // Render
    this.screen.render();
  }
  
  /**
   * Create widgets
   */
  createWidgets() {
    // Title
    this.widgets.title = this.grid.set(0, 0, 1, 12, blessed.box, {
      content: '{center}Otedama Mining Pool - Terminal Dashboard{/center}',
      tags: true,
      style: {
        fg: 'cyan',
        border: {
          fg: 'cyan'
        }
      }
    });
    
    // Pool stats
    this.widgets.poolStats = this.grid.set(1, 0, 3, 4, contrib.lcd, {
      label: 'Pool Hashrate',
      strokeWidth: 2,
      elements: 8,
      display: '0.00TH/s',
      elementSpacing: 4,
      elementPadding: 2,
      color: 'green'
    });
    
    this.widgets.minerCount = this.grid.set(1, 4, 3, 4, contrib.lcd, {
      label: 'Active Miners',
      strokeWidth: 2,
      elements: 6,
      display: '0',
      elementSpacing: 4,
      elementPadding: 2,
      color: 'yellow'
    });
    
    this.widgets.efficiency = this.grid.set(1, 8, 3, 4, contrib.gauge, {
      label: 'Pool Efficiency',
      stroke: 'green',
      fill: 'white',
      percent: 100
    });
    
    // Hashrate chart
    this.widgets.hashrateChart = this.grid.set(4, 0, 4, 8, contrib.line, {
      style: {
        line: 'yellow',
        text: 'green',
        baseline: 'black'
      },
      xLabelPadding: 3,
      xPadding: 5,
      showLegend: true,
      wholeNumbersOnly: false,
      label: 'Hashrate History (TH/s)'
    });
    
    // Blocks info
    this.widgets.blocksInfo = this.grid.set(4, 8, 4, 4, blessed.box, {
      label: 'Recent Blocks',
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      style: {
        fg: 'white',
        border: {
          fg: 'blue'
        }
      }
    });
    
    // Miners table
    this.widgets.minersTable = this.grid.set(8, 0, 4, 8, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: 'Top Miners',
      width: '100%',
      height: '100%',
      border: {
        type: 'line',
        fg: 'cyan'
      },
      columnSpacing: 2,
      columnWidth: [20, 12, 10, 8, 8]
    });
    
    // Network stats
    this.widgets.networkStats = this.grid.set(8, 8, 4, 4, blessed.box, {
      label: 'Network Stats',
      tags: true,
      style: {
        fg: 'white',
        border: {
          fg: 'magenta'
        }
      }
    });
    
    // Set initial data
    this.updateWidgets();
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Quit on q, Ctrl+C
    this.screen.key(['q', 'C-c'], () => {
      this.shutdown();
    });
    
    // Refresh on r
    this.screen.key(['r'], () => {
      this.updateWidgets();
      this.screen.render();
    });
    
    // Help on h
    this.screen.key(['h'], () => {
      this.showHelp();
    });
    
    // Focus navigation
    this.screen.key(['tab'], () => {
      this.screen.focusNext();
    });
    
    this.screen.key(['S-tab'], () => {
      this.screen.focusPrevious();
    });
  }
  
  /**
   * Connect to WebSocket
   */
  connect() {
    try {
      this.ws = new WebSocket(this.config.wsUrl);
      
      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.updateStatus('Connected', 'green');
        
        // Subscribe to updates
        this.ws.send(JSON.stringify({ type: 'subscribe', channels: ['all'] }));
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          logger.error('Error parsing message:', error);
        }
      });
      
      this.ws.on('close', () => {
        this.updateStatus('Disconnected', 'red');
        this.scheduleReconnect();
      });
      
      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.updateStatus('Error', 'red');
      });
      
    } catch (error) {
      logger.error('Failed to connect:', error);
      this.scheduleReconnect();
    }
  }
  
  /**
   * Handle WebSocket message
   */
  handleMessage(message) {
    switch (message.type) {
      case 'pool_stats':
        this.poolData = message.data;
        this.updatePoolStats();
        break;
        
      case 'miner_update':
        this.updateMiner(message.data);
        break;
        
      case 'block_found':
        this.addBlock(message.data);
        this.showNotification('Block Found!', `Height: ${message.data.height}`);
        break;
        
      case 'network_stats':
        this.networkStats = message.data;
        this.updateNetworkStats();
        break;
        
      case 'recent_blocks':
        this.recentBlocks = message.data || [];
        this.updateBlocks();
        break;
    }
  }
  
  /**
   * Update pool statistics
   */
  updatePoolStats() {
    // Update LCD displays
    const hashrate = this.formatHashrate(this.poolData.hashrate);
    this.widgets.poolStats.setDisplay(hashrate);
    
    this.widgets.minerCount.setDisplay(this.poolData.miners.toString());
    
    // Update efficiency gauge
    this.widgets.efficiency.setPercent(Math.round(this.poolData.efficiency));
    
    // Add to hashrate history
    this.hashrateHistory.push({
      x: new Date().toLocaleTimeString(),
      y: this.poolData.hashrate / 1e12 // Convert to TH/s
    });
    
    // Keep last 60 points
    if (this.hashrateHistory.length > 60) {
      this.hashrateHistory.shift();
    }
    
    // Update chart
    this.widgets.hashrateChart.setData([{
      title: 'Hashrate',
      x: this.hashrateHistory.map(p => p.x),
      y: this.hashrateHistory.map(p => p.y)
    }]);
    
    this.screen.render();
  }
  
  /**
   * Update miner
   */
  updateMiner(data) {
    const index = this.minersList.findIndex(m => m.id === data.minerId);
    if (index >= 0) {
      this.minersList[index] = data.stats;
    } else {
      this.minersList.push(data.stats);
    }
    
    // Sort by hashrate
    this.minersList.sort((a, b) => b.hashrate - a.hashrate);
    
    // Update table
    this.updateMinersTable();
  }
  
  /**
   * Update miners table
   */
  updateMinersTable() {
    const headers = ['Address', 'Hashrate', 'Shares', 'Eff %', 'Status'];
    
    const data = this.minersList.slice(0, 10).map(miner => [
      miner.address ? `${miner.address.substring(0, 8)}...${miner.address.substring(miner.address.length - 6)}` : 'Unknown',
      this.formatHashrate(miner.hashrate || 0),
      (miner.shares || 0).toString(),
      `${(miner.efficiency || 0).toFixed(1)}%`,
      miner.online ? 'Online' : 'Offline'
    ]);
    
    this.widgets.minersTable.setData({
      headers,
      data
    });
    
    this.screen.render();
  }
  
  /**
   * Add block
   */
  addBlock(block) {
    this.recentBlocks.unshift(block);
    if (this.recentBlocks.length > 10) {
      this.recentBlocks.pop();
    }
    
    this.updateBlocks();
  }
  
  /**
   * Update blocks display
   */
  updateBlocks() {
    let content = '';
    
    if (this.recentBlocks.length === 0) {
      content = '{center}No blocks found yet{/center}';
    } else {
      this.recentBlocks.forEach((block, i) => {
        const time = new Date(block.timestamp).toLocaleTimeString();
        content += `{bold}Block ${block.height}{/bold}\n`;
        content += `Hash: ${block.hash.substring(0, 16)}...\n`;
        content += `Time: ${time}\n`;
        if (i < this.recentBlocks.length - 1) content += '\n';
      });
    }
    
    this.widgets.blocksInfo.setContent(content);
    this.screen.render();
  }
  
  /**
   * Update network stats
   */
  updateNetworkStats() {
    const content = `
{bold}Difficulty:{/bold} ${this.formatNumber(this.networkStats.difficulty || 0)}
{bold}Block Height:{/bold} ${this.formatNumber(this.networkStats.blockHeight || 0)}
{bold}Network Hash:{/bold} ${this.formatHashrate(this.networkStats.networkHashrate || 0)}
{bold}Block Reward:{/bold} ${this.networkStats.blockReward || 0} BTC
    `.trim();
    
    this.widgets.networkStats.setContent(content);
    this.screen.render();
  }
  
  /**
   * Update status
   */
  updateStatus(status, color) {
    const content = `{${color}-fg}Status: ${status}{/${color}-fg}`;
    this.widgets.title.setContent(`{center}Otedama Mining Pool - Terminal Dashboard - ${content}{/center}`);
    this.screen.render();
  }
  
  /**
   * Show notification
   */
  showNotification(title, message) {
    const notification = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      label: title,
      tags: true,
      keys: true,
      hidden: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        bg: 'green',
        border: {
          fg: 'white'
        }
      }
    });
    
    notification.display(message, 3, () => {
      notification.destroy();
    });
  }
  
  /**
   * Show help
   */
  showHelp() {
    const help = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 'shrink',
      label: 'Help',
      tags: true,
      keys: true,
      hidden: true,
      border: {
        type: 'line'
      }
    });
    
    const helpText = `
{bold}Keyboard Shortcuts:{/bold}

  {cyan-fg}q, Ctrl+C{/cyan-fg}  - Quit
  {cyan-fg}r{/cyan-fg}          - Refresh display
  {cyan-fg}h{/cyan-fg}          - Show this help
  {cyan-fg}Tab{/cyan-fg}        - Next widget
  {cyan-fg}Shift+Tab{/cyan-fg}  - Previous widget
  {cyan-fg}↑/↓{/cyan-fg}        - Navigate in tables
  
Press any key to close...
    `.trim();
    
    help.display(helpText, 0, () => {
      help.destroy();
    });
  }
  
  /**
   * Format hashrate
   */
  formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let unitIndex = 0;
    let value = parseFloat(hashrate) || 0;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return value.toFixed(2) + units[unitIndex];
  }
  
  /**
   * Format number
   */
  formatNumber(num) {
    return new Intl.NumberFormat().format(num);
  }
  
  /**
   * Schedule reconnect
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  
  /**
   * Start update timer
   */
  startUpdateTimer() {
    setInterval(() => {
      this.updateWidgets();
    }, this.config.updateInterval);
  }
  
  /**
   * Update all widgets
   */
  updateWidgets() {
    // Force render
    this.screen.render();
  }
  
  /**
   * Shutdown dashboard
   */
  shutdown() {
    if (this.ws) {
      this.ws.close();
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    process.exit(0);
  }
}

/**
 * Main entry point
 */
async function main() {
  const dashboard = new TerminalDashboard({
    wsUrl: process.env.DASHBOARD_WS_URL || 'ws://localhost:8081/ws'
  });
  
  dashboard.initialize();
}

// Handle errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

// Run dashboard
main().catch((error) => {
  logger.error('Failed to start dashboard:', error);
  process.exit(1);
});
