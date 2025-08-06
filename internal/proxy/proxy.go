package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MiningProxy provides proxy functionality for miners behind firewalls
// Following Rob Pike's simplicity and John Carmack's performance principles
type MiningProxy struct {
	logger *zap.Logger
	config ProxyConfig
	
	// Proxy state
	listener     net.Listener
	upstream     *UpstreamPool
	
	// Connection tracking
	connections  sync.Map // map[string]*ProxyConnection
	connID       atomic.Uint64
	
	// Statistics
	stats        *ProxyStats
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// ProxyConfig contains proxy configuration
type ProxyConfig struct {
	// Listen configuration
	ListenAddr      string
	EnableTLS       bool
	TLSCertFile     string
	TLSKeyFile      string
	
	// Upstream configuration
	UpstreamAddrs   []string
	UpstreamTLS     bool
	
	// Connection settings
	MaxConnections  int
	ConnTimeout     time.Duration
	IdleTimeout     time.Duration
	
	// Buffer sizes
	ReadBufferSize  int
	WriteBufferSize int
	
	// Features
	EnableCompression bool
	EnableStats       bool
}

// ProxyConnection represents a proxied connection
type ProxyConnection struct {
	id           uint64
	clientConn   net.Conn
	upstreamConn net.Conn
	proxy        *MiningProxy
	
	// Metrics
	bytesIn      atomic.Uint64
	bytesOut     atomic.Uint64
	startTime    time.Time
	lastActivity atomic.Value // time.Time
	
	// State
	closed       atomic.Bool
	closeOnce    sync.Once
}

// ProxyStats tracks proxy statistics
type ProxyStats struct {
	TotalConnections  atomic.Uint64
	ActiveConnections atomic.Int64
	BytesProxied      atomic.Uint64
	MessagesProxied   atomic.Uint64
	Errors            atomic.Uint64
	
	// Upstream stats
	UpstreamFailures  atomic.Uint64
	UpstreamSwitches  atomic.Uint64
}

// UpstreamPool manages upstream connections
type UpstreamPool struct {
	addrs        []string
	current      atomic.Int32
	connections  sync.Map // map[string]net.Conn
	healthChecks sync.Map // map[string]bool
	tlsEnabled   bool
	logger       *zap.Logger
}

// NewMiningProxy creates a new mining proxy
func NewMiningProxy(logger *zap.Logger, config ProxyConfig) *MiningProxy {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &MiningProxy{
		logger: logger,
		config: config,
		upstream: &UpstreamPool{
			addrs:      config.UpstreamAddrs,
			tlsEnabled: config.UpstreamTLS,
			logger:     logger,
		},
		stats:  &ProxyStats{},
		ctx:    ctx,
		cancel: cancel,
	}
}

// Start starts the mining proxy
func (mp *MiningProxy) Start() error {
	mp.logger.Info("Starting mining proxy",
		zap.String("listen_addr", mp.config.ListenAddr),
		zap.Strings("upstream_addrs", mp.config.UpstreamAddrs),
	)
	
	// Start upstream health checks
	mp.wg.Add(1)
	go mp.upstream.healthCheckLoop(mp.ctx, &mp.wg)
	
	// Create listener
	var listener net.Listener
	var err error
	
	if mp.config.EnableTLS {
		cert, err := tls.LoadX509KeyPair(mp.config.TLSCertFile, mp.config.TLSKeyFile)
		if err != nil {
			return fmt.Errorf("failed to load TLS cert: %w", err)
		}
		
		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		
		listener, err = tls.Listen("tcp", mp.config.ListenAddr, tlsConfig)
	} else {
		listener, err = net.Listen("tcp", mp.config.ListenAddr)
	}
	
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	
	mp.listener = listener
	
	// Start accept loop
	mp.wg.Add(1)
	go mp.acceptLoop()
	
	// Start stats reporter
	if mp.config.EnableStats {
		mp.wg.Add(1)
		go mp.statsLoop()
	}
	
	return nil
}

// Stop stops the mining proxy
func (mp *MiningProxy) Stop() error {
	mp.logger.Info("Stopping mining proxy")
	
	mp.cancel()
	
	if mp.listener != nil {
		mp.listener.Close()
	}
	
	// Close all connections
	mp.connections.Range(func(key, value interface{}) bool {
		conn := value.(*ProxyConnection)
		conn.Close()
		return true
	})
	
	mp.wg.Wait()
	
	return nil
}

// acceptLoop accepts new connections
func (mp *MiningProxy) acceptLoop() {
	defer mp.wg.Done()
	
	for {
		conn, err := mp.listener.Accept()
		if err != nil {
			select {
			case <-mp.ctx.Done():
				return
			default:
				mp.logger.Error("Accept error", zap.Error(err))
				continue
			}
		}
		
		// Check connection limit
		if mp.stats.ActiveConnections.Load() >= int64(mp.config.MaxConnections) {
			conn.Close()
			mp.logger.Warn("Connection limit reached",
				zap.Int64("active", mp.stats.ActiveConnections.Load()),
				zap.Int("limit", mp.config.MaxConnections),
			)
			continue
		}
		
		// Handle connection
		mp.wg.Add(1)
		go mp.handleConnection(conn)
	}
}

// handleConnection handles a client connection
func (mp *MiningProxy) handleConnection(clientConn net.Conn) {
	defer mp.wg.Done()
	
	// Create proxy connection
	connID := mp.connID.Add(1)
	proxyConn := &ProxyConnection{
		id:         connID,
		clientConn: clientConn,
		proxy:      mp,
		startTime:  time.Now(),
	}
	proxyConn.lastActivity.Store(time.Now())
	
	// Track connection
	mp.connections.Store(fmt.Sprintf("%d", connID), proxyConn)
	mp.stats.TotalConnections.Add(1)
	mp.stats.ActiveConnections.Add(1)
	
	defer func() {
		proxyConn.Close()
		mp.connections.Delete(fmt.Sprintf("%d", connID))
		mp.stats.ActiveConnections.Add(-1)
	}()
	
	// Connect to upstream
	upstreamConn, err := mp.upstream.getConnection()
	if err != nil {
		mp.logger.Error("Failed to connect to upstream",
			zap.Uint64("conn_id", connID),
			zap.Error(err),
		)
		mp.stats.Errors.Add(1)
		return
	}
	
	proxyConn.upstreamConn = upstreamConn
	
	mp.logger.Info("Proxy connection established",
		zap.Uint64("conn_id", connID),
		zap.String("client", clientConn.RemoteAddr().String()),
		zap.String("upstream", upstreamConn.RemoteAddr().String()),
	)
	
	// Start proxying
	var wg sync.WaitGroup
	wg.Add(2)
	
	// Client -> Upstream
	go func() {
		defer wg.Done()
		mp.proxy(proxyConn, clientConn, upstreamConn, true)
	}()
	
	// Upstream -> Client
	go func() {
		defer wg.Done()
		mp.proxy(proxyConn, upstreamConn, clientConn, false)
	}()
	
	wg.Wait()
}

// proxy copies data between connections
func (mp *MiningProxy) proxy(conn *ProxyConnection, src, dst net.Conn, isUpstream bool) {
	buffer := make([]byte, mp.config.ReadBufferSize)
	
	for {
		// Set read timeout
		if mp.config.IdleTimeout > 0 {
			src.SetReadDeadline(time.Now().Add(mp.config.IdleTimeout))
		}
		
		n, err := src.Read(buffer)
		if err != nil {
			if err != io.EOF && !errors.Is(err, net.ErrClosed) {
				mp.logger.Debug("Read error",
					zap.Uint64("conn_id", conn.id),
					zap.Bool("upstream", isUpstream),
					zap.Error(err),
				)
				mp.stats.Errors.Add(1)
			}
			return
		}
		
		if n > 0 {
			// Set write timeout
			if mp.config.ConnTimeout > 0 {
				dst.SetWriteDeadline(time.Now().Add(mp.config.ConnTimeout))
			}
			
			_, err = dst.Write(buffer[:n])
			if err != nil {
				mp.logger.Debug("Write error",
					zap.Uint64("conn_id", conn.id),
					zap.Bool("upstream", isUpstream),
					zap.Error(err),
				)
				mp.stats.Errors.Add(1)
				return
			}
			
			// Update stats
			if isUpstream {
				conn.bytesOut.Add(uint64(n))
			} else {
				conn.bytesIn.Add(uint64(n))
			}
			mp.stats.BytesProxied.Add(uint64(n))
			conn.lastActivity.Store(time.Now())
		}
	}
}

// Close closes the proxy connection
func (pc *ProxyConnection) Close() error {
	pc.closeOnce.Do(func() {
		pc.closed.Store(true)
		
		if pc.clientConn != nil {
			pc.clientConn.Close()
		}
		if pc.upstreamConn != nil {
			pc.upstreamConn.Close()
		}
		
		duration := time.Since(pc.startTime)
		pc.proxy.logger.Info("Proxy connection closed",
			zap.Uint64("conn_id", pc.id),
			zap.Duration("duration", duration),
			zap.Uint64("bytes_in", pc.bytesIn.Load()),
			zap.Uint64("bytes_out", pc.bytesOut.Load()),
		)
	})
	
	return nil
}

// UpstreamPool methods

// getConnection gets an upstream connection
func (up *UpstreamPool) getConnection() (net.Conn, error) {
	// Simple round-robin selection
	index := up.current.Add(1) % int32(len(up.addrs))
	addr := up.addrs[index]
	
	// Check health
	if healthy, ok := up.healthChecks.Load(addr); ok && !healthy.(bool) {
		// Try next upstream
		for i := 0; i < len(up.addrs); i++ {
			index = (index + 1) % int32(len(up.addrs))
			addr = up.addrs[index]
			if healthy, ok := up.healthChecks.Load(addr); !ok || healthy.(bool) {
				break
			}
		}
	}
	
	// Connect
	var conn net.Conn
	var err error
	
	if up.tlsEnabled {
		conn, err = tls.Dial("tcp", addr, &tls.Config{
			MinVersion: tls.VersionTLS12,
		})
	} else {
		conn, err = net.Dial("tcp", addr)
	}
	
	if err != nil {
		up.healthChecks.Store(addr, false)
		return nil, fmt.Errorf("failed to connect to upstream %s: %w", addr, err)
	}
	
	up.healthChecks.Store(addr, true)
	return conn, nil
}

// healthCheckLoop performs periodic health checks
func (up *UpstreamPool) healthCheckLoop(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	// Initial health check
	for _, addr := range up.addrs {
		go up.checkHealth(addr)
	}
	
	for {
		select {
		case <-ctx.Done():
			return
			
		case <-ticker.C:
			for _, addr := range up.addrs {
				go up.checkHealth(addr)
			}
		}
	}
}

// checkHealth checks the health of an upstream
func (up *UpstreamPool) checkHealth(addr string) {
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		up.healthChecks.Store(addr, false)
		up.logger.Warn("Upstream health check failed",
			zap.String("addr", addr),
			zap.Error(err),
		)
		return
	}
	conn.Close()
	
	up.healthChecks.Store(addr, true)
}

// statsLoop reports statistics periodically
func (mp *MiningProxy) statsLoop() {
	defer mp.wg.Done()
	
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mp.ctx.Done():
			return
			
		case <-ticker.C:
			mp.logger.Info("Proxy statistics",
				zap.Uint64("total_connections", mp.stats.TotalConnections.Load()),
				zap.Int64("active_connections", mp.stats.ActiveConnections.Load()),
				zap.Uint64("bytes_proxied", mp.stats.BytesProxied.Load()),
				zap.Uint64("errors", mp.stats.Errors.Load()),
			)
		}
	}
}

// GetStats returns proxy statistics
func (mp *MiningProxy) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_connections":   mp.stats.TotalConnections.Load(),
		"active_connections":  mp.stats.ActiveConnections.Load(),
		"bytes_proxied":       mp.stats.BytesProxied.Load(),
		"messages_proxied":    mp.stats.MessagesProxied.Load(),
		"errors":              mp.stats.Errors.Load(),
		"upstream_failures":   mp.stats.UpstreamFailures.Load(),
		"upstream_switches":   mp.stats.UpstreamSwitches.Load(),
	}
}