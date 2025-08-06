package optimization

import (
	"context"
	"fmt"
	"hash/fnv"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ShardingManager manages data sharding for horizontal scalability
type ShardingManager struct {
	logger     *zap.Logger
	shards     []*Shard
	numShards  int
	hashFunc   HashFunc
	rebalancer *Rebalancer
	metrics    *ShardingMetrics
	mu         sync.RWMutex
}

// Shard represents a single data shard
type Shard struct {
	ID         uint32
	Primary    string
	Replicas   []string
	State      ShardState
	Load       atomic.Int64
	DataSize   atomic.Int64
	LastAccess atomic.Int64
	mu         sync.RWMutex
}

// ShardState represents the state of a shard
type ShardState int

const (
	ShardStateActive ShardState = iota
	ShardStateMigrating
	ShardStateSplitting
	ShardStateMerging
	ShardStateOffline
)

// HashFunc is a function that hashes a key to determine shard
type HashFunc func(key string) uint32

// ShardingConfig contains sharding configuration
type ShardingConfig struct {
	NumShards          int
	ReplicationFactor  int
	MaxShardSize       int64 // bytes
	MinShardSize       int64 // bytes
	RebalanceInterval  time.Duration
	LoadBalanceEnabled bool
}

// ShardingMetrics tracks sharding performance metrics
type ShardingMetrics struct {
	TotalRequests    atomic.Uint64
	ShardHits        []*atomic.Uint64
	RebalanceCount   atomic.Uint64
	MigrationCount   atomic.Uint64
	SplitCount       atomic.Uint64
	MergeCount       atomic.Uint64
	LoadImbalance    atomic.Value // float64
	AvgResponseTime  atomic.Value // time.Duration
}

// NewShardingManager creates a new sharding manager
func NewShardingManager(logger *zap.Logger, config ShardingConfig) *ShardingManager {
	sm := &ShardingManager{
		logger:    logger,
		numShards: config.NumShards,
		hashFunc:  defaultHashFunc,
		shards:    make([]*Shard, config.NumShards),
		metrics:   &ShardingMetrics{},
	}

	// Initialize shards
	for i := 0; i < config.NumShards; i++ {
		sm.shards[i] = &Shard{
			ID:       uint32(i),
			State:    ShardStateActive,
			Primary:  fmt.Sprintf("node-%d", i%3), // Example: 3 primary nodes
			Replicas: []string{fmt.Sprintf("node-%d", (i+1)%3), fmt.Sprintf("node-%d", (i+2)%3)},
		}
	}

	// Initialize metrics
	sm.metrics.ShardHits = make([]*atomic.Uint64, config.NumShards)
	for i := range sm.metrics.ShardHits {
		sm.metrics.ShardHits[i] = &atomic.Uint64{}
	}

	// Start rebalancer if enabled
	if config.LoadBalanceEnabled {
		sm.rebalancer = NewRebalancer(logger, sm, config)
		go sm.rebalancer.Start(context.Background())
	}

	return sm
}

// GetShard returns the shard for a given key
func (sm *ShardingManager) GetShard(key string) (*Shard, error) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	hash := sm.hashFunc(key)
	shardID := hash % uint32(sm.numShards)

	if shardID >= uint32(len(sm.shards)) {
		return nil, fmt.Errorf("shard %d not found", shardID)
	}

	shard := sm.shards[shardID]
	
	// Update metrics
	sm.metrics.TotalRequests.Add(1)
	sm.metrics.ShardHits[shardID].Add(1)
	shard.Load.Add(1)
	shard.LastAccess.Store(time.Now().Unix())

	return shard, nil
}

// ConsistentHash implements consistent hashing for dynamic sharding
type ConsistentHash struct {
	circle     map[uint32]string
	keys       []uint32
	vnodes     int
	mu         sync.RWMutex
}

// NewConsistentHash creates a new consistent hash ring
func NewConsistentHash(vnodes int) *ConsistentHash {
	return &ConsistentHash{
		circle: make(map[uint32]string),
		vnodes: vnodes,
	}
}

// Add adds a node to the consistent hash ring
func (ch *ConsistentHash) Add(node string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()

	for i := 0; i < ch.vnodes; i++ {
		hash := ch.hash(fmt.Sprintf("%s:%d", node, i))
		ch.circle[hash] = node
		ch.keys = append(ch.keys, hash)
	}

	// Sort keys for binary search
	ch.sortKeys()
}

// Get returns the node responsible for a key
func (ch *ConsistentHash) Get(key string) string {
	ch.mu.RLock()
	defer ch.mu.RUnlock()

	if len(ch.circle) == 0 {
		return ""
	}

	hash := ch.hash(key)
	
	// Binary search for the first node with hash >= key hash
	idx := ch.search(hash)
	if idx >= len(ch.keys) {
		idx = 0
	}

	return ch.circle[ch.keys[idx]]
}

// Rebalancer handles automatic shard rebalancing
type Rebalancer struct {
	logger  *zap.Logger
	sm      *ShardingManager
	config  ShardingConfig
	running atomic.Bool
}

// NewRebalancer creates a new rebalancer
func NewRebalancer(logger *zap.Logger, sm *ShardingManager, config ShardingConfig) *Rebalancer {
	return &Rebalancer{
		logger: logger,
		sm:     sm,
		config: config,
	}
}

