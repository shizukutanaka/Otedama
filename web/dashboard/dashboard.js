/**
 * Otedama Mining Dashboard
 * Real-time monitoring and control interface
 */

class OtedamaDashboard {
    constructor() {
        // Configuration
        this.config = {
            apiUrl: window.location.origin,
            wsUrl: `ws://${window.location.host}/ws`,
            updateInterval: 5000,
            maxLogEntries: 100,
            reconnectInterval: 5000,
            chartUpdateInterval: 1000
        };

        // State
        this.state = {
            connected: false,
            mining: false,
            currentSection: 'overview',
            charts: {},
            websocket: null,
            reconnectAttempts: 0,
            lastUpdate: null
        };

        // Data storage
        this.data = {
            stats: {},
            hardware: [],
            pools: [],
            settings: {},
            logs: [],
            chartData: {
                hashrate: { labels: [], data: [] },
                temperature: { labels: [], datasets: [] },
                power: { labels: [], data: [] },
                shares: { labels: [], accepted: [], rejected: [] }
            }
        };

        this.init();
    }

    /**
     * Initialize the dashboard
     */
    async init() {
        try {
            this.showLoading('Initializing dashboard...');
            
            // Setup DOM event listeners
            this.setupEventListeners();
            
            // Initialize charts
            this.initializeCharts();
            
            // Connect to API and WebSocket
            await this.connect();
            
            // Load initial data
            await this.loadInitialData();
            
            // Start periodic updates
            this.startPeriodicUpdates();
            
            this.hideLoading();
            this.showNotification('Dashboard initialized successfully', 'success');
            
        } catch (error) {
            console.error('Failed to initialize dashboard:', error);
            this.hideLoading();
            this.showNotification('Failed to initialize dashboard', 'error');
        }
    }

