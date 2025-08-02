package network

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// DDoSProtection provides DDoS protection for the network layer
type DDoSProtection struct {
	logger *zap.Logger
	config DDoSConfig
	
	// Connection tracking
	connections  map[string]*ConnectionInfo
	connMu       sync.RWMutex
	
	// Rate limiting
	rateLimiters map[string]*rate.Limiter
	limiterMu    sync.RWMutex
	
	// Ban list
	banList      map[string]time.Time
	banMu        sync.RWMutex
	
	// Metrics
	blockedCount atomic.Uint64
	allowedCount atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// DDoSConfig configures DDoS protection
type DDoSConfig struct {
	Enabled              bool          `yaml:"enabled"`
	MaxConnectionsPerIP  int           `yaml:"max_connections_per_ip"`
	RateLimitPerMinute   int           `yaml:"rate_limit_per_minute"`
	BanDuration          time.Duration `yaml:"ban_duration"`
	
	// Advanced settings
	SynFloodProtection   bool          `yaml:"syn_flood_protection"`
	SlowlorisProtection  bool          `yaml:"slowloris_protection"`
	AmplificationProtection bool       `yaml:"amplification_protection"`
	
	// Thresholds
	PacketSizeLimit      int           `yaml:"packet_size_limit"`
	ConnectionTimeout    time.Duration `yaml:"connection_timeout"`
	RequestTimeout       time.Duration `yaml:"request_timeout"`
	
	// Whitelist
	WhitelistedIPs       []string      `yaml:"whitelisted_ips"`
	
	// Pattern detection
	EnablePatternDetection bool        `yaml:"enable_pattern_detection"`
	PatternThreshold     int           `yaml:"pattern_threshold"`
}

// ConnectionInfo tracks information about a connection
type ConnectionInfo struct {
	IP              string
	FirstSeen       time.Time
	LastSeen        time.Time
	ConnectionCount int
	RequestCount    uint64
	BytesReceived   uint64
	BytesSent       uint64
	Flags           ConnectionFlags
}

// ConnectionFlags tracks connection behavior
type ConnectionFlags struct {
	SuspiciousActivity bool
	RateLimited        bool
	PatternDetected    bool
}

// NewDDoSProtection creates a new DDoS protection system
func NewDDoSProtection(logger *zap.Logger, config DDoSConfig) *DDoSProtection {
	ctx, cancel := context.WithCancel(context.Background())
	
	ddos := &DDoSProtection{
		logger:       logger,
		config:       config,
		connections:  make(map[string]*ConnectionInfo),
		rateLimiters: make(map[string]*rate.Limiter),
		banList:      make(map[string]time.Time),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	return ddos
}

// Start begins DDoS protection
func (d *DDoSProtection) Start() {
	if !d.config.Enabled {
		d.logger.Info("DDoS protection disabled")
		return
	}
	
	d.logger.Info("Starting DDoS protection",
		zap.Int("max_connections_per_ip", d.config.MaxConnectionsPerIP),
		zap.Int("rate_limit_per_minute", d.config.RateLimitPerMinute),
		zap.Duration("ban_duration", d.config.BanDuration),
	)
	
	// Start cleanup routine
	d.wg.Add(1)
	go d.cleanupLoop()
	
	// Start pattern detection if enabled
	if d.config.EnablePatternDetection {
		d.wg.Add(1)
		go d.patternDetectionLoop()
	}
}

// Stop stops DDoS protection
func (d *DDoSProtection) Stop() {
	d.logger.Info("Stopping DDoS protection")
	d.cancel()
	d.wg.Wait()
}

// CheckConnection checks if a connection should be allowed
func (d *DDoSProtection) CheckConnection(ip string) (bool, string) {
	if !d.config.Enabled {
		return true, ""
	}
	
	// Check whitelist
	if d.isWhitelisted(ip) {
		d.allowedCount.Add(1)
		return true, ""
	}
	
	// Check ban list
	if d.isBanned(ip) {
		d.blockedCount.Add(1)
		return false, "IP banned"
	}
	
	// Check connection limit
	if !d.checkConnectionLimit(ip) {
		d.ban(ip, "Connection limit exceeded")
		d.blockedCount.Add(1)
		return false, "Connection limit exceeded"
	}
	
	// Check rate limit
	if !d.checkRateLimit(ip) {
		d.blockedCount.Add(1)
		return false, "Rate limit exceeded"
	}
	
	// Update connection info
	d.updateConnectionInfo(ip)
	
	d.allowedCount.Add(1)
	return true, ""
}

// CheckPacket checks if a packet should be allowed
func (d *DDoSProtection) CheckPacket(ip string, size int) bool {
	if !d.config.Enabled {
		return true
	}
	
	// Check packet size limit
	if d.config.PacketSizeLimit > 0 && size > d.config.PacketSizeLimit {
		d.logger.Warn("Oversized packet blocked",
			zap.String("ip", ip),
			zap.Int("size", size),
			zap.Int("limit", d.config.PacketSizeLimit),
		)
		d.recordSuspiciousActivity(ip)
		return false
	}
	
	// Update bytes received
	d.connMu.RLock()
	if conn, exists := d.connections[ip]; exists {
		atomic.AddUint64(&conn.BytesReceived, uint64(size))
	}
	d.connMu.RUnlock()
	
	return true
}

// RecordRequest records a request from an IP
func (d *DDoSProtection) RecordRequest(ip string) {
	d.connMu.RLock()
	if conn, exists := d.connections[ip]; exists {
		atomic.AddUint64(&conn.RequestCount, 1)
	}
	d.connMu.RUnlock()
}

// GetMetrics returns DDoS protection metrics
func (d *DDoSProtection) GetMetrics() map[string]interface{} {
	d.connMu.RLock()
	activeConnections := len(d.connections)
	d.connMu.RUnlock()
	
	d.banMu.RLock()
	bannedIPs := len(d.banList)
	d.banMu.RUnlock()
	
	return map[string]interface{}{
		"blocked_count":      d.blockedCount.Load(),
		"allowed_count":      d.allowedCount.Load(),
		"active_connections": activeConnections,
		"banned_ips":         bannedIPs,
		"protection_enabled": d.config.Enabled,
	}
}

// isWhitelisted checks if an IP is whitelisted
func (d *DDoSProtection) isWhitelisted(ip string) bool {
	for _, whitelisted := range d.config.WhitelistedIPs {
		if ip == whitelisted {
			return true
		}
		
		// Check CIDR ranges
		if _, ipNet, err := net.ParseCIDR(whitelisted); err == nil {
			if ipNet.Contains(net.ParseIP(ip)) {
				return true
			}
		}
	}
	return false
}

// isBanned checks if an IP is banned
func (d *DDoSProtection) isBanned(ip string) bool {
	d.banMu.RLock()
	banTime, exists := d.banList[ip]
	d.banMu.RUnlock()
	
	if !exists {
		return false
	}
	
	// Check if ban has expired
	if time.Since(banTime) > d.config.BanDuration {
		d.banMu.Lock()
		delete(d.banList, ip)
		d.banMu.Unlock()
		return false
	}
	
	return true
}

// ban adds an IP to the ban list
func (d *DDoSProtection) ban(ip string, reason string) {
	d.banMu.Lock()
	d.banList[ip] = time.Now()
	d.banMu.Unlock()
	
	d.logger.Warn("IP banned",
		zap.String("ip", ip),
		zap.String("reason", reason),
		zap.Duration("duration", d.config.BanDuration),
	)
}

// checkConnectionLimit checks if connection limit is exceeded
func (d *DDoSProtection) checkConnectionLimit(ip string) bool {
	d.connMu.RLock()
	conn, exists := d.connections[ip]
	d.connMu.RUnlock()
	
	if !exists {
		return true
	}
	
	return conn.ConnectionCount < d.config.MaxConnectionsPerIP
}

// checkRateLimit checks if rate limit is exceeded
func (d *DDoSProtection) checkRateLimit(ip string) bool {
	d.limiterMu.Lock()
	limiter, exists := d.rateLimiters[ip]
	if !exists {
		// Create new rate limiter
		limiter = rate.NewLimiter(
			rate.Limit(float64(d.config.RateLimitPerMinute)/60),
			d.config.RateLimitPerMinute,
		)
		d.rateLimiters[ip] = limiter
	}
	d.limiterMu.Unlock()
	
	return limiter.Allow()
}

// updateConnectionInfo updates connection information
func (d *DDoSProtection) updateConnectionInfo(ip string) {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	
	conn, exists := d.connections[ip]
	if !exists {
		conn = &ConnectionInfo{
			IP:        ip,
			FirstSeen: time.Now(),
		}
		d.connections[ip] = conn
	}
	
	conn.LastSeen = time.Now()
	conn.ConnectionCount++
}

// recordSuspiciousActivity records suspicious activity
func (d *DDoSProtection) recordSuspiciousActivity(ip string) {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	
	if conn, exists := d.connections[ip]; exists {
		conn.Flags.SuspiciousActivity = true
		
		// Check if should ban
		if d.config.EnablePatternDetection {
			// Implement pattern-based banning logic
		}
	}
}

// cleanupLoop periodically cleans up old data
func (d *DDoSProtection) cleanupLoop() {
	defer d.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-ticker.C:
			d.cleanup()
		}
	}
}

