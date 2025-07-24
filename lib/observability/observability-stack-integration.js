/**
 * Observability Stack Integration
 * 可観測性スタック統合
 */

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');

class ObservabilityStackIntegration extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Stack components
            components: {
                prometheus: config.components?.prometheus !== false,
                grafana: config.components?.grafana !== false,
                loki: config.components?.loki !== false,
                tempo: config.components?.tempo !== false,
                jaeger: config.components?.jaeger !== false,
                elasticsearch: config.components?.elasticsearch || false,
                kibana: config.components?.kibana || false
            },
            
            // Prometheus configuration
            prometheus: {
                endpoint: config.prometheus?.endpoint || 'http://prometheus:9090',
                pushGateway: config.prometheus?.pushGateway || 'http://pushgateway:9091',
                scrapeInterval: config.prometheus?.scrapeInterval || 15000,
                retention: config.prometheus?.retention || '15d',
                metrics: {
                    prefix: config.prometheus?.metrics?.prefix || 'otedama_',
                    labels: config.prometheus?.metrics?.labels || {
                        service: 'otedama-pool',
                        environment: process.env.NODE_ENV || 'production'
                    }
                }
            },
            
            // Grafana configuration
            grafana: {
                endpoint: config.grafana?.endpoint || 'http://grafana:3000',
                apiKey: config.grafana?.apiKey || process.env.GRAFANA_API_KEY,
                dashboards: config.grafana?.dashboards || ['mining', 'system', 'network', 'security'],
                alerts: config.grafana?.alerts !== false
            },
            
            // Loki configuration (logging)
            loki: {
                endpoint: config.loki?.endpoint || 'http://loki:3100',
                batchSize: config.loki?.batchSize || 100,
                batchInterval: config.loki?.batchInterval || 1000,
                labels: config.loki?.labels || {
                    app: 'otedama',
                    component: 'pool'
                }
            },
            
            // Tempo configuration (tracing)
            tempo: {
                endpoint: config.tempo?.endpoint || 'http://tempo:14268',
                samplingRate: config.tempo?.samplingRate || 0.1,
                batchSize: config.tempo?.batchSize || 100
            },
            
            // Jaeger configuration
            jaeger: {
                endpoint: config.jaeger?.endpoint || 'http://jaeger:14268',
                agentHost: config.jaeger?.agentHost || 'jaeger-agent',
                agentPort: config.jaeger?.agentPort || 6831,
                samplingRate: config.jaeger?.samplingRate || 0.1
            },
            
            // Elasticsearch configuration
            elasticsearch: {
                endpoint: config.elasticsearch?.endpoint || 'http://elasticsearch:9200',
                index: config.elasticsearch?.index || 'otedama',
                type: config.elasticsearch?.type || '_doc',
                batchSize: config.elasticsearch?.batchSize || 100
            },
            
            // Alerting configuration
            alerting: {
                enabled: config.alerting?.enabled !== false,
                channels: config.alerting?.channels || ['prometheus', 'grafana'],
                rules: config.alerting?.rules || []
            },
            
            // Metrics configuration
            metricsConfig: {
                includeSystemMetrics: config.metricsConfig?.includeSystemMetrics !== false,
                includeCustomMetrics: config.metricsConfig?.includeCustomMetrics !== false,
                metricGroups: config.metricsConfig?.metricGroups || [
                    'mining', 'network', 'system', 'security', 'business'
                ]
            },
            
            // Logging configuration
            loggingConfig: {
                level: config.loggingConfig?.level || 'info',
                format: config.loggingConfig?.format || 'json',
                includeStackTrace: config.loggingConfig?.includeStackTrace !== false
            },
            
            // Tracing configuration
            tracingConfig: {
                includeAllRequests: config.tracingConfig?.includeAllRequests || false,
                includeDatabaseQueries: config.tracingConfig?.includeDatabaseQueries !== false,
                includeExternalCalls: config.tracingConfig?.includeExternalCalls !== false
            },
            
            ...config
        };
        
        // Component clients
        this.clients = {
            prometheus: null,
            grafana: null,
            loki: null,
            tempo: null,
            jaeger: null,
            elasticsearch: null
        };
        
        // Metric collectors
        this.metricCollectors = new Map();
        
        // Log buffer
        this.logBuffer = [];
        
        // Trace buffer
        this.traceBuffer = [];
        
        // Dashboard configurations
        this.dashboards = new Map();
        
        // Alert rules
        this.alertRules = new Map();
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('可観測性スタックを初期化中...');
        
        // Initialize enabled components
        const initPromises = [];
        
        if (this.config.components.prometheus) {
            initPromises.push(this.initializePrometheus());
        }
        
        if (this.config.components.grafana) {
            initPromises.push(this.initializeGrafana());
        }
        
        if (this.config.components.loki) {
            initPromises.push(this.initializeLoki());
        }
        
        if (this.config.components.tempo) {
            initPromises.push(this.initializeTempo());
        }
        
        if (this.config.components.jaeger) {
            initPromises.push(this.initializeJaeger());
        }
        
        if (this.config.components.elasticsearch) {
            initPromises.push(this.initializeElasticsearch());
        }
        
        await Promise.all(initPromises);
        
        // Setup metric collectors
        this.setupMetricCollectors();
        
        // Setup log shipping
        this.setupLogShipping();
        
        // Setup trace exporters
        this.setupTraceExporters();
        
        // Setup dashboards
        await this.setupDashboards();
        
        // Setup alerting
        if (this.config.alerting.enabled) {
            await this.setupAlerting();
        }
        
        console.log('✓ 可観測性スタックの初期化完了');
    }
    
    /**
     * Initialize Prometheus
     */
    async initializePrometheus() {
        // Create Prometheus registry
        this.prometheusRegistry = new PrometheusRegistry();
        
        // Setup default metrics
        this.setupDefaultMetrics();
        
        // Setup metrics endpoint
        this.setupMetricsEndpoint();
        
        // Setup push gateway client if configured
        if (this.config.prometheus.pushGateway) {
            this.setupPushGateway();
        }
    }
    
    /**
     * Setup default metrics
     */
    setupDefaultMetrics() {
        const prefix = this.config.prometheus.metrics.prefix;
        
        // System metrics
        if (this.config.metricsConfig.includeSystemMetrics) {
            // CPU usage
            this.cpuUsageGauge = this.prometheusRegistry.gauge({
                name: `${prefix}cpu_usage_percent`,
                help: 'CPU usage percentage',
                labelNames: ['core']
            });
            
            // Memory usage
            this.memoryUsageGauge = this.prometheusRegistry.gauge({
                name: `${prefix}memory_usage_bytes`,
                help: 'Memory usage in bytes',
                labelNames: ['type'] // heap, rss, external
            });
            
            // Disk usage
            this.diskUsageGauge = this.prometheusRegistry.gauge({
                name: `${prefix}disk_usage_bytes`,
                help: 'Disk usage in bytes',
                labelNames: ['path', 'type'] // used, available, total
            });
        }
        
        // Mining metrics
        if (this.config.metricsConfig.metricGroups.includes('mining')) {
            // Hashrate
            this.hashrateGauge = this.prometheusRegistry.gauge({
                name: `${prefix}mining_hashrate`,
                help: 'Current mining hashrate',
                labelNames: ['algorithm', 'worker']
            });
            
            // Shares
            this.sharesCounter = this.prometheusRegistry.counter({
                name: `${prefix}mining_shares_total`,
                help: 'Total mining shares',
                labelNames: ['type', 'worker'] // valid, invalid, stale
            });
            
            // Blocks
            this.blocksCounter = this.prometheusRegistry.counter({
                name: `${prefix}mining_blocks_total`,
                help: 'Total blocks found',
                labelNames: ['status'] // found, orphaned, confirmed
            });
        }
        
        // Network metrics
        if (this.config.metricsConfig.metricGroups.includes('network')) {
            // Connections
            this.connectionsGauge = this.prometheusRegistry.gauge({
                name: `${prefix}network_connections`,
                help: 'Number of network connections',
                labelNames: ['type', 'state'] // stratum, http, ws / active, idle
            });
            
            // Bandwidth
            this.bandwidthCounter = this.prometheusRegistry.counter({
                name: `${prefix}network_bandwidth_bytes`,
                help: 'Network bandwidth usage',
                labelNames: ['direction'] // in, out
            });
            
            // Request latency
            this.requestLatencyHistogram = this.prometheusRegistry.histogram({
                name: `${prefix}request_duration_seconds`,
                help: 'Request duration in seconds',
                labelNames: ['method', 'endpoint', 'status'],
                buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
            });
        }
        
        // Security metrics
        if (this.config.metricsConfig.metricGroups.includes('security')) {
            // Authentication attempts
            this.authAttemptsCounter = this.prometheusRegistry.counter({
                name: `${prefix}auth_attempts_total`,
                help: 'Total authentication attempts',
                labelNames: ['result', 'method'] // success, failure / password, token, mfa
            });
            
            // Security events
            this.securityEventsCounter = this.prometheusRegistry.counter({
                name: `${prefix}security_events_total`,
                help: 'Total security events',
                labelNames: ['type', 'severity'] // intrusion, ddos, injection / low, medium, high, critical
            });
        }
        
        // Business metrics
        if (this.config.metricsConfig.metricGroups.includes('business')) {
            // Revenue
            this.revenueCounter = this.prometheusRegistry.counter({
                name: `${prefix}revenue_total`,
                help: 'Total revenue',
                labelNames: ['currency', 'source'] // btc, eth / mining, fees
            });
            
            // Users
            this.activeUsersGauge = this.prometheusRegistry.gauge({
                name: `${prefix}active_users`,
                help: 'Number of active users',
                labelNames: ['type'] // miners, pool_operators
            });
        }
    }
    
    /**
     * Setup metrics endpoint
     */
    setupMetricsEndpoint() {
        const server = http.createServer((req, res) => {
            if (req.url === '/metrics') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(this.prometheusRegistry.metrics());
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        
        const port = process.env.METRICS_PORT || 9090;
        server.listen(port, () => {
            console.log(`Prometheus metrics endpoint listening on port ${port}`);
        });
    }
    
    /**
     * Initialize Grafana
     */
    async initializeGrafana() {
        this.clients.grafana = {
            endpoint: this.config.grafana.endpoint,
            apiKey: this.config.grafana.apiKey,
            
            async request(method, path, data) {
                const options = {
                    method,
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                };
                
                if (data) {
                    options.body = JSON.stringify(data);
                }
                
                const response = await fetch(`${this.endpoint}${path}`, options);
                return response.json();
            }
        };
        
        // Verify connection
        try {
            await this.clients.grafana.request('GET', '/api/org');
            console.log('Connected to Grafana');
        } catch (error) {
            console.error('Failed to connect to Grafana:', error);
        }
    }
    
    /**
     * Setup dashboards
     */
    async setupDashboards() {
        if (!this.config.components.grafana) return;
        
        // Mining dashboard
        if (this.config.grafana.dashboards.includes('mining')) {
            this.dashboards.set('mining', this.createMiningDashboard());
        }
        
        // System dashboard
        if (this.config.grafana.dashboards.includes('system')) {
            this.dashboards.set('system', this.createSystemDashboard());
        }
        
        // Network dashboard
        if (this.config.grafana.dashboards.includes('network')) {
            this.dashboards.set('network', this.createNetworkDashboard());
        }
        
        // Security dashboard
        if (this.config.grafana.dashboards.includes('security')) {
            this.dashboards.set('security', this.createSecurityDashboard());
        }
        
        // Import dashboards to Grafana
        for (const [name, dashboard] of this.dashboards) {
            try {
                await this.importDashboard(dashboard);
                console.log(`Imported ${name} dashboard to Grafana`);
            } catch (error) {
                console.error(`Failed to import ${name} dashboard:`, error);
            }
        }
    }
    
    /**
     * Create mining dashboard
     */
    createMiningDashboard() {
        return {
            dashboard: {
                title: 'Otedama Mining Dashboard',
                tags: ['otedama', 'mining'],
                timezone: 'browser',
                panels: [
                    {
                        title: 'Total Hashrate',
                        type: 'graph',
                        gridPos: { x: 0, y: 0, w: 12, h: 8 },
                        targets: [{
                            expr: `sum(${this.config.prometheus.metrics.prefix}mining_hashrate)`,
                            legendFormat: 'Total Hashrate'
                        }]
                    },
                    {
                        title: 'Hashrate by Worker',
                        type: 'graph',
                        gridPos: { x: 12, y: 0, w: 12, h: 8 },
                        targets: [{
                            expr: `${this.config.prometheus.metrics.prefix}mining_hashrate`,
                            legendFormat: '{{worker}}'
                        }]
                    },
                    {
                        title: 'Shares',
                        type: 'stat',
                        gridPos: { x: 0, y: 8, w: 6, h: 4 },
                        targets: [{
                            expr: `sum(rate(${this.config.prometheus.metrics.prefix}mining_shares_total[5m]))`,
                            legendFormat: 'Shares/sec'
                        }]
                    },
                    {
                        title: 'Share Efficiency',
                        type: 'gauge',
                        gridPos: { x: 6, y: 8, w: 6, h: 4 },
                        targets: [{
                            expr: `sum(rate(${this.config.prometheus.metrics.prefix}mining_shares_total{type="valid"}[5m])) / sum(rate(${this.config.prometheus.metrics.prefix}mining_shares_total[5m])) * 100`,
                            legendFormat: 'Efficiency %'
                        }]
                    },
                    {
                        title: 'Blocks Found',
                        type: 'stat',
                        gridPos: { x: 12, y: 8, w: 6, h: 4 },
                        targets: [{
                            expr: `sum(${this.config.prometheus.metrics.prefix}mining_blocks_total{status="found"})`,
                            legendFormat: 'Total Blocks'
                        }]
                    },
                    {
                        title: 'Block Luck',
                        type: 'graph',
                        gridPos: { x: 18, y: 8, w: 6, h: 4 },
                        targets: [{
                            expr: `rate(${this.config.prometheus.metrics.prefix}mining_blocks_total{status="found"}[1h])`,
                            legendFormat: 'Blocks/hour'
                        }]
                    }
                ],
                time: {
                    from: 'now-6h',
                    to: 'now'
                },
                refresh: '10s'
            }
        };
    }
    
    /**
     * Initialize Loki for log aggregation
     */
    async initializeLoki() {
        this.clients.loki = {
            endpoint: this.config.loki.endpoint,
            batchSize: this.config.loki.batchSize,
            labels: this.config.loki.labels,
            
            async push(logs) {
                const streams = [{
                    stream: this.labels,
                    values: logs.map(log => [
                        String(log.timestamp * 1000000), // nanoseconds
                        JSON.stringify(log)
                    ])
                }];
                
                const response = await fetch(`${this.endpoint}/loki/api/v1/push`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ streams })
                });
                
                if (!response.ok) {
                    throw new Error(`Loki push failed: ${response.statusText}`);
                }
            }
        };
        
        // Start log shipping
        setInterval(() => {
            this.shipLogs();
        }, this.config.loki.batchInterval);
    }
    
    /**
     * Setup log shipping
     */
    setupLogShipping() {
        // Override console methods to capture logs
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        
        console.log = (...args) => {
            this.captureLog('info', args);
            originalLog.apply(console, args);
        };
        
        console.error = (...args) => {
            this.captureLog('error', args);
            originalError.apply(console, args);
        };
        
        console.warn = (...args) => {
            this.captureLog('warn', args);
            originalWarn.apply(console, args);
        };
    }
    
    /**
     * Capture log entry
     */
    captureLog(level, args) {
        const logEntry = {
            timestamp: Date.now(),
            level,
            message: args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' '),
            labels: {
                ...this.config.loki.labels,
                level
            }
        };
        
        this.logBuffer.push(logEntry);
        
        // Ship if buffer is full
        if (this.logBuffer.length >= this.config.loki.batchSize) {
            this.shipLogs();
        }
    }
    
    /**
     * Ship logs to Loki
     */
    async shipLogs() {
        if (this.logBuffer.length === 0 || !this.clients.loki) return;
        
        const logs = this.logBuffer.splice(0, this.config.loki.batchSize);
        
        try {
            await this.clients.loki.push(logs);
        } catch (error) {
            console.error('Failed to ship logs to Loki:', error);
            // Put logs back in buffer
            this.logBuffer.unshift(...logs);
        }
    }
    
    /**
     * Initialize tracing
     */
    async initializeTempo() {
        this.clients.tempo = {
            endpoint: this.config.tempo.endpoint,
            
            async export(spans) {
                const batch = {
                    process: {
                        serviceName: 'otedama-pool',
                        tags: []
                    },
                    spans: spans.map(span => ({
                        traceID: span.traceId,
                        spanID: span.spanId,
                        operationName: span.operationName,
                        references: span.parentSpanId ? [{
                            refType: 'CHILD_OF',
                            traceID: span.traceId,
                            spanID: span.parentSpanId
                        }] : [],
                        startTime: span.startTime * 1000,
                        duration: span.duration * 1000,
                        tags: Object.entries(span.tags || {}).map(([key, value]) => ({
                            key,
                            type: typeof value === 'string' ? 'string' : 'number',
                            value: String(value)
                        })),
                        logs: span.logs || []
                    }))
                };
                
                const response = await fetch(`${this.endpoint}/api/traces`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-thrift'
                    },
                    body: JSON.stringify(batch)
                });
                
                if (!response.ok) {
                    throw new Error(`Tempo export failed: ${response.statusText}`);
                }
            }
        };
    }
    
    /**
     * Setup trace exporters
     */
    setupTraceExporters() {
        // Export traces periodically
        setInterval(() => {
            this.exportTraces();
        }, 5000);
    }
    
    /**
     * Export traces
     */
    async exportTraces() {
        if (this.traceBuffer.length === 0) return;
        
        const traces = this.traceBuffer.splice(0, this.config.tempo.batchSize);
        
        const exportPromises = [];
        
        if (this.clients.tempo) {
            exportPromises.push(this.clients.tempo.export(traces));
        }
        
        if (this.clients.jaeger) {
            exportPromises.push(this.clients.jaeger.export(traces));
        }
        
        try {
            await Promise.all(exportPromises);
        } catch (error) {
            console.error('Failed to export traces:', error);
            // Put traces back in buffer
            this.traceBuffer.unshift(...traces);
        }
    }
    
    /**
     * Create a new trace span
     */
    startSpan(operationName, options = {}) {
        const span = {
            traceId: options.traceId || this.generateTraceId(),
            spanId: this.generateSpanId(),
            parentSpanId: options.parentSpanId,
            operationName,
            startTime: Date.now(),
            tags: {},
            logs: []
        };
        
        return {
            setTag(key, value) {
                span.tags[key] = value;
            },
            
            log(message, fields = {}) {
                span.logs.push({
                    timestamp: Date.now() * 1000,
                    fields: [
                        { key: 'message', value: message },
                        ...Object.entries(fields).map(([key, value]) => ({ key, value: String(value) }))
                    ]
                });
            },
            
            finish() {
                span.endTime = Date.now();
                span.duration = span.endTime - span.startTime;
                
                // Sample based on configuration
                if (Math.random() < this.config.tempo.samplingRate) {
                    this.traceBuffer.push(span);
                }
                
                return span;
            }
        };
    }
    
    /**
     * Setup alerting
     */
    async setupAlerting() {
        // Define default alert rules
        const defaultRules = [
            {
                name: 'HighCPUUsage',
                expr: `avg(${this.config.prometheus.metrics.prefix}cpu_usage_percent) > 80`,
                for: '5m',
                severity: 'warning',
                annotations: {
                    summary: 'High CPU usage detected',
                    description: 'CPU usage has been above 80% for 5 minutes'
                }
            },
            {
                name: 'HighMemoryUsage',
                expr: `avg(${this.config.prometheus.metrics.prefix}memory_usage_bytes{type="heap"}) / avg(${this.config.prometheus.metrics.prefix}memory_usage_bytes{type="total"}) > 0.9`,
                for: '5m',
                severity: 'warning',
                annotations: {
                    summary: 'High memory usage detected',
                    description: 'Memory usage has been above 90% for 5 minutes'
                }
            },
            {
                name: 'LowHashrate',
                expr: `sum(${this.config.prometheus.metrics.prefix}mining_hashrate) < 1000000`,
                for: '10m',
                severity: 'critical',
                annotations: {
                    summary: 'Low total hashrate',
                    description: 'Total hashrate has dropped below 1 MH/s'
                }
            },
            {
                name: 'HighShareRejectionRate',
                expr: `sum(rate(${this.config.prometheus.metrics.prefix}mining_shares_total{type="invalid"}[5m])) / sum(rate(${this.config.prometheus.metrics.prefix}mining_shares_total[5m])) > 0.05`,
                for: '5m',
                severity: 'warning',
                annotations: {
                    summary: 'High share rejection rate',
                    description: 'Share rejection rate is above 5%'
                }
            },
            {
                name: 'SecurityEvent',
                expr: `sum(rate(${this.config.prometheus.metrics.prefix}security_events_total{severity=~"high|critical"}[5m])) > 0`,
                for: '1m',
                severity: 'critical',
                annotations: {
                    summary: 'Security event detected',
                    description: 'High or critical severity security event detected'
                }
            }
        ];
        
        // Merge with custom rules
        const allRules = [...defaultRules, ...this.config.alerting.rules];
        
        // Setup alert rules in Prometheus
        if (this.config.alerting.channels.includes('prometheus')) {
            await this.setupPrometheusAlerts(allRules);
        }
        
        // Setup alert rules in Grafana
        if (this.config.alerting.channels.includes('grafana')) {
            await this.setupGrafanaAlerts(allRules);
        }
    }
    
    /**
     * Record custom metric
     */
    recordMetric(name, value, labels = {}) {
        const metric = this.metricCollectors.get(name);
        if (!metric) {
            console.warn(`Metric ${name} not found`);
            return;
        }
        
        if (metric.type === 'counter') {
            metric.inc(labels, value);
        } else if (metric.type === 'gauge') {
            metric.set(labels, value);
        } else if (metric.type === 'histogram') {
            metric.observe(labels, value);
        }
    }
    
    /**
     * Create custom metric
     */
    createMetric(name, type, help, labelNames = []) {
        const fullName = `${this.config.prometheus.metrics.prefix}${name}`;
        
        let metric;
        switch (type) {
            case 'counter':
                metric = this.prometheusRegistry.counter({
                    name: fullName,
                    help,
                    labelNames
                });
                break;
                
            case 'gauge':
                metric = this.prometheusRegistry.gauge({
                    name: fullName,
                    help,
                    labelNames
                });
                break;
                
            case 'histogram':
                metric = this.prometheusRegistry.histogram({
                    name: fullName,
                    help,
                    labelNames,
                    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
                });
                break;
                
            default:
                throw new Error(`Unknown metric type: ${type}`);
        }
        
        this.metricCollectors.set(name, { type, metric });
        return metric;
    }
    
    /**
     * Get observability status
     */
    getStatus() {
        const status = {
            components: {},
            metrics: {
                registered: this.metricCollectors.size,
                prometheus: this.prometheusRegistry?.metrics?.length || 0
            },
            logs: {
                buffered: this.logBuffer.length
            },
            traces: {
                buffered: this.traceBuffer.length
            },
            dashboards: Array.from(this.dashboards.keys()),
            alerts: Array.from(this.alertRules.keys())
        };
        
        // Check component status
        for (const [component, enabled] of Object.entries(this.config.components)) {
            if (enabled) {
                status.components[component] = {
                    enabled: true,
                    connected: !!this.clients[component]
                };
            }
        }
        
        return status;
    }
    
    /**
     * Helper methods
     */
    
    generateTraceId() {
        return crypto.randomBytes(16).toString('hex');
    }
    
    generateSpanId() {
        return crypto.randomBytes(8).toString('hex');
    }
    
    /**
     * Cleanup
     */
    async cleanup() {
        // Export remaining logs
        await this.shipLogs();
        
        // Export remaining traces
        await this.exportTraces();
        
        // Clear buffers
        this.logBuffer = [];
        this.traceBuffer = [];
    }
}

