package monitoring

import (
	"encoding/json"
	"html/template"
	"net/http"
	"time"
)

// DashboardHandler provides a web-based monitoring dashboard
type DashboardHandler struct {
	server *MonitoringServer
}

// NewDashboardHandler creates a new dashboard handler
func NewDashboardHandler(server *MonitoringServer) *DashboardHandler {
	return &DashboardHandler{
		server: server,
	}
}

// RegisterRoutes registers dashboard routes
func (d *DashboardHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/", d.handleDashboard)
	mux.HandleFunc("/api/stats", d.handleAPIStats)
	mux.HandleFunc("/api/components", d.handleAPIComponents)
}

func (d *DashboardHandler) handleDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	
	tmpl := `<!DOCTYPE html>
<html>
<head>
    <title>Otedama Monitoring Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
            color: #333;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card h2 {
            margin-top: 0;
            color: #2c3e50;
            font-size: 1.2em;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #eee;
        }
        .metric:last-child {
            border-bottom: none;
        }
        .metric-label {
            color: #7f8c8d;
        }
        .metric-value {
            font-weight: 600;
            color: #2c3e50;
        }
        .status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.85em;
            font-weight: 600;
        }
        .status-healthy {
            background: #d4edda;
            color: #155724;
        }
        .status-unhealthy {
            background: #f8d7da;
            color: #721c24;
        }
        .refresh-info {
            text-align: center;
            color: #7f8c8d;
            margin-top: 20px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Otedama Monitoring Dashboard</h1>
        
        <div id="status"></div>
        
        <div class="grid" id="metrics">
            <div class="card">
                <h2>System Metrics</h2>
                <div id="system-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h2>Mining Performance</h2>
                <div id="mining-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h2>Network Status</h2>
                <div id="network-metrics">Loading...</div>
            </div>
            
            <div class="card">
                <h2>Component Health</h2>
                <div id="component-health">Loading...</div>
            </div>
        </div>
        
        <div class="refresh-info">
            Auto-refresh every 5 seconds | Last updated: <span id="last-updated">-</span>
        </div>
    </div>
    
    <script>
        function formatNumber(num) {
            if (num >= 1e9) return (num / 1e9).toFixed(2) + 'G';
            if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
            if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
            return num.toString();
        }
        
        function formatBytes(bytes) {
            if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
            if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
            if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
            return bytes + ' B';
        }
        
        function formatHashRate(hashRate) {
            if (hashRate >= 1e15) return (hashRate / 1e15).toFixed(2) + ' PH/s';
            if (hashRate >= 1e12) return (hashRate / 1e12).toFixed(2) + ' TH/s';
            if (hashRate >= 1e9) return (hashRate / 1e9).toFixed(2) + ' GH/s';
            if (hashRate >= 1e6) return (hashRate / 1e6).toFixed(2) + ' MH/s';
            if (hashRate >= 1e3) return (hashRate / 1e3).toFixed(2) + ' KH/s';
            return hashRate.toFixed(2) + ' H/s';
        }
        
        function createMetric(label, value) {
            return '<div class="metric"><span class="metric-label">' + label + '</span><span class="metric-value">' + value + '</span></div>';
        }
        
        async function updateDashboard() {
            try {
                // Fetch stats
                const statsResponse = await fetch('/api/stats');
                const stats = await statsResponse.json();
                
                // Update system metrics
                const systemMetrics = document.getElementById('system-metrics');
                systemMetrics.innerHTML = 
                    createMetric('CPU Usage', stats.cpu_usage_percent.toFixed(1) + '%') +
                    createMetric('Memory Used', formatBytes(stats.memory_used_bytes)) +
                    createMetric('Goroutines', formatNumber(stats.goroutine_count)) +
                    createMetric('Go Version', stats.go_version);
                
                // Update mining metrics
                const miningMetrics = document.getElementById('mining-metrics');
                miningMetrics.innerHTML = 
                    createMetric('Hash Rate', formatHashRate(stats.hash_rate)) +
                    createMetric('Shares Submitted', formatNumber(stats.shares_submitted)) +
                    createMetric('Shares Accepted', formatNumber(stats.shares_accepted)) +
                    createMetric('Active Workers', stats.active_workers);
                
                // Update network metrics
                const networkMetrics = document.getElementById('network-metrics');
                networkMetrics.innerHTML = 
                    createMetric('Connected Peers', stats.connected_peers) +
                    createMetric('Network In', formatBytes(stats.network_in_bytes)) +
                    createMetric('Network Out', formatBytes(stats.network_out_bytes)) +
                    createMetric('Pool Hash Rate', formatHashRate(stats.pool_hash_rate));
                
                // Fetch component status
                const componentsResponse = await fetch('/status');
                const components = await componentsResponse.json();
                
                // Update component health
                const componentHealth = document.getElementById('component-health');
                let healthHTML = '';
                
                for (const [name, component] of Object.entries(components.components)) {
                    const statusClass = component.healthy ? 'status-healthy' : 'status-unhealthy';
                    const statusText = component.healthy ? 'Healthy' : 'Unhealthy';
                    healthHTML += '<div class="metric">' +
                        '<span class="metric-label">' + name + '</span>' +
                        '<span class="status ' + statusClass + '">' + statusText + '</span>' +
                        '</div>';
                }
                
                componentHealth.innerHTML = healthHTML;
                
                // Update last updated time
                document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
                
            } catch (error) {
                console.error('Failed to update dashboard:', error);
            }
        }
        
        // Initial update
        updateDashboard();
        
        // Auto-refresh every 5 seconds
        setInterval(updateDashboard, 5000);
    </script>
</body>
</html>`
	
	t, _ := template.New("dashboard").Parse(tmpl)
	t.Execute(w, nil)
}

func (d *DashboardHandler) handleAPIStats(w http.ResponseWriter, r *http.Request) {
	d.server.metricsMu.RLock()
	metrics := *d.server.metrics
	d.server.metricsMu.RUnlock()
	
	// Add current timestamp
	response := map[string]interface{}{
		"timestamp":           time.Now(),
		"cpu_usage_percent":   metrics.CPUUsage,
		"memory_used_bytes":   metrics.MemoryUsed,
		"memory_total_bytes":  metrics.MemoryTotal,
		"goroutine_count":     metrics.GoroutineCount,
		"go_version":         metrics.GoVersion,
		"hash_rate":          metrics.HashRate,
		"shares_submitted":   metrics.SharesSubmitted,
		"shares_accepted":    metrics.SharesAccepted,
		"connected_peers":    metrics.ConnectedPeers,
		"network_in_bytes":   metrics.NetworkInBytes,
		"network_out_bytes":  metrics.NetworkOutBytes,
		"active_workers":     metrics.ActiveWorkers,
		"pool_hash_rate":     metrics.PoolHashRate,
		"uptime":            metrics.Uptime.String(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (d *DashboardHandler) handleAPIComponents(w http.ResponseWriter, r *http.Request) {
	d.server.componentsMu.RLock()
	defer d.server.componentsMu.RUnlock()
	
	components := make(map[string]interface{})
	
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	
	for name, component := range d.server.components {
		err := component.HealthCheck(ctx)
		
		componentInfo := map[string]interface{}{
			"name":    name,
			"healthy": err == nil,
			"stats":   component.GetStats(),
		}
		
		if err != nil {
			componentInfo["error"] = err.Error()
		}
		
		components[name] = componentInfo
	}
	
	response := map[string]interface{}{
		"timestamp":  time.Now(),
		"components": components,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}