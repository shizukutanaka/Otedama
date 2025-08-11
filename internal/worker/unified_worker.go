package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// Manager manages mining workers
type Manager struct {
	logger *zap.Logger
	config config.WorkerConfig
	db     *database.DB
	
	// Workers
	workers    map[string]*Worker
	workersMu  sync.RWMutex
	
	// Statistics
	stats      *Statistics
	
	// API
	apiRouter  *mux.Router
	apiServer  *http.Server
	
	// Lifecycle
	running    atomic.Bool
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// Worker represents a mining worker
type Worker struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	WalletAddress  string    `json:"wallet_address"`
	Type           string    `json:"type"` // cpu, gpu, asic
	
	// Connection
	Connected      bool      `json:"connected"`
	IPAddress      string    `json:"ip_address"`
	UserAgent      string    `json:"user_agent"`
	ConnectedAt    time.Time `json:"connected_at"`
	LastSeen       time.Time `json:"last_seen"`
	
	// Mining stats
	HashRate       atomic.Uint64 `json:"hashrate"`
	Temperature    atomic.Uint32 `json:"temperature"`
	FanSpeed       atomic.Uint32 `json:"fan_speed"`
	Power          atomic.Uint32 `json:"power"`
	
	// Shares
	SharesSubmitted atomic.Uint64 `json:"shares_submitted"`
	SharesAccepted  atomic.Uint64 `json:"shares_accepted"`
	SharesRejected  atomic.Uint64 `json:"shares_rejected"`
	SharesStale     atomic.Uint64 `json:"shares_stale"`
	LastShareTime   time.Time     `json:"last_share_time"`
	
	// Difficulty
	Difficulty      float64   `json:"difficulty"`
	TargetDiff      float64   `json:"target_difficulty"`
	
	// Earnings
	TotalEarnings   float64   `json:"total_earnings"`
	UnpaidBalance   float64   `json:"unpaid_balance"`
	LastPayment     time.Time `json:"last_payment"`
	
	// Configuration
	Config          WorkerConfig `json:"config"`
	
	// Internal
	shareHistory    []ShareRecord
	historyMu       sync.RWMutex
	updateChan      chan WorkerUpdate
}

// WorkerConfig contains worker configuration
type WorkerConfig struct {
	MinDifficulty   float64 `json:"min_difficulty"`
	MaxDifficulty   float64 `json:"max_difficulty"`
	PayoutThreshold float64 `json:"payout_threshold"`
	FeePercent      float64 `json:"fee_percent"`
	Enabled         bool    `json:"enabled"`
	Notes           string  `json:"notes"`
}

// ShareRecord represents a share submission record
type ShareRecord struct {
	Timestamp   time.Time
	Difficulty  float64
	Valid       bool
	Hash        string
	JobID       string
}

// WorkerUpdate represents an update to worker stats
type WorkerUpdate struct {
	HashRate    uint64
	Temperature uint32
	FanSpeed    uint32
	Power       uint32
	ShareValid  bool
	ShareDiff   float64
}

// Statistics tracks overall worker statistics
type Statistics struct {
	TotalWorkers    atomic.Int32
	ActiveWorkers   atomic.Int32
	TotalHashRate   atomic.Uint64
	TotalShares     atomic.Uint64
	ValidShares     atomic.Uint64
	InvalidShares   atomic.Uint64
	StaleShares     atomic.Uint64
	TotalEarnings   float64
	mu              sync.RWMutex
}

// ValidationRules defines worker validation rules
type ValidationRules struct {
	RequireRegistration bool
	MinHashRate        uint64
	MaxIdleTime        time.Duration
	MaxInvalidPercent  float64
	BanDuration        time.Duration
}

// WorkerAPI provides HTTP API for worker management
type WorkerAPI struct {
	manager *Manager
	logger  *zap.Logger
}

// NewManager creates a new worker manager
func NewManager(logger *zap.Logger, config config.WorkerConfig, db *database.DB) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	
	m := &Manager{
		logger:  logger,
		config:  config,
		db:      db,
		workers: make(map[string]*Worker),
		stats:   &Statistics{},
		ctx:     ctx,
		cancel:  cancel,
	}
	
	// Setup API if enabled
	if config.APIEnabled {
		m.setupAPI()
	}
	
	return m
}

// Start starts the worker manager
func (m *Manager) Start() error {
	if !m.running.CompareAndSwap(false, true) {
		return errors.New("manager already running")
	}
	
	// Start background workers
	m.wg.Add(2)
	go m.statsUpdater()
	go m.cleanupWorker()
	
	// Start API server if configured
	if m.apiServer != nil {
		m.wg.Add(1)
		go m.startAPI()
	}
	
	m.logger.Info("Worker manager started")
	return nil
}

