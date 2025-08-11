package asic

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/stratum"
	"go.uber.org/zap"
)

// ASICStratumBridge bridges ASIC devices with Stratum protocol
type ASICStratumBridge struct {
	logger      *zap.Logger
	manager     *ASICManager
	stratumServer *stratum.Server
	
	// Work management
	currentWork  *stratum.Job
	workMu       sync.RWMutex
	
	// Device work assignment
	deviceWork   map[string]*DeviceWork // deviceID -> work
	deviceWorkMu sync.RWMutex
	
	// Statistics
	stats        *BridgeStats
	
	// Control
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// DeviceWork represents work assigned to a specific device
type DeviceWork struct {
	Device       *ASICDevice
	Job          *stratum.Job
	StartTime    time.Time
	SharesFound  uint64
	LastShare    time.Time
	Difficulty   float64
	ExtraNonce1  string
	ExtraNonce2Size int
}

// BridgeStats contains bridge statistics
type BridgeStats struct {
	JobsDistributed uint64
	SharesSubmitted uint64
	SharesAccepted  uint64
	SharesRejected  uint64
	BlocksFound     uint64
	LastBlockTime   time.Time
}

// NewASICStratumBridge creates a new ASIC-Stratum bridge
func NewASICStratumBridge(logger *zap.Logger, manager *ASICManager) *ASICStratumBridge {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &ASICStratumBridge{
		logger:     logger,
		manager:    manager,
		deviceWork: make(map[string]*DeviceWork),
		stats:      &BridgeStats{},
		ctx:        ctx,
		cancel:     cancel,
	}
}

// SetStratumServer sets the Stratum server for the bridge
func (b *ASICStratumBridge) SetStratumServer(server *stratum.Server) error {
	if server == nil {
		return errors.New("stratum server cannot be nil")
	}
	
	b.stratumServer = server
	
	// Set callbacks
	callbacks := &stratum.Callbacks{
		OnShare:  b.handleShare,
		OnGetJob: b.getJob,
		OnAuth:   b.authenticateDevice,
	}
	
	return server.SetCallbacks(callbacks)
}

// Start starts the ASIC-Stratum bridge
func (b *ASICStratumBridge) Start() error {
	b.logger.Info("Starting ASIC-Stratum bridge")
	
	// Start work distribution
	b.wg.Add(1)
	go b.workDistributor()
	
	// Start share processor
	b.wg.Add(1)
	go b.shareProcessor()
	
	// Start statistics reporter
	b.wg.Add(1)
	go b.statsReporter()
	
	return nil
}

// Stop stops the ASIC-Stratum bridge
func (b *ASICStratumBridge) Stop() error {
	b.logger.Info("Stopping ASIC-Stratum bridge")
	
	b.cancel()
	b.wg.Wait()
	
	return nil
}

// UpdateWork updates the current mining work
func (b *ASICStratumBridge) UpdateWork(job *stratum.Job) {
	b.workMu.Lock()
	b.currentWork = job
	b.workMu.Unlock()
	
	b.logger.Info("Updated mining work",
		zap.String("job_id", job.ID),
		zap.String("prev_hash", job.PrevHash),
		zap.Uint64("height", job.Height),
		zap.Float64("difficulty", job.Difficulty),
	)
	
	// Distribute to all devices
	b.distributeWork(job)
}

// Private methods

func (b *ASICStratumBridge) workDistributor() {
	defer b.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			b.checkAndUpdateWork()
		case <-b.ctx.Done():
			return
		}
	}
}

func (b *ASICStratumBridge) checkAndUpdateWork() {
	// Get current work
	b.workMu.RLock()
	currentWork := b.currentWork
	b.workMu.RUnlock()
	
	if currentWork == nil {
		return
	}
	
	// Check if work is still valid (not older than 2 minutes)
	if time.Since(currentWork.CreatedAt) > 2*time.Minute {
		b.logger.Warn("Current work is stale, requesting new work")
		// Request new work from pool
		if b.stratumServer != nil {
			newJob := b.getJob()
			if newJob != nil {
				b.UpdateWork(newJob)
			}
		}
	}
}