// cleanup removes old connection data and expired bans
func (d *DDoSProtection) cleanup() {
	now := time.Now()
	
	// Clean up old connections
	d.connMu.Lock()
	for ip, conn := range d.connections {
		if now.Sub(conn.LastSeen) > 30*time.Minute {
			delete(d.connections, ip)
		}
	}
	d.connMu.Unlock()
	
	// Clean up expired bans
	d.banMu.Lock()
	for ip, banTime := range d.banList {
		if now.Sub(banTime) > d.config.BanDuration {
			delete(d.banList, ip)
		}
	}
	d.banMu.Unlock()
	
	// Clean up old rate limiters
	d.limiterMu.Lock()
	// Keep only active rate limiters
	activeIPs := make(map[string]bool)
	d.connMu.RLock()
	for ip := range d.connections {
		activeIPs[ip] = true
	}
	d.connMu.RUnlock()
	
	for ip := range d.rateLimiters {
		if !activeIPs[ip] {
			delete(d.rateLimiters, ip)
		}
	}
	d.limiterMu.Unlock()
}

// patternDetectionLoop detects attack patterns
func (d *DDoSProtection) patternDetectionLoop() {
	defer d.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-ticker.C:
			d.detectPatterns()
		}
	}
}

// detectPatterns analyzes connection patterns for attacks
func (d *DDoSProtection) detectPatterns() {
	d.connMu.RLock()
	defer d.connMu.RUnlock()
	
	// Detect SYN flood patterns
	if d.config.SynFloodProtection {
		d.detectSynFlood()
	}
	
	// Detect slowloris attacks
	if d.config.SlowlorisProtection {
		d.detectSlowloris()
	}
	
	// Detect amplification attacks
	if d.config.AmplificationProtection {
		d.detectAmplification()
	}
}

