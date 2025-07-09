// src/tracing/trace-ui.ts
import express from 'express';
import { DistributedTracer } from './distributed-tracer';
import { TraceAnalyzer } from './trace-analyzer';
import { Logger } from '../logging/logger';

export class TraceUI {
  private router: express.Router;
  private tracer: DistributedTracer;
  private analyzer: TraceAnalyzer;
  private logger: Logger;

  constructor(tracer: DistributedTracer, analyzer: TraceAnalyzer, logger: Logger) {
    this.router = express.Router();
    this.tracer = tracer;
    this.analyzer = analyzer;
    this.logger = logger;
    
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Main dashboard
    this.router.get('/', (req, res) => {
      res.send(this.generateDashboardHTML());
    });

    // Trace detail page
    this.router.get('/trace/:traceId', (req, res) => {
      const { traceId } = req.params;
      const analysis = this.analyzer.analyzeTrace(traceId);
      
      if (!analysis) {
        return res.status(404).send('<h1>Trace not found</h1>');
      }
      
      res.send(this.generateTraceDetailHTML(analysis));
    });

    // Service map page
    this.router.get('/services', (req, res) => {
      res.send(this.generateServiceMapHTML());
    });

    // Insights page
    this.router.get('/insights', (req, res) => {
      res.send(this.generateInsightsHTML());
    });

    // API endpoints
    this.router.get('/api/metrics', (req, res) => {
      const metrics = this.tracer.getMetrics();
      const stats = this.analyzer.getTraceStatistics();
      
      res.json({
        success: true,
        data: { metrics, stats }
      });
    });

    this.router.get('/api/traces', async (req, res) => {
      try {
        const query = {
          serviceName: req.query.service as string,
          operationName: req.query.operation as string,
          minDuration: req.query.minDuration ? parseInt(req.query.minDuration as string) : undefined,
          hasErrors: req.query.hasErrors === 'true',
          limit: req.query.limit ? parseInt(req.query.limit as string) : 50
        };

        const traces = await this.analyzer.searchTraces(query);
        
        res.json({
          success: true,
          data: traces
        });
      } catch (error) {
        this.logger.error('Trace search error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to search traces'
        });
      }
    });

    this.router.get('/api/insights', (req, res) => {
      const severity = req.query.severity as any;
      const insights = this.analyzer.getInsights(severity);
      
      res.json({
        success: true,
        data: insights
      });
    });

    this.router.get('/api/service-map', (req, res) => {
      const serviceMap = this.tracer.getServiceMap();
      const dependencies = this.analyzer.getServiceDependencies();
      
      res.json({
        success: true,
        data: {
          serviceMap: Object.fromEntries(serviceMap),
          dependencies: Object.fromEntries(dependencies)
        }
      });
    });

    // Static assets
    this.router.get('/style.css', (req, res) => {
      res.type('text/css').send(this.getCSS());
    });

