#!/usr/bin/env node
// Real-time monitoring dashboard for Otedama Pool
import * as blessed from 'blessed';
import * as contrib from 'blessed-contrib';
import axios from 'axios';
import * as WebSocket from 'ws';

interface PoolStats {
  pool: {
    hashrate: number;
    activeMiners: number;
    totalMiners: number;
    validShares: number;
    invalidShares: number;
    blocksFound: number;
  };
  stratum: {
    connections: number;
  };
  system: {
    memoryUsed: number;
    memoryTotal: number;
    cpuUsage: number;
  };
}

class PoolMonitor {
  private screen: blessed.Widgets.Screen;
  private grid: any;
  private widgets: {
    hashrate: any;
    miners: any;
    shares: any;
    blocks: any;
    logs: any;
    connections: any;
    memory: any;
    alerts: any;
  };
  private ws: WebSocket | null = null;
  private apiUrl: string;
  private wsUrl: string;
  private updateInterval: NodeJS.Timeout | null = null;
  
  constructor(
    apiUrl: string = 'http://localhost:8088',
    wsUrl: string = 'ws://localhost:8081'
  ) {
    this.apiUrl = apiUrl;
    this.wsUrl = wsUrl;
    
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Otedama Pool Monitor'
    });
    
    // Create grid
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen
    });
    
    // Create widgets
    this.widgets = this.createWidgets();
    
    // Setup key bindings
    this.setupKeyBindings();
  }
  
  private createWidgets() {
    // Hashrate chart
    const hashrate = this.grid.set(0, 0, 4, 8, contrib.line, {
      style: {
        line: "yellow",
        text: "green",
        baseline: "black"
      },
      xLabelPadding: 3,
      xPadding: 5,
      showLegend: true,
      wholeNumbersOnly: false,
      label: 'Pool Hashrate (TH/s)'
    });
    
    // Miners gauge
    const miners = this.grid.set(0, 8, 2, 4, contrib.gauge, {
      label: 'Active Miners',
      stroke: 'green',
      fill: 'white',
      percent: 0
    });
    
    // Shares donut
    const shares = this.grid.set(2, 8, 2, 4, contrib.donut, {
      label: 'Shares',
      radius: 8,
      arcWidth: 3,
      remainColor: 'black',
      yPadding: 2
    });
    
    // Blocks table
    const blocks = this.grid.set(4, 0, 4, 6, contrib.table, {
      keys: true,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      label: 'Recent Blocks',
      width: '30%',
      height: '30%',
      border: { type: "line", fg: "cyan" },
      columnSpacing: 10,
      columnWidth: [10, 12, 20]
    });
    
    // Log display
    const logs = this.grid.set(8, 0, 4, 8, contrib.log, {
      fg: "green",
      selectedFg: "green",
      label: 'Live Logs'
    });
    
    // Connections
    const connections = this.grid.set(4, 6, 2, 6, blessed.box, {
      label: 'Connections',
      content: 'Loading...',
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' }
      }
    });
    
    // Memory usage
    const memory = this.grid.set(6, 6, 2, 6, contrib.gauge, {
      label: 'Memory Usage',
      stroke: 'blue',
      fill: 'white',
      percent: 0
    });
    
    // Alerts
    const alerts = this.grid.set(8, 8, 4, 4, blessed.list, {
      label: 'Alerts',
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'red' },
        selected: {
          bg: 'red',
          fg: 'white'
        }
      },
      mouse: true,
      keys: true
    });
    
    return {
      hashrate,
      miners,
      shares,
      blocks,
      logs,
      connections,
      memory,
      alerts
    };
  }
  
  private setupKeyBindings(): void {
    // Quit on q or Ctrl-C
    this.screen.key(['q', 'C-c'], () => {
      this.stop();
      process.exit(0);
    });
    
    // Refresh on r
    this.screen.key(['r'], () => {
      this.updateStats();
    });
    
    // Clear logs on c
    this.screen.key(['c'], () => {
      this.widgets.logs.log('Logs cleared');
    });
  }
  
  async start(): Promise<void> {
    // Initial render
    this.screen.render();
    
    // Connect to WebSocket
    this.connectWebSocket();
    
    // Start polling API
    this.updateStats();
    this.updateInterval = setInterval(() => {
      this.updateStats();
    }, 5000);
    
    // Show welcome message
    this.widgets.logs.log('Otedama Pool Monitor started');
    this.widgets.logs.log('Press q to quit, r to refresh, c to clear logs');
  }
  
  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => {
        this.widgets.logs.log('WebSocket connected');
      });
      
      this.ws.on('message', (data: string) => {
        try {
          const message = JSON.parse(data);
          this.handleWebSocketMessage(message);
        } catch (error) {
          this.widgets.logs.log(`WebSocket error: ${error}`);
        }
      });
      
      this.ws.on('close', () => {
        this.widgets.logs.log('WebSocket disconnected, reconnecting...');
        setTimeout(() => this.connectWebSocket(), 5000);
      });
      
      this.ws.on('error', (error) => {
        this.widgets.logs.log(`WebSocket error: ${error.message}`);
      });
    } catch (error) {
      this.widgets.logs.log(`Failed to connect WebSocket: ${error}`);
    }
  }
  
  private handleWebSocketMessage(message: any): void {
    switch (message.type) {
      case 'share':
        this.widgets.logs.log(`Share accepted: ${message.minerId} (${message.difficulty})`);
        break;
        
      case 'block':
        this.widgets.alerts.addItem(`BLOCK FOUND! Height: ${message.height}`);
        this.screen.render();
        break;
        
      case 'miner_connect':
        this.widgets.logs.log(`Miner connected: ${message.minerId}`);
        break;
        
      case 'miner_disconnect':
        this.widgets.logs.log(`Miner disconnected: ${message.minerId}`);
        break;
    }
  }
  
  private async updateStats(): Promise<void> {
    try {
      // Fetch pool stats
      const response = await axios.get(`${this.apiUrl}/api/v1/pool/stats`);
      const stats: PoolStats = response.data.data;
      
      // Update hashrate chart
      this.updateHashrateChart(stats.pool.hashrate);
      
      // Update miners gauge
      const minerPercent = (stats.pool.activeMiners / Math.max(stats.pool.totalMiners, 1)) * 100;
      this.widgets.miners.setPercent(minerPercent);
      this.widgets.miners.setLabel(`Active Miners: ${stats.pool.activeMiners}/${stats.pool.totalMiners}`);
      
      // Update shares donut
      const totalShares = stats.pool.validShares + stats.pool.invalidShares;
      if (totalShares > 0) {
        this.widgets.shares.setData([
          { percent: stats.pool.validShares / totalShares, label: 'Valid', color: 'green' },
          { percent: stats.pool.invalidShares / totalShares, label: 'Invalid', color: 'red' }
        ]);
      }
      
      // Update connections
      this.widgets.connections.setContent(
        `Stratum Connections: ${stats.stratum.connections}\n` +
        `Total Hashrate: ${this.formatHashrate(stats.pool.hashrate)}\n` +
        `Blocks Found: ${stats.pool.blocksFound}`
      );
      
      // Update memory gauge
      if (stats.system.memoryTotal > 0) {
        const memPercent = (stats.system.memoryUsed / stats.system.memoryTotal) * 100;
        this.widgets.memory.setPercent(memPercent);
      }
      
      // Fetch and update blocks
      await this.updateBlocks();
      
      this.screen.render();
    } catch (error) {
      this.widgets.logs.log(`API error: ${(error as Error).message}`);
    }
  }
  
  private hashrateHistory: Array<[number, number]> = [];
  
  private updateHashrateChart(hashrate: number): void {
    const now = Date.now();
    this.hashrateHistory.push([now, hashrate / 1e12]); // Convert to TH/s
    
    // Keep last 50 points
    if (this.hashrateHistory.length > 50) {
      this.hashrateHistory.shift();
    }
    
    // Format data for chart
    const x = this.hashrateHistory.map((_, i) => i.toString());
    const y = this.hashrateHistory.map(h => h[1]);
    
    this.widgets.hashrate.setData([{
      title: 'Hashrate',
      x: x,
      y: y,
      style: { line: 'yellow' }
    }]);
  }
  
  private async updateBlocks(): Promise<void> {
    try {
      const response = await axios.get(`${this.apiUrl}/api/v1/blocks/recent?limit=10`);
      const blocks = response.data.data || [];
      
      const tableData = blocks.map((block: any) => [
        block.height.toString(),
        new Date(block.timestamp).toLocaleTimeString(),
        block.reward.toFixed(8)
      ]);
      
      this.widgets.blocks.setData({
        headers: ['Height', 'Time', 'Reward'],
        data: tableData
      });
    } catch (error) {
      // Blocks endpoint might not exist, ignore
    }
  }
  
  private formatHashrate(hashrate: number): string {
    if (hashrate >= 1e15) return `${(hashrate / 1e15).toFixed(2)} PH/s`;
    if (hashrate >= 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
    if (hashrate >= 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    if (hashrate >= 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
    if (hashrate >= 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
    return `${hashrate.toFixed(2)} H/s`;
  }
  
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    if (this.ws) {
      this.ws.close();
    }
    
    this.screen.destroy();
  }
}

// ASCII Art Banner
function showBanner(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   ██████╗ ████████╗███████╗██████╗  █████╗ ███╗   ███╗ █████╗   ║
║  ██╔═══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔══██╗  ║
║  ██║   ██║   ██║   █████╗  ██║  ██║███████║██╔████╔██║███████║  ║
║  ██║   ██║   ██║   ██╔══╝  ██║  ██║██╔══██║██║╚██╔╝██║██╔══██║  ║
║  ╚██████╔╝   ██║   ███████╗██████╔╝██║  ██║██║ ╚═╝ ██║██║  ██║  ║
║   ╚═════╝    ╚═╝   ╚══════╝╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝  ║
║                                                                   ║
║                    Pool Monitor v1.0.0                            ║
╚═══════════════════════════════════════════════════════════════════╝
`);
}

// Main execution
async function main() {
  // Check if running in terminal
  if (!process.stdout.isTTY) {
    console.error('This monitor requires an interactive terminal');
    process.exit(1);
  }
  
  // Parse command line arguments
  const apiUrl = process.argv[2] || 'http://localhost:8088';
  const wsUrl = process.argv[3] || 'ws://localhost:8081';
  
  // Show banner in non-monitor mode
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showBanner();
    console.log('Usage: npm run monitor [API_URL] [WS_URL]');
    console.log('');
    console.log('Default:');
    console.log('  API_URL: http://localhost:8088');
    console.log('  WS_URL: ws://localhost:8081');
    console.log('');
    console.log('Example:');
    console.log('  npm run monitor http://pool.example.com:8088 ws://pool.example.com:8081');
    process.exit(0);
  }
  
  // Create and start monitor
  const monitor = new PoolMonitor(apiUrl, wsUrl);
  
  try {
    await monitor.start();
  } catch (error) {
    console.error('Failed to start monitor:', error);
    process.exit(1);
  }
}

// Note: This is a mock implementation since blessed-contrib is not installed
// In production, you would need to install: npm install blessed blessed-contrib axios ws @types/blessed @types/ws

if (require.main === module) {
  main();
}