// Stop stops the worker manager
func (m *Manager) Stop() error {
	if !m.running.CompareAndSwap(true, false) {
		return errors.New("manager not running")
	}
	
	m.cancel()
	
	// Stop API server
	if m.apiServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		m.apiServer.Shutdown(ctx)
	}
	
	m.wg.Wait()
	
	// Save worker states
	m.saveWorkerStates()
	
	m.logger.Info("Worker manager stopped")
	return nil
}

// RegisterWorker registers a new worker
func (m *Manager) RegisterWorker(id, name, wallet string) (*Worker, error) {
	m.workersMu.Lock()
	defer m.workersMu.Unlock()
	
	// Check if worker already exists
	if _, exists := m.workers[id]; exists {
		return nil, errors.New("worker already registered")
	}
	
	// Validate wallet address
	if err := m.validateWalletAddress(wallet); err != nil {
		return nil, fmt.Errorf("invalid wallet address: %w", err)
	}
	
	worker := &Worker{
		ID:            id,
		Name:          name,
		WalletAddress: wallet,
		ConnectedAt:   time.Now(),
		LastSeen:      time.Now(),
		Connected:     true,
		Config: WorkerConfig{
			MinDifficulty:   m.config.DefaultMinDiff,
			MaxDifficulty:   m.config.DefaultMaxDiff,
			PayoutThreshold: m.config.DefaultPayoutThreshold,
			FeePercent:      m.config.DefaultFeePercent,
			Enabled:         true,
		},
		updateChan:   make(chan WorkerUpdate, 100),
		shareHistory: make([]ShareRecord, 0, 100),
	}
	
	m.workers[id] = worker
	m.stats.TotalWorkers.Add(1)
	m.stats.ActiveWorkers.Add(1)
	
	// Save to database if configured
	if m.db != nil {
		dbWorker := &database.Worker{
			ID:         id,
			Name:       name,
			WalletAddr: wallet,
			Active:     true,
			CreatedAt:  time.Now(),
			LastSeen:   time.Now(),
		}
		m.db.Workers.Create(dbWorker)
	}
	
	m.logger.Info("Worker registered",
		zap.String("id", id),
		zap.String("name", name),
		zap.String("wallet", wallet))
	
	return worker, nil
}

// GetWorker gets a worker by ID
func (m *Manager) GetWorker(id string) (*Worker, error) {
	m.workersMu.RLock()
	defer m.workersMu.RUnlock()
	
	worker, exists := m.workers[id]
	if !exists {
		return nil, errors.New("worker not found")
	}
	
	return worker, nil
}

// UpdateWorker updates worker information
func (m *Manager) UpdateWorker(id string, update WorkerUpdate) error {
	worker, err := m.GetWorker(id)
	if err != nil {
		return err
	}
	
	// Update stats
	if update.HashRate > 0 {
		oldRate := worker.HashRate.Swap(update.HashRate)
		m.stats.TotalHashRate.Add(update.HashRate - oldRate)
	}
	
	if update.Temperature > 0 {
		worker.Temperature.Store(update.Temperature)
	}
	
	if update.FanSpeed > 0 {
		worker.FanSpeed.Store(update.FanSpeed)
	}
	
	if update.Power > 0 {
		worker.Power.Store(update.Power)
	}
	
	worker.LastSeen = time.Now()
	
	// Send to update channel for processing
	select {
	case worker.updateChan <- update:
	default:
		// Channel full, drop update
	}
	
	return nil
}

// SubmitShare processes a share submission
func (m *Manager) SubmitShare(workerID, jobID, hash string, difficulty float64) (bool, error) {
	worker, err := m.GetWorker(workerID)
	if err != nil {
		return false, err
	}
	
	// Validate share
	valid := m.validateShare(worker, jobID, hash, difficulty)
	
	// Update statistics
	worker.SharesSubmitted.Add(1)
	m.stats.TotalShares.Add(1)
	
	if valid {
		worker.SharesAccepted.Add(1)
		m.stats.ValidShares.Add(1)
		worker.LastShareTime = time.Now()
		
		// Calculate earnings
		earnings := m.calculateShareValue(difficulty)
		worker.UnpaidBalance += earnings
		
		// Update database
		if m.db != nil {
			share := &database.Share{
				WorkerID:    workerID,
				JobID:       jobID,
				Hash:        hash,
				Difficulty:  difficulty,
				ShareDiff:   difficulty,
				Valid:       true,
				SubmittedAt: time.Now(),
			}
			m.db.Shares.Create(share)
		}
	} else {
		worker.SharesRejected.Add(1)
		m.stats.InvalidShares.Add(1)
	}
	
	// Record share
	worker.historyMu.Lock()
	worker.shareHistory = append(worker.shareHistory, ShareRecord{
		Timestamp:  time.Now(),
		Difficulty: difficulty,
		Valid:      valid,
		Hash:       hash,
		JobID:      jobID,
	})
	
	// Trim history if too long
	if len(worker.shareHistory) > 1000 {
		worker.shareHistory = worker.shareHistory[500:]
	}
	worker.historyMu.Unlock()
	
	// Adjust difficulty
	m.adjustDifficulty(worker)
	
	return valid, nil
}

