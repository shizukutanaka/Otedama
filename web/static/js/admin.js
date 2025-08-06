// Admin Dashboard JavaScript

class AdminDashboard {
    constructor() {
        this.currentSection = 'dashboard';
        this.charts = {};
        this.refreshInterval = null;
        this.init();
    }

    init() {
        this.setupNavigation();
        this.setupEventListeners();
        this.startAutoRefresh();
        this.loadDashboard();
    }

    setupNavigation() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = link.getAttribute('href').substring(1);
                this.showSection(section);
            });
        });
    }

    showSection(section) {
        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        document.querySelector(`a[href="#${section}"]`).classList.add('active');

        // Update sections
        document.querySelectorAll('.admin-section').forEach(sec => {
            sec.classList.remove('active');
        });
        document.getElementById(section).classList.add('active');

        this.currentSection = section;
        this.loadSectionData(section);
    }

    setupEventListeners() {
        // Refresh button
        document.getElementById('refresh-btn').addEventListener('click', () => {
            this.refreshCurrentSection();
        });

        // Worker search
        const workerSearch = document.getElementById('worker-search');
        if (workerSearch) {
            workerSearch.addEventListener('input', (e) => {
                this.filterWorkers(e.target.value);
            });
        }

        // Process payouts button
        const processBtn = document.getElementById('process-payouts');
        if (processBtn) {
            processBtn.addEventListener('click', () => {
                this.processPayouts();
            });
        }

        // Settings form
        const settingsForm = document.getElementById('pool-settings-form');
        if (settingsForm) {
            settingsForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveSettings();
            });
        }

        // Maintenance buttons
        document.getElementById('cleanup-btn')?.addEventListener('click', () => {
            this.runCleanup();
        });

        // Modal close
        document.querySelector('.close')?.addEventListener('click', () => {
            this.closeModal();
        });
    }

    startAutoRefresh() {
        this.refreshInterval = setInterval(() => {
            this.updateServerTime();
            if (this.currentSection === 'dashboard') {
                this.loadDashboard();
            }
        }, 30000); // 30 seconds

        this.updateServerTime();
    }

    updateServerTime() {
        const now = new Date();
        document.getElementById('server-time').textContent = now.toLocaleTimeString();
    }

    refreshCurrentSection() {
        this.loadSectionData(this.currentSection);
    }

    loadSectionData(section) {
        switch (section) {
            case 'dashboard':
                this.loadDashboard();
                break;
            case 'workers':
                this.loadWorkers();
                break;
            case 'blocks':
                this.loadBlocks();
                break;
            case 'payouts':
                this.loadPayouts();
                break;
            case 'settings':
                this.loadSettings();
                break;
        }
    }

    // Dashboard Methods
    async loadDashboard() {
        try {
            const response = await fetch('/admin/dashboard');
            const data = await response.json();
            
            this.updateMetrics(data.overview);
            this.updateCharts(data);
            this.updateRecentActivity(data);
        } catch (error) {
            console.error('Failed to load dashboard:', error);
        }
    }

    updateMetrics(overview) {
        document.getElementById('total-workers').textContent = overview.total_workers || '--';
        document.getElementById('pool-hashrate').textContent = this.formatHashrate(overview.total_hashrate);
        document.getElementById('blocks-24h').textContent = overview.blocks_found_24h || '--';
        document.getElementById('total-paid').textContent = this.formatBTC(overview.total_paid_24h);
    }

    updateCharts(data) {
        this.updateHashrateChart();
        this.updateSharesChart();
    }

    async updateHashrateChart() {
        const response = await fetch('/admin/charts/hashrate');
        const chartData = await response.json();
        
        const ctx = document.getElementById('hashrate-chart').getContext('2d');
        
        if (this.charts.hashrate) {
            this.charts.hashrate.destroy();
        }
        
        this.charts.hashrate = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartData.data.map(d => new Date(d.time * 1000).toLocaleTimeString()),
                datasets: [{
                    label: 'Hashrate',
                    data: chartData.data.map(d => d.value),
                    borderColor: '#4CAF50',
                    backgroundColor: 'rgba(76, 175, 80, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: (value) => this.formatHashrate(value)
                        }
                    }
                }
            }
        });
    }

    async updateSharesChart() {
        const response = await fetch('/admin/charts/shares');
        const chartData = await response.json();
        
        const ctx = document.getElementById('shares-chart').getContext('2d');
        
        if (this.charts.shares) {
            this.charts.shares.destroy();
        }
        
        this.charts.shares = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.data.map(d => new Date(d.time * 1000).toLocaleTimeString()),
                datasets: [{
                    label: 'Valid',
                    data: chartData.data.map(d => d.valid),
                    backgroundColor: '#4CAF50'
                }, {
                    label: 'Invalid',
                    data: chartData.data.map(d => d.invalid),
                    backgroundColor: '#f44336'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        stacked: true
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true
                    }
                }
            }
        });
    }

    updateRecentActivity(data) {
        // Mock activity for now
        const activities = [
            { type: 'block', message: 'New block found at height 123456', time: Date.now() - 300000 },
            { type: 'worker', message: 'New worker joined: miner123', time: Date.now() - 600000 },
            { type: 'payout', message: 'Payout processed: 0.1234 BTC', time: Date.now() - 900000 }
        ];
        
        const container = document.getElementById('recent-activity');
        container.innerHTML = activities.map(activity => `
            <div class="activity-item">
                <span>${activity.message}</span>
                <span class="activity-time">${this.timeAgo(activity.time)}</span>
            </div>
        `).join('');
    }

    // Workers Methods
    async loadWorkers(page = 1) {
        try {
            const response = await fetch(`/admin/workers?page=${page}`);
            const data = await response.json();
            
            this.displayWorkers(data.workers);
        } catch (error) {
            console.error('Failed to load workers:', error);
        }
    }

    displayWorkers(workers) {
        const tbody = document.querySelector('#workers-table tbody');
        tbody.innerHTML = workers.map(worker => `
            <tr>
                <td>${worker.id}</td>
                <td>${worker.username}</td>
                <td>${this.formatHashrate(worker.hashrate)}</td>
                <td>${worker.valid_shares}</td>
                <td>${worker.invalid_shares}</td>
                <td>${this.timeAgo(worker.last_seen * 1000)}</td>
                <td><span class="status status-${worker.status}">${worker.status}</span></td>
                <td>
                    <button class="btn btn-sm" onclick="dashboard.viewWorker('${worker.id}')">View</button>
                    <button class="btn btn-sm ${worker.status === 'banned' ? 'btn-primary' : 'btn-danger'}" 
                            onclick="dashboard.toggleBan('${worker.id}', ${worker.status === 'banned'})">
                        ${worker.status === 'banned' ? 'Unban' : 'Ban'}
                    </button>
                </td>
            </tr>
        `).join('');
    }

    async viewWorker(workerId) {
        try {
            const response = await fetch(`/admin/workers/${workerId}`);
            const data = await response.json();
            
            // Show modal with worker details
            const modal = document.getElementById('worker-modal');
            const details = document.getElementById('worker-details');
            
            details.innerHTML = `
                <div class="worker-detail">
                    <h3>Worker: ${workerId}</h3>
                    <p>Hashrate: ${this.formatHashrate(data.hashrate)}</p>
                    <p>Total Shares: ${data.shares.total_shares}</p>
                    <p>Valid Rate: ${data.shares.valid_rate.toFixed(2)}%</p>
                    <p>Current Difficulty: ${data.difficulty.difficulty}</p>
                    <p>Unpaid Balance: ${this.formatBTC(data.earnings.unpaid_balance)}</p>
                </div>
            `;
            
            modal.style.display = 'block';
        } catch (error) {
            console.error('Failed to load worker details:', error);
        }
    }

    async toggleBan(workerId, unban = false) {
        const action = unban ? 'unban' : 'ban';
        if (!confirm(`Are you sure you want to ${action} this worker?`)) {
            return;
        }
        
        try {
            const response = await fetch(`/admin/workers/${workerId}/${action}`, {
                method: 'POST'
            });
            
            if (response.ok) {
                this.loadWorkers();
            }
        } catch (error) {
            console.error(`Failed to ${action} worker:`, error);
        }
    }

    // Blocks Methods
    async loadBlocks() {
        try {
            const response = await fetch('/admin/blocks');
            const blocks = await response.json();
            
            this.displayBlocks(blocks);
        } catch (error) {
            console.error('Failed to load blocks:', error);
        }
    }

    displayBlocks(blocks) {
        const tbody = document.querySelector('#blocks-table tbody');
        tbody.innerHTML = blocks.map(block => `
            <tr>
                <td>${block.height}</td>
                <td title="${block.hash}">${block.hash.substring(0, 10)}...</td>
                <td>${this.formatBTC(block.reward)}</td>
                <td><span class="status status-${block.status}">${block.status}</span></td>
                <td>${block.confirmations}</td>
                <td>${new Date(block.found_at * 1000).toLocaleString()}</td>
                <td>${block.miner}</td>
            </tr>
        `).join('');
    }

    // Payouts Methods
    async loadPayouts() {
        try {
            const response = await fetch('/admin/payouts');
            const payouts = await response.json();
            
            this.displayPayouts(payouts);
        } catch (error) {
            console.error('Failed to load payouts:', error);
        }
    }

    displayPayouts(payouts) {
        const tbody = document.querySelector('#payouts-table tbody');
        tbody.innerHTML = payouts.map(payout => `
            <tr>
                <td>${payout.id}</td>
                <td>${payout.worker_id}</td>
                <td>${this.formatBTC(payout.amount)}</td>
                <td title="${payout.address}">${payout.address.substring(0, 10)}...</td>
                <td>${payout.transaction_id ? `<a href="#" onclick="dashboard.viewTx('${payout.transaction_id}')">${payout.transaction_id.substring(0, 10)}...</a>` : '--'}</td>
                <td><span class="status status-${payout.status}">${payout.status}</span></td>
                <td>${new Date(payout.created_at * 1000).toLocaleString()}</td>
            </tr>
        `).join('');
    }

    async processPayouts() {
        if (!confirm('Are you sure you want to process pending payouts?')) {
            return;
        }
        
        try {
            const response = await fetch('/admin/payouts/process', {
                method: 'POST'
            });
            
            if (response.ok) {
                alert('Payout processing started');
                this.loadPayouts();
            }
        } catch (error) {
            console.error('Failed to process payouts:', error);
        }
    }

    // Settings Methods
    async loadSettings() {
        try {
            const response = await fetch('/admin/stats');
            const data = await response.json();
            
            // Populate settings form
            document.getElementById('pool-fee').value = data.config.pool_fee_percent || 1;
            document.getElementById('min-payout').value = data.config.minimum_payout || 0.001;
            document.getElementById('payout-fee').value = data.config.payout_fee || 0.0001;
            document.getElementById('confirmations').value = data.config.required_confirmations || 6;
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    async saveSettings() {
        const settings = {
            pool_fee_percent: parseFloat(document.getElementById('pool-fee').value),
            minimum_payout: parseFloat(document.getElementById('min-payout').value),
            payout_fee: parseFloat(document.getElementById('payout-fee').value),
            required_confirmations: parseInt(document.getElementById('confirmations').value)
        };
        
        // TODO: Implement settings save endpoint
        alert('Settings saved (not implemented)');
    }

    async runCleanup() {
        if (!confirm('Run cleanup tasks?')) {
            return;
        }
        
        try {
            const response = await fetch('/admin/maintenance/cleanup', {
                method: 'POST'
            });
            
            if (response.ok) {
                alert('Cleanup started');
            }
        } catch (error) {
            console.error('Failed to run cleanup:', error);
        }
    }

    // Utility Methods
    formatHashrate(hashrate) {
        if (!hashrate) return '-- H/s';
        
        const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
        let unitIndex = 0;
        
        while (hashrate >= 1000 && unitIndex < units.length - 1) {
            hashrate /= 1000;
            unitIndex++;
        }
        
        return `${hashrate.toFixed(2)} ${units[unitIndex]}`;
    }

    formatBTC(amount) {
        if (!amount) return '-- BTC';
        return `${amount.toFixed(8)} BTC`;
    }

    timeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        
        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    filterWorkers(search) {
        const rows = document.querySelectorAll('#workers-table tbody tr');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(search.toLowerCase()) ? '' : 'none';
        });
    }

    viewTx(txId) {
        // Open blockchain explorer
        window.open(`https://blockchair.com/bitcoin/transaction/${txId}`, '_blank');
    }

    closeModal() {
        document.getElementById('worker-modal').style.display = 'none';
    }
}

// Initialize dashboard
const dashboard = new AdminDashboard();