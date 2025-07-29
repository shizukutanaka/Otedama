package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Config はマイニングエンジンの設定
type Config struct {
	Algorithm   string
	Threads     int
	CPUAffinity []int
}

// Engine はマイニングエンジン
type Engine struct {
	config     Config
	logger     *zap.Logger
	workers    []*Worker
	running    atomic.Bool
	hashRate   atomic.Uint64
	totalNonce atomic.Uint64
	mu         sync.RWMutex
}

// Worker はマイニングワーカー
type Worker struct {
	id         int
	engine     *Engine
	nonceChan  chan uint64
	resultChan chan *Result
	hashCount  atomic.Uint64
}

// Result はマイニング結果
type Result struct {
	Nonce      uint64
	Hash       []byte
	Difficulty uint32
	Found      bool
}

// MiningJob はマイニングジョブ
type MiningJob struct {
	ID         string
	Header     []byte
	Target     []byte
	Coinbase1  []byte
	Coinbase2  []byte
	Difficulty uint32
	StartNonce uint64
	EndNonce   uint64
}

// NewEngine は新しいマイニングエンジンを作成
func NewEngine(cfg Config, logger *zap.Logger) (*Engine, error) {
	if cfg.Threads <= 0 {
		cfg.Threads = runtime.NumCPU()
	}

	e := &Engine{
		config:  cfg,
		logger:  logger,
		workers: make([]*Worker, cfg.Threads),
	}

	// ワーカー初期化
	for i := 0; i < cfg.Threads; i++ {
		e.workers[i] = &Worker{
			id:         i,
			engine:     e,
			nonceChan:  make(chan uint64, 1000),
			resultChan: make(chan *Result, 10),
		}
	}

	return e, nil
}

// Start はマイニングエンジンを開始
func (e *Engine) Start(ctx context.Context) error {
	if e.running.Load() {
		return fmt.Errorf("engine already running")
	}

	e.running.Store(true)
	e.logger.Info("Starting mining engine",
		zap.String("algorithm", e.config.Algorithm),
		zap.Int("threads", e.config.Threads),
	)

	// ワーカー開始
	for _, worker := range e.workers {
		go worker.run(ctx)
	}

	// ハッシュレート計算
	go e.calculateHashRate(ctx)

	return nil
}

// Stop はマイニングエンジンを停止
func (e *Engine) Stop() error {
	if !e.running.Load() {
		return nil
	}

	e.running.Store(false)
	e.logger.Info("Stopping mining engine")

	// ワーカーのチャンネルを閉じる
	for _, worker := range e.workers {
		close(worker.nonceChan)
	}

	return nil
}

// SubmitJob はジョブを投入
func (e *Engine) SubmitJob(job *MiningJob) {
	if !e.running.Load() {
		return
	}

	// ノンスを各ワーカーに分配
	nonceRange := job.EndNonce - job.StartNonce
	noncePerWorker := nonceRange / uint64(len(e.workers))

	for i, worker := range e.workers {
		startNonce := job.StartNonce + uint64(i)*noncePerWorker
		endNonce := startNonce + noncePerWorker
		if i == len(e.workers)-1 {
			endNonce = job.EndNonce
		}

		// ノンスを送信
		for nonce := startNonce; nonce < endNonce; nonce++ {
			select {
			case worker.nonceChan <- nonce:
			default:
				// バッファフルの場合はスキップ
			}
		}
	}
}

// GetHashRate は現在のハッシュレートを取得
func (e *Engine) GetHashRate() uint64 {
	return e.hashRate.Load()
}

// calculateHashRate はハッシュレートを計算
func (e *Engine) calculateHashRate(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var lastCount uint64

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			currentCount := e.totalNonce.Load()
			rate := currentCount - lastCount
			e.hashRate.Store(rate)
			lastCount = currentCount
		}
	}
}

// Worker implementation

// run はワーカーのメインループ
func (w *Worker) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case nonce, ok := <-w.nonceChan:
			if !ok {
				return
			}
			w.mine(nonce)
		}
	}
}

// mine はマイニングを実行
func (w *Worker) mine(nonce uint64) {
	// ハッシュ計算（簡易実装）
	data := make([]byte, 8)
	binary.LittleEndian.PutUint64(data, nonce)
	
	hash := sha256.Sum256(data)
	
	// ハッシュカウントを増やす
	w.hashCount.Add(1)
	w.engine.totalNonce.Add(1)
	
	// 結果チェック（簡易実装）
	if hash[0] == 0 && hash[1] == 0 {
		result := &Result{
			Nonce:      nonce,
			Hash:       hash[:],
			Difficulty: 0x1d00ffff,
			Found:      true,
		}
		
		select {
		case w.resultChan <- result:
		default:
			// 結果チャンネルがフルの場合はドロップ
		}
	}
}

// CPUアフィニティ設定（プラットフォーム依存）
func (e *Engine) setupCPUAffinity() error {
	// TODO: プラットフォーム固有の実装
	// Linux: sched_setaffinity
	// Windows: SetThreadAffinityMask
	// macOS: thread_policy_set
	return nil
}