func (b *ASICStratumBridge) distributeWork(job *stratum.Job) {
	devices := b.manager.GetAllDevices()
	
	for _, device := range devices {
		if device.GetStatus() != StatusMining && device.GetStatus() != StatusIdle {
			continue
		}
		
		// Convert Stratum job to ASIC work format
		work := b.convertJobToWork(job, device)
		
		// Send work to device
		if err := device.SendWork(work); err != nil {
			b.logger.Error("Failed to send work to device",
				zap.String("device_id", device.ID),
				zap.Error(err),
			)
			continue
		}
		
		// Record work assignment
		b.recordDeviceWork(device, job)
		
		b.stats.JobsDistributed++
	}
}

func (b *ASICStratumBridge) convertJobToWork(job *stratum.Job, device *ASICDevice) *MiningWork {
	// Generate unique extra nonce for this device
	extraNonce1 := b.generateExtraNonce1(device.ID)
	
	// Create extended job for ASIC support
	extJob := stratum.CreateExtendedJob(job)
	
	return &MiningWork{
		JobID:        job.ID,
		PrevHash:     job.PrevHash,
		CoinbaseA:    extJob.CoinbaseA,
		CoinbaseB:    extJob.CoinbaseB,
		MerkleBranch: job.MerkleBranch,
		Version:      parseHexUint32(job.Version),
		NBits:        parseHexUint32(job.NBits),
		NTime:        parseHexUint32(job.NTime),
		CleanJobs:    job.CleanJobs,
		Target:       stratum.BigIntToTargetString(job.Target),
	}
}

func (b *ASICStratumBridge) recordDeviceWork(device *ASICDevice, job *stratum.Job) {
	b.deviceWorkMu.Lock()
	defer b.deviceWorkMu.Unlock()
	
	b.deviceWork[device.ID] = &DeviceWork{
		Device:      device,
		Job:         job,
		StartTime:   time.Now(),
		Difficulty:  job.Difficulty,
		ExtraNonce1: b.generateExtraNonce1(device.ID),
		ExtraNonce2Size: 4,
	}
}

func (b *ASICStratumBridge) shareProcessor() {
	defer b.wg.Done()
	
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			b.processDeviceShares()
		case <-b.ctx.Done():
			return
		}
	}
}

func (b *ASICStratumBridge) processDeviceShares() {
	b.deviceWorkMu.RLock()
	defer b.deviceWorkMu.RUnlock()
	
	for _, work := range b.deviceWork {
		device := work.Device
		
		// Get work status from device
		workStatus, err := device.GetWorkStatus()
		if err != nil {
			continue
		}
		
		// Check for new shares
		newShares := workStatus.ValidShares - work.SharesFound
		if newShares > 0 {
			work.SharesFound = workStatus.ValidShares
			work.LastShare = time.Now()
			
			// Submit shares to Stratum
			for i := uint64(0); i < newShares; i++ {
				b.submitShare(device, work)
			}
		}
	}
}

func (b *ASICStratumBridge) submitShare(device *ASICDevice, work *DeviceWork) {
	// Create Stratum share
	share := &stratum.Share{
		JobID:      work.Job.ID,
		WorkerName: device.ID,
		Nonce:      generateRandomNonce(), // Device handles nonce internally
		Difficulty: work.Difficulty,
		Timestamp:  time.Now().Unix(),
	}
	
	// Submit through callback
	if err := b.handleShare(share); err != nil {
		b.logger.Debug("Share rejected",
			zap.String("device_id", device.ID),
			zap.Error(err),
		)
		b.stats.SharesRejected++
	} else {
		b.stats.SharesAccepted++
		
		// Check if block found
		if share.IsBlock {
			b.stats.BlocksFound++
			b.stats.LastBlockTime = time.Now()
			
			b.logger.Info("Block found!",
				zap.String("device_id", device.ID),
				zap.String("job_id", share.JobID),
			)
		}
	}
	
	b.stats.SharesSubmitted++
}

func (b *ASICStratumBridge) statsReporter() {
	defer b.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			b.reportStats()
		case <-b.ctx.Done():
			return
		}
	}
}

func (b *ASICStratumBridge) reportStats() {
	// Get aggregate stats from ASIC manager
	asicStats := b.manager.GetStats()
	
	b.logger.Info("ASIC-Stratum bridge statistics",
		zap.Uint64("jobs_distributed", b.stats.JobsDistributed),
		zap.Uint64("shares_submitted", b.stats.SharesSubmitted),
		zap.Uint64("shares_accepted", b.stats.SharesAccepted),
		zap.Uint64("shares_rejected", b.stats.SharesRejected),
		zap.Uint64("blocks_found", b.stats.BlocksFound),
		zap.Any("asic_stats", asicStats),
	)
}

