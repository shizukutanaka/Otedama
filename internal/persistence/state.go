package persistence

import (
	"compress/gzip"
	"context"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// StateManager manages application state persistence
type StateManager struct {
	dataDir      string
	saveInterval time.Duration
	
	// State storage
	states       map[string]interface{}
	statesMu     sync.RWMutex
	
	// Checkpoint management
	checkpoints  []*Checkpoint
	checkpointMu sync.RWMutex
	
	// Statistics
	saveCount    atomic.Uint64
	loadCount    atomic.Uint64
	lastSave     atomic.Value // time.Time
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Checkpoint represents a state checkpoint
type Checkpoint struct {
	ID        string
	Timestamp time.Time
	States    map[string]json.RawMessage
	Metadata  map[string]interface{}
}

// StateConfig holds state manager configuration
type StateConfig struct {
	DataDir        string
	SaveInterval   time.Duration
	MaxCheckpoints int
	Compression    bool
}

// DefaultStateConfig returns default configuration
func DefaultStateConfig() *StateConfig {
	return &StateConfig{
		DataDir:        "./data/state",
		SaveInterval:   30 * time.Second,
		MaxCheckpoints: 10,
		Compression:    true,
	}
}

// NewStateManager creates a new state manager
func NewStateManager(config *StateConfig) (*StateManager, error) {
	if config == nil {
		config = DefaultStateConfig()
	}
	
	// Create data directory
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data dir: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	sm := &StateManager{
		dataDir:      config.DataDir,
		saveInterval: config.SaveInterval,
		states:       make(map[string]interface{}),
		checkpoints:  make([]*Checkpoint, 0),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Load existing state
	if err := sm.LoadLatest(); err != nil && !os.IsNotExist(err) {
		cancel()
		return nil, fmt.Errorf("failed to load state: %w", err)
	}
	
	// Start auto-save routine
	sm.wg.Add(1)
	go sm.autoSaveRoutine()
	
	return sm, nil
}

// Set sets a state value
func (sm *StateManager) Set(key string, value interface{}) {
	sm.statesMu.Lock()
	defer sm.statesMu.Unlock()
	sm.states[key] = value
}

// Get gets a state value
func (sm *StateManager) Get(key string) (interface{}, bool) {
	sm.statesMu.RLock()
	defer sm.statesMu.RUnlock()
	val, exists := sm.states[key]
	return val, exists
}

// GetString gets a string state value
func (sm *StateManager) GetString(key string) (string, bool) {
	val, exists := sm.Get(key)
	if !exists {
		return "", false
	}
	str, ok := val.(string)
	return str, ok
}

// GetInt gets an integer state value
func (sm *StateManager) GetInt(key string) (int, bool) {
	val, exists := sm.Get(key)
	if !exists {
		return 0, false
	}
	i, ok := val.(int)
	return i, ok
}

// Delete removes a state value
func (sm *StateManager) Delete(key string) {
	sm.statesMu.Lock()
	defer sm.statesMu.Unlock()
	delete(sm.states, key)
}

// Save saves current state to disk
func (sm *StateManager) Save() error {
	sm.statesMu.RLock()
	defer sm.statesMu.RUnlock()
	
	// Create checkpoint
	checkpoint := &Checkpoint{
		ID:        generateCheckpointID(),
		Timestamp: time.Now(),
		States:    make(map[string]json.RawMessage),
		Metadata: map[string]interface{}{
			"version": "1.0",
			"app":     "Otedama",
		},
	}
	
	// Serialize states
	for key, value := range sm.states {
		data, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("failed to marshal %s: %w", key, err)
		}
		checkpoint.States[key] = data
	}
	
	// Save checkpoint
	if err := sm.saveCheckpoint(checkpoint); err != nil {
		return err
	}
	
	sm.saveCount.Add(1)
	sm.lastSave.Store(time.Now())
	
	// Add to checkpoints list
	sm.checkpointMu.Lock()
	sm.checkpoints = append(sm.checkpoints, checkpoint)
	
	// Cleanup old checkpoints
	if len(sm.checkpoints) > 10 {
		sm.checkpoints = sm.checkpoints[len(sm.checkpoints)-10:]
	}
	sm.checkpointMu.Unlock()
	
	return nil
}

// saveCheckpoint saves checkpoint to file
func (sm *StateManager) saveCheckpoint(checkpoint *Checkpoint) error {
	filename := filepath.Join(sm.dataDir, fmt.Sprintf("checkpoint_%s.dat", checkpoint.ID))
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Use compression
	var writer io.Writer = file
	gzWriter := gzip.NewWriter(file)
	defer gzWriter.Close()
	writer = gzWriter
	
	// Encode checkpoint
	encoder := gob.NewEncoder(writer)
	if err := encoder.Encode(checkpoint); err != nil {
		return err
	}
	
	return nil
}

// LoadLatest loads the latest checkpoint
func (sm *StateManager) LoadLatest() error {
	// Find latest checkpoint file
	files, err := filepath.Glob(filepath.Join(sm.dataDir, "checkpoint_*.dat"))
	if err != nil {
		return err
	}
	
	if len(files) == 0 {
		return os.ErrNotExist
	}
	
	// Load most recent file
	latestFile := files[len(files)-1]
	return sm.LoadFromFile(latestFile)
}

// LoadFromFile loads state from file
func (sm *StateManager) LoadFromFile(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Use decompression
	var reader io.Reader = file
	gzReader, err := gzip.NewReader(file)
	if err == nil {
		defer gzReader.Close()
		reader = gzReader
	}
	
	// Decode checkpoint
	var checkpoint Checkpoint
	decoder := gob.NewDecoder(reader)
	if err := decoder.Decode(&checkpoint); err != nil {
		return err
	}
	
	// Restore states
	sm.statesMu.Lock()
	defer sm.statesMu.Unlock()
	
	for key, data := range checkpoint.States {
		var value interface{}
		if err := json.Unmarshal(data, &value); err != nil {
			continue // Skip invalid entries
		}
		sm.states[key] = value
	}
	
	sm.loadCount.Add(1)
	
	return nil
}

// CreateSnapshot creates a named snapshot
func (sm *StateManager) CreateSnapshot(name string) error {
	sm.statesMu.RLock()
	defer sm.statesMu.RUnlock()
	
	snapshot := make(map[string]interface{})
	for k, v := range sm.states {
		snapshot[k] = v
	}
	
	// Save snapshot
	filename := filepath.Join(sm.dataDir, fmt.Sprintf("snapshot_%s.json", name))
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(snapshot)
}

// RestoreSnapshot restores from a named snapshot
func (sm *StateManager) RestoreSnapshot(name string) error {
	filename := filepath.Join(sm.dataDir, fmt.Sprintf("snapshot_%s.json", name))
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	var snapshot map[string]interface{}
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&snapshot); err != nil {
		return err
	}
	
	sm.statesMu.Lock()
	defer sm.statesMu.Unlock()
	
	sm.states = snapshot
	
	return nil
}

// autoSaveRoutine periodically saves state
func (sm *StateManager) autoSaveRoutine() {
	defer sm.wg.Done()
	
	ticker := time.NewTicker(sm.saveInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if err := sm.Save(); err != nil {
				// Log error
				_ = err
			}
			
		case <-sm.ctx.Done():
			// Final save before shutdown
			sm.Save()
			return
		}
	}
}

