package v2

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// JobManager manages mining jobs for Stratum v2
// Rob Pike's channel patterns with John Carmack's optimization
type JobManager struct {
	logger *zap.Logger
	
	// Job generation
	currentJob    atomic.Value // *MiningJob
	jobID         atomic.Uint32
	jobTemplate   *JobTemplate
	
	// Job distribution
	jobChannels   map[uint32]chan *MiningJob
	channelsMu    sync.RWMutex
	
	// Block template updates
	templateChan  chan *BlockTemplate
	
	// Metrics
	jobsCreated   atomic.Uint64
	jobsSent      atomic.Uint64
	
	// Lifecycle
	ctx           context.Context
	wg            sync.WaitGroup
}

// JobTemplate contains block template information
type JobTemplate struct {
	Version          uint32
	PreviousBlock    [32]byte
	MerkleRoot       [32]byte
	Timestamp        uint32
	Bits             uint32
	CoinbaseValue    uint64
	Height           uint64
	TransactionCount int
}

// BlockTemplate represents a new block template
type BlockTemplate struct {
	JobTemplate
	Transactions [][]byte
	UpdateTime   time.Time
}

// NewJobManager creates a new job manager
func NewJobManager(logger *zap.Logger) *JobManager {
	return &JobManager{
		logger:       logger,
		jobChannels:  make(map[uint32]chan *MiningJob),
		templateChan: make(chan *BlockTemplate, 10),
	}
}

// Start starts the job manager
func (jm *JobManager) Start(ctx context.Context) {
	jm.ctx = ctx
	
	// Start job generation loop
	jm.wg.Add(1)
	go jm.jobGenerationLoop()
	
	// Start template update loop
	jm.wg.Add(1)
	go jm.templateUpdateLoop()
}

// Stop stops the job manager
func (jm *JobManager) Stop() {
	jm.wg.Wait()
}

// jobGenerationLoop generates new jobs
func (jm *JobManager) jobGenerationLoop() {
	defer jm.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			jm.generateNewJob(false)
			
		case <-jm.ctx.Done():
			return
		}
	}
}

// templateUpdateLoop handles block template updates
func (jm *JobManager) templateUpdateLoop() {
	defer jm.wg.Done()
	
	for {
		select {
		case template := <-jm.templateChan:
			jm.updateTemplate(template)
			
		case <-jm.ctx.Done():
			return
		}
	}
}

// UpdateTemplate updates the block template
func (jm *JobManager) UpdateTemplate(template *BlockTemplate) {
	select {
	case jm.templateChan <- template:
	default:
		// Drop if channel is full
		jm.logger.Warn("Template update channel full")
	}
}

// updateTemplate applies a new block template
func (jm *JobManager) updateTemplate(template *BlockTemplate) {
	jm.jobTemplate = &template.JobTemplate
	
	// Generate new job with updated template
	jm.generateNewJob(true)
	
	jm.logger.Info("Block template updated",
		zap.Uint64("height", template.Height),
		zap.Int("tx_count", template.TransactionCount),
	)
}

// generateNewJob creates a new mining job
func (jm *JobManager) generateNewJob(futureJob bool) {
	if jm.jobTemplate == nil {
		return
	}
	
	jobID := jm.jobID.Add(1)
	
	job := &MiningJob{
		ID:         jobID,
		Version:    jm.jobTemplate.Version,
		PrevHash:   jm.jobTemplate.PreviousBlock,
		MerkleRoot: jm.jobTemplate.MerkleRoot,
		Timestamp:  uint32(time.Now().Unix()),
		Bits:       jm.jobTemplate.Bits,
		Created:    time.Now(),
	}
	
	// Calculate target from bits
	job.Target = bitsToTarget(job.Bits)
	
	// Store as current job
	jm.currentJob.Store(job)
	jm.jobsCreated.Add(1)
	
	// Distribute to all channels
	jm.distributeJob(job, futureJob)
}

// distributeJob sends job to all active channels
func (jm *JobManager) distributeJob(job *MiningJob, futureJob bool) {
	jm.channelsMu.RLock()
	channels := make([]chan *MiningJob, 0, len(jm.jobChannels))
	for _, ch := range jm.jobChannels {
		channels = append(channels, ch)
	}
	jm.channelsMu.RUnlock()
	
	// Send to all channels concurrently
	var wg sync.WaitGroup
	for _, ch := range channels {
		wg.Add(1)
		go func(jobChan chan *MiningJob) {
			defer wg.Done()
			
			select {
			case jobChan <- job:
				jm.jobsSent.Add(1)
			case <-time.After(100 * time.Millisecond):
				// Timeout - channel might be blocked
			}
		}(ch)
	}
	
	wg.Wait()
	
	jm.logger.Debug("Job distributed",
		zap.Uint32("job_id", job.ID),
		zap.Int("channels", len(channels)),
		zap.Bool("future_job", futureJob),
	)
}

// RegisterChannel registers a channel for job updates
func (jm *JobManager) RegisterChannel(channelID uint32) chan *MiningJob {
	jobChan := make(chan *MiningJob, 10)
	
	jm.channelsMu.Lock()
	jm.jobChannels[channelID] = jobChan
	jm.channelsMu.Unlock()
	
	return jobChan
}

// UnregisterChannel removes a channel from job updates
func (jm *JobManager) UnregisterChannel(channelID uint32) {
	jm.channelsMu.Lock()
	if ch, ok := jm.jobChannels[channelID]; ok {
		close(ch)
		delete(jm.jobChannels, channelID)
	}
	jm.channelsMu.Unlock()
}

