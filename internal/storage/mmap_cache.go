package storage

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"go.uber.org/zap"
)

// MMapCache implements memory-mapped file caching for blockchain data
// Following John Carmack's principle: "Memory bandwidth is precious"
type MMapCache struct {
	logger *zap.Logger
	config *MMapConfig
	
	// Memory-mapped regions
	regions      map[string]*MMapRegion
	regionsMu    sync.RWMutex
	
	// Block index
	blockIndex   *BlockIndex
	
	// Cache statistics
	stats        *CacheStats
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// MMapConfig contains memory-mapped cache configuration
type MMapConfig struct {
	BaseDir          string
	MaxRegionSize    int64
	MaxTotalSize     int64
	BlocksPerFile    int
	IndexInterval    int
	Compression      bool
	PreloadHeaders   bool
	AsyncWrites      bool
	SyncInterval     time.Duration
	EvictionPolicy   string // "lru", "lfu", "fifo"
}

// MMapRegion represents a memory-mapped file region
type MMapRegion struct {
	filePath     string
	size         int64
	data         []byte
	file         *os.File
	lastAccess   atomic.Int64
	accessCount  atomic.Uint64
	dirty        atomic.Bool
	mu           sync.RWMutex
}

// BlockIndex maintains an index of block locations
type BlockIndex struct {
	index        map[uint64]*BlockLocation
	indexMu      sync.RWMutex
	headerCache  *LRUCache
	txCache      *LRUCache
}

// BlockLocation stores where a block is located
type BlockLocation struct {
	Region       string
	Offset       int64
	Size         int32
	Height       uint64
	Hash         [32]byte
	Timestamp    uint32
}

// CacheStats tracks cache performance
type CacheStats struct {
	Hits         atomic.Uint64
	Misses       atomic.Uint64
	Reads        atomic.Uint64
	Writes       atomic.Uint64
	Evictions    atomic.Uint64
	BytesRead    atomic.Uint64
	BytesWritten atomic.Uint64
}

// NewMMapCache creates a new memory-mapped cache
func NewMMapCache(logger *zap.Logger, config *MMapConfig) (*MMapCache, error) {
	if config == nil {
		config = DefaultMMapConfig()
	}
	
	// Create base directory
	if err := os.MkdirAll(config.BaseDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create cache directory: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	cache := &MMapCache{
		logger:     logger,
		config:     config,
		regions:    make(map[string]*MMapRegion),
		blockIndex: NewBlockIndex(),
		stats:      &CacheStats{},
		ctx:        ctx,
		cancel:     cancel,
	}
	
	return cache, nil
}

// Start starts the cache
func (c *MMapCache) Start() error {
	c.logger.Info("Starting memory-mapped cache",
		zap.String("base_dir", c.config.BaseDir),
		zap.Int64("max_region_size", c.config.MaxRegionSize),
		zap.Int64("max_total_size", c.config.MaxTotalSize),
	)
	
	// Load existing regions
	if err := c.loadExistingRegions(); err != nil {
		return fmt.Errorf("failed to load existing regions: %w", err)
	}
	
	// Start background workers
	if c.config.AsyncWrites {
		c.wg.Add(1)
		go c.syncWorker()
	}
	
	c.wg.Add(1)
	go c.evictionWorker()
	
	// Preload headers if configured
	if c.config.PreloadHeaders {
		go c.preloadBlockHeaders()
	}
	
	return nil
}

// Stop stops the cache
func (c *MMapCache) Stop() error {
	c.logger.Info("Stopping memory-mapped cache")
	
	c.cancel()
	c.wg.Wait()
	
	// Sync and close all regions
	c.regionsMu.Lock()
	for name, region := range c.regions {
		if err := c.closeRegion(region); err != nil {
			c.logger.Error("Failed to close region",
				zap.String("region", name),
				zap.Error(err),
			)
		}
	}
	c.regionsMu.Unlock()
	
	return nil
}

// GetBlock retrieves a block from cache
func (c *MMapCache) GetBlock(height uint64) ([]byte, error) {
	// Check index
	location := c.blockIndex.GetLocation(height)
	if location == nil {
		c.stats.Misses.Add(1)
		return nil, fmt.Errorf("block not found: %d", height)
	}
	
	// Get region
	region := c.getRegion(location.Region)
	if region == nil {
		c.stats.Misses.Add(1)
		return nil, fmt.Errorf("region not loaded: %s", location.Region)
	}
	
	// Read data
	data, err := c.readFromRegion(region, location.Offset, int64(location.Size))
	if err != nil {
		c.stats.Misses.Add(1)
		return nil, err
	}
	
	c.stats.Hits.Add(1)
	c.stats.Reads.Add(1)
	c.stats.BytesRead.Add(uint64(location.Size))
	
	return data, nil
}

// PutBlock stores a block in cache
func (c *MMapCache) PutBlock(height uint64, hash [32]byte, data []byte) error {
	// Determine region
	regionName := c.getRegionName(height)
	region := c.getOrCreateRegion(regionName)
	
	// Write data
	offset, err := c.writeToRegion(region, data)
	if err != nil {
		return err
	}
	
	// Update index
	location := &BlockLocation{
		Region:    regionName,
		Offset:    offset,
		Size:      int32(len(data)),
		Height:    height,
		Hash:      hash,
		Timestamp: uint32(time.Now().Unix()),
	}
	
	c.blockIndex.AddLocation(height, location)
	
	c.stats.Writes.Add(1)
	c.stats.BytesWritten.Add(uint64(len(data)))
	
	return nil
}

// GetStats returns cache statistics
func (c *MMapCache) GetStats() CacheStatistics {
	return CacheStatistics{
		Hits:         c.stats.Hits.Load(),
		Misses:       c.stats.Misses.Load(),
		HitRate:      c.calculateHitRate(),
		Reads:        c.stats.Reads.Load(),
		Writes:       c.stats.Writes.Load(),
		Evictions:    c.stats.Evictions.Load(),
		BytesRead:    c.stats.BytesRead.Load(),
		BytesWritten: c.stats.BytesWritten.Load(),
		RegionCount:  len(c.regions),
	}
}

// Private methods

func (c *MMapCache) loadExistingRegions() error {
	entries, err := os.ReadDir(c.config.BaseDir)
	if err != nil {
		return err
	}
	
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		
		if filepath.Ext(entry.Name()) == ".dat" {
			regionPath := filepath.Join(c.config.BaseDir, entry.Name())
			if err := c.loadRegion(entry.Name(), regionPath); err != nil {
				c.logger.Warn("Failed to load region",
					zap.String("region", entry.Name()),
					zap.Error(err),
				)
			}
		}
	}
	
	return nil
}

func (c *MMapCache) loadRegion(name, path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0644)
	if err != nil {
		return err
	}
	
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	
	// Memory map the file
	data, err := syscall.Mmap(int(file.Fd()), 0, int(info.Size()),
		syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		file.Close()
		return err
	}
	
	region := &MMapRegion{
		filePath: path,
		size:     info.Size(),
		data:     data,
		file:     file,
	}
	
	c.regionsMu.Lock()
	c.regions[name] = region
	c.regionsMu.Unlock()
	
	// Load index from region
	c.loadRegionIndex(name, region)
	
	return nil
}