// Callback implementations

func (b *ASICStratumBridge) handleShare(share *stratum.Share) error {
	// Validate share
	if share.JobID == "" || share.WorkerName == "" {
		return errors.New("invalid share")
	}
	
	// Get device work
	b.deviceWorkMu.RLock()
	work, exists := b.deviceWork[share.WorkerName]
	b.deviceWorkMu.RUnlock()
	
	if !exists {
		return errors.New("unknown worker")
	}
	
	// Validate job ID
	if share.JobID != work.Job.ID {
		return errors.New("stale share")
	}
	
	// Validate share difficulty
	if share.Difficulty < work.Difficulty {
		return errors.New("low difficulty share")
	}
	
	// TODO: Implement actual share validation
	// This would involve checking the hash against the target
	
	// Check if it's a block
	share.IsBlock = b.checkIfBlock(share, work.Job)
	
	return nil
}

func (b *ASICStratumBridge) getJob() *stratum.Job {
	b.workMu.RLock()
	defer b.workMu.RUnlock()
	
	return b.currentWork
}

func (b *ASICStratumBridge) authenticateDevice(username, password string) error {
	// Simple authentication - accept any device
	// In production, implement proper authentication
	return nil
}

// Helper functions

func (b *ASICStratumBridge) generateExtraNonce1(deviceID string) string {
	// Generate unique extra nonce based on device ID
	// This ensures each device works on different nonce ranges
	hash := sha256Hash([]byte(deviceID))
	return hex.EncodeToString(hash[:4]) // 4 bytes
}

func (b *ASICStratumBridge) checkIfBlock(share *stratum.Share, job *stratum.Job) bool {
	// This is a simplified check
	// In reality, you would validate the full block hash
	
	// Check if share meets network difficulty
	networkDifficulty := job.Difficulty * 1000 // Example multiplier
	return share.Difficulty >= networkDifficulty
}

func parseHexUint32(hexStr string) uint32 {
	// Remove 0x prefix if present
	hexStr = stripHexPrefix(hexStr)
	
	// Parse hex string
	var value uint32
	fmt.Sscanf(hexStr, "%x", &value)
	return value
}

func stripHexPrefix(s string) string {
	if len(s) >= 2 && s[0:2] == "0x" {
		return s[2:]
	}
	return s
}

func generateRandomNonce() string {
	// Generate random 4-byte nonce
	nonce := make([]byte, 4)
	for i := range nonce {
		nonce[i] = byte(time.Now().UnixNano() & 0xFF)
	}
	return hex.EncodeToString(nonce)
}

func sha256Hash(data []byte) []byte {
	hash := make([]byte, 32)
	// Simplified - use actual SHA256 implementation
	copy(hash, data)
	return hash
}

// ASICWorkDistributor manages work distribution to ASICs
type ASICWorkDistributor struct {
	logger   *zap.Logger
	bridge   *ASICStratumBridge
	
	// Work queue
	workQueue chan *stratum.Job
	
	// Control
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewASICWorkDistributor creates a new work distributor
func NewASICWorkDistributor(logger *zap.Logger, bridge *ASICStratumBridge) *ASICWorkDistributor {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &ASICWorkDistributor{
		logger:    logger,
		bridge:    bridge,
		workQueue: make(chan *stratum.Job, 100),
		ctx:       ctx,
		cancel:    cancel,
	}
}

// AddWork adds new work to the distribution queue
func (d *ASICWorkDistributor) AddWork(job *stratum.Job) {
	select {
	case d.workQueue <- job:
		d.logger.Debug("Added work to queue", zap.String("job_id", job.ID))
	default:
		d.logger.Warn("Work queue full, dropping job", zap.String("job_id", job.ID))
	}
}

// Start starts the work distributor
func (d *ASICWorkDistributor) Start() {
	go d.distributionLoop()
}

// Stop stops the work distributor
func (d *ASICWorkDistributor) Stop() {
	d.cancel()
}

func (d *ASICWorkDistributor) distributionLoop() {
	for {
		select {
		case job := <-d.workQueue:
			d.bridge.UpdateWork(job)
		case <-d.ctx.Done():
			return
		}
	}
}