// SendJobToChannel sends current job to specific channel
func (jm *JobManager) SendJobToChannel(channel *MiningChannel) {
	job := jm.currentJob.Load()
	if job == nil {
		return
	}
	
	miningJob := job.(*MiningJob)
	
	// Create job message
	msg := NewMiningJob{
		ChannelID:      channel.id,
		JobID:          miningJob.ID,
		FutureJob:      false,
		Version:        miningJob.Version,
		VersionRolling: true,
		PrevHash:       miningJob.PrevHash,
		MerkleRoot:     miningJob.MerkleRoot,
	}
	
	// Send to channel
	if err := channel.connection.sendMessage(MsgNewMiningJob, msg); err != nil {
		jm.logger.Error("Failed to send job",
			zap.Uint32("channel_id", channel.id),
			zap.Error(err),
		)
		return
	}
	
	// Track job in channel
	channel.jobsMu.Lock()
	channel.activeJobs[miningJob.ID] = miningJob
	
	// Clean old jobs
	for id, job := range channel.activeJobs {
		if time.Since(job.Created) > 5*time.Minute {
			delete(channel.activeJobs, id)
		}
	}
	channel.jobsMu.Unlock()
}

// GetCurrentJob returns the current mining job
func (jm *JobManager) GetCurrentJob() *MiningJob {
	job := jm.currentJob.Load()
	if job == nil {
		return nil
	}
	return job.(*MiningJob)
}

// GetStats returns job manager statistics
func (jm *JobManager) GetStats() JobStats {
	return JobStats{
		JobsCreated: jm.jobsCreated.Load(),
		JobsSent:    jm.jobsSent.Load(),
		ActiveChannels: len(jm.jobChannels),
	}
}

// JobStats contains job manager statistics
type JobStats struct {
	JobsCreated    uint64
	JobsSent       uint64
	ActiveChannels int
}

// Helper functions

// bitsToTarget converts bits to target
func bitsToTarget(bits uint32) [32]byte {
	// Extract exponent and mantissa
	exp := bits >> 24
	mant := bits & 0x00FFFFFF
	
	var target [32]byte
	
	if exp <= 3 {
		mant >>= 8 * (3 - exp)
		target[28] = byte(mant)
		target[29] = byte(mant >> 8)
		target[30] = byte(mant >> 16)
		target[31] = byte(mant >> 24)
	} else {
		offset := exp - 3
		if offset < 29 {
			target[32-offset-1] = byte(mant)
			target[32-offset-2] = byte(mant >> 8)
			target[32-offset-3] = byte(mant >> 16)
			target[32-offset-4] = byte(mant >> 24)
		}
	}
	
	return target
}

// targetToBits converts target to bits
func targetToBits(target [32]byte) uint32 {
	// Find first non-zero byte
	var i int
	for i = 0; i < 32 && target[i] == 0; i++ {
	}
	
	if i == 32 {
		return 0
	}
	
	// Extract mantissa (3 bytes)
	var mant uint32
	if i <= 29 {
		mant = uint32(target[i])<<16 | uint32(target[i+1])<<8 | uint32(target[i+2])
	}
	
	// Calculate exponent
	exp := uint32(32 - i)
	
	// Normalize mantissa
	if mant > 0x7FFFFF {
		mant >>= 8
		exp++
	}
	
	return exp<<24 | mant
}

// JobTemplateManager manages job templates from upstream
type JobTemplateManager struct {
	logger        *zap.Logger
	jobManager    *JobManager
	upstream      string
	pollInterval  time.Duration
	
	// Current template
	currentTemplate atomic.Value // *BlockTemplate
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewJobTemplateManager creates a job template manager
func NewJobTemplateManager(logger *zap.Logger, jobManager *JobManager, upstream string) *JobTemplateManager {
	return &JobTemplateManager{
		logger:       logger,
		jobManager:   jobManager,
		upstream:     upstream,
		pollInterval: 500 * time.Millisecond, // Poll every 500ms for low latency
	}
}

// Start starts the template manager
func (tm *JobTemplateManager) Start() {
	tm.ctx, tm.cancel = context.WithCancel(context.Background())
	
	tm.wg.Add(1)
	go tm.pollLoop()
}

// Stop stops the template manager
func (tm *JobTemplateManager) Stop() {
	tm.cancel()
	tm.wg.Wait()
}

// pollLoop polls for new block templates
func (tm *JobTemplateManager) pollLoop() {
	defer tm.wg.Done()
	
	ticker := time.NewTicker(tm.pollInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			tm.pollTemplate()
			
		case <-tm.ctx.Done():
			return
		}
	}
}

// pollTemplate polls for new template
func (tm *JobTemplateManager) pollTemplate() {
	// In production, this would connect to bitcoind or pool software
	// to get new block templates
	
	// Example template update
	template := &BlockTemplate{
		JobTemplate: JobTemplate{
			Version:       0x20000000,
			Timestamp:     uint32(time.Now().Unix()),
			Bits:          0x1705ae3a,
			Height:        800000,
			CoinbaseValue: 625000000, // 6.25 BTC
		},
		UpdateTime: time.Now(),
	}
	
	// Check if template changed
	current := tm.currentTemplate.Load()
	if current != nil {
		currentTemplate := current.(*BlockTemplate)
		if template.PreviousBlock == currentTemplate.PreviousBlock &&
			template.TransactionCount == currentTemplate.TransactionCount {
			// No change
			return
		}
	}
	
	// Update template
	tm.currentTemplate.Store(template)
	tm.jobManager.UpdateTemplate(template)
}