// GetAllWorkers returns all workers
func (m *Manager) GetAllWorkers() []*Worker {
	m.workersMu.RLock()
	defer m.workersMu.RUnlock()
	
	workers := make([]*Worker, 0, len(m.workers))
	for _, w := range m.workers {
		workers = append(workers, w)
	}
	
	return workers
}

// GetActiveWorkers returns active workers
func (m *Manager) GetActiveWorkers() []*Worker {
	m.workersMu.RLock()
	defer m.workersMu.RUnlock()
	
	workers := make([]*Worker, 0)
	cutoff := time.Now().Add(-5 * time.Minute)
	
	for _, w := range m.workers {
		if w.Connected && w.LastSeen.After(cutoff) {
			workers = append(workers, w)
		}
	}
	
	return workers
}

// GetStatistics returns overall statistics
func (m *Manager) GetStatistics() map[string]interface{} {
	m.stats.mu.RLock()
	defer m.stats.mu.RUnlock()
	
	return map[string]interface{}{
		"total_workers":   m.stats.TotalWorkers.Load(),
		"active_workers":  m.stats.ActiveWorkers.Load(),
		"total_hashrate":  m.stats.TotalHashRate.Load(),
		"total_shares":    m.stats.TotalShares.Load(),
		"valid_shares":    m.stats.ValidShares.Load(),
		"invalid_shares":  m.stats.InvalidShares.Load(),
		"stale_shares":    m.stats.StaleShares.Load(),
		"total_earnings":  m.stats.TotalEarnings,
		"efficiency":      m.calculateEfficiency(),
	}
}

// Background workers

func (m *Manager) statsUpdater() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.updateStatistics()
		}
	}
}

func (m *Manager) cleanupWorker() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.cleanupInactiveWorkers()
		}
	}
}

func (m *Manager) updateStatistics() {
	m.workersMu.RLock()
	defer m.workersMu.RUnlock()
	
	var totalHashRate uint64
	var activeCount int32
	cutoff := time.Now().Add(-5 * time.Minute)
	
	for _, worker := range m.workers {
		if worker.LastSeen.After(cutoff) {
			activeCount++
			totalHashRate += worker.HashRate.Load()
		} else {
			worker.Connected = false
		}
	}
	
	m.stats.ActiveWorkers.Store(activeCount)
	m.stats.TotalHashRate.Store(totalHashRate)
	
	// Save stats to database
	if m.db != nil {
		stats := &database.Statistics{
			Timestamp:     time.Now(),
			HashRate:      float64(totalHashRate),
			Workers:       int(activeCount),
			SharesValid:   int64(m.stats.ValidShares.Load()),
			SharesInvalid: int64(m.stats.InvalidShares.Load()),
			SharesStale:   int64(m.stats.StaleShares.Load()),
		}
		m.db.Statistics.Create(stats)
	}
}

func (m *Manager) cleanupInactiveWorkers() {
	m.workersMu.Lock()
	defer m.workersMu.Unlock()
	
	cutoff := time.Now().Add(-24 * time.Hour)
	
	for id, worker := range m.workers {
		if worker.LastSeen.Before(cutoff) && !worker.Connected {
			delete(m.workers, id)
			m.stats.TotalWorkers.Add(-1)
			m.logger.Info("Removed inactive worker", zap.String("id", id))
		}
	}
}

// Validation methods

func (m *Manager) validateWalletAddress(address string) error {
	// Basic validation - can be extended based on currency
	if len(address) < 20 || len(address) > 100 {
		return errors.New("invalid wallet address length")
	}
	return nil
}

func (m *Manager) validateShare(worker *Worker, jobID, hash string, difficulty float64) bool {
	// Check if worker is enabled
	if !worker.Config.Enabled {
		return false
	}
	
	// Check difficulty
	if difficulty < worker.Config.MinDifficulty {
		return false
	}
	
	// Additional validation would go here
	// - Check PoW
	// - Check job validity
	// - Check for duplicates
	
	return true
}

// Difficulty adjustment

