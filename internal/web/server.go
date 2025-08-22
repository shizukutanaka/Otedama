package web

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
)

// Server represents the web server
type Server struct {
	mu         sync.RWMutex
	ctx        context.Context
	cancel     context.CancelFunc
	router     *mux.Router
	httpServer *http.Server
	templates  *template.Template
	wsHub      *WebSocketHub
	mining     MiningInterface
	monitor    MonitorInterface
}

// MiningInterface defines mining operations for web server
type MiningInterface interface {
	GetStatus() interface{}
	GetHashrate() float64
	GetStatistics() interface{}
}

// MonitorInterface defines monitoring operations for web server
type MonitorInterface interface {
	GetMetrics() interface{}
	GetHealth() interface{}
}

// WebSocketHub manages WebSocket connections
type WebSocketHub struct {
	mu         sync.RWMutex
	clients    map[*WebSocketClient]bool
	broadcast  chan []byte
	register   chan *WebSocketClient
	unregister chan *WebSocketClient
}

// WebSocketClient represents a WebSocket client
type WebSocketClient struct {
	hub  *WebSocketHub
	conn *websocket.Conn
	send chan []byte
}

// NewServer creates a new web server
func NewServer(port int, mining MiningInterface, monitor MonitorInterface) (*Server, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	s := &Server{
		ctx:     ctx,
		cancel:  cancel,
		mining:  mining,
		monitor: monitor,
		wsHub: &WebSocketHub{
			clients:    make(map[*WebSocketClient]bool),
			broadcast:  make(chan []byte),
			register:   make(chan *WebSocketClient),
			unregister: make(chan *WebSocketClient),
		},
	}
	
	// Load templates
	if err := s.loadTemplates(); err != nil {
		return nil, fmt.Errorf("failed to load templates: %w", err)
	}
	
	// Setup routes
	s.setupRoutes()
	
	// Create HTTP server
	s.httpServer = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: s.router,
	}
	
	return s, nil
}

// Start starts the web server
func (s *Server) Start() error {
	// Start WebSocket hub
	go s.wsHub.Run()
	
	// Start stats broadcaster
	go s.broadcastStats()
	
	// Start HTTP server
	go func() {
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			// Log error
		}
	}()
	
	return nil
}

// Stop stops the web server
func (s *Server) Stop() error {
	s.cancel()
	
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return s.httpServer.Shutdown(ctx)
}

// loadTemplates loads HTML templates
func (s *Server) loadTemplates() error {
	// In production, would load from embedded templates
	// For now, create simple templates
	
	tmpl := `
<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
        h1 { font-size: 2.5rem; margin-bottom: 2rem; text-align: center; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 1rem;
            padding: 1.5rem;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .stat-label {
            font-size: 0.875rem;
            opacity: 0.8;
            margin-bottom: 0.5rem;
        }
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
        }
        .stat-unit {
            font-size: 1rem;
            opacity: 0.8;
            margin-left: 0.25rem;
        }
        .chart-container {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 1rem;
            padding: 1.5rem;
            border: 1px solid rgba(255, 255, 255, 0.2);
            margin-bottom: 2rem;
        }
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 0.5rem;
        }
        .status-running { background: #10b981; }
        .status-stopped { background: #ef4444; }
        .control-buttons {
            display: flex;
            gap: 1rem;
            justify-content: center;
            margin-top: 2rem;
        }
        button {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            padding: 0.75rem 2rem;
            border-radius: 0.5rem;
            font-size: 1rem;
            cursor: pointer;
            transition: all 0.3s;
        }
        button:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Otedama Mining Dashboard</h1>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Status</div>
                <div class="stat-value">
                    <span class="status-indicator status-{{.Status}}"></span>
                    {{.StatusText}}
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Hashrate</div>
                <div class="stat-value">
                    <span id="hashrate">{{.Hashrate}}</span>
                    <span class="stat-unit">{{.HashrateUnit}}</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Shares</div>
                <div class="stat-value">
                    <span id="shares">{{.SharesAccepted}}</span>
                    <span class="stat-unit">/ {{.SharesSubmitted}}</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Efficiency</div>
                <div class="stat-value">
                    <span id="efficiency">{{.Efficiency}}</span>
                    <span class="stat-unit">H/W</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Temperature</div>
                <div class="stat-value">
                    <span id="temperature">{{.Temperature}}</span>
                    <span class="stat-unit">°C</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Power</div>
                <div class="stat-value">
                    <span id="power">{{.Power}}</span>
                    <span class="stat-unit">W</span>
                </div>
            </div>
        </div>
        
        <div class="chart-container">
            <canvas id="hashrateChart"></canvas>
        </div>
        
        <div class="control-buttons">
            <button onclick="startMining()">Start Mining</button>
            <button onclick="stopMining()">Stop Mining</button>
            <button onclick="openSettings()">Settings</button>
        </div>
    </div>
    
    <script>
        // WebSocket connection with protocol detection
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
        
        ws.onmessage = function(event) {
            const data = JSON.parse(event.data);
            updateStats(data);
        };
        
        function updateStats(data) {
            if (data.hashrate !== undefined) {
                document.getElementById('hashrate').textContent = formatHashrate(data.hashrate);
            }
            if (data.shares_accepted !== undefined) {
                document.getElementById('shares').textContent = data.shares_accepted;
            }
            if (data.efficiency !== undefined) {
                document.getElementById('efficiency').textContent = data.efficiency.toFixed(2);
            }
            if (data.temperature !== undefined) {
                document.getElementById('temperature').textContent = data.temperature.toFixed(1);
            }
            if (data.power !== undefined) {
                document.getElementById('power').textContent = data.power.toFixed(0);
            }
        }
        
        function formatHashrate(hashrate) {
            const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
            let unitIndex = 0;
            let value = hashrate;
            
            while (value >= 1000 && unitIndex < units.length - 1) {
                value /= 1000;
                unitIndex++;
            }
            
            return value.toFixed(2);
        }
        
        function startMining() {
            fetch('/api/mining/start', { method: 'POST' })
                .then(response => response.json())
                .then(data => console.log(data));
        }
        
        function stopMining() {
            fetch('/api/mining/stop', { method: 'POST' })
                .then(response => response.json())
                .then(data => console.log(data));
        }
        
        function openSettings() {
            window.location.href = '/settings';
        }
    </script>
</body>
</html>
`
	
	var err error
	s.templates, err = template.New("dashboard").Parse(tmpl)
	return err
}