// detectSynFlood detects SYN flood attacks
func (d *DDoSProtection) detectSynFlood() {
	// Analyze connection patterns for SYN floods
	// Look for high rate of new connections without data
	
	for ip, conn := range d.connections {
		if conn.ConnectionCount > 100 && conn.BytesReceived < 1000 {
			d.logger.Warn("Potential SYN flood detected",
				zap.String("ip", ip),
				zap.Int("connections", conn.ConnectionCount),
				zap.Uint64("bytes", conn.BytesReceived),
			)
			conn.Flags.PatternDetected = true
		}
	}
}

// detectSlowloris detects slowloris attacks
func (d *DDoSProtection) detectSlowloris() {
	// Analyze for connections that stay open too long with minimal data
	
	now := time.Now()
	for ip, conn := range d.connections {
		connectionDuration := now.Sub(conn.FirstSeen)
		if connectionDuration > 5*time.Minute && conn.BytesReceived < 10000 {
			d.logger.Warn("Potential slowloris attack detected",
				zap.String("ip", ip),
				zap.Duration("duration", connectionDuration),
				zap.Uint64("bytes", conn.BytesReceived),
			)
			conn.Flags.PatternDetected = true
		}
	}
}

// detectAmplification detects amplification attacks
func (d *DDoSProtection) detectAmplification() {
	// Analyze for connections with disproportionate response sizes
	
	for ip, conn := range d.connections {
		if conn.BytesReceived > 0 && conn.BytesSent > conn.BytesReceived*10 {
			d.logger.Warn("Potential amplification attack detected",
				zap.String("ip", ip),
				zap.Uint64("bytes_received", conn.BytesReceived),
				zap.Uint64("bytes_sent", conn.BytesSent),
			)
			conn.Flags.PatternDetected = true
		}
	}
}