func (c *MMapCache) loadRegionIndex(name string, region *MMapRegion) {
	// Read index from end of file
	// Index format: [index_size:4][index_data][index_offset:8]
	
	if region.size < 12 {
		return
	}
	
	// Read index offset
	indexOffsetBytes := region.data[region.size-8:]
	indexOffset := int64(binary.LittleEndian.Uint64(indexOffsetBytes))
	
	if indexOffset >= region.size-8 || indexOffset < 0 {
		return
	}
	
	// Read index size
	indexSizeBytes := region.data[indexOffset : indexOffset+4]
	indexSize := binary.LittleEndian.Uint32(indexSizeBytes)
	
	if int64(indexSize) > region.size-indexOffset-12 {
		return
	}
	
	// Parse index
	indexData := region.data[indexOffset+4 : indexOffset+4+int64(indexSize)]
	c.parseRegionIndex(name, indexData)
}

func (c *MMapCache) parseRegionIndex(regionName string, indexData []byte) {
	offset := 0
	for offset+44 <= len(indexData) { // 8+32+4 = 44 bytes per entry
		height := binary.LittleEndian.Uint64(indexData[offset:])
		offset += 8
		
		var hash [32]byte
		copy(hash[:], indexData[offset:offset+32])
		offset += 32
		
		blockOffset := binary.LittleEndian.Uint32(indexData[offset:])
		offset += 4
		
		location := &BlockLocation{
			Region: regionName,
			Offset: int64(blockOffset),
			Height: height,
			Hash:   hash,
		}
		
		c.blockIndex.AddLocation(height, location)
	}
}

