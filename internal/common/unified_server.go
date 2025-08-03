package common

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "sync"
    "time"
    
    "go.uber.org/zap"
)

// UnifiedServer provides a base server implementation for all server types
type UnifiedServer struct {
    Name      string
    Addr      string
    Logger    *zap.Logger
    
    listener  net.Listener
    server    *http.Server
    ctx       context.Context
    cancel    context.CancelFunc
    wg        sync.WaitGroup
    running   bool
    mu        sync.RWMutex
}

// NewUnifiedServer creates a new unified server instance
func NewUnifiedServer(name, addr string, logger *zap.Logger) *UnifiedServer {
    ctx, cancel := context.WithCancel(context.Background())
    return &UnifiedServer{
        Name:   name,
        Addr:   addr,
        Logger: logger,
        ctx:    ctx,
        cancel: cancel,
    }
}

// Start starts the server
func (s *UnifiedServer) Start() error {
    s.mu.Lock()
    defer s.mu.Unlock()
    
    if s.running {
        return fmt.Errorf("%s server already running", s.Name)
    }
    
    s.Logger.Info("Starting server",
        zap.String("name", s.Name),
        zap.String("addr", s.Addr),
    )
    
    s.running = true
    return nil
}

// Stop stops the server
func (s *UnifiedServer) Stop() error {
    s.mu.Lock()
    defer s.mu.Unlock()
    
    if !s.running {
        return nil
    }
    
    s.Logger.Info("Stopping server", zap.String("name", s.Name))
    s.cancel()
    s.wg.Wait()
    s.running = false
    
    if s.listener != nil {
        return s.listener.Close()
    }
    
    return nil
}

// IsRunning returns whether the server is running
func (s *UnifiedServer) IsRunning() bool {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return s.running
}

// ServeHTTP serves HTTP requests
func (s *UnifiedServer) ServeHTTP(handler http.Handler) error {
    s.server = &http.Server{
        Addr:    s.Addr,
        Handler: handler,
    }
    
    return s.server.ListenAndServe()
}

// ServeTCP serves TCP connections
func (s *UnifiedServer) ServeTCP(handler func(net.Conn)) error {
    listener, err := net.Listen("tcp", s.Addr)
    if err != nil {
        return fmt.Errorf("failed to listen: %w", err)
    }
    
    s.listener = listener
    
    s.wg.Add(1)
    go func() {
        defer s.wg.Done()
        for {
            select {
            case <-s.ctx.Done():
                return
            default:
                conn, err := listener.Accept()
                if err != nil {
                    if s.ctx.Err() != nil {
                        return
                    }
                    s.Logger.Error("Accept error", zap.Error(err))
                    continue
                }
                
                go handler(conn)
            }
        }
    }()
    
    return nil
}

// GetContext returns the server context
func (s *UnifiedServer) GetContext() context.Context {
    return s.ctx
}