// NetworkOptimizer optimizes network performance
type NetworkOptimizer struct {
	logger *zap.Logger
	config OptimizerConfig
	
	// Latency tracking
	latencyTracker *LatencyTracker
	
	// Connection pooling
	connectionPool *ConnectionPool
	
	// Buffer management
	bufferPool sync.Pool
	
	// Metrics
	metrics *NetworkMetrics
}

// OptimizerConfig configures network optimization
type OptimizerConfig struct {
	// TCP optimization
	TCPNoDelay      bool `yaml:"tcp_nodelay"`
	TCPQuickAck     bool `yaml:"tcp_quickack"`
	TCPKeepAlive    bool `yaml:"tcp_keepalive"`
	KeepAliveTime   time.Duration `yaml:"keepalive_time"`
	
	// Buffer sizes
	ReadBufferSize  int `yaml:"read_buffer_size"`
	WriteBufferSize int `yaml:"write_buffer_size"`
	
	// Connection pooling
	MaxIdleConns    int `yaml:"max_idle_conns"`
	MaxActiveConns  int `yaml:"max_active_conns"`
	IdleTimeout     time.Duration `yaml:"idle_timeout"`
	
	// Latency optimization
	EnableFastOpen  bool `yaml:"enable_fast_open"`
	EnableNagle     bool `yaml:"enable_nagle"`
}

// LatencyTracker tracks network latency
type LatencyTracker struct {
	measurements map[string]*LatencyMeasurement
	mu           sync.RWMutex
}

// LatencyMeasurement contains latency data
type LatencyMeasurement struct {
	MinLatency    time.Duration
	MaxLatency    time.Duration
	AvgLatency    time.Duration
	LastLatency   time.Duration
	Measurements  int64
	LastMeasured  time.Time
}

// ConnectionPool manages connection pooling
type ConnectionPool struct {
	connections map[string][]net.Conn
	mu          sync.RWMutex
	config      OptimizerConfig
}

// NetworkMetrics tracks network performance metrics
type NetworkMetrics struct {
	BytesSent     atomic.Uint64
	BytesReceived atomic.Uint64
	PacketsSent   atomic.Uint64
	PacketsReceived atomic.Uint64
	Errors        atomic.Uint64
	Retransmits   atomic.Uint64
}

// NewNetworkOptimizer creates a new network optimizer
func NewNetworkOptimizer(logger *zap.Logger, config OptimizerConfig) *NetworkOptimizer {
	return &NetworkOptimizer{
		logger: logger,
		config: config,
		latencyTracker: &LatencyTracker{
			measurements: make(map[string]*LatencyMeasurement),
		},
		connectionPool: &ConnectionPool{
			connections: make(map[string][]net.Conn),
			config:      config,
		},
		bufferPool: sync.Pool{
			New: func() interface{} {
				return make([]byte, config.ReadBufferSize)
			},
		},
		metrics: &NetworkMetrics{},
	}
}

// OptimizeConnection optimizes a network connection
func (no *NetworkOptimizer) OptimizeConnection(conn net.Conn) error {
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		return nil // Not a TCP connection
	}
	
	// Set TCP options
	if no.config.TCPNoDelay {
		tcpConn.SetNoDelay(true)
	}
	
	if no.config.TCPKeepAlive {
		tcpConn.SetKeepAlive(true)
		tcpConn.SetKeepAlivePeriod(no.config.KeepAliveTime)
	}
	
	// Set buffer sizes
	if no.config.ReadBufferSize > 0 {
		tcpConn.SetReadBuffer(no.config.ReadBufferSize)
	}
	
	if no.config.WriteBufferSize > 0 {
		tcpConn.SetWriteBuffer(no.config.WriteBufferSize)
	}
	
	return nil
}

