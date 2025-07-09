// Metrics and monitoring for P2Pool
// 
// Simple, efficient metrics collection and export

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use chrono::{DateTime, Utc};

/// Metric types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MetricValue {
    Counter(u64),
    Gauge(f64),
    Histogram(Vec<f64>),
    Timer(Duration),
}

/// Individual metric
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metric {
    pub name: String,
    pub value: MetricValue,
    pub labels: HashMap<String, String>,
    pub timestamp: DateTime<Utc>,
    pub help: String,
}

impl Metric {
    /// Create new counter metric
    pub fn counter(name: &str, value: u64, help: &str) -> Self {
        Self {
            name: name.to_string(),
            value: MetricValue::Counter(value),
            labels: HashMap::new(),
            timestamp: Utc::now(),
            help: help.to_string(),
        }
    }
    
    /// Create new gauge metric
    pub fn gauge(name: &str, value: f64, help: &str) -> Self {
        Self {
            name: name.to_string(),
            value: MetricValue::Gauge(value),
            labels: HashMap::new(),
            timestamp: Utc::now(),
            help: help.to_string(),
        }
    }
    
    /// Add label to metric
    pub fn with_label(mut self, key: &str, value: &str) -> Self {
        self.labels.insert(key.to_string(), value.to_string());
        self
    }
}

/// Metrics collector
#[derive(Debug, Clone)]
pub struct MetricsCollector {
    metrics: Arc<Mutex<HashMap<String, Metric>>>,
}