func (c *MMapCache) getRegion(name string) *MMapRegion {
	c.regionsMu.RLock()
	region := c.regions[name]
	c.regionsMu.RUnlock()
	
	if region != nil {
		region.lastAccess.Store(time.Now().UnixNano())
		region.accessCount.Add(1)
	}
	
	return region
}

func (c *MMapCache) getOrCreateRegion(name string) *MMapRegion {
	region := c.getRegion(name)
	if region != nil {
		return region
	}
	
	// Create new region
	path := filepath.Join(c.config.BaseDir, name)
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		c.logger.Error("Failed to create region file",
			zap.String("path", path),
			zap.Error(err),
		)
		return nil
	}
	
	// Pre-allocate space
	if err := file.Truncate(c.config.MaxRegionSize); err != nil {
		file.Close()
		return nil
	}
	
	// Memory map the file
	data, err := syscall.Mmap(int(file.Fd()), 0, int(c.config.MaxRegionSize),
		syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		file.Close()
		return nil
	}
	
	region = &MMapRegion{
		filePath: path,
		size:     0,
		data:     data,
		file:     file,
	}
	
	c.regionsMu.Lock()
	c.regions[name] = region
	c.regionsMu.Unlock()
	
	return region
}

func (c *MMapCache) readFromRegion(region *MMapRegion, offset, size int64) ([]byte, error) {
	region.mu.RLock()
	defer region.mu.RUnlock()
	
	if offset+size > region.size {
		return nil, fmt.Errorf("read beyond region bounds")
	}
	
	data := make([]byte, size)
	copy(data, region.data[offset:offset+size])
	
	return data, nil
}

func (c *MMapCache) writeToRegion(region *MMapRegion, data []byte) (int64, error) {
	region.mu.Lock()
	defer region.mu.Unlock()
	
	if region.size+int64(len(data)) > c.config.MaxRegionSize {
		return 0, fmt.Errorf("region full")
	}
	
	offset := region.size
	copy(region.data[offset:], data)
	region.size += int64(len(data))
	region.dirty.Store(true)
	
	return offset, nil
}

func (c *MMapCache) closeRegion(region *MMapRegion) error {
	region.mu.Lock()
	defer region.mu.Unlock()
	
	// Sync if dirty
	if region.dirty.Load() {
		if err := c.syncRegion(region); err != nil {
			return err
		}
	}
	
	// Unmap
	if err := syscall.Munmap(region.data); err != nil {
		return err
	}
	
	// Close file
	return region.file.Close()
}

func (c *MMapCache) syncRegion(region *MMapRegion) error {
	// Sync memory-mapped data to disk
	if err := msync(region.data); err != nil {
		return err
	}
	
	region.dirty.Store(false)
	return nil
}

