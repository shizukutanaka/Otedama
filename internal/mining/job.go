package mining

import (
	"sync"
	"sync/atomic"
	"time"
)

// JobDistributor はジョブ分配を管理
type JobDistributor struct {
	currentJob   atomic.Value // *MiningJob
	jobQueue     chan *MiningJob
	workers      sync.Map
	mu           sync.RWMutex
	jobCounter   atomic.Uint64
	targetTime   time.Duration
	lastJobTime  time.Time
}

// WorkerStats はワーカー統計
type WorkerStats struct {
	ID            string
	HashRate      uint64
	SharesSubmitted uint64
	SharesAccepted  uint64
	LastShare       time.Time
}

// NewJobDistributor は新しいジョブディストリビューターを作成
func NewJobDistributor() *JobDistributor {
	jd := &JobDistributor{
		jobQueue:    make(chan *MiningJob, 100),
		targetTime:  30 * time.Second,
		lastJobTime: time.Now(),
	}
	
	// 初期ジョブを設定
	initialJob := &MiningJob{
		ID:         "initial",
		Header:     make([]byte, 80),
		Target:     make([]byte, 32),
		Coinbase1:  make([]byte, 0),
		Coinbase2:  make([]byte, 0),
		Difficulty: 0x1d00ffff,
		StartNonce: 0,
		EndNonce:   0xffffffff,
	}
	jd.currentJob.Store(initialJob)
	
	return jd
}

// SubmitJob は新しいジョブを投入
func (jd *JobDistributor) SubmitJob(job *MiningJob) {
	jd.currentJob.Store(job)
	jd.lastJobTime = time.Now()
	jd.jobCounter.Add(1)
	
	// ジョブキューに追加（非ブロッキング）
	select {
	case jd.jobQueue <- job:
	default:
		// キューがフルの場合は古いジョブを破棄
	}
}

// GetCurrentJob は現在のジョブを取得
func (jd *JobDistributor) GetCurrentJob() *MiningJob {
	if job := jd.currentJob.Load(); job != nil {
		return job.(*MiningJob)
	}
	return nil
}

// RegisterWorker はワーカーを登録
func (jd *JobDistributor) RegisterWorker(workerID string) {
	stats := &WorkerStats{
		ID:          workerID,
		LastShare:   time.Now(),
	}
	jd.workers.Store(workerID, stats)
}

// UnregisterWorker はワーカーの登録を解除
func (jd *JobDistributor) UnregisterWorker(workerID string) {
	jd.workers.Delete(workerID)
}

// UpdateWorkerStats はワーカー統計を更新
func (jd *JobDistributor) UpdateWorkerStats(workerID string, hashRate uint64, shareAccepted bool) {
	if value, ok := jd.workers.Load(workerID); ok {
		stats := value.(*WorkerStats)
		stats.HashRate = hashRate
		stats.SharesSubmitted++
		if shareAccepted {
			stats.SharesAccepted++
		}
		stats.LastShare = time.Now()
	}
}

// GetWorkerStats は全ワーカーの統計を取得
func (jd *JobDistributor) GetWorkerStats() []WorkerStats {
	var stats []WorkerStats
	
	jd.workers.Range(func(key, value interface{}) bool {
		if workerStat, ok := value.(*WorkerStats); ok {
			stats = append(stats, *workerStat)
		}
		return true
	})
	
	return stats
}

// ShouldCreateNewJob は新しいジョブを作成すべきか判断
func (jd *JobDistributor) ShouldCreateNewJob() bool {
	return time.Since(jd.lastJobTime) > jd.targetTime
}

// GetJobCount はジョブ数を取得
func (jd *JobDistributor) GetJobCount() uint64 {
	return jd.jobCounter.Load()
}