// Simple Prometheus registry implementation
class PrometheusRegistry {
    constructor() {
        this.metrics = [];
    }
    
    counter(config) {
        const metric = new Counter(config);
        this.metrics.push(metric);
        return metric;
    }
    
    gauge(config) {
        const metric = new Gauge(config);
        this.metrics.push(metric);
        return metric;
    }
    
    histogram(config) {
        const metric = new Histogram(config);
        this.metrics.push(metric);
        return metric;
    }
    
    metrics() {
        let output = '';
        
        for (const metric of this.metrics) {
            output += metric.getMetrics();
        }
        
        return output;
    }
}

class Counter {
    constructor(config) {
        this.config = config;
        this.values = new Map();
    }
    
    inc(labels = {}, value = 1) {
        const key = JSON.stringify(labels);
        const current = this.values.get(key) || 0;
        this.values.set(key, current + value);
    }
    
    getMetrics() {
        let output = `# HELP ${this.config.name} ${this.config.help}\n`;
        output += `# TYPE ${this.config.name} counter\n`;
        
        for (const [labelsStr, value] of this.values) {
            const labels = JSON.parse(labelsStr);
            const labelPairs = Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(',');
            
            output += `${this.config.name}{${labelPairs}} ${value}\n`;
        }
        
        return output;
    }
}