impl MetricsCollector {
    /// Create new metrics collector
    pub fn new() -> Self {
        Self {
            metrics: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    /// Record counter metric
    pub fn counter(&self, name: &str, value: u64, help: &str) {
        let metric = Metric::counter(name, value, help);
        let mut metrics = self.metrics.lock().unwrap();
        metrics.insert(name.to_string(), metric);
    }
    
    /// Increment counter metric
    pub fn increment_counter(&self, name: &str, help: &str) {
        let mut metrics = self.metrics.lock().unwrap();
        
        match metrics.get(name) {
            Some(existing) => {
                if let MetricValue::Counter(current) = existing.value {
                    let updated = Metric::counter(name, current + 1, help);
                    metrics.insert(name.to_string(), updated);
                }
            }
            None => {
                let metric = Metric::counter(name, 1, help);
                metrics.insert(name.to_string(), metric);
            }
        }
    }
    
    /// Record gauge metric
    pub fn gauge(&self, name: &str, value: f64, help: &str) {
        let metric = Metric::gauge(name, value, help);
        let mut metrics = self.metrics.lock().unwrap();
        metrics.insert(name.to_string(), metric);
    }
    
    /// Record timer metric
    pub fn timer(&self, name: &str, duration: Duration, help: &str) {
        let metric = Metric {
            name: name.to_string(),
            value: MetricValue::Timer(duration),
            labels: HashMap::new(),
            timestamp: Utc::now(),
            help: help.to_string(),
        };
        
        let mut metrics = self.metrics.lock().unwrap();
        metrics.insert(name.to_string(), metric);
    }
    
    /// Get all metrics
    pub fn get_all_metrics(&self) -> Vec<Metric> {
        let metrics = self.metrics.lock().unwrap();
        metrics.values().cloned().collect()
    }
    
    /// Get metric by name
    pub fn get_metric(&self, name: &str) -> Option<Metric> {
        let metrics = self.metrics.lock().unwrap();
        metrics.get(name).cloned()
    }
    
    /// Clear all metrics
    pub fn clear(&self) {
        let mut metrics = self.metrics.lock().unwrap();
        metrics.clear();
    }
    
    /// Export metrics in Prometheus format
    pub fn export_prometheus(&self) -> String {
        let metrics = self.metrics.lock().unwrap();
        let mut output = String::new();
        
        for metric in metrics.values() {
            // Add help text
            output.push_str(&format!("# HELP {} {}\n", metric.name, metric.help));
            
            // Add type
            let metric_type = match metric.value {
                MetricValue::Counter(_) => "counter",
                MetricValue::Gauge(_) => "gauge",
                MetricValue::Histogram(_) => "histogram",
                MetricValue::Timer(_) => "histogram",
            };
            output.push_str(&format!("# TYPE {} {}\n", metric.name, metric_type));
            
            // Add value
            let value_str = match &metric.value {
                MetricValue::Counter(v) => v.to_string(),
                MetricValue::Gauge(v) => v.to_string(),
                MetricValue::Histogram(values) => {
                    // For now, just return the average
                    let avg = values.iter().sum::<f64>() / values.len() as f64;
                    avg.to_string()
                }
                MetricValue::Timer(duration) => duration.as_millis().to_string(),
            };
            
            // Format labels
            let labels_str = if metric.labels.is_empty() {
                String::new()
            } else {
                let labels: Vec<String> = metric.labels.iter()
                    .map(|(k, v)| format!("{}=\"{}\"", k, v))
                    .collect();
                format!("{{{}}}", labels.join(","))
            };
            
            output.push_str(&format!("{}{} {}\n", metric.name, labels_str, value_str));
        }
        
        output
    }
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Timer helper for measuring execution time
pub struct Timer {
    start: Instant,
    name: String,
    collector: MetricsCollector,
}

impl Timer {
    /// Start new timer
    pub fn start(name: &str, collector: MetricsCollector) -> Self {
        Self {
            start: Instant::now(),
            name: name.to_string(),
            collector,
        }
    }
    
    /// Stop timer and record metric
    pub fn stop(self, help: &str) {
        let duration = self.start.elapsed();
        self.collector.timer(&self.name, duration, help);
    }
}

/// P2Pool specific metrics
pub struct P2PoolMetrics {
    collector: MetricsCollector,
}

impl P2PoolMetrics {
    /// Create new P2Pool metrics
    pub fn new() -> Self {
        Self {
            collector: MetricsCollector::new(),
        }
    }
    
    /// Record share received
    pub fn share_received(&self, miner_address: &str, difficulty: f64) {
        self.collector.increment_counter("p2pool_shares_total", "Total shares received");
        self.collector.gauge("p2pool_last_share_difficulty", difficulty, "Last share difficulty");
        
        // Per-miner metrics
        let metric_name = format!("p2pool_shares_miner_{}", miner_address);
        self.collector.increment_counter(&metric_name, "Shares per miner");
    }
    
    /// Record block found
    pub fn block_found(&self, height: u64, reward: u64) {
        self.collector.increment_counter("p2pool_blocks_total", "Total blocks found");
        self.collector.gauge("p2pool_last_block_height", height as f64, "Last block height");
        self.collector.gauge("p2pool_last_block_reward", reward as f64, "Last block reward");
    }
    
    /// Record peer connection
    pub fn peer_connected(&self, peer_count: usize) {
        self.collector.gauge("p2pool_peers_connected", peer_count as f64, "Connected peers");
        self.collector.increment_counter("p2pool_peer_connections_total", "Total peer connections");
    }
    
    /// Record peer disconnection
    pub fn peer_disconnected(&self, peer_count: usize) {
        self.collector.gauge("p2pool_peers_connected", peer_count as f64, "Connected peers");
        self.collector.increment_counter("p2pool_peer_disconnections_total", "Total peer disconnections");
    }
    
    /// Record hash rate
    pub fn hash_rate(&self, hash_rate: u64) {
        self.collector.gauge("p2pool_hash_rate", hash_rate as f64, "Current hash rate");
    }
    
    /// Record difficulty adjustment
    pub fn difficulty_adjustment(&self, old_difficulty: f64, new_difficulty: f64) {
        self.collector.gauge("p2pool_difficulty", new_difficulty, "Current mining difficulty");
        
        let adjustment_factor = new_difficulty / old_difficulty;
        self.collector.gauge("p2pool_difficulty_adjustment_factor", adjustment_factor, "Difficulty adjustment factor");
    }
    
    /// Record payout
    pub fn payout(&self, address: &str, amount: u64) {
        self.collector.increment_counter("p2pool_payouts_total", "Total payouts");
        self.collector.gauge("p2pool_last_payout_amount", amount as f64, "Last payout amount");
        
        // Per-address payout tracking
        let metric_name = format!("p2pool_payout_amount_{}", address);
        self.collector.gauge(&metric_name, amount as f64, "Payout amount per address");
    }
    
    /// Record storage operation
    pub fn storage_operation(&self, operation: &str, duration: Duration) {
        let metric_name = format!("p2pool_storage_{}_duration", operation);
        self.collector.timer(&metric_name, duration, &format!("Storage {} operation duration", operation));
        
        let counter_name = format!("p2pool_storage_{}_total", operation);
        self.collector.increment_counter(&counter_name, &format!("Total storage {} operations", operation));
    }
    
    /// Record network message
    pub fn network_message(&self, message_type: &str, direction: &str) {
        let metric_name = format!("p2pool_network_messages_{}_{}_total", direction, message_type);
        self.collector.increment_counter(&metric_name, &format!("Network messages {} {}", direction, message_type));
    }
    
    /// Get collector for custom metrics
    pub fn collector(&self) -> &MetricsCollector {
        &self.collector
    }
    
    /// Export all metrics in Prometheus format
    pub fn export_prometheus(&self) -> String {
        self.collector.export_prometheus()
    }
}

impl Default for P2PoolMetrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Metrics server for HTTP exposure
pub struct MetricsServer {
    metrics: P2PoolMetrics,
    bind_address: String,
    port: u16,
}

impl MetricsServer {
    /// Create new metrics server
    pub fn new(metrics: P2PoolMetrics, bind_address: String, port: u16) -> Self {
        Self {
            metrics,
            bind_address,
            port,
        }
    }
    
    /// Start metrics server (simplified implementation)
    pub async fn start(&self) -> Result<()> {
        // In a real implementation, this would start an HTTP server
        // For now, just log the metrics
        tracing::info!("Metrics server starting on {}:{}", self.bind_address, self.port);
        
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            
            let prometheus_output = self.metrics.export_prometheus();
            tracing::debug!("Current metrics:\n{}", prometheus_output);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_metrics_collector() {
        let collector = MetricsCollector::new();
        
        collector.counter("test_counter", 5, "Test counter");
        collector.gauge("test_gauge", 3.14, "Test gauge");
        
        let metrics = collector.get_all_metrics();
        assert_eq!(metrics.len(), 2);
        
        let counter_metric = collector.get_metric("test_counter").unwrap();
        match counter_metric.value {
            MetricValue::Counter(value) => assert_eq!(value, 5),
            _ => panic!("Expected counter value"),
        }
    }
    
    #[test]
    fn test_counter_increment() {
        let collector = MetricsCollector::new();
        
        collector.increment_counter("test", "Test counter");
        collector.increment_counter("test", "Test counter");
        collector.increment_counter("test", "Test counter");
        
        let metric = collector.get_metric("test").unwrap();
        match metric.value {
            MetricValue::Counter(value) => assert_eq!(value, 3),
            _ => panic!("Expected counter value"),
        }
    }
    
    #[test]
    fn test_prometheus_export() {
        let collector = MetricsCollector::new();
        
        collector.counter("test_counter", 42, "A test counter");
        collector.gauge("test_gauge", 3.14, "A test gauge");
        
        let output = collector.export_prometheus();
        assert!(output.contains("test_counter"));
        assert!(output.contains("test_gauge"));
        assert!(output.contains("42"));
        assert!(output.contains("3.14"));
    }
    
    #[test]
    fn test_timer() {
        let collector = MetricsCollector::new();
        let timer = Timer::start("test_timer", collector.clone());
        
        std::thread::sleep(Duration::from_millis(10));
        timer.stop("Test timer");
        
        let metric = collector.get_metric("test_timer").unwrap();
        match metric.value {
            MetricValue::Timer(duration) => assert!(duration.as_millis() >= 10),
            _ => panic!("Expected timer value"),
        }
    }
    
    #[test]
    fn test_p2pool_metrics() {
        let metrics = P2PoolMetrics::new();
        
        metrics.share_received("miner1", 1000.0);
        metrics.block_found(100, 5000000000);
        metrics.peer_connected(5);
        
        let output = metrics.export_prometheus();
        assert!(output.contains("p2pool_shares_total"));
        assert!(output.contains("p2pool_blocks_total"));
        assert!(output.contains("p2pool_peers_connected"));
    }
}