// MeasureLatency measures latency to a remote host
func (no *NetworkOptimizer) MeasureLatency(host string) time.Duration {
	start := time.Now()
	
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return 0
	}
	defer conn.Close()
	
	latency := time.Since(start)
	
	// Update tracking
	no.latencyTracker.Update(host, latency)
	
	return latency
}

// GetBuffer gets a buffer from the pool
func (no *NetworkOptimizer) GetBuffer() []byte {
	return no.bufferPool.Get().([]byte)
}

// PutBuffer returns a buffer to the pool
func (no *NetworkOptimizer) PutBuffer(buf []byte) {
	// Clear buffer before returning to pool
	for i := range buf {
		buf[i] = 0
	}
	no.bufferPool.Put(buf)
}

// GetMetrics returns network metrics
func (no *NetworkOptimizer) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"bytes_sent":       no.metrics.BytesSent.Load(),
		"bytes_received":   no.metrics.BytesReceived.Load(),
		"packets_sent":     no.metrics.PacketsSent.Load(),
		"packets_received": no.metrics.PacketsReceived.Load(),
		"errors":           no.metrics.Errors.Load(),
		"retransmits":      no.metrics.Retransmits.Load(),
	}
}

// Update updates latency measurement
func (lt *LatencyTracker) Update(host string, latency time.Duration) {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	
	measurement, exists := lt.measurements[host]
	if !exists {
		measurement = &LatencyMeasurement{
			MinLatency: latency,
			MaxLatency: latency,
		}
		lt.measurements[host] = measurement
	}
	
	// Update measurements
	if latency < measurement.MinLatency {
		measurement.MinLatency = latency
	}
	if latency > measurement.MaxLatency {
		measurement.MaxLatency = latency
	}
	
	// Update average
	measurement.Measurements++
	measurement.AvgLatency = time.Duration(
		(int64(measurement.AvgLatency)*  (measurement.Measurements-1) + int64(latency)) / measurement.Measurements,
	)
	
	measurement.LastLatency = latency
	measurement.LastMeasured = time.Now()
}

// GetLatency returns latency measurement for a host
func (lt *LatencyTracker) GetLatency(host string) *LatencyMeasurement {
	lt.mu.RLock()
	defer lt.mu.RUnlock()
	
	measurement, exists := lt.measurements[host]
	if !exists {
		return nil
	}
	
	// Return copy
	copy := *measurement
	return &copy
}

// GetConnection gets a connection from the pool
func (cp *ConnectionPool) GetConnection(address string) (net.Conn, error) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	// Check for existing connection
	if conns, exists := cp.connections[address]; exists && len(conns) > 0 {
		// Get last connection
		conn := conns[len(conns)-1]
		cp.connections[address] = conns[:len(conns)-1]
		
		// Check if connection is still alive
		if err := cp.checkConnection(conn); err == nil {
			return conn, nil
		}
		// Connection is dead, close it
		conn.Close()
	}
	
	// Create new connection
	return net.DialTimeout("tcp", address, 10*time.Second)
}

// PutConnection returns a connection to the pool
func (cp *ConnectionPool) PutConnection(address string, conn net.Conn) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	// Check pool size
	if conns, exists := cp.connections[address]; exists {
		if len(conns) >= cp.config.MaxIdleConns {
			// Pool is full, close connection
			conn.Close()
			return
		}
	}
	
	// Add to pool
	cp.connections[address] = append(cp.connections[address], conn)
	
	// Set idle timeout
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		tcpConn.SetKeepAlive(true)
		tcpConn.SetKeepAlivePeriod(cp.config.IdleTimeout)
	}
}

// checkConnection checks if a connection is still alive
func (cp *ConnectionPool) checkConnection(conn net.Conn) error {
	// Set a short deadline
	conn.SetReadDeadline(time.Now().Add(1 * time.Millisecond))
	
	// Try to read
	buf := make([]byte, 1)
	_, err := conn.Read(buf)
	
	// Reset deadline
	conn.SetReadDeadline(time.Time{})
	
	// Check error
	if err != nil {
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			// Timeout is expected, connection is alive
			return nil
		}
		return err
	}
	
	return nil
}