// setupRoutes sets up HTTP routes
func (s *Server) setupRoutes() {
	s.router = mux.NewRouter()
	
	// Web pages
	s.router.HandleFunc("/", s.handleDashboard).Methods("GET")
	s.router.HandleFunc("/settings", s.handleSettings).Methods("GET")
	s.router.HandleFunc("/logs", s.handleLogs).Methods("GET")
	
	// API endpoints
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/status", s.handleAPIStatus).Methods("GET")
	api.HandleFunc("/stats", s.handleAPIStats).Methods("GET")
	api.HandleFunc("/mining/start", s.handleAPIMiningStart).Methods("POST")
	api.HandleFunc("/mining/stop", s.handleAPIMiningStop).Methods("POST")
	api.HandleFunc("/config", s.handleAPIConfig).Methods("GET", "POST")
	
	// WebSocket
	s.router.HandleFunc("/ws", s.handleWebSocket)
}

// handleDashboard handles dashboard page
func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	// Prepare template data
	data := map[string]interface{}{
		"Status":         "running",
		"StatusText":     "Running",
		"Hashrate":       formatHashrate(s.mining.GetHashrate()),
		"HashrateUnit":   getHashrateUnit(s.mining.GetHashrate()),
		"SharesAccepted": 0,
		"SharesSubmitted": 0,
		"Efficiency":     0,
		"Temperature":    0,
		"Power":          0,
	}
	
	s.templates.Execute(w, data)
}

// handleSettings handles settings page
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	// Settings page
	w.Write([]byte("Settings Page"))
}

// handleLogs handles logs page
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	// Logs page
	w.Write([]byte("Logs Page"))
}

// handleAPIStatus handles status API
func (s *Server) handleAPIStatus(w http.ResponseWriter, r *http.Request) {
	status := s.mining.GetStatus()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// handleAPIStats handles stats API
func (s *Server) handleAPIStats(w http.ResponseWriter, r *http.Request) {
	stats := s.mining.GetStatistics()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// handleAPIMiningStart handles mining start API
func (s *Server) handleAPIMiningStart(w http.ResponseWriter, r *http.Request) {
	// Start mining
	response := map[string]string{"status": "started"}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleAPIMiningStop handles mining stop API
func (s *Server) handleAPIMiningStop(w http.ResponseWriter, r *http.Request) {
	// Stop mining
	response := map[string]string{"status": "stopped"}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleAPIConfig handles config API
func (s *Server) handleAPIConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		// Get config
		config := map[string]interface{}{
			"algorithm": "sha256d",
			"pools":     []string{},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(config)
	} else {
		// Update config
		var config map[string]interface{}
		json.NewDecoder(r.Body).Decode(&config)
		
		response := map[string]string{"status": "updated"}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	}
}

// handleWebSocket handles WebSocket connections
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	
	client := &WebSocketClient{
		hub:  s.wsHub,
		conn: conn,
		send: make(chan []byte, 256),
	}
	
	client.hub.register <- client
	
	go client.writePump()
	go client.readPump()
}

// broadcastStats broadcasts stats to WebSocket clients
func (s *Server) broadcastStats() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			stats := map[string]interface{}{
				"hashrate":        s.mining.GetHashrate(),
				"shares_accepted": 0,
				"efficiency":      0,
				"temperature":     0,
				"power":           0,
			}
			
			data, _ := json.Marshal(stats)
			s.wsHub.broadcast <- data
		}
	}
}

// WebSocketHub methods

func (h *WebSocketHub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
			
		case message := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

// WebSocketClient methods

func (c *WebSocketClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (c *WebSocketClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			c.conn.WriteMessage(websocket.TextMessage, message)
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// Helper functions

func formatHashrate(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIndex := 0
	value := hashrate
	
	for value >= 1000 && unitIndex < len(units)-1 {
		value /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f", value)
}

func getHashrateUnit(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIndex := 0
	value := hashrate
	
	for value >= 1000 && unitIndex < len(units)-1 {
		value /= 1000
		unitIndex++
	}
	
	return units[unitIndex]
}