// Close closes the state manager
func (sm *StateManager) Close() error {
	sm.cancel()
	sm.wg.Wait()
	
	// Final save
	return sm.Save()
}

// GetStatistics returns state manager statistics
func (sm *StateManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["save_count"] = sm.saveCount.Load()
	stats["load_count"] = sm.loadCount.Load()
	
	if lastSave := sm.lastSave.Load(); lastSave != nil {
		stats["last_save"] = lastSave.(time.Time)
	}
	
	sm.statesMu.RLock()
	stats["state_count"] = len(sm.states)
	sm.statesMu.RUnlock()
	
	sm.checkpointMu.RLock()
	stats["checkpoint_count"] = len(sm.checkpoints)
	sm.checkpointMu.RUnlock()
	
	return stats
}

// generateCheckpointID generates a unique checkpoint ID
func generateCheckpointID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// TransactionalState provides transactional state updates
type TransactionalState struct {
	manager      *StateManager
	transaction  map[string]interface{}
	inTransaction bool
	mu           sync.Mutex
}

// NewTransactionalState creates transactional state wrapper
func NewTransactionalState(manager *StateManager) *TransactionalState {
	return &TransactionalState{
		manager:     manager,
		transaction: make(map[string]interface{}),
	}
}

// Begin starts a transaction
func (ts *TransactionalState) Begin() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	
	if ts.inTransaction {
		return errors.New("transaction already in progress")
	}
	
	ts.inTransaction = true
	ts.transaction = make(map[string]interface{})
	return nil
}

// Set sets a value in transaction
func (ts *TransactionalState) Set(key string, value interface{}) error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	
	if !ts.inTransaction {
		return errors.New("no transaction in progress")
	}
	
	ts.transaction[key] = value
	return nil
}

// Commit commits the transaction
func (ts *TransactionalState) Commit() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	
	if !ts.inTransaction {
		return errors.New("no transaction in progress")
	}
	
	// Apply all changes
	for key, value := range ts.transaction {
		ts.manager.Set(key, value)
	}
	
	ts.inTransaction = false
	ts.transaction = make(map[string]interface{})
	
	return nil
}

// Rollback rolls back the transaction
func (ts *TransactionalState) Rollback() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	
	if !ts.inTransaction {
		return errors.New("no transaction in progress")
	}
	
	ts.inTransaction = false
	ts.transaction = make(map[string]interface{})
	
	return nil
}

// WAL provides write-ahead logging
type WAL struct {
	file     *os.File
	encoder  *json.Encoder
	mu       sync.Mutex
}

// NewWAL creates a new write-ahead log
func NewWAL(filename string) (*WAL, error) {
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	
	return &WAL{
		file:    file,
		encoder: json.NewEncoder(file),
	}, nil
}

// LogEntry represents a WAL entry
type LogEntry struct {
	Timestamp time.Time              `json:"timestamp"`
	Operation string                 `json:"operation"`
	Key       string                 `json:"key"`
	Value     interface{}            `json:"value,omitempty"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// Append appends an entry to the log
func (w *WAL) Append(entry *LogEntry) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	entry.Timestamp = time.Now()
	return w.encoder.Encode(entry)
}

// Close closes the WAL
func (w *WAL) Close() error {
	return w.file.Close()
}

// Replay replays WAL entries
func ReplayWAL(filename string, handler func(*LogEntry) error) error {
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	decoder := json.NewDecoder(file)
	for {
		var entry LogEntry
		if err := decoder.Decode(&entry); err != nil {
			if err == io.EOF {
				break
			}
			return err
		}
		
		if err := handler(&entry); err != nil {
			return err
		}
	}
	
	return nil
}