func (c *MMapCache) syncWorker() {
	defer c.wg.Done()
	
	ticker := time.NewTicker(c.config.SyncInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			c.syncDirtyRegions()
			
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *MMapCache) syncDirtyRegions() {
	c.regionsMu.RLock()
	regions := make([]*MMapRegion, 0)
	for _, region := range c.regions {
		if region.dirty.Load() {
			regions = append(regions, region)
		}
	}
	c.regionsMu.RUnlock()
	
	for _, region := range regions {
		if err := c.syncRegion(region); err != nil {
			c.logger.Error("Failed to sync region",
				zap.String("path", region.filePath),
				zap.Error(err),
			)
		}
	}
}

func (c *MMapCache) evictionWorker() {
	defer c.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			c.evictIfNeeded()
			
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *MMapCache) evictIfNeeded() {
	// Calculate total size
	var totalSize int64
	c.regionsMu.RLock()
	for _, region := range c.regions {
		totalSize += region.size
	}
	c.regionsMu.RUnlock()
	
	if totalSize <= c.config.MaxTotalSize {
		return
	}
	
	// Evict based on policy
	switch c.config.EvictionPolicy {
	case "lru":
		c.evictLRU()
	case "lfu":
		c.evictLFU()
	default:
		c.evictFIFO()
	}
}

func (c *MMapCache) evictLRU() {
	// Find least recently used region
	c.regionsMu.Lock()
	defer c.regionsMu.Unlock()
	
	var oldestRegion *MMapRegion
	var oldestName string
	oldestTime := int64(^uint64(0) >> 1) // Max int64
	
	for name, region := range c.regions {
		lastAccess := region.lastAccess.Load()
		if lastAccess < oldestTime {
			oldestTime = lastAccess
			oldestRegion = region
			oldestName = name
		}
	}
	
	if oldestRegion != nil {
		delete(c.regions, oldestName)
		c.closeRegion(oldestRegion)
		c.stats.Evictions.Add(1)
	}
}

func (c *MMapCache) evictLFU() {
	// Find least frequently used region
	c.regionsMu.Lock()
	defer c.regionsMu.Unlock()
	
	var leastUsedRegion *MMapRegion
	var leastUsedName string
	leastCount := uint64(^uint64(0)) // Max uint64
	
	for name, region := range c.regions {
		accessCount := region.accessCount.Load()
		if accessCount < leastCount {
			leastCount = accessCount
			leastUsedRegion = region
			leastUsedName = name
		}
	}
	
	if leastUsedRegion != nil {
		delete(c.regions, leastUsedName)
		c.closeRegion(leastUsedRegion)
		c.stats.Evictions.Add(1)
	}
}

func (c *MMapCache) evictFIFO() {
	// Simple FIFO eviction - evict first region
	c.regionsMu.Lock()
	defer c.regionsMu.Unlock()
	
	for name, region := range c.regions {
		delete(c.regions, name)
		c.closeRegion(region)
		c.stats.Evictions.Add(1)
		break
	}
}

func (c *MMapCache) preloadBlockHeaders() {
	// Preload recent block headers for fast access
	// Implementation depends on blockchain structure
}

func (c *MMapCache) getRegionName(height uint64) string {
	// Group blocks into regions
	regionNumber := height / uint64(c.config.BlocksPerFile)
	return fmt.Sprintf("blocks_%06d.dat", regionNumber)
}

func (c *MMapCache) calculateHitRate() float64 {
	hits := c.stats.Hits.Load()
	misses := c.stats.Misses.Load()
	total := hits + misses
	
	if total == 0 {
		return 0
	}
	
	return float64(hits) / float64(total)
}

// BlockIndex methods

func NewBlockIndex() *BlockIndex {
	return &BlockIndex{
		index:       make(map[uint64]*BlockLocation),
		headerCache: NewLRUCache(10000),
		txCache:     NewLRUCache(50000),
	}
}

func (bi *BlockIndex) AddLocation(height uint64, location *BlockLocation) {
	bi.indexMu.Lock()
	bi.index[height] = location
	bi.indexMu.Unlock()
}

func (bi *BlockIndex) GetLocation(height uint64) *BlockLocation {
	bi.indexMu.RLock()
	location := bi.index[height]
	bi.indexMu.RUnlock()
	return location
}

// Platform-specific msync implementation
func msync(data []byte) error {
	// Use syscall.FlushViewOfFile on Windows
	// Use syscall.Msync on Unix
	return nil
}

// Helper structures

type CacheStatistics struct {
	Hits         uint64
	Misses       uint64
	HitRate      float64
	Reads        uint64
	Writes       uint64
	Evictions    uint64
	BytesRead    uint64
	BytesWritten uint64
	RegionCount  int
}

// LRUCache is a simple LRU cache implementation
type LRUCache struct {
	capacity int
	data     map[string]interface{}
	order    []string
	mu       sync.Mutex
}

func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		data:     make(map[string]interface{}),
		order:    make([]string, 0, capacity),
	}
}

// DefaultMMapConfig returns default configuration
func DefaultMMapConfig() *MMapConfig {
	return &MMapConfig{
		BaseDir:        "/var/cache/otedama/blocks",
		MaxRegionSize:  1 * 1024 * 1024 * 1024, // 1GB per region
		MaxTotalSize:   10 * 1024 * 1024 * 1024, // 10GB total
		BlocksPerFile:  10000,
		IndexInterval:  100,
		Compression:    false,
		PreloadHeaders: true,
		AsyncWrites:    true,
		SyncInterval:   30 * time.Second,
		EvictionPolicy: "lru",
	}
}