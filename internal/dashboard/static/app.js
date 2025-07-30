// Otedama Dashboard Application
class Dashboard {
    constructor() {
        this.ws = null;
        this.charts = {};
        this.data = {
            hashrate: [],
            performance: [],
            shares: []
        };
        this.maxDataPoints = 60; // Keep last 60 data points
        
        this.init();
    }
    
    init() {
        this.setupWebSocket();
        this.setupTabs();
        this.setupControls();
        this.setupCharts();
        this.loadInitialData();
        
        // Start periodic updates
        setInterval(() => this.updateTime(), 1000);
    }
    
    setupWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            document.getElementById('pool-status').textContent = 'Connected';
            document.getElementById('pool-status').style.color = '#10b981';
        };
        
        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            document.getElementById('pool-status').textContent = 'Disconnected';
            document.getElementById('pool-status').style.color = '#ef4444';
            
            // Attempt to reconnect after 5 seconds
            setTimeout(() => this.setupWebSocket(), 5000);
        };
        
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.updateDashboard(data);
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }
    
    setupTabs() {
        const tabs = document.querySelectorAll('.tab');
        const contents = document.querySelectorAll('.tab-content');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                
                // Update active tab
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // Update active content
                contents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === targetTab) {
                        content.classList.add('active');
                    }
                });
                
                // Load tab-specific data
                this.loadTabData(targetTab);
            });
        });
    }
    
    setupControls() {
        // Mining controls
        document.getElementById('mining-start').addEventListener('click', () => {
            this.sendMiningControl('start');
        });
        
        document.getElementById('mining-stop').addEventListener('click', () => {
            this.sendMiningControl('stop');
        });
        
        document.getElementById('mining-pause').addEventListener('click', () => {
            this.sendMiningControl('pause');
        });
        
        document.getElementById('mining-resume').addEventListener('click', () => {
            this.sendMiningControl('resume');
        });
        
        // Settings forms
        document.getElementById('mining-settings').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveMiningSettings();
        });
        
        document.getElementById('pool-settings').addEventListener('submit', (e) => {
            e.preventDefault();
            this.savePoolSettings();
        });
    }
    
    setupCharts() {
        // Hashrate chart
        const hashrateCtx = document.getElementById('hashrate-chart').getContext('2d');
        this.charts.hashrate = new Chart(hashrateCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Hashrate',
                    data: [],
                    borderColor: '#00d4ff',
                    backgroundColor: 'rgba(0, 212, 255, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#8892b0'
                        }
                    },
                    x: {
                        ticks: {
                            color: '#8892b0'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });
        
        // Performance chart
        const performanceCtx = document.getElementById('performance-chart').getContext('2d');
        this.charts.performance = new Chart(performanceCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Accepted Shares',
                        data: [],
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        tension: 0.4
                    },
                    {
                        label: 'Rejected Shares',
                        data: [],
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#8892b0'
                        }
                    },
                    x: {
                        ticks: {
                            color: '#8892b0'
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#8892b0'
                        }
                    }
                }
            }
        });
    }
    
    async loadInitialData() {
        try {
            // Load system info
            const systemInfo = await this.fetchAPI('/api/v1/system/info');
            document.getElementById('version').textContent = systemInfo.version;
            
            // Load mining stats
            const miningStats = await this.fetchAPI('/api/v1/mining/stats');
            this.updateMiningStats(miningStats);
            
            // Load health status
            const healthStatus = await this.fetchAPI('/api/v1/health/status');
            this.updateHealthStatus(healthStatus);
            
        } catch (error) {
            console.error('Failed to load initial data:', error);
        }
    }
    
    async loadTabData(tab) {
        switch (tab) {
            case 'workers':
                const workers = await this.fetchAPI('/api/v1/mining/workers');
                this.updateWorkersTable(workers);
                break;
                
            case 'currency':
                const balances = await this.fetchAPI('/api/v1/currency/balances');
                const rates = await this.fetchAPI('/api/v1/currency/rates');
                this.updateCurrencyInfo(balances, rates);
                break;
                
            case 'health':
                const checks = await this.fetchAPI('/api/v1/health/checks');
                this.updateHealthChecks(checks);
                break;
        }
    }
    
    updateDashboard(data) {
        // Update mining stats
        if (data.mining) {
            this.updateMiningStats(data.mining);
            this.updateCharts(data);
        }
        
        // Update health status
        if (data.health) {
            this.updateHealthStatus(data.health);
        }
        
        // Update system stats
        if (data.system) {
            this.updateSystemStats(data.system);
        }
    }
    
    updateMiningStats(stats) {
        // Update overview
        document.getElementById('total-hashrate').textContent = this.formatHashrate(stats.hashrate || 0);
        document.getElementById('active-workers').textContent = stats.workers || 0;
        document.getElementById('shares-accepted').textContent = stats.shares_accepted || 0;
        document.getElementById('shares-rejected').textContent = stats.shares_rejected || 0;
        document.getElementById('blocks-found').textContent = stats.blocks_found || 0;
        
        // Update mining tab
        document.getElementById('mining-algorithm').textContent = stats.algorithm || '-';
        document.getElementById('mining-difficulty').textContent = this.formatDifficulty(stats.difficulty || 0);
        document.getElementById('current-job').textContent = stats.current_job || '-';
    }
    
    updateHealthStatus(status) {
        const healthDiv = document.getElementById('overall-health');
        const indicator = healthDiv.querySelector('.status-indicator');
        const text = healthDiv.querySelector('.status-text');
        
        indicator.className = 'status-indicator';
        
        switch (status.status) {
            case 'healthy':
                indicator.classList.add('healthy');
                text.textContent = 'All systems operational';
                break;
            case 'warning':
                indicator.classList.add('warning');
                text.textContent = 'Minor issues detected';
                break;
            case 'critical':
                indicator.classList.add('critical');
                text.textContent = 'Critical issues detected';
                break;
        }
    }
    
    updateSystemStats(stats) {
        // Update CPU usage
        if (stats.cpu_usage !== undefined) {
            document.getElementById('cpu-usage').style.width = `${stats.cpu_usage}%`;
        }
        
        // Update memory usage
        if (stats.memory_usage !== undefined) {
            document.getElementById('memory-usage').style.width = `${stats.memory_usage}%`;
        }
        
        // Update network load
        if (stats.network_load !== undefined) {
            document.getElementById('network-load').style.width = `${stats.network_load}%`;
        }
    }
    
    updateCharts(data) {
        const now = new Date().toLocaleTimeString();
        
        // Update hashrate chart
        if (data.mining && data.mining.hashrate !== undefined) {
            this.data.hashrate.push(data.mining.hashrate);
            if (this.data.hashrate.length > this.maxDataPoints) {
                this.data.hashrate.shift();
            }
            
            this.charts.hashrate.data.labels.push(now);
            if (this.charts.hashrate.data.labels.length > this.maxDataPoints) {
                this.charts.hashrate.data.labels.shift();
            }
            
            this.charts.hashrate.data.datasets[0].data = this.data.hashrate;
            this.charts.hashrate.update('none');
        }
        
        // Update performance chart
        if (data.mining && data.mining.shares_accepted !== undefined) {
            const acceptedData = this.charts.performance.data.datasets[0].data;
            const rejectedData = this.charts.performance.data.datasets[1].data;
            
            acceptedData.push(data.mining.shares_accepted);
            rejectedData.push(data.mining.shares_rejected || 0);
            
            if (acceptedData.length > this.maxDataPoints) {
                acceptedData.shift();
                rejectedData.shift();
            }
            
            this.charts.performance.data.labels.push(now);
            if (this.charts.performance.data.labels.length > this.maxDataPoints) {
                this.charts.performance.data.labels.shift();
            }
            
            this.charts.performance.update('none');
        }
    }
    
    updateWorkersTable(workers) {
        const tbody = document.querySelector('#workers-list tbody');
        tbody.innerHTML = '';
        
        let cpuCount = 0, gpuCount = 0, asicCount = 0;
        
        workers.forEach(worker => {
            const row = tbody.insertRow();
            row.innerHTML = `
                <td>${worker.id}</td>
                <td>${worker.type}</td>
                <td>${this.formatHashrate(worker.hashrate)}</td>
                <td>${worker.shares_accepted}/${worker.shares_total}</td>
                <td>${(worker.efficiency * 100).toFixed(1)}%</td>
                <td><span class="status-${worker.status}">${worker.status}</span></td>
            `;
            
            // Count worker types
            switch (worker.type) {
                case 'CPU': cpuCount++; break;
                case 'GPU': gpuCount++; break;
                case 'ASIC': asicCount++; break;
            }
        });
        
        // Update summary
        document.getElementById('total-workers').textContent = workers.length;
        document.getElementById('cpu-workers').textContent = cpuCount;
        document.getElementById('gpu-workers').textContent = gpuCount;
        document.getElementById('asic-workers').textContent = asicCount;
    }
    
    updateCurrencyInfo(balances, rates) {
        // Update balances
        const balancesGrid = document.getElementById('balances-grid');
        balancesGrid.innerHTML = '';
        
        Object.entries(balances).forEach(([currency, balance]) => {
            const card = document.createElement('div');
            card.className = 'balance-card';
            card.innerHTML = `
                <div class="currency">${currency}</div>
                <div class="amount">${this.formatBalance(balance, currency)}</div>
            `;
            balancesGrid.appendChild(card);
        });
        
        // Update exchange rates
        const ratesTable = document.querySelector('#rates-table tbody');
        ratesTable.innerHTML = '';
        
        Object.entries(rates).forEach(([pair, rate]) => {
            const row = ratesTable.insertRow();
            row.innerHTML = `
                <td>${pair.replace('_', '/')}</td>
                <td>$${rate.toFixed(2)}</td>
                <td class="change-positive">+2.5%</td>
            `;
        });
    }
    
    updateHealthChecks(checks) {
        const container = document.getElementById('health-checks-list');
        container.innerHTML = '';
        
        checks.forEach(check => {
            const checkDiv = document.createElement('div');
            checkDiv.className = 'health-check';
            checkDiv.innerHTML = `
                <div class="check-name">${check.name}</div>
                <div class="check-status status-${check.status}">${check.status}</div>
            `;
            container.appendChild(checkDiv);
        });
    }
    
    updateTime() {
        const systemInfo = document.getElementById('uptime');
        if (systemInfo && systemInfo.dataset.startTime) {
            const start = new Date(systemInfo.dataset.startTime);
            const now = new Date();
            const diff = now - start;
            systemInfo.textContent = this.formatDuration(diff);
        }
    }
    
    async sendMiningControl(action) {
        try {
            const response = await fetch('/api/v1/mining/control', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ action })
            });
            
            if (response.ok) {
                this.showNotification(`Mining ${action} successful`, 'success');
            } else {
                throw new Error(`Failed to ${action} mining`);
            }
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async fetchAPI(endpoint) {
        const response = await fetch(endpoint);
        if (!response.ok) {
            throw new Error(`API request failed: ${response.statusText}`);
        }
        return response.json();
    }
    
    // Utility functions
    formatHashrate(hashrate) {
        const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
        let unitIndex = 0;
        let value = hashrate;
        
        while (value >= 1000 && unitIndex < units.length - 1) {
            value /= 1000;
            unitIndex++;
        }
        
        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }
    
    formatDifficulty(difficulty) {
        if (difficulty < 1000) {
            return difficulty.toFixed(2);
        } else if (difficulty < 1000000) {
            return `${(difficulty / 1000).toFixed(2)}K`;
        } else if (difficulty < 1000000000) {
            return `${(difficulty / 1000000).toFixed(2)}M`;
        } else {
            return `${(difficulty / 1000000000).toFixed(2)}G`;
        }
    }
    
    formatBalance(balance, currency) {
        // Simplified formatting - adjust based on currency decimals
        const value = parseFloat(balance) / 1e18; // Assuming 18 decimals
        return value.toFixed(8);
    }
    
    formatDuration(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }
    
    showNotification(message, type = 'info') {
        // Simple notification - can be enhanced with a proper notification library
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});