    /**
     * Setup event listeners for UI interactions
     */
    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = link.getAttribute('href').substring(1);
                this.showSection(section);
            });
        });

        // Control buttons
        document.getElementById('start-mining')?.addEventListener('click', () => this.startMining());
        document.getElementById('stop-mining')?.addEventListener('click', () => this.stopMining());
        document.getElementById('optimize-settings')?.addEventListener('click', () => this.optimizeSettings());

        // Hardware actions
        document.getElementById('refresh-hardware')?.addEventListener('click', () => this.refreshHardware());
        document.getElementById('detect-hardware')?.addEventListener('click', () => this.detectHardware());

        // Pool actions
        document.getElementById('add-pool')?.addEventListener('click', () => this.showAddPoolModal());
        document.getElementById('test-pools')?.addEventListener('click', () => this.testAllPools());

        // Settings
        document.getElementById('save-settings')?.addEventListener('click', () => this.saveSettings());
        document.getElementById('reset-settings')?.addEventListener('click', () => this.resetSettings());

        // Modal controls
        document.querySelectorAll('.modal-close').forEach(closeBtn => {
            closeBtn.addEventListener('click', () => this.hideModal());
        });

        // Form submissions
        document.getElementById('pool-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.addPool();
        });

        // Settings controls
        document.getElementById('gpu-intensity')?.addEventListener('input', (e) => {
            document.getElementById('intensity-value').textContent = e.target.value;
        });

        // Chart timeframe changes
        document.getElementById('hashrate-timeframe')?.addEventListener('change', (e) => {
            this.updateChartTimeframe('hashrate', e.target.value);
        });

        // Log filtering
        document.getElementById('log-filter')?.addEventListener('change', (e) => {
            this.filterLogs(e.target.value);
        });

        document.getElementById('clear-log')?.addEventListener('click', () => this.clearLogs());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                switch (e.key) {
                    case '1': this.showSection('overview'); e.preventDefault(); break;
                    case '2': this.showSection('hardware'); e.preventDefault(); break;
                    case '3': this.showSection('pools'); e.preventDefault(); break;
                    case '4': this.showSection('settings'); e.preventDefault(); break;
                    case 's': this.startMining(); e.preventDefault(); break;
                    case 'x': this.stopMining(); e.preventDefault(); break;
                }
            }
        });

        // Window events
        window.addEventListener('beforeunload', () => {
            this.disconnect();
        });

        window.addEventListener('focus', () => {
            if (!this.state.connected) {
                this.connect();
            }
        });
    }

    /**
     * Initialize Chart.js charts
     */
    initializeCharts() {
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#cbd5e1' }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b' },
                    grid: { color: '#334155' }
                },
                y: {
                    ticks: { color: '#64748b' },
                    grid: { color: '#334155' }
                }
            }
        };

        // Hashrate chart
        const hashrateCtx = document.getElementById('hashrate-chart');
        if (hashrateCtx) {
            this.state.charts.hashrate = new Chart(hashrateCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Hashrate',
                        data: [],
                        borderColor: '#2563eb',
                        backgroundColor: 'rgba(37, 99, 235, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Hash/s',
                                color: '#64748b'
                            }
                        }
                    }
                }
            });
        }

        // Temperature chart
        const tempCtx = document.getElementById('temperature-chart');
        if (tempCtx) {
            this.state.charts.temperature = new Chart(tempCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: []
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            min: 0,
                            max: 100,
                            title: {
                                display: true,
                                text: 'Temperature (°C)',
                                color: '#64748b'
                            }
                        }
                    }
                }
            });
        }

        // Power chart
        const powerCtx = document.getElementById('power-chart');
        if (powerCtx) {
            this.state.charts.power = new Chart(powerCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Power Usage',
                        data: [],
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Watts',
                                color: '#64748b'
                            }
                        }
                    }
                }
            });
        }

        // Pool chart
        const poolCtx = document.getElementById('pool-chart');
        if (poolCtx) {
            this.state.charts.pool = new Chart(poolCtx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Accepted',
                        data: [],
                        backgroundColor: '#10b981'
                    }, {
                        label: 'Rejected',
                        data: [],
                        backgroundColor: '#ef4444'
                    }]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Shares',
                                color: '#64748b'
                            }
                        }
                    }
                }
            });
        }
    }

    /**
     * Connect to API and WebSocket
     */
    async connect() {
        try {
            // Test API connection
            const response = await fetch(`${this.config.apiUrl}/api/v1/status`);
            if (!response.ok) throw new Error('API connection failed');

            // Setup WebSocket connection
            this.setupWebSocket();
            
            this.state.connected = true;
            this.updateConnectionStatus(true);
            
        } catch (error) {
            console.error('Connection failed:', error);
            this.state.connected = false;
            this.updateConnectionStatus(false);
            
            // Retry connection
            setTimeout(() => this.connect(), this.config.reconnectInterval);
        }
    }

    /**
     * Setup WebSocket connection for real-time updates
     */
    setupWebSocket() {
        if (this.state.websocket) {
            this.state.websocket.close();
        }

        this.state.websocket = new WebSocket(`${this.config.wsUrl}/stats`);
        
        this.state.websocket.onopen = () => {
            console.log('WebSocket connected');
            this.state.connected = true;
            this.state.reconnectAttempts = 0;
            this.updateConnectionStatus(true);
        };

        this.state.websocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleRealtimeData(data);
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        };

        this.state.websocket.onclose = () => {
            console.log('WebSocket disconnected');
            this.state.connected = false;
            this.updateConnectionStatus(false);
            
            // Attempt reconnection
            this.state.reconnectAttempts++;
            const delay = Math.min(this.config.reconnectInterval * this.state.reconnectAttempts, 30000);
            setTimeout(() => this.setupWebSocket(), delay);
        };

        this.state.websocket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    /**
     * Handle real-time data from WebSocket
     */
    handleRealtimeData(data) {
        // Update stats
        this.data.stats = { ...this.data.stats, ...data };
        
        // Update UI elements
        this.updateMetrics(data);
        this.updateCharts(data);
        
        // Log event if provided
        if (data.event) {
            this.addLogEntry(data.event);
        }
        
        this.state.lastUpdate = new Date();
    }

    /**
     * Load initial data from API
     */
    async loadInitialData() {
        try {
            // Load multiple endpoints in parallel
            const [stats, hardware, pools, settings] = await Promise.all([
                this.apiCall('/api/v1/mining/stats'),
                this.apiCall('/api/v1/hardware'),
                this.apiCall('/api/v1/pools'),
                this.apiCall('/api/v1/config')
            ]);

            this.data.stats = stats;
            this.data.hardware = hardware;
            this.data.pools = pools;
            this.data.settings = settings;

            // Update UI
            this.updateMetrics(stats);
            this.updateHardwareDisplay();
            this.updatePoolsDisplay();
            this.updateSettingsDisplay();

        } catch (error) {
            console.error('Failed to load initial data:', error);
            this.showNotification('Failed to load initial data', 'error');
        }
    }

    /**
     * Make API call with error handling
     */
    async apiCall(endpoint, options = {}) {
        try {
            const response = await fetch(`${this.config.apiUrl}${endpoint}`, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            if (!response.ok) {
                throw new Error(`API call failed: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`API call to ${endpoint} failed:`, error);
            throw error;
        }
    }

    /**
     * Update metrics display
     */
    updateMetrics(stats) {
        // Total hashrate
        const hashrateEl = document.getElementById('total-hashrate');
        if (hashrateEl && stats.hashrate !== undefined) {
            hashrateEl.textContent = this.formatHashrate(stats.hashrate);
        }

        // Shares
        const sharesEl = document.getElementById('shares-accepted');
        const acceptanceEl = document.getElementById('acceptance-rate');
        if (sharesEl && stats.shares) {
            sharesEl.textContent = stats.shares.accepted || 0;
            
            if (acceptanceEl && stats.shares.submitted > 0) {
                const rate = (stats.shares.accepted / stats.shares.submitted * 100).toFixed(1);
                acceptanceEl.textContent = `${rate}%`;
            }
        }

        // Power usage
        const powerEl = document.getElementById('power-usage');
        const efficiencyEl = document.getElementById('efficiency');
        if (powerEl && stats.power !== undefined) {
            powerEl.textContent = `${stats.power} W`;
            
            if (efficiencyEl && stats.hashrate && stats.power > 0) {
                const efficiency = (stats.hashrate / stats.power).toFixed(2);
                efficiencyEl.textContent = `${efficiency} H/W`;
            }
        }

        // Temperature
        const tempEl = document.getElementById('avg-temperature');
        const tempStatusEl = document.getElementById('temp-status');
        if (tempEl && stats.temperature !== undefined) {
            tempEl.textContent = `${stats.temperature}°C`;
            
            if (tempStatusEl) {
                if (stats.temperature > 85) {
                    tempStatusEl.textContent = 'High';
                    tempStatusEl.className = 'metric-detail warning';
                } else if (stats.temperature > 75) {
                    tempStatusEl.textContent = 'Warm';
                    tempStatusEl.className = 'metric-detail';
                } else {
                    tempStatusEl.textContent = 'Normal';
                    tempStatusEl.className = 'metric-detail';
                }
            }
        }

        // Uptime
        const uptimeEl = document.getElementById('uptime');
        const startTimeEl = document.getElementById('start-time');
        if (uptimeEl && stats.uptime !== undefined) {
            uptimeEl.textContent = this.formatDuration(stats.uptime);
            
            if (startTimeEl && stats.start_time) {
                const startTime = new Date(stats.start_time);
                startTimeEl.textContent = `Started: ${startTime.toLocaleTimeString()}`;
            }
        }

        // Revenue estimate
        const revenueEl = document.getElementById('daily-revenue');
        if (revenueEl && stats.estimated_revenue !== undefined) {
            revenueEl.textContent = `$${stats.estimated_revenue.toFixed(2)}`;
        }

        // Power cost
        const powerCostEl = document.getElementById('power-cost');
        if (powerCostEl && stats.power_cost !== undefined) {
            powerCostEl.textContent = stats.power_cost.toFixed(2);
        }

        // Update mining status
        this.state.mining = stats.mining || false;
        this.updateMiningStatus();
    }

    /**
     * Update charts with new data
     */
    updateCharts(stats) {
        const now = new Date();
        const timeLabel = now.toLocaleTimeString();

        // Update hashrate chart
        if (this.state.charts.hashrate && stats.hashrate !== undefined) {
            const chart = this.state.charts.hashrate;
            chart.data.labels.push(timeLabel);
            chart.data.datasets[0].data.push(stats.hashrate);
            
            // Keep only last 50 data points
            if (chart.data.labels.length > 50) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
            
            chart.update('none');
        }

        // Update temperature chart
        if (this.state.charts.temperature && stats.device_temperatures) {
            const chart = this.state.charts.temperature;
            
            // Update labels
            chart.data.labels.push(timeLabel);
            
            // Update datasets for each device
            Object.entries(stats.device_temperatures).forEach(([deviceId, temp], index) => {
                if (!chart.data.datasets[index]) {
                    chart.data.datasets[index] = {
                        label: deviceId,
                        data: [],
                        borderColor: this.getDeviceColor(index),
                        backgroundColor: 'transparent',
                        tension: 0.4
                    };
                }
                chart.data.datasets[index].data.push(temp);
            });

            // Clean up old data
            if (chart.data.labels.length > 50) {
                chart.data.labels.shift();
                chart.data.datasets.forEach(dataset => {
                    if (dataset.data.length > 0) dataset.data.shift();
                });
            }
            
            chart.update('none');
        }

        // Update power chart
        if (this.state.charts.power && stats.power !== undefined) {
            const chart = this.state.charts.power;
            chart.data.labels.push(timeLabel);
            chart.data.datasets[0].data.push(stats.power);
            
            if (chart.data.labels.length > 50) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
            
            chart.update('none');
        }

        // Update pool chart
        if (this.state.charts.pool && stats.pool_shares) {
            const chart = this.state.charts.pool;
            const pools = Object.keys(stats.pool_shares);
            
            chart.data.labels = pools;
            chart.data.datasets[0].data = pools.map(pool => stats.pool_shares[pool].accepted || 0);
            chart.data.datasets[1].data = pools.map(pool => stats.pool_shares[pool].rejected || 0);
            
            chart.update('none');
        }
    }

    /**
     * Update hardware display
     */
    updateHardwareDisplay() {
        const container = document.getElementById('hardware-devices');
        if (!container) return;

        container.innerHTML = '';

        this.data.hardware.forEach(device => {
            const deviceEl = this.createHardwareDeviceElement(device);
            container.appendChild(deviceEl);
        });
    }

    /**
     * Create hardware device element
     */
    createHardwareDeviceElement(device) {
        const deviceEl = document.createElement('div');
        deviceEl.className = 'hardware-device';
        deviceEl.innerHTML = `
            <div class="device-header">
                <div class="device-info">
                    <h4>${device.name || device.id}</h4>
                    <span class="device-type">${device.type}</span>
                </div>
                <span class="device-status ${device.online ? 'online' : 'offline'}">
                    ${device.online ? 'Online' : 'Offline'}
                </span>
            </div>
            <div class="device-metrics">
                <div class="device-metric">
                    <div class="device-metric-value">${this.formatHashrate(device.hashrate || 0)}</div>
                    <div class="device-metric-label">Hashrate</div>
                </div>
                <div class="device-metric">
                    <div class="device-metric-value">${device.temperature || 0}°C</div>
                    <div class="device-metric-label">Temperature</div>
                </div>
                <div class="device-metric">
                    <div class="device-metric-value">${device.power || 0}W</div>
                    <div class="device-metric-label">Power</div>
                </div>
                <div class="device-metric">
                    <div class="device-metric-value">${device.fan_speed || 0}%</div>
                    <div class="device-metric-label">Fan Speed</div>
                </div>
            </div>
        `;

        return deviceEl;
    }

    /**
     * Update pools display
     */
    updatePoolsDisplay() {
        const container = document.getElementById('mining-pools');
        if (!container) return;

        container.innerHTML = '';

        this.data.pools.forEach((pool, index) => {
            const poolEl = this.createPoolElement(pool, index);
            container.appendChild(poolEl);
        });
    }

    /**
     * Create pool element
     */
    createPoolElement(pool, index) {
        const poolEl = document.createElement('div');
        poolEl.className = 'pool-item';
        poolEl.innerHTML = `
            <div class="pool-info">
                <div class="pool-url">${pool.url}</div>
                <div class="pool-details">
                    <span>User: ${pool.user}</span>
                    <span>Priority: ${pool.priority}</span>
                    <span class="pool-status ${pool.connected ? 'online' : 'offline'}">
                        ${pool.connected ? 'Connected' : 'Disconnected'}
                    </span>
                </div>
            </div>
            <div class="pool-stats">
                <div class="pool-stat">
                    <div class="pool-stat-value">${pool.latency || 0}ms</div>
                    <div class="pool-stat-label">Latency</div>
                </div>
                <div class="pool-stat">
                    <div class="pool-stat-value">${pool.shares_accepted || 0}</div>
                    <div class="pool-stat-label">Accepted</div>
                </div>
                <div class="pool-stat">
                    <div class="pool-stat-value">${pool.shares_rejected || 0}</div>
                    <div class="pool-stat-label">Rejected</div>
                </div>
            </div>
            <div class="pool-actions">
                <button class="btn-secondary btn-sm" onclick="dashboard.testPool(${index})">Test</button>
                <button class="btn-secondary btn-sm" onclick="dashboard.removePool(${index})">Remove</button>
            </div>
        `;

        return poolEl;
    }

    /**
     * Update settings display
     */
    updateSettingsDisplay() {
        if (!this.data.settings.mining) return;

        const settings = this.data.settings.mining;

        // Algorithm
        const algorithmEl = document.getElementById('algorithm-select');
        if (algorithmEl) algorithmEl.value = settings.algorithm || 'auto';

        // CPU settings
        const cpuEnabledEl = document.getElementById('cpu-enabled');
        if (cpuEnabledEl) cpuEnabledEl.checked = settings.cpu?.enabled || false;

        const cpuThreadsEl = document.getElementById('cpu-threads');
        if (cpuThreadsEl) cpuThreadsEl.value = settings.cpu?.threads || 0;

        const cpuPriorityEl = document.getElementById('cpu-priority');
        if (cpuPriorityEl) cpuPriorityEl.value = settings.cpu?.priority || 'normal';

        // GPU settings
        const gpuEnabledEl = document.getElementById('gpu-enabled');
        if (gpuEnabledEl) gpuEnabledEl.checked = settings.gpu?.enabled || false;

        const gpuIntensityEl = document.getElementById('gpu-intensity');
        if (gpuIntensityEl) {
            gpuIntensityEl.value = settings.gpu?.intensity || 20;
            document.getElementById('intensity-value').textContent = gpuIntensityEl.value;
        }

        const tempLimitEl = document.getElementById('temp-limit');
        if (tempLimitEl) tempLimitEl.value = settings.gpu?.temperature_limit || 85;

        // Power settings
        const powerLimitEl = document.getElementById('power-limit');
        if (powerLimitEl) powerLimitEl.value = settings.gpu?.power_limit || 0;

        const thermalThrottlingEl = document.getElementById('thermal-throttling');
        if (thermalThrottlingEl) thermalThrottlingEl.checked = settings.thermal_throttling || false;
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        setInterval(async () => {
            if (this.state.connected) {
                try {
                    // Refresh data that might not come via WebSocket
                    await this.refreshHardware();
                } catch (error) {
                    console.error('Periodic update failed:', error);
                }
            }
        }, this.config.updateInterval);
    }

    /**
     * Show/hide sections
     */
    showSection(sectionName) {
        // Update navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        document.querySelector(`[href="#${sectionName}"]`)?.classList.add('active');

        // Update sections
        document.querySelectorAll('.section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(sectionName)?.classList.add('active');

        this.state.currentSection = sectionName;
    }

    /**
     * Update connection status indicator
     */
    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connection-status');
        const miningStatusEl = document.getElementById('mining-status');
        
        if (statusEl) {
            statusEl.className = connected ? 'status-online' : 'status-offline';
        }
        
        if (miningStatusEl) {
            miningStatusEl.textContent = connected ? 
                (this.state.mining ? 'Mining' : 'Connected') : 
                'Disconnected';
        }
    }

    /**
     * Update mining status
     */
    updateMiningStatus() {
        const startBtn = document.getElementById('start-mining');
        const stopBtn = document.getElementById('stop-mining');
        
        if (this.state.mining) {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
        } else {
            startBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
        }
    }

    /**
     * Start mining
     */
    async startMining() {
        try {
            this.showLoading('Starting mining...');
            await this.apiCall('/api/v1/mining/start', { method: 'POST' });
            this.state.mining = true;
            this.updateMiningStatus();
            this.showNotification('Mining started successfully', 'success');
            this.addLogEntry({
                type: 'info',
                message: 'Mining started by user',
                timestamp: new Date()
            });
        } catch (error) {
            console.error('Failed to start mining:', error);
            this.showNotification('Failed to start mining', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Stop mining
     */
    async stopMining() {
        try {
            this.showLoading('Stopping mining...');
            await this.apiCall('/api/v1/mining/stop', { method: 'POST' });
            this.state.mining = false;
            this.updateMiningStatus();
            this.showNotification('Mining stopped successfully', 'success');
            this.addLogEntry({
                type: 'info',
                message: 'Mining stopped by user',
                timestamp: new Date()
            });
        } catch (error) {
            console.error('Failed to stop mining:', error);
            this.showNotification('Failed to stop mining', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Optimize settings
     */
    async optimizeSettings() {
        try {
            this.showLoading('Optimizing settings...');
            await this.apiCall('/api/v1/optimize', { method: 'POST' });
            this.showNotification('Settings optimized successfully', 'success');
            await this.loadInitialData(); // Reload settings
        } catch (error) {
            console.error('Failed to optimize settings:', error);
            this.showNotification('Failed to optimize settings', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Refresh hardware data
     */
    async refreshHardware() {
        try {
            this.data.hardware = await this.apiCall('/api/v1/hardware');
            this.updateHardwareDisplay();
        } catch (error) {
            console.error('Failed to refresh hardware:', error);
        }
    }

    /**
     * Detect new hardware
     */
    async detectHardware() {
        try {
            this.showLoading('Detecting hardware...');
            await this.apiCall('/api/v1/hardware/detect', { method: 'POST' });
            await this.refreshHardware();
            this.showNotification('Hardware detection completed', 'success');
        } catch (error) {
            console.error('Failed to detect hardware:', error);
            this.showNotification('Failed to detect hardware', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Show add pool modal
     */
    showAddPoolModal() {
        const modal = document.getElementById('add-pool-modal');
        if (modal) {
            modal.classList.add('active');
            document.getElementById('pool-url').focus();
        }
    }

    /**
     * Hide modal
     */
    hideModal() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('active');
        });
    }

    /**
     * Add new pool
     */
    async addPool() {
        try {
            const formData = {
                url: document.getElementById('pool-url').value,
                user: document.getElementById('pool-user').value,
                password: document.getElementById('pool-password').value,
                priority: parseInt(document.getElementById('pool-priority').value)
            };

            await this.apiCall('/api/v1/pools', {
                method: 'POST',
                body: JSON.stringify(formData)
            });

            this.hideModal();
            this.showNotification('Pool added successfully', 'success');
            await this.loadInitialData(); // Reload pools
            
            // Reset form
            document.getElementById('pool-form').reset();
            
        } catch (error) {
            console.error('Failed to add pool:', error);
            this.showNotification('Failed to add pool', 'error');
        }
    }

    /**
     * Test all pools
     */
    async testAllPools() {
        try {
            this.showLoading('Testing pools...');
            await this.apiCall('/api/v1/pools/test', { method: 'POST' });
            this.showNotification('Pool test completed', 'success');
            await this.loadInitialData(); // Reload pools with updated status
        } catch (error) {
            console.error('Failed to test pools:', error);
            this.showNotification('Failed to test pools', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /**
     * Test specific pool
     */
    async testPool(index) {
        try {
            const pool = this.data.pools[index];
            await this.apiCall(`/api/v1/pools/${index}/test`, { method: 'POST' });
            this.showNotification(`Pool ${pool.url} tested successfully`, 'success');
        } catch (error) {
            console.error('Failed to test pool:', error);
            this.showNotification('Failed to test pool', 'error');
        }
    }

    /**
     * Remove pool
     */
    async removePool(index) {
        if (!confirm('Are you sure you want to remove this pool?')) return;

        try {
            await this.apiCall(`/api/v1/pools/${index}`, { method: 'DELETE' });
            this.showNotification('Pool removed successfully', 'success');
            await this.loadInitialData(); // Reload pools
        } catch (error) {
            console.error('Failed to remove pool:', error);
            this.showNotification('Failed to remove pool', 'error');
        }
    }

    /**
     * Save settings
     */
    async saveSettings() {
        try {
            const settings = {
                mining: {
                    algorithm: document.getElementById('algorithm-select').value,
                    cpu: {
                        enabled: document.getElementById('cpu-enabled').checked,
                        threads: parseInt(document.getElementById('cpu-threads').value),
                        priority: document.getElementById('cpu-priority').value
                    },
                    gpu: {
                        enabled: document.getElementById('gpu-enabled').checked,
                        intensity: parseInt(document.getElementById('gpu-intensity').value),
                        temperature_limit: parseInt(document.getElementById('temp-limit').value),
                        power_limit: parseInt(document.getElementById('power-limit').value)
                    },
                    thermal_throttling: document.getElementById('thermal-throttling').checked
                }
            };

            await this.apiCall('/api/v1/config', {
                method: 'PUT',
                body: JSON.stringify(settings)
            });

            this.showNotification('Settings saved successfully', 'success');
            this.data.settings = { ...this.data.settings, ...settings };
            
        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showNotification('Failed to save settings', 'error');
        }
    }

    /**
     * Reset settings to defaults
     */
    async resetSettings() {
        if (!confirm('Are you sure you want to reset all settings to defaults?')) return;

        try {
            await this.apiCall('/api/v1/config/reset', { method: 'POST' });
            this.showNotification('Settings reset to defaults', 'success');
            await this.loadInitialData(); // Reload settings
        } catch (error) {
            console.error('Failed to reset settings:', error);
            this.showNotification('Failed to reset settings', 'error');
        }
    }

    /**
     * Add log entry
     */
    addLogEntry(entry) {
        const logContainer = document.getElementById('activity-log');
        if (!logContainer) return;

        const logEl = document.createElement('div');
        logEl.className = 'log-item';
        
        const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
        
        logEl.innerHTML = `
            <span class="log-timestamp">${timestamp.toLocaleTimeString()}</span>
            <span class="log-type ${entry.type}">${entry.type}</span>
            <span class="log-message">${entry.message}</span>
        `;

        logContainer.insertBefore(logEl, logContainer.firstChild);

        // Keep only recent entries
        while (logContainer.children.length > this.config.maxLogEntries) {
            logContainer.removeChild(logContainer.lastChild);
        }

        // Store in data
        this.data.logs.unshift(entry);
        if (this.data.logs.length > this.config.maxLogEntries) {
            this.data.logs.pop();
        }
    }

    /**
     * Filter logs
     */
    filterLogs(filter) {
        const logItems = document.querySelectorAll('.log-item');
        
        logItems.forEach(item => {
            const type = item.querySelector('.log-type').textContent;
            
            if (filter === 'all' || type === filter) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    /**
     * Clear logs
     */
    clearLogs() {
        const logContainer = document.getElementById('activity-log');
        if (logContainer) {
            logContainer.innerHTML = '';
        }
        this.data.logs = [];
    }

    /**
     * Show loading overlay
     */
    showLoading(message = 'Loading...') {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            const textEl = overlay.querySelector('.loading-text');
            if (textEl) textEl.textContent = message;
        }
    }

    /**
     * Hide loading overlay
     */
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    /**
     * Show notification
     */
    showNotification(message, type = 'info', duration = 5000) {
        const container = document.getElementById('notifications');
        if (!container) return;

        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <div class="notification-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
            <div class="notification-message">${message}</div>
        `;

        container.appendChild(notification);

        // Auto-remove after duration
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }

    /**
     * Disconnect from services
     */
    disconnect() {
        if (this.state.websocket) {
            this.state.websocket.close();
            this.state.websocket = null;
        }
        this.state.connected = false;
    }

    /**
     * Utility functions
     */
    formatHashrate(hashrate) {
        if (hashrate >= 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
        if (hashrate >= 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
        if (hashrate >= 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
        if (hashrate >= 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
        return `${hashrate.toFixed(0)} H/s`;
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }

    getDeviceColor(index) {
        const colors = [
            '#2563eb', '#10b981', '#f59e0b', '#ef4444', 
            '#8b5cf6', '#06b6d4', '#84cc16', '#f97316'
        ];
        return colors[index % colors.length];
    }

    updateChartTimeframe(chartName, timeframe) {
        // Implementation for updating chart timeframe
        console.log(`Updating ${chartName} chart timeframe to ${timeframe}`);
        // This would typically involve fetching historical data
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new OtedamaDashboard();
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.dashboard) {
        // Reconnect when page becomes visible
        if (!window.dashboard.state.connected) {
            window.dashboard.connect();
        }
    }
});