class Gauge {
    constructor(config) {
        this.config = config;
        this.values = new Map();
    }
    
    set(labels = {}, value) {
        const key = JSON.stringify(labels);
        this.values.set(key, value);
    }
    
    getMetrics() {
        let output = `# HELP ${this.config.name} ${this.config.help}\n`;
        output += `# TYPE ${this.config.name} gauge\n`;
        
        for (const [labelsStr, value] of this.values) {
            const labels = JSON.parse(labelsStr);
            const labelPairs = Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(',');
            
            output += `${this.config.name}{${labelPairs}} ${value}\n`;
        }
        
        return output;
    }
}

class Histogram {
    constructor(config) {
        this.config = config;
        this.values = new Map();
        this.buckets = config.buckets;
    }
    
    observe(labels = {}, value) {
        const key = JSON.stringify(labels);
        if (!this.values.has(key)) {
            this.values.set(key, []);
        }
        this.values.get(key).push(value);
    }
    
    getMetrics() {
        let output = `# HELP ${this.config.name} ${this.config.help}\n`;
        output += `# TYPE ${this.config.name} histogram\n`;
        
        for (const [labelsStr, values] of this.values) {
            const labels = JSON.parse(labelsStr);
            const labelPairs = Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(',');
            
            // Calculate bucket counts
            for (const bucket of this.buckets) {
                const count = values.filter(v => v <= bucket).length;
                output += `${this.config.name}_bucket{${labelPairs},le="${bucket}"} ${count}\n`;
            }
            
            output += `${this.config.name}_bucket{${labelPairs},le="+Inf"} ${values.length}\n`;
            output += `${this.config.name}_sum{${labelPairs}} ${values.reduce((a, b) => a + b, 0)}\n`;
            output += `${this.config.name}_count{${labelPairs}} ${values.length}\n`;
        }
        
        return output;
    }
}

module.exports = ObservabilityStackIntegration;