// Start starts the rebalancer
func (r *Rebalancer) Start(ctx context.Context) {
	if !r.running.CompareAndSwap(false, true) {
		return
	}

	ticker := time.NewTicker(r.config.RebalanceInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.running.Store(false)
			return
		case <-ticker.C:
			r.rebalance()
		}
	}
}

// rebalance performs load balancing across shards
func (r *Rebalancer) rebalance() {
	r.sm.mu.Lock()
	defer r.sm.mu.Unlock()

	// Calculate load statistics
	var totalLoad int64
	loads := make([]int64, len(r.sm.shards))
	
	for i, shard := range r.sm.shards {
		loads[i] = shard.Load.Load()
		totalLoad += loads[i]
	}

	if totalLoad == 0 {
		return
	}

	avgLoad := totalLoad / int64(len(r.sm.shards))
	threshold := float64(avgLoad) * 0.2 // 20% threshold

	// Find overloaded and underloaded shards
	var overloaded, underloaded []*Shard
	
	for i, shard := range r.sm.shards {
		load := float64(loads[i])
		if load > float64(avgLoad)+threshold {
			overloaded = append(overloaded, shard)
		} else if load < float64(avgLoad)-threshold {
			underloaded = append(underloaded, shard)
		}
	}

	// Perform migrations if needed
	if len(overloaded) > 0 && len(underloaded) > 0 {
		r.logger.Info("Rebalancing shards",
			zap.Int("overloaded", len(overloaded)),
			zap.Int("underloaded", len(underloaded)),
		)

		// Simple migration strategy: move data from most loaded to least loaded
		// In production, this would involve actual data migration
		r.sm.metrics.RebalanceCount.Add(1)
	}

	// Check for splits and merges
	for _, shard := range r.sm.shards {
		size := shard.DataSize.Load()
		
		if size > r.config.MaxShardSize && shard.State == ShardStateActive {
			r.splitShard(shard)
		} else if size < r.config.MinShardSize && shard.State == ShardStateActive {
			r.mergeShard(shard)
		}
	}
}

// splitShard splits a shard that has grown too large
func (r *Rebalancer) splitShard(shard *Shard) {
	shard.mu.Lock()
	defer shard.mu.Unlock()

	if shard.State != ShardStateActive {
		return
	}

	shard.State = ShardStateSplitting
	r.sm.metrics.SplitCount.Add(1)

	r.logger.Info("Splitting shard",
		zap.Uint32("shard_id", shard.ID),
		zap.Int64("size", shard.DataSize.Load()),
	)

	// In production, this would:
	// 1. Create new shard
	// 2. Migrate half the data
	// 3. Update routing table
	// 4. Mark old shard as split

	// Simulate split completion
	go func() {
		time.Sleep(5 * time.Second)
		shard.mu.Lock()
		shard.State = ShardStateActive
		shard.DataSize.Store(shard.DataSize.Load() / 2)
		shard.mu.Unlock()
	}()
}

// mergeShard merges a shard that has become too small
func (r *Rebalancer) mergeShard(shard *Shard) {
	shard.mu.Lock()
	defer shard.mu.Unlock()

	if shard.State != ShardStateActive {
		return
	}

	shard.State = ShardStateMerging
	r.sm.metrics.MergeCount.Add(1)

	r.logger.Info("Merging shard",
		zap.Uint32("shard_id", shard.ID),
		zap.Int64("size", shard.DataSize.Load()),
	)

	// In production, this would:
	// 1. Find suitable merge target
	// 2. Migrate all data
	// 3. Update routing table
	// 4. Decommission old shard
}

// Helper functions

func defaultHashFunc(key string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(key))
	return h.Sum32()
}

func (ch *ConsistentHash) hash(key string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(key))
	return h.Sum32()
}

func (ch *ConsistentHash) sortKeys() {
	// Simple bubble sort for demonstration
	// Use sort.Slice in production
	n := len(ch.keys)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			if ch.keys[j] > ch.keys[j+1] {
				ch.keys[j], ch.keys[j+1] = ch.keys[j+1], ch.keys[j]
			}
		}
	}
}

func (ch *ConsistentHash) search(hash uint32) int {
	// Binary search implementation
	left, right := 0, len(ch.keys)-1
	
	for left <= right {
		mid := (left + right) / 2
		if ch.keys[mid] == hash {
			return mid
		}
		if ch.keys[mid] < hash {
			left = mid + 1
		} else {
			right = mid - 1
		}
	}
	
	return left
}

// GetMetrics returns current sharding metrics
func (sm *ShardingManager) GetMetrics() map[string]interface{} {
	metrics := make(map[string]interface{})
	
	metrics["total_requests"] = sm.metrics.TotalRequests.Load()
	metrics["rebalance_count"] = sm.metrics.RebalanceCount.Load()
	metrics["migration_count"] = sm.metrics.MigrationCount.Load()
	metrics["split_count"] = sm.metrics.SplitCount.Load()
	metrics["merge_count"] = sm.metrics.MergeCount.Load()
	
	// Calculate load distribution
	var loads []int64
	for _, shard := range sm.shards {
		loads = append(loads, shard.Load.Load())
	}
	metrics["shard_loads"] = loads
	
	return metrics
}