    this.router.get('/script.js', (req, res) => {
      res.type('application/javascript').send(this.getJavaScript());
    });
  }

  private generateDashboardHTML(): string {
    const metrics = this.tracer.getMetrics();
    const stats = this.analyzer.getTraceStatistics();
    const insights = this.analyzer.getInsights();
    const criticalInsights = insights.filter(i => i.severity === 'critical').length;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Distributed Tracing Dashboard</title>
    <link rel="stylesheet" href="/tracing/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>📊 Distributed Tracing Dashboard</h1>
            <nav>
                <a href="/tracing/">Dashboard</a>
                <a href="/tracing/services">Service Map</a>
                <a href="/tracing/insights">Insights</a>
            </nav>
        </header>

        <div class="metrics-overview">
            <div class="metric-card">
                <h3>Total Spans</h3>
                <div class="metric-value">${metrics.totalSpans}</div>
            </div>
            <div class="metric-card">
                <h3>Active Spans</h3>
                <div class="metric-value">${metrics.activeSpans}</div>
            </div>
            <div class="metric-card">
                <h3>Error Rate</h3>
                <div class="metric-value ${stats.errorRate > 5 ? 'error' : ''}">${stats.errorRate.toFixed(1)}%</div>
            </div>
            <div class="metric-card">
                <h3>Avg Duration</h3>
                <div class="metric-value">${metrics.avgDuration.toFixed(1)}ms</div>
            </div>
            <div class="metric-card">
                <h3>P95 Duration</h3>
                <div class="metric-value">${metrics.p95Duration.toFixed(1)}ms</div>
            </div>
            <div class="metric-card">
                <h3>Throughput</h3>
                <div class="metric-value">${metrics.throughput.toFixed(1)} req/s</div>
            </div>
            <div class="metric-card">
                <h3>Total Traces</h3>
                <div class="metric-value">${stats.totalTraces}</div>
            </div>
            <div class="metric-card ${criticalInsights > 0 ? 'alert' : ''}">
                <h3>Critical Issues</h3>
                <div class="metric-value">${criticalInsights}</div>
            </div>
        </div>

        <div class="dashboard-sections">
            <div class="section">
                <h2>Recent Traces</h2>
                <div class="trace-search">
                    <input type="text" id="serviceFilter" placeholder="Filter by service">
                    <input type="text" id="operationFilter" placeholder="Filter by operation">
                    <button onclick="searchTraces()">Search</button>
                    <button onclick="loadRecentTraces()">Recent</button>
                </div>
                <div id="tracesList" class="traces-list">
                    Loading traces...
                </div>
            </div>

            <div class="section">
                <h2>Top Operations</h2>
                <div class="operations-list">
                    ${stats.topOperations.map(op => `
                        <div class="operation-item">
                            <div class="operation-name">${op.operation}</div>
                            <div class="operation-stats">
                                <span>Count: ${op.count}</span>
                                <span>Avg: ${op.avgDuration.toFixed(1)}ms</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="section">
                <h2>Performance Insights</h2>
                <div id="insightsList" class="insights-list">
                    ${insights.slice(0, 5).map(insight => `
                        <div class="insight-item severity-${insight.severity}">
                            <div class="insight-header">
                                <span class="insight-type">${insight.type.replace('_', ' ')}</span>
                                <span class="insight-severity">${insight.severity}</span>
                            </div>
                            <div class="insight-title">${insight.title}</div>
                            <div class="insight-description">${insight.description}</div>
                        </div>
                    `).join('')}
                </div>
                <a href="/tracing/insights" class="view-all-link">View All Insights →</a>
            </div>
        </div>
    </div>

    <script src="/tracing/script.js"></script>
    <script>
        // Auto-refresh data
        setInterval(() => {
            loadRecentTraces();
            updateMetrics();
        }, 30000);

        // Load initial data
        document.addEventListener('DOMContentLoaded', () => {
            loadRecentTraces();
        });
    </script>
</body>
</html>`;
  }

  private generateTraceDetailHTML(analysis: any): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trace: ${analysis.traceId}</title>
    <link rel="stylesheet" href="/tracing/style.css">
</head>
<body>
    <div class="container">
        <header>
            <nav>
                <a href="/tracing/">&larr; Back to Dashboard</a>
            </nav>
            <h1>🔍 Trace Analysis</h1>
            <div class="trace-id">ID: ${analysis.traceId}</div>
        </header>

        <div class="trace-overview">
            <div class="overview-card">
                <h3>Duration</h3>
                <div class="overview-value">${analysis.totalDuration.toFixed(1)}ms</div>
            </div>
            <div class="overview-card">
                <h3>Services</h3>
                <div class="overview-value">${analysis.serviceCoverage.length}</div>
            </div>
            <div class="overview-card">
                <h3>Spans</h3>
                <div class="overview-value">${analysis.spans.length}</div>
            </div>
            <div class="overview-card ${analysis.errorRate > 0 ? 'error' : ''}">
                <h3>Error Rate</h3>
                <div class="overview-value">${analysis.errorRate.toFixed(1)}%</div>
            </div>
        </div>

        <div class="trace-sections">
            <div class="section">
                <h2>Timeline</h2>
                <div class="timeline">
                    ${this.generateTimelineHTML(analysis.spans)}
                </div>
            </div>

            <div class="section">
                <h2>Critical Path</h2>
                <div class="critical-path">
                    ${analysis.criticalPath.map(span => `
                        <div class="path-span">
                            <div class="span-name">${span.operationName}</div>
                            <div class="span-duration">${span.duration?.toFixed(1) || 0}ms</div>
                            <div class="span-service">${span.tags['service.name'] || span.process.serviceName}</div>
                        </div>
                    `).join('')}
                </div>
            </div>

            ${analysis.bottlenecks.length > 0 ? `
                <div class="section">
                    <h2>Bottlenecks</h2>
                    <div class="bottlenecks-list">
                        ${analysis.bottlenecks.map(bottleneck => `
                            <div class="bottleneck-item severity-${bottleneck.severity}">
                                <div class="bottleneck-header">
                                    <span class="bottleneck-operation">${bottleneck.operationName}</span>
                                    <span class="bottleneck-percentage">${bottleneck.percentage.toFixed(1)}%</span>
                                    <span class="bottleneck-duration">${bottleneck.duration.toFixed(1)}ms</span>
                                </div>
                                <div class="bottleneck-suggestions">
                                    ${bottleneck.suggestions.map(s => `<div class="suggestion">💡 ${s}</div>`).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}

            <div class="section">
                <h2>Span Details</h2>
                <div class="spans-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Operation</th>
                                <th>Service</th>
                                <th>Duration</th>
                                <th>Status</th>
                                <th>Tags</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${analysis.spans.map(span => `
                                <tr class="span-row ${span.status === 'error' ? 'error' : ''}">
                                    <td>${span.operationName}</td>
                                    <td>${span.tags['service.name'] || span.process.serviceName}</td>
                                    <td>${span.duration?.toFixed(1) || 0}ms</td>
                                    <td><span class="status-badge ${span.status}">${span.status}</span></td>
                                    <td>
                                        <details>
                                            <summary>View Tags</summary>
                                            <pre>${JSON.stringify(span.tags, null, 2)}</pre>
                                        </details>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <script src="/tracing/script.js"></script>
</body>
</html>`;
  }

  private generateTimelineHTML(spans: any[]): string {
    if (spans.length === 0) return '<div>No spans found</div>';

    const earliestStart = Math.min(...spans.map(s => s.startTime));
    const latestEnd = Math.max(...spans.map(s => s.endTime || s.startTime));
    const totalDuration = latestEnd - earliestStart;

    return spans.map(span => {
      const start = ((span.startTime - earliestStart) / totalDuration) * 100;
      const width = ((span.duration || 0) / totalDuration) * 100;
      
      return `
        <div class="timeline-span ${span.status === 'error' ? 'error' : ''}" 
             style="left: ${start}%; width: ${Math.max(width, 0.5)}%;"
             title="${span.operationName} - ${span.duration?.toFixed(1) || 0}ms">
          <div class="span-label">${span.operationName}</div>
        </div>
      `;
    }).join('');
  }

  private generateServiceMapHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Service Map</title>
    <link rel="stylesheet" href="/tracing/style.css">
</head>
<body>
    <div class="container">
        <header>
            <nav>
                <a href="/tracing/">&larr; Back to Dashboard</a>
            </nav>
            <h1>🗺️ Service Map</h1>
        </header>

        <div class="service-map-container">
            <div id="serviceMap" class="service-map">
                Loading service map...
            </div>
        </div>

        <div class="service-details">
            <h2>Service Health</h2>
            <div id="serviceHealth" class="service-health-list">
                Loading service health...
            </div>
        </div>
    </div>

    <script src="/tracing/script.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            loadServiceMap();
        });
    </script>
</body>
</html>`;
  }

  private generateInsightsHTML(): string {
    const insights = this.analyzer.getInsights();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Performance Insights</title>
    <link rel="stylesheet" href="/tracing/style.css">
</head>
<body>
    <div class="container">
        <header>
            <nav>
                <a href="/tracing/">&larr; Back to Dashboard</a>
            </nav>
            <h1>💡 Performance Insights</h1>
            <div class="insights-summary">
                <span>Total: ${insights.length}</span>
                <span class="critical">Critical: ${insights.filter(i => i.severity === 'critical').length}</span>
                <span class="high">High: ${insights.filter(i => i.severity === 'high').length}</span>
                <span class="medium">Medium: ${insights.filter(i => i.severity === 'medium').length}</span>
            </div>
        </header>

        <div class="insights-filters">
            <select id="severityFilter" onchange="filterInsights()">
                <option value="">All Severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
            </select>
            <select id="typeFilter" onchange="filterInsights()">
                <option value="">All Types</option>
                <option value="latency_spike">Latency Spike</option>
                <option value="error_burst">Error Burst</option>
                <option value="throughput_drop">Throughput Drop</option>
                <option value="dependency_issue">Dependency Issue</option>
            </select>
        </div>

        <div class="insights-container">
            ${insights.map(insight => `
                <div class="insight-card severity-${insight.severity}" data-severity="${insight.severity}" data-type="${insight.type}">
                    <div class="insight-header">
                        <span class="insight-type">${insight.type.replace(/_/g, ' ')}</span>
                        <span class="insight-severity severity-${insight.severity}">${insight.severity}</span>
                        <span class="insight-time">${new Date(insight.timeRange.start).toLocaleString()}</span>
                    </div>
                    
                    <h3 class="insight-title">${insight.title}</h3>
                    <p class="insight-description">${insight.description}</p>
                    
                    ${insight.affectedServices.length > 0 ? `
                        <div class="affected-services">
                            <strong>Affected Services:</strong>
                            ${insight.affectedServices.map(service => `<span class="service-tag">${service}</span>`).join('')}
                        </div>
                    ` : ''}
                    
                    <div class="insight-metrics">
                        <strong>Metrics:</strong>
                        ${Object.entries(insight.metrics).map(([key, value]) => 
                            `<span class="metric">${key}: ${typeof value === 'number' ? value.toFixed(1) : value}</span>`
                        ).join('')}
                    </div>
                    
                    <div class="recommendations">
                        <strong>Recommendations:</strong>
                        <ul>
                            ${insight.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                        </ul>
                    </div>
                </div>
            `).join('')}
        </div>
    </div>

    <script src="/tracing/script.js"></script>
    <script>
        function filterInsights() {
            const severityFilter = document.getElementById('severityFilter').value;
            const typeFilter = document.getElementById('typeFilter').value;
            const cards = document.querySelectorAll('.insight-card');
            
            cards.forEach(card => {
                const severity = card.dataset.severity;
                const type = card.dataset.type;
                
                const severityMatch = !severityFilter || severity === severityFilter;
                const typeMatch = !typeFilter || type === typeFilter;
                
                if (severityMatch && typeMatch) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        }
    </script>
</body>
</html>`;
  }

  private getCSS(): string {
    return `
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background-color: #f5f7fa;
    color: #333;
    line-height: 1.6;
}

.container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
}

header {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin-bottom: 30px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

header h1 {
    color: #2c3e50;
    font-size: 1.8rem;
}

nav {
    display: flex;
    gap: 20px;
}

nav a {
    color: #3498db;
    text-decoration: none;
    font-weight: 500;
    padding: 8px 16px;
    border-radius: 4px;
    transition: background-color 0.2s;
}

nav a:hover {
    background-color: #ecf0f1;
}

.trace-id {
    font-family: monospace;
    background: #ecf0f1;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.9rem;
}

.metrics-overview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.metric-card {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    text-align: center;
}

.metric-card.alert {
    border-left: 4px solid #e74c3c;
}

.metric-card h3 {
    color: #7f8c8d;
    font-size: 0.9rem;
    margin-bottom: 10px;
    text-transform: uppercase;
}

.metric-value {
    font-size: 2rem;
    font-weight: bold;
    color: #2c3e50;
}

.metric-value.error {
    color: #e74c3c;
}

.dashboard-sections {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 30px;
}

.section {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.section h2 {
    color: #2c3e50;
    margin-bottom: 20px;
    font-size: 1.3rem;
}

.trace-search {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
}

.trace-search input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
}

.trace-search button {
    padding: 8px 16px;
    background: #3498db;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
}

.trace-search button:hover {
    background: #2980b9;
}

.traces-list, .operations-list, .insights-list {
    max-height: 400px;
    overflow-y: auto;
}

.trace-item {
    padding: 15px;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    margin-bottom: 10px;
    cursor: pointer;
    transition: background-color 0.2s;
}

.trace-item:hover {
    background-color: #f8f9fa;
}

.trace-item.error {
    border-left: 4px solid #e74c3c;
}

.trace-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}

.trace-id-short {
    font-family: monospace;
    color: #7f8c8d;
    font-size: 0.9rem;
}

.trace-duration {
    font-weight: bold;
    color: #2c3e50;
}

.trace-services {
    font-size: 0.9rem;
    color: #7f8c8d;
}

.operation-item {
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.operation-name {
    font-weight: 500;
    color: #2c3e50;
}

.operation-stats {
    display: flex;
    gap: 15px;
    font-size: 0.9rem;
    color: #7f8c8d;
}

.insight-item {
    padding: 15px;
    border-radius: 6px;
    margin-bottom: 15px;
    border-left: 4px solid;
}

.insight-item.severity-critical {
    border-left-color: #e74c3c;
    background-color: #fdf2f2;
}

.insight-item.severity-high {
    border-left-color: #f39c12;
    background-color: #fef9e7;
}

.insight-item.severity-medium {
    border-left-color: #f1c40f;
    background-color: #fffbdd;
}

.insight-item.severity-low {
    border-left-color: #95a5a6;
    background-color: #f8f9fa;
}

.insight-header {
    display: flex;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 0.8rem;
}

.insight-type {
    background: #ecf0f1;
    padding: 2px 8px;
    border-radius: 12px;
    color: #2c3e50;
    text-transform: capitalize;
}

.insight-severity {
    padding: 2px 8px;
    border-radius: 12px;
    color: white;
    text-transform: uppercase;
    font-weight: bold;
}

.insight-severity.severity-critical { background: #e74c3c; }
.insight-severity.severity-high { background: #f39c12; }
.insight-severity.severity-medium { background: #f1c40f; color: #333; }
.insight-severity.severity-low { background: #95a5a6; }

.insight-title {
    font-weight: 600;
    color: #2c3e50;
    margin-bottom: 5px;
}

.insight-description {
    color: #7f8c8d;
    font-size: 0.9rem;
}

.view-all-link {
    display: inline-block;
    margin-top: 15px;
    color: #3498db;
    text-decoration: none;
    font-weight: 500;
}

.view-all-link:hover {
    text-decoration: underline;
}

/* Trace detail styles */
.trace-overview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.overview-card {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    text-align: center;
}

.overview-card.error {
    border-left: 4px solid #e74c3c;
}

.overview-card h3 {
    color: #7f8c8d;
    font-size: 0.9rem;
    margin-bottom: 10px;
}

.overview-value {
    font-size: 1.8rem;
    font-weight: bold;
    color: #2c3e50;
}

.trace-sections {
    display: flex;
    flex-direction: column;
    gap: 30px;
}

.timeline {
    position: relative;
    height: 200px;
    background: #f8f9fa;
    border-radius: 6px;
    overflow-x: auto;
    padding: 20px;
}

.timeline-span {
    position: absolute;
    height: 30px;
    background: #3498db;
    border-radius: 4px;
    color: white;
    display: flex;
    align-items: center;
    padding: 0 8px;
    margin-bottom: 5px;
    font-size: 0.8rem;
    cursor: pointer;
}

.timeline-span.error {
    background: #e74c3c;
}

.timeline-span:hover {
    opacity: 0.8;
}

.critical-path {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.path-span {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 15px;
    background: #f8f9fa;
    border-radius: 6px;
    border-left: 4px solid #3498db;
}

.span-name {
    font-weight: 500;
    color: #2c3e50;
}

.span-duration {
    font-weight: bold;
    color: #e67e22;
}

.span-service {
    font-size: 0.9rem;
    color: #7f8c8d;
}

.bottlenecks-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.bottleneck-item {
    padding: 15px;
    border-radius: 6px;
    border-left: 4px solid;
}

.bottleneck-item.severity-critical {
    border-left-color: #e74c3c;
    background: #fdf2f2;
}

.bottleneck-item.severity-high {
    border-left-color: #f39c12;
    background: #fef9e7;
}

.bottleneck-item.severity-medium {
    border-left-color: #f1c40f;
    background: #fffbdd;
}

.bottleneck-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.bottleneck-operation {
    font-weight: 500;
    color: #2c3e50;
}

.bottleneck-percentage {
    font-weight: bold;
    color: #e67e22;
}

.bottleneck-duration {
    color: #7f8c8d;
}

.bottleneck-suggestions {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.suggestion {
    font-size: 0.9rem;
    color: #27ae60;
}

.spans-table {
    overflow-x: auto;
}

.spans-table table {
    width: 100%;
    border-collapse: collapse;
}

.spans-table th,
.spans-table td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid #e0e0e0;
}

.spans-table th {
    background: #f8f9fa;
    font-weight: 600;
    color: #2c3e50;
}

.span-row.error {
    background: #fdf2f2;
}

.status-badge {
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: bold;
    text-transform: uppercase;
}

.status-badge.ok {
    background: #d4edda;
    color: #155724;
}

.status-badge.error {
    background: #f8d7da;
    color: #721c24;
}

.status-badge.timeout {
    background: #fff3cd;
    color: #856404;
}

/* Service map styles */
.service-map-container {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin-bottom: 30px;
}

.service-map {
    min-height: 400px;
    display: flex;
    justify-content: center;
    align-items: center;
    color: #7f8c8d;
}

.service-health-list {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

/* Insights page styles */
.insights-summary {
    display: flex;
    gap: 20px;
    font-size: 0.9rem;
}

.insights-summary .critical { color: #e74c3c; font-weight: bold; }
.insights-summary .high { color: #f39c12; font-weight: bold; }
.insights-summary .medium { color: #f1c40f; font-weight: bold; }

.insights-filters {
    display: flex;
    gap: 15px;
    margin-bottom: 30px;
}

.insights-filters select {
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: white;
}

.insights-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.insight-card {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    border-left: 4px solid;
}

.insight-card.severity-critical {
    border-left-color: #e74c3c;
}

.insight-card.severity-high {
    border-left-color: #f39c12;
}

.insight-card.severity-medium {
    border-left-color: #f1c40f;
}

.insight-card.severity-low {
    border-left-color: #95a5a6;
}

.affected-services {
    margin: 15px 0;
}

.service-tag {
    background: #ecf0f1;
    color: #2c3e50;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.8rem;
    margin-right: 8px;
}

.insight-metrics {
    margin: 15px 0;
}

.metric {
    background: #f8f9fa;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-right: 10px;
    display: inline-block;
    margin-bottom: 5px;
}

.recommendations {
    margin-top: 15px;
}

.recommendations ul {
    margin-left: 20px;
}

.recommendations li {
    margin-bottom: 5px;
    color: #2c3e50;
}

@media (max-width: 768px) {
    .dashboard-sections {
        grid-template-columns: 1fr;
    }
    
    .metrics-overview {
        grid-template-columns: repeat(2, 1fr);
    }
    
    .trace-search {
        flex-direction: column;
    }
    
    .insights-filters {
        flex-direction: column;
    }
}`;
  }

  private getJavaScript(): string {
    return `
async function loadRecentTraces() {
    try {
        const response = await fetch('/tracing/api/traces?limit=20');
        const result = await response.json();
        
        if (result.success) {
            displayTraces(result.data);
        }
    } catch (error) {
        console.error('Failed to load traces:', error);
    }
}

async function searchTraces() {
    const service = document.getElementById('serviceFilter').value;
    const operation = document.getElementById('operationFilter').value;
    
    const params = new URLSearchParams();
    if (service) params.set('service', service);
    if (operation) params.set('operation', operation);
    params.set('limit', '20');
    
    try {
        const response = await fetch(\`/tracing/api/traces?\${params}\`);
        const result = await response.json();
        
        if (result.success) {
            displayTraces(result.data);
        }
    } catch (error) {
        console.error('Failed to search traces:', error);
    }
}

function displayTraces(traces) {
    const container = document.getElementById('tracesList');
    if (!container) return;
    
    if (traces.length === 0) {
        container.innerHTML = '<div>No traces found</div>';
        return;
    }
    
    container.innerHTML = traces.map(trace => \`
        <div class="trace-item \${trace.errorRate > 0 ? 'error' : ''}" onclick="viewTrace('\${trace.traceId}')">
            <div class="trace-header">
                <span class="trace-id-short">\${trace.traceId.substring(0, 16)}...</span>
                <span class="trace-duration">\${trace.totalDuration.toFixed(1)}ms</span>
            </div>
            <div class="trace-services">
                Services: \${trace.serviceCoverage.join(', ')}
                \${trace.errorRate > 0 ? \`<span style="color: #e74c3c;">(\${trace.errorRate.toFixed(1)}% errors)</span>\` : ''}
            </div>
        </div>
    \`).join('');
}

function viewTrace(traceId) {
    window.location.href = \`/tracing/trace/\${traceId}\`;
}

async function updateMetrics() {
    try {
        const response = await fetch('/tracing/api/metrics');
        const result = await response.json();
        
        if (result.success) {
            // Update metric cards if they exist
            const metricCards = document.querySelectorAll('.metric-value');
            // This would update the actual values in a real implementation
        }
    } catch (error) {
        console.error('Failed to update metrics:', error);
    }
}

async function loadServiceMap() {
    try {
        const response = await fetch('/tracing/api/service-map');
        const result = await response.json();
        
        if (result.success) {
            displayServiceMap(result.data);
        }
    } catch (error) {
        console.error('Failed to load service map:', error);
    }
}

function displayServiceMap(data) {
    const container = document.getElementById('serviceMap');
    const healthContainer = document.getElementById('serviceHealth');
    
    if (container) {
        // Simple service map display (would use a graph library in production)
        const services = Object.keys(data.serviceMap);
        container.innerHTML = \`
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px;">
                \${services.map(service => \`
                    <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; text-align: center;">
                        <strong>\${service}</strong>
                        <div style="font-size: 0.8rem; color: #7f8c8d; margin-top: 5px;">
                            Calls: \${data.serviceMap[service] ? Array.from(data.serviceMap[service]).join(', ') : 'None'}
                        </div>
                    </div>
                \`).join('')}
            </div>
        \`;
    }
    
    if (healthContainer) {
        const dependencies = data.dependencies;
        healthContainer.innerHTML = Object.entries(dependencies).map(([service, dep]) => \`
            <div style="padding: 15px; border: 1px solid #e0e0e0; border-radius: 6px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong>\${service}</strong>
                    <span class="status-badge \${dep.health}">\${dep.health}</span>
                </div>
                <div style="margin-top: 10px; font-size: 0.9rem; color: #7f8c8d;">
                    Availability: \${dep.sla.availability.toFixed(1)}% | 
                    Error Rate: \${dep.sla.errorRate.toFixed(1)}% |
                    P95 Latency: \${dep.sla.latencyP95.toFixed(1)}ms
                </div>
            </div>
        \`).join('');
    }
}

// Auto-refresh functions
function startAutoRefresh() {
    setInterval(async () => {
        await loadRecentTraces();
        await updateMetrics();
    }, 30000); // Every 30 seconds
}

// Initialize auto-refresh when page loads
document.addEventListener('DOMContentLoaded', () => {
    startAutoRefresh();
});`;
  }

  public getRouter(): express.Router {
    return this.router;
  }
}
