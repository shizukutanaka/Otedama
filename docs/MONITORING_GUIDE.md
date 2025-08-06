# Monitoring Guide

This guide covers monitoring, metrics collection, and alerting for Otedama deployments.

## Table of Contents

- [Overview](#overview)
- [Metrics](#metrics)
- [Prometheus Setup](#prometheus-setup)
- [Grafana Dashboards](#grafana-dashboards)
- [Alerting](#alerting)
- [Logging](#logging)
- [Health Checks](#health-checks)
- [Performance Tuning](#performance-tuning)

## Overview

Otedama provides comprehensive monitoring capabilities:

- **Metrics**: Prometheus-compatible metrics endpoint
- **Logging**: Structured JSON logging with multiple outputs
- **Tracing**: OpenTelemetry support for distributed tracing
- **Health Checks**: Liveness and readiness probes
- **Dashboards**: Pre-built Grafana dashboards

## Metrics

### Available Metrics

Otedama exposes metrics at `/metrics` endpoint:

#### Pool Metrics
```
# Hashrate
otedama_pool_hashrate_total{algorithm="sha256"} 1.5e12
otedama_pool_hashrate_effective{algorithm="sha256"} 1.4e12

# Workers
otedama_pool_workers_active 1523
otedama_pool_workers_total 2156
otedama_pool_workers_idle 633

# Shares
otedama_pool_shares_valid_total{algorithm="sha256"} 9876543
otedama_pool_shares_invalid_total{algorithm="sha256"} 12345
otedama_pool_shares_stale_total{algorithm="sha256"} 5432

# Blocks
otedama_pool_blocks_found_total 156
otedama_pool_blocks_orphaned_total 3
otedama_pool_blocks_pending 2

# Payouts
otedama_pool_payouts_total 45678
otedama_pool_payouts_pending 234
otedama_pool_balance_total 156.789
```

#### System Metrics
```
# Performance
otedama_system_cpu_usage_percent 45.6
otedama_system_memory_usage_bytes 3456789012
otedama_system_goroutines 1234

# Network
otedama_network_connections_active 523
otedama_network_bandwidth_bytes_total{direction="rx"} 123456789
otedama_network_bandwidth_bytes_total{direction="tx"} 987654321

# Database
otedama_database_connections_active 45
otedama_database_queries_total{query="get_shares"} 98765
otedama_database_query_duration_seconds{query="get_shares",quantile="0.99"} 0.05
```

### Custom Metrics

Add custom metrics in your code:

```go
import (
    "github.com/prometheus/client_golang/prometheus"
)

var (
    customMetric = prometheus.NewCounter(
        prometheus.CounterOpts{
            Name: "otedama_custom_events_total",
            Help: "Total number of custom events",
        },
    )
)

func init() {
    prometheus.MustRegister(customMetric)
}
```

## Prometheus Setup

### 1. Install Prometheus

```bash
# Docker
docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v $(pwd)/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus

# Binary
wget https://github.com/prometheus/prometheus/releases/download/v2.45.0/prometheus-2.45.0.linux-amd64.tar.gz
tar xvf prometheus-*.tar.gz
cd prometheus-*
```

### 2. Configure Prometheus

Create `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

rule_files:
  - "alerts/*.yml"

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
    metrics_path: '/metrics'
    scrape_interval: 10s

  - job_name: 'otedama-nodes'
    consul_sd_configs:
      - server: 'consul:8500'
        services: ['otedama']
    relabel_configs:
      - source_labels: [__meta_consul_service]
        target_label: job
      - source_labels: [__meta_consul_node]
        target_label: instance
      - source_labels: [__meta_consul_tags]
        regex: '.*,prod,.*'
        action: keep
```

### 3. Recording Rules

Create `rules/recording.yml`:

```yaml
groups:
  - name: otedama_recording
    interval: 30s
    rules:
      # Hashrate efficiency
      - record: otedama:pool:efficiency
        expr: |
          otedama_pool_hashrate_effective / otedama_pool_hashrate_total

      # Share acceptance rate
      - record: otedama:shares:acceptance_rate
        expr: |
          rate(otedama_pool_shares_valid_total[5m]) /
          (rate(otedama_pool_shares_valid_total[5m]) + 
           rate(otedama_pool_shares_invalid_total[5m]) + 
           rate(otedama_pool_shares_stale_total[5m]))

      # Worker efficiency
      - record: otedama:workers:efficiency
        expr: |
          otedama_pool_workers_active / otedama_pool_workers_total
```

## Grafana Dashboards

### 1. Install Grafana

```bash
# Docker
docker run -d \
  --name grafana \
  -p 3000:3000 \
  grafana/grafana

# Add Prometheus data source
curl -X POST http://admin:admin@localhost:3000/api/datasources \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prometheus",
    "type": "prometheus",
    "url": "http://prometheus:9090",
    "access": "proxy"
  }'
```

### 2. Import Dashboards

Otedama provides pre-built dashboards:

```bash
# Download dashboards
curl -O https://raw.githubusercontent.com/otedama/otedama/master/dashboards/pool-overview.json
curl -O https://raw.githubusercontent.com/otedama/otedama/master/dashboards/worker-details.json
curl -O https://raw.githubusercontent.com/otedama/otedama/master/dashboards/system-metrics.json

# Import via API
curl -X POST http://admin:admin@localhost:3000/api/dashboards/import \
  -H "Content-Type: application/json" \
  -d @pool-overview.json
```

### 3. Custom Dashboard Example

```json
{
  "dashboard": {
    "title": "Otedama Mining Pool",
    "panels": [
      {
        "title": "Total Hashrate",
        "targets": [
          {
            "expr": "sum(otedama_pool_hashrate_total)",
            "legendFormat": "Total"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Active Workers",
        "targets": [
          {
            "expr": "otedama_pool_workers_active"
          }
        ],
        "type": "stat"
      }
    ]
  }
}
```

## Alerting

### 1. Alert Rules

Create `alerts/otedama.yml`:

```yaml
groups:
  - name: otedama_alerts
    rules:
      # High invalid share rate
      - alert: HighInvalidShareRate
        expr: |
          rate(otedama_pool_shares_invalid_total[5m]) / 
          rate(otedama_pool_shares_valid_total[5m]) > 0.05
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High invalid share rate: {{ $value | humanizePercentage }}"
          description: "Invalid share rate is above 5% for 10 minutes"

      # Low hashrate
      - alert: LowPoolHashrate
        expr: otedama_pool_hashrate_total < 1e9
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Pool hashrate critically low: {{ $value | humanize }}"
          description: "Pool hashrate has been below 1 GH/s for 15 minutes"

      # Database connection issues
      - alert: DatabaseConnectionHigh
        expr: otedama_database_connections_active > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High database connections: {{ $value }}"

      # Worker disconnections
      - alert: MassWorkerDisconnection
        expr: |
          (otedama_pool_workers_active - otedama_pool_workers_active offset 5m) 
          / otedama_pool_workers_active offset 5m < -0.2
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Mass worker disconnection detected"
          description: "More than 20% of workers disconnected in 5 minutes"
```

### 2. Alertmanager Configuration

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  receiver: 'default'
  routes:
    - match:
        severity: critical
      receiver: pagerduty
    - match:
        severity: warning
      receiver: slack

receivers:
  - name: 'default'
    webhook_configs:
      - url: 'http://localhost:5001/webhook'

  - name: 'slack'
    slack_configs:
      - api_url: 'YOUR_SLACK_WEBHOOK_URL'
        channel: '#otedama-alerts'
        title: 'Otedama Alert'
        text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}'

  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_KEY'
```

## Logging

### 1. Log Configuration

Configure logging in `config.yaml`:

```yaml
logging:
  level: info  # debug, info, warn, error
  format: json  # json, text
  outputs:
    - type: stdout
      format: json
    - type: file
      path: /var/log/otedama/otedama.log
      maxSize: 100  # MB
      maxBackups: 10
      maxAge: 30  # days
    - type: syslog
      network: udp
      address: localhost:514
      tag: otedama
```

### 2. Structured Logging

Example log entries:

```json
{
  "level": "info",
  "timestamp": "2025-01-15T10:30:45Z",
  "logger": "stratum",
  "msg": "New worker connected",
  "worker_id": "worker123",
  "ip": "192.168.1.100",
  "user_agent": "cgminer/4.11.1"
}

{
  "level": "error",
  "timestamp": "2025-01-15T10:31:02Z",
  "logger": "database",
  "msg": "Query failed",
  "query": "INSERT INTO shares",
  "error": "connection timeout",
  "duration_ms": 5003
}
```

### 3. Log Aggregation

Using Fluentd:

```yaml
# fluent.conf
<source>
  @type tail
  path /var/log/otedama/*.log
  pos_file /var/log/td-agent/otedama.pos
  tag otedama.*
  <parse>
    @type json
  </parse>
</source>

<match otedama.**>
  @type elasticsearch
  host elasticsearch
  port 9200
  index_name otedama
  type_name logs
  logstash_format true
  logstash_prefix otedama
</match>
```

## Health Checks

### 1. Endpoints

#### Liveness Probe
```bash
curl http://localhost:8080/health/live
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T10:30:45Z"
}
```

#### Readiness Probe
```bash
curl http://localhost:8080/health/ready
```

Response:
```json
{
  "status": "ok",
  "checks": {
    "database": "ok",
    "redis": "ok",
    "stratum": "ok"
  }
}
```

### 2. Kubernetes Configuration

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
```

## Performance Tuning

### 1. Metrics-Based Tuning

Monitor and adjust based on metrics:

```yaml
# High CPU usage
if otedama_system_cpu_usage_percent > 80:
  - Increase worker pool size
  - Enable CPU profiling
  - Check for inefficient algorithms

# High memory usage
if otedama_system_memory_usage_bytes > 80%:
  - Reduce cache sizes
  - Enable memory profiling
  - Check for memory leaks

# Database bottlenecks
if otedama_database_query_duration_seconds > 0.1:
  - Add database indexes
  - Optimize queries
  - Scale database horizontally
```

### 2. Profiling

Enable profiling endpoints:

```yaml
debug:
  enabled: true
  pprof: true
  port: 6060
```

Use profiling tools:

```bash
# CPU profile
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Memory profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

### 3. Optimization Checklist

- [ ] Enable connection pooling
- [ ] Configure appropriate cache sizes
- [ ] Use read replicas for queries
- [ ] Enable query result caching
- [ ] Optimize database indexes
- [ ] Configure appropriate worker limits
- [ ] Enable compression where applicable
- [ ] Use CDN for static assets
- [ ] Configure appropriate timeouts
- [ ] Enable HTTP/2 and keep-alive

## Best Practices

1. **Set up monitoring early** - Don't wait for production
2. **Use dashboards** - Visualize trends, not just current values
3. **Alert on symptoms** - Not just causes
4. **Keep metrics cardinality low** - Avoid label explosion
5. **Use recording rules** - For complex queries
6. **Regular review** - Update alerts based on incidents
7. **Automate responses** - Where possible
8. **Document runbooks** - For each alert
9. **Test monitoring** - Regularly verify it works
10. **Monitor the monitors** - Ensure monitoring is reliable