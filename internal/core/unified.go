package core

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "net"
    "net/http"
    "runtime"
    "sync"
    "time"
    
    "go.uber.org/zap"
)

// ========== Core Types ==========

type Config struct {
    Mining struct {
        Algorithm string
        Threads   int
    }
    Pool struct {
        URL      string
        User     string
        Password string
    }
    API struct {
        Enabled bool
        Listen  string
    }
}

type Engine struct {
    ctx       context.Context
    cancel    context.CancelFunc
    config    *Config
    logger    *zap.Logger
    miner     *Miner
    pool      *PoolClient
    api       *APIServer
    stats     *Stats
    mu        sync.RWMutex
}

// ========== Mining Core ==========

type Miner struct {
    algorithm string
    threads   int
    hashrate  float64
    mu        sync.Mutex
}

func (m *Miner) Mine(ctx context.Context, job *Job) (*Share, error) {
    data := append(job.Data, job.Nonce...)
    hash := sha256.Sum256(data)
    doubleHash := sha256.Sum256(hash[:])
    
    return &Share{
        JobID: job.ID,
        Nonce: hex.EncodeToString(job.Nonce),
        Hash:  hex.EncodeToString(doubleHash[:]),
        Time:  time.Now(),
    }, nil
}

// ========== Pool Client ==========

type PoolClient struct {
    url    string
    user   string
    pass   string
    conn   net.Conn
    mu     sync.Mutex
}

func (p *PoolClient) Connect() error {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    conn, err := net.DialTimeout("tcp", p.url, 10*time.Second)
    if err != nil {
        return err
    }
    p.conn = conn
    return nil
}

func (p *PoolClient) SubmitShare(share *Share) error {
    // Simple share submission
    data := map[string]interface{}{
        "id":     1,
        "method": "mining.submit",
        "params": []interface{}{p.user, share.JobID, share.Nonce},
    }
    
    return json.NewEncoder(p.conn).Encode(data)
}

// ========== API Server ==========

type APIServer struct {
    addr   string
    engine *Engine
}

func (a *APIServer) Start() error {
    http.HandleFunc("/api/status", a.handleStatus)
    http.HandleFunc("/api/stats", a.handleStats)
    return http.ListenAndServe(a.addr, nil)
}

func (a *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status":  "running",
        "version": "2.1.3-minimal",
        "uptime":  time.Since(a.engine.stats.StartTime).Seconds(),
    })
}

func (a *APIServer) handleStats(w http.ResponseWriter, r *http.Request) {
    a.engine.mu.RLock()
    defer a.engine.mu.RUnlock()
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(a.engine.stats)
}

// ========== Statistics ==========

type Stats struct {
    StartTime    time.Time
    TotalShares  uint64
    AcceptedShares uint64
    RejectedShares uint64
    Hashrate     float64
    mu           sync.Mutex
}

func (s *Stats) AddShare(accepted bool) {
    s.mu.Lock()
    defer s.mu.Unlock()
    
    s.TotalShares++
    if accepted {
        s.AcceptedShares++
    } else {
        s.RejectedShares++
    }
}

// ========== Data Structures ==========

type Job struct {
    ID     string
    Data   []byte
    Target []byte
    Nonce  []byte
}

type Share struct {
    JobID string
    Nonce string
    Hash  string
    Time  time.Time
}

// ========== Main Engine Functions ==========

func NewEngine(config *Config, logger *zap.Logger) (*Engine, error) {
    ctx, cancel := context.WithCancel(context.Background())
    
    engine := &Engine{
        ctx:    ctx,
        cancel: cancel,
        config: config,
        logger: logger,
        stats:  &Stats{StartTime: time.Now()},
    }
    
    // Initialize components
    engine.miner = &Miner{
        algorithm: config.Mining.Algorithm,
        threads:   config.Mining.Threads,
    }
    
    engine.pool = &PoolClient{
        url:  config.Pool.URL,
        user: config.Pool.User,
        pass: config.Pool.Password,
    }
    
    if config.API.Enabled {
        engine.api = &APIServer{
            addr:   config.API.Listen,
            engine: engine,
        }
    }
    
    return engine, nil
}

func (e *Engine) Start() error {
    e.logger.Info("Starting Otedama engine",
        zap.String("algorithm", e.config.Mining.Algorithm),
        zap.Int("threads", e.config.Mining.Threads),
    )
    
    // Connect to pool
    if err := e.pool.Connect(); err != nil {
        return fmt.Errorf("pool connection failed: %w", err)
    }
    
    // Start API server
    if e.api != nil {
        go func() {
            if err := e.api.Start(); err != nil {
                e.logger.Error("API server failed", zap.Error(err))
            }
        }()
    }
    
    // Start mining loop
    go e.miningLoop()
    
    return nil
}

func (e *Engine) Stop() {
    e.logger.Info("Stopping Otedama engine")
    e.cancel()
    
    if e.pool.conn != nil {
        e.pool.conn.Close()
    }
}

func (e *Engine) miningLoop() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-e.ctx.Done():
            return
        case <-ticker.C:
            // Simulate mining
            job := &Job{
                ID:    fmt.Sprintf("job_%d", time.Now().Unix()),
                Data:  []byte("sample_block_data"),
                Nonce: []byte(fmt.Sprintf("%d", time.Now().UnixNano())),
            }
            
            share, err := e.miner.Mine(e.ctx, job)
            if err != nil {
                e.logger.Error("Mining failed", zap.Error(err))
                continue
            }
            
            if err := e.pool.SubmitShare(share); err != nil {
                e.logger.Error("Share submission failed", zap.Error(err))
                e.stats.AddShare(false)
            } else {
                e.stats.AddShare(true)
            }
        }
    }
}

// ========== Utility Functions ==========

func GetSystemInfo() map[string]interface{} {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    
    return map[string]interface{}{
        "goroutines": runtime.NumGoroutine(),
        "memory_mb":  m.Alloc / 1024 / 1024,
        "cpu_cores":  runtime.NumCPU(),
        "go_version": runtime.Version(),
    }
}