func (m *Manager) adjustDifficulty(worker *Worker) {
	worker.historyMu.RLock()
	history := worker.shareHistory
	worker.historyMu.RUnlock()
	
	if len(history) < 10 {
		return
	}
	
	// Calculate share rate
	recent := history[len(history)-10:]
	duration := recent[len(recent)-1].Timestamp.Sub(recent[0].Timestamp)
	if duration == 0 {
		return
	}
	
	shareRate := float64(len(recent)) / duration.Seconds()
	targetRate := 1.0 / 30.0 // Target 1 share per 30 seconds
	
	// Adjust difficulty
	newDiff := worker.Difficulty
	if shareRate > targetRate*1.5 {
		newDiff = worker.Difficulty * 1.25
	} else if shareRate < targetRate*0.5 {
		newDiff = worker.Difficulty * 0.75
	}
	
	// Apply limits
	if newDiff < worker.Config.MinDifficulty {
		newDiff = worker.Config.MinDifficulty
	}
	if newDiff > worker.Config.MaxDifficulty {
		newDiff = worker.Config.MaxDifficulty
	}
	
	if newDiff != worker.Difficulty {
		worker.Difficulty = newDiff
		worker.TargetDiff = newDiff
		m.logger.Debug("Adjusted worker difficulty",
			zap.String("worker", worker.ID),
			zap.Float64("new_diff", newDiff))
	}
}

// Utility methods

func (m *Manager) calculateShareValue(difficulty float64) float64 {
	// Simple PPS (Pay Per Share) calculation
	// This would be more complex in production
	return difficulty * m.config.ShareValue
}

func (m *Manager) calculateEfficiency() float64 {
	total := m.stats.TotalShares.Load()
	if total == 0 {
		return 0
	}
	
	valid := m.stats.ValidShares.Load()
	return float64(valid) / float64(total) * 100
}

func (m *Manager) saveWorkerStates() {
	if m.db == nil {
		return
	}
	
	m.workersMu.RLock()
	defer m.workersMu.RUnlock()
	
	for _, worker := range m.workers {
		m.db.Workers.UpdateStats(
			worker.ID,
			float64(worker.HashRate.Load()),
			int64(worker.SharesAccepted.Load()),
			int64(worker.SharesStale.Load()),
			int64(worker.SharesRejected.Load()),
		)
	}
}

// API Setup

func (m *Manager) setupAPI() {
	m.apiRouter = mux.NewRouter()
	api := &WorkerAPI{manager: m, logger: m.logger}
	
	// API routes
	m.apiRouter.HandleFunc("/api/workers", api.GetWorkers).Methods("GET")
	m.apiRouter.HandleFunc("/api/workers/{id}", api.GetWorker).Methods("GET")
	m.apiRouter.HandleFunc("/api/workers", api.RegisterWorker).Methods("POST")
	m.apiRouter.HandleFunc("/api/workers/{id}", api.UpdateWorker).Methods("PUT")
	m.apiRouter.HandleFunc("/api/workers/{id}", api.DeleteWorker).Methods("DELETE")
	m.apiRouter.HandleFunc("/api/workers/{id}/stats", api.GetWorkerStats).Methods("GET")
	m.apiRouter.HandleFunc("/api/statistics", api.GetStatistics).Methods("GET")
	
	m.apiServer = &http.Server{
		Addr:    m.config.APIAddr,
		Handler: m.apiRouter,
	}
}

func (m *Manager) startAPI() {
	defer m.wg.Done()
	
	m.logger.Info("Starting worker API", zap.String("addr", m.config.APIAddr))
	if err := m.apiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		m.logger.Error("API server error", zap.Error(err))
	}
}

// API Handlers

func (api *WorkerAPI) GetWorkers(w http.ResponseWriter, r *http.Request) {
	workers := api.manager.GetAllWorkers()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(workers)
}

func (api *WorkerAPI) GetWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	
	worker, err := api.manager.GetWorker(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(worker)
}

func (api *WorkerAPI) RegisterWorker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Wallet string `json:"wallet"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	worker, err := api.manager.RegisterWorker(req.ID, req.Name, req.Wallet)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(worker)
}

func (api *WorkerAPI) UpdateWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	
	var config WorkerConfig
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	
	worker, err := api.manager.GetWorker(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	
	worker.Config = config
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(worker)
}

func (api *WorkerAPI) DeleteWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	
	api.manager.workersMu.Lock()
	delete(api.manager.workers, id)
	api.manager.workersMu.Unlock()
	
	w.WriteHeader(http.StatusNoContent)
}

func (api *WorkerAPI) GetWorkerStats(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	
	worker, err := api.manager.GetWorker(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	
	stats := map[string]interface{}{
		"hashrate":         worker.HashRate.Load(),
		"shares_submitted": worker.SharesSubmitted.Load(),
		"shares_accepted":  worker.SharesAccepted.Load(),
		"shares_rejected":  worker.SharesRejected.Load(),
		"efficiency":       float64(worker.SharesAccepted.Load()) / float64(worker.SharesSubmitted.Load()+1) * 100,
		"unpaid_balance":   worker.UnpaidBalance,
		"total_earnings":   worker.TotalEarnings,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func (api *WorkerAPI) GetStatistics(w http.ResponseWriter, r *http.Request) {
	stats := api.manager.GetStatistics()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}