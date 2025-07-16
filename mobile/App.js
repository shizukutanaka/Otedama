/**
 * Otedama Mobile App - Progressive Web Application
 * 
 * Design Philosophy:
 * - Mobile-first responsive design
 * - Offline capability
 * - Native app-like experience
 * - Real-time mining monitoring
 * - Multi-language support
 */

class OtedamaMobileApp {
  constructor() {
    this.apiUrl = this.detectApiUrl();
    this.isOnline = navigator.onLine;
    this.language = this.detectLanguage();
    this.theme = this.detectTheme();
    this.cache = new Map();
    this.websocket = null;
    
    this.init();
  }

  detectApiUrl() {
    // Auto-detect API URL based on current location
    const hostname = window.location.hostname;
    const port = window.location.port || '8080';
    return `${window.location.protocol}//${hostname}:${port}`;
  }

  detectLanguage() {
    // Detect user language
    const stored = localStorage.getItem('otedama-language');
    if (stored) return stored;
    
    const browser = navigator.language.split('-')[0];
    const supported = ['en', 'ja', 'zh', 'ko', 'es', 'fr', 'de', 'ru', 'it', 'pt', 'ar'];
    return supported.includes(browser) ? browser : 'en';
  }

  detectTheme() {
    const stored = localStorage.getItem('otedama-theme');
    if (stored) return stored;
    
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  async init() {
    await this.loadTranslations();
    this.setupServiceWorker();
    this.setupUI();
    this.setupWebSocket();
    this.setupEventListeners();
    this.startDataRefresh();
    
    console.log('📱 Otedama Mobile App initialized');
  }

  async loadTranslations() {
    const translations = {
      en: {
        title: 'Otedama Mining',
        hashrate: 'Hashrate',
        earnings: 'Earnings',
        miners: 'Miners',
        efficiency: 'Efficiency',
        start: 'Start Mining',
        stop: 'Stop Mining',
        settings: 'Settings',
        wallet: 'Wallet',
        currency: 'Currency',
        status: 'Status',
        online: 'Online',
        offline: 'Offline',
        connecting: 'Connecting...',
        error: 'Error',
        success: 'Success'
      },
      ja: {
        title: 'Otedama マイニング',
        hashrate: 'ハッシュレート',
        earnings: '収益',
        miners: 'マイナー',
        efficiency: '効率性',
        start: 'マイニング開始',
        stop: 'マイニング停止',
        settings: '設定',
        wallet: 'ウォレット',
        currency: '通貨',
        status: 'ステータス',
        online: 'オンライン',
        offline: 'オフライン',
        connecting: '接続中...',
        error: 'エラー',
        success: '成功'
      },
      zh: {
        title: 'Otedama 挖矿',
        hashrate: '算力',
        earnings: '收益',
        miners: '矿工',
        efficiency: '效率',
        start: '开始挖矿',
        stop: '停止挖矿',
        settings: '设置',
        wallet: '钱包',
        currency: '货币',
        status: '状态',
        online: '在线',
        offline: '离线',
        connecting: '连接中...',
        error: '错误',
        success: '成功'
      }
    };
    
    this.t = translations[this.language] || translations.en;
  }

  setupServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js')
        .then(registration => {
          console.log('Service Worker registered:', registration);
        })
        .catch(error => {
          console.log('Service Worker registration failed:', error);
        });
    }
  }

  setupUI() {
    document.body.innerHTML = `
      <div id="app" class="app ${this.theme}">
        <header class="header">
          <h1 class="title">${this.t.title}</h1>
          <div class="status ${this.isOnline ? 'online' : 'offline'}">
            ${this.isOnline ? this.t.online : this.t.offline}
          </div>
        </header>

        <main class="main">
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value" id="hashrate">0 H/s</div>
              <div class="stat-label">${this.t.hashrate}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="miners">0</div>
              <div class="stat-label">${this.t.miners}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="earnings">0</div>
              <div class="stat-label">${this.t.earnings}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="efficiency">0%</div>
              <div class="stat-label">${this.t.efficiency}</div>
            </div>
          </div>

          <div class="controls">
            <button id="toggleMining" class="btn btn-primary">
              ${this.t.start}
            </button>
            <button id="refreshData" class="btn btn-secondary">
              Refresh
            </button>
          </div>

          <div class="settings-panel" id="settingsPanel" style="display: none;">
            <h3>${this.t.settings}</h3>
            <div class="form-group">
              <label>${this.t.wallet}:</label>
              <input type="text" id="walletInput" placeholder="Your wallet address">
            </div>
            <div class="form-group">
              <label>${this.t.currency}:</label>
              <select id="currencySelect">
                <option value="RVN">Ravencoin (RVN)</option>
                <option value="BTC">Bitcoin (BTC)</option>
                <option value="ETH">Ethereum (ETH)</option>
                <option value="XMR">Monero (XMR)</option>
                <option value="LTC">Litecoin (LTC)</option>
              </select>
            </div>
          </div>
        </main>

        <nav class="bottom-nav">
          <button class="nav-btn active" data-view="stats">
            📊 Stats
          </button>
          <button class="nav-btn" data-view="mining">
            ⛏️ Mining
          </button>
          <button class="nav-btn" data-view="dex">
            💱 DEX
          </button>
          <button class="nav-btn" data-view="settings">
            ⚙️ Settings
          </button>
        </nav>
      </div>
    `;

    this.injectStyles();
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.6;
        -webkit-font-smoothing: antialiased;
        overscroll-behavior: none;
      }

      .app {
        min-height: 100vh;
        background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
        color: white;
        display: flex;
        flex-direction: column;
      }

      .header {
        padding: 1rem;
        background: rgba(0,0,0,0.2);
        display: flex;
        justify-content: space-between;
        align-items: center;
        backdrop-filter: blur(10px);
      }

      .title {
        font-size: 1.5rem;
        font-weight: 600;
      }

      .status {
        padding: 0.5rem 1rem;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: 500;
      }

      .status.online {
        background: rgba(46, 204, 113, 0.2);
        border: 1px solid #2ecc71;
      }

      .status.offline {
        background: rgba(231, 76, 60, 0.2);
        border: 1px solid #e74c3c;
      }

      .main {
        flex: 1;
        padding: 1rem;
        overflow-y: auto;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        margin-bottom: 2rem;
      }

      .stat-card {
        background: rgba(255,255,255,0.1);
        padding: 1.5rem;
        border-radius: 12px;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.2);
        text-align: center;
      }

      .stat-value {
        font-size: 1.5rem;
        font-weight: bold;
        color: #3498db;
        margin-bottom: 0.5rem;
      }

      .stat-label {
        font-size: 0.8rem;
        opacity: 0.8;
      }

      .controls {
        display: flex;
        gap: 1rem;
        margin-bottom: 2rem;
      }

      .btn {
        flex: 1;
        padding: 1rem;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      }

      .btn-primary {
        background: #3498db;
        color: white;
      }

      .btn-primary:active {
        background: #2980b9;
        transform: scale(0.98);
      }

      .btn-secondary {
        background: rgba(255,255,255,0.1);
        color: white;
        border: 1px solid rgba(255,255,255,0.2);
      }

      .settings-panel {
        background: rgba(255,255,255,0.1);
        padding: 1.5rem;
        border-radius: 12px;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.2);
      }

      .form-group {
        margin-bottom: 1rem;
      }

      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        font-weight: 500;
      }

      .form-group input,
      .form-group select {
        width: 100%;
        padding: 0.75rem;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 6px;
        background: rgba(255,255,255,0.1);
        color: white;
        font-size: 1rem;
      }

      .form-group input::placeholder {
        color: rgba(255,255,255,0.6);
      }

      .bottom-nav {
        display: flex;
        background: rgba(0,0,0,0.3);
        backdrop-filter: blur(10px);
        padding: 1rem 0;
      }

      .nav-btn {
        flex: 1;
        padding: 0.75rem;
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.7);
        font-size: 0.8rem;
        cursor: pointer;
        transition: all 0.3s ease;
      }

      .nav-btn.active {
        color: #3498db;
        background: rgba(52, 152, 219, 0.1);
      }

      .nav-btn:active {
        transform: scale(0.95);
      }

      /* Dark theme adjustments */
      .app.dark {
        /* Already dark by default */
      }

      /* Light theme */
      .app.light {
        background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
        color: #333;
      }

      /* Responsive design */
      @media (max-width: 480px) {
        .stats-grid {
          grid-template-columns: 1fr;
        }
        
        .header {
          padding: 0.75rem;
        }
        
        .title {
          font-size: 1.25rem;
        }
        
        .main {
          padding: 0.75rem;
        }
      }

      /* PWA specific styles */
      @media (display-mode: standalone) {
        .header {
          padding-top: env(safe-area-inset-top, 1rem);
        }
        
        .bottom-nav {
          padding-bottom: env(safe-area-inset-bottom, 1rem);
        }
      }
    `;
    
    document.head.appendChild(style);
  }

  setupWebSocket() {
    const wsUrl = this.apiUrl.replace('http', 'ws');
    
    try {
      this.websocket = new WebSocket(wsUrl);
      
      this.websocket.onopen = () => {
        console.log('📡 WebSocket connected');
        this.updateStatus(true);
      };
      
      this.websocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      };
      
      this.websocket.onclose = () => {
        console.log('📡 WebSocket disconnected');
        this.updateStatus(false);
        // Reconnect after 5 seconds
        setTimeout(() => this.setupWebSocket(), 5000);
      };
      
      this.websocket.onerror = (error) => {
        console.error('📡 WebSocket error:', error);
      };
      
    } catch (error) {
      console.error('WebSocket setup failed:', error);
    }
  }

  handleWebSocketMessage(data) {
    if (data.type === 'pool_stats') {
      this.updateStats(data);
    }
  }

  updateStats(stats) {
    document.getElementById('hashrate').textContent = this.formatHashrate(stats.hashrate);
    document.getElementById('miners').textContent = stats.miners || 0;
    document.getElementById('earnings').textContent = (stats.totalPaid || 0).toFixed(4);
    document.getElementById('efficiency').textContent = (stats.efficiency || 0).toFixed(1) + '%';
  }

  formatHashrate(hashrate) {
    if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
    if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
    if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
    if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' kH/s';
    return hashrate.toFixed(2) + ' H/s';
  }

  updateStatus(online) {
    this.isOnline = online;
    const statusEl = document.querySelector('.status');
    if (statusEl) {
      statusEl.textContent = online ? this.t.online : this.t.offline;
      statusEl.className = `status ${online ? 'online' : 'offline'}`;
    }
  }

  setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.switchView(e.target.dataset.view);
      });
    });

    // Mining control
    document.getElementById('toggleMining')?.addEventListener('click', () => {
      this.toggleMining();
    });

    // Refresh data
    document.getElementById('refreshData')?.addEventListener('click', () => {
      this.refreshData();
    });

    // Network status
    window.addEventListener('online', () => this.updateStatus(true));
    window.addEventListener('offline', () => this.updateStatus(false));

    // Touch events for better mobile experience
    document.addEventListener('touchstart', (e) => {
      if (e.target.classList.contains('btn')) {
        e.target.style.transform = 'scale(0.95)';
      }
    });

    document.addEventListener('touchend', (e) => {
      if (e.target.classList.contains('btn')) {
        e.target.style.transform = '';
      }
    });
  }

  switchView(view) {
    // Update navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    document.querySelector(`[data-view="${view}"]`).classList.add('active');

    // Show/hide panels
    const settingsPanel = document.getElementById('settingsPanel');
    if (view === 'settings') {
      settingsPanel.style.display = 'block';
    } else {
      settingsPanel.style.display = 'none';
    }
  }

  async toggleMining() {
    const btn = document.getElementById('toggleMining');
    const isStarted = btn.textContent.includes(this.t.stop);
    
    btn.textContent = this.t.connecting;
    btn.disabled = true;
    
    try {
      // Mock mining toggle - in real app, this would call the API
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (isStarted) {
        btn.textContent = this.t.start;
        this.showNotification(this.t.success, 'Mining stopped');
      } else {
        btn.textContent = this.t.stop;
        this.showNotification(this.t.success, 'Mining started');
      }
    } catch (error) {
      this.showNotification(this.t.error, error.message);
      btn.textContent = isStarted ? this.t.stop : this.t.start;
    } finally {
      btn.disabled = false;
    }
  }

  async refreshData() {
    try {
      const response = await fetch(`${this.apiUrl}/api/stats`);
      const stats = await response.json();
      this.updateStats(stats);
      this.showNotification(this.t.success, 'Data refreshed');
    } catch (error) {
      this.showNotification(this.t.error, 'Refresh failed');
    }
  }

  startDataRefresh() {
    // Refresh data every 30 seconds
    setInterval(() => {
      if (this.isOnline) {
        this.refreshData();
      }
    }, 30000);
  }

  showNotification(type, message) {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === this.t.success ? '#2ecc71' : '#e74c3c'};
      color: white;
      padding: 1rem 2rem;
      border-radius: 8px;
      z-index: 1000;
      animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }, 3000);
  }
}

// Initialize app when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new OtedamaMobileApp();
  });
} else {
  new OtedamaMobileApp();
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OtedamaMobileApp;
}
