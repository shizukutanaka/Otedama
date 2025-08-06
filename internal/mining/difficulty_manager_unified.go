package mining

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// UnifiedDifficultyManager - 統合された難易度管理システム
// John Carmack, Robert C. Martin, Rob Pikeの設計原則を適用
type UnifiedDifficultyManager struct {
	logger *zap.Logger
	config DifficultyManagerConfig
	
	// 現在の難易度
	currentDifficulty atomic.Value // *big.Float
	targetBlockTime   time.Duration
	
	// シェア追跡
	shareBuffer  *ShareTimeBuffer
	blockHistory []*BlockInfo
	historyMu    sync.RWMutex
	
	// 調整アルゴリズム
	algorithms      map[string]DifficultyAlgorithm
	activeAlgorithm string
	
	// 統計
	stats *DifficultyStats
	
	// チャネル
	blockChan      chan *BlockInfo
	adjustmentChan chan *DifficultyAdjustment
	
	// ライフサイクル
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// DifficultyManagerConfig - 難易度管理設定
type DifficultyManagerConfig struct {
	// アルゴリズム設定
	Algorithm        string        `json:"algorithm"`
	RetargetInterval int           `json:"retarget_interval"`
	RetargetTimespan time.Duration `json:"retarget_timespan"`
	
	// 調整制限
	MaxAdjustmentFactor float64 `json:"max_adjustment_factor"`
	MinAdjustmentFactor float64 `json:"min_adjustment_factor"`
	
	// スムージングパラメータ
	SmoothingWindow int     `json:"smoothing_window"`
	DampingFactor   float64 `json:"damping_factor"`
	
	// 緊急調整
	EmergencyThreshold float64       `json:"emergency_threshold"`
	EmergencyWindow    time.Duration `json:"emergency_window"`
	
	// ターゲットパラメータ
	TargetBlockTime time.Duration `json:"target_block_time"`
	MinDifficulty   *big.Float    `json:"min_difficulty"`
	MaxDifficulty   *big.Float    `json:"max_difficulty"`
	
	// シェアターゲット設定
	ShareTargetTime  time.Duration `json:"share_target_time"`
	ShareBufferSize  int           `json:"share_buffer_size"`
	EnableVariance   bool          `json:"enable_variance"`
	OutlierThreshold float64       `json:"outlier_threshold"`
}

// DifficultyAlgorithm - 難易度調整アルゴリズムインターフェース
type DifficultyAlgorithm interface {
	CalculateNewDifficulty(currentDiff *big.Float, blocks []*BlockInfo, config DifficultyManagerConfig) (*big.Float, float64)
	Name() string
	RequiredBlocks() int
}

// BlockInfo - ブロック情報
type BlockInfo struct {
	Height       int64
	Hash         string
	Timestamp    time.Time
	Difficulty   *big.Float
	Nonce        uint64
	HashRate     float64
	Transactions int
}

// DifficultyAdjustment - 難易度調整
type DifficultyAdjustment struct {
	Height                    int64
	OldDifficulty             *big.Float
	NewDifficulty             *big.Float
	AdjustmentFactor          float64
	Reason                    string
	Algorithm                 string
	Timestamp                 time.Time
	BlocksSinceLastAdjustment int
	TimeSinceLastAdjustment   time.Duration
}

// DifficultyStats - 難易度統計
type DifficultyStats struct {
	TotalAdjustments     atomic.Uint64
	UpAdjustments        atomic.Uint64
	DownAdjustments      atomic.Uint64
	EmergencyAdjustments atomic.Uint64
	CurrentDifficulty    atomic.Value // *big.Float
	AverageBlockTime     atomic.Value // time.Duration
	AverageShareTime     atomic.Value // time.Duration
	ShareTimeVariance    atomic.Value // float64
	CurrentHashRate      atomic.Value // float64
	LastAdjustment       atomic.Value // time.Time
	StabilityScore       atomic.Value // float64
}

// ShareTimeBuffer - シェア時間バッファ
type ShareTimeBuffer struct {
	times     []time.Time
	intervals []time.Duration
	size      int
	index     int
	count     int
	mu        sync.RWMutex
}

// NewUnifiedDifficultyManager - 統合難易度マネージャーを作成
func NewUnifiedDifficultyManager(logger *zap.Logger, config DifficultyManagerConfig) *UnifiedDifficultyManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	// デフォルト値設定
	if config.RetargetInterval == 0 {
		config.RetargetInterval = 2016 // Bitcoin default
	}
	if config.RetargetTimespan == 0 {
		config.RetargetTimespan = 14 * 24 * time.Hour
	}
	if config.MaxAdjustmentFactor == 0 {
		config.MaxAdjustmentFactor = 4.0
	}
	if config.MinAdjustmentFactor == 0 {
		config.MinAdjustmentFactor = 0.25
	}
	if config.TargetBlockTime == 0 {
		config.TargetBlockTime = 10 * time.Minute
	}
	if config.ShareTargetTime == 0 {
		config.ShareTargetTime = 10 * time.Second
	}
	if config.ShareBufferSize == 0 {
		config.ShareBufferSize = 100
	}
	
	dm := &UnifiedDifficultyManager{
		logger:          logger,
		config:          config,
		targetBlockTime: config.TargetBlockTime,
		shareBuffer:     newShareTimeBuffer(config.ShareBufferSize),
		blockHistory:    make([]*BlockInfo, 0, config.RetargetInterval*2),
		algorithms:      make(map[string]DifficultyAlgorithm),
		activeAlgorithm: config.Algorithm,
		stats:           &DifficultyStats{},
		blockChan:       make(chan *BlockInfo, 100),
		adjustmentChan:  make(chan *DifficultyAdjustment, 10),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// 初期難易度を設定
	if config.MinDifficulty != nil {
		dm.currentDifficulty.Store(new(big.Float).Copy(config.MinDifficulty))
	} else {
		dm.currentDifficulty.Store(big.NewFloat(1.0))
	}
	
	// 統計を初期化
	dm.stats.CurrentDifficulty.Store(dm.GetCurrentDifficulty())
	dm.stats.LastAdjustment.Store(time.Now())
	
	// アルゴリズムを初期化
	dm.initializeAlgorithms()
	
	return dm
}

// Start - マネージャーを開始
func (dm *UnifiedDifficultyManager) Start() error {
	dm.logger.Info("Starting unified difficulty manager",
		zap.String("algorithm", dm.activeAlgorithm),
		zap.Int("retarget_interval", dm.config.RetargetInterval),
		zap.Duration("target_block_time", dm.targetBlockTime))
	
	// ワーカーを開始
	dm.wg.Add(1)
	go dm.blockProcessor()
	
	dm.wg.Add(1)
	go dm.adjustmentProcessor()
	
	dm.wg.Add(1)
	go dm.emergencyMonitor()
	
	dm.wg.Add(1)
	go dm.shareAdjustmentLoop()
	
	dm.wg.Add(1)
	go dm.statsUpdater()
	
	return nil
}

// Stop - マネージャーを停止
func (dm *UnifiedDifficultyManager) Stop() error {
	dm.logger.Info("Stopping difficulty manager")
	dm.cancel()
	dm.wg.Wait()
	return nil
}

// ProcessBlock - 新しいブロックを処理
func (dm *UnifiedDifficultyManager) ProcessBlock(block *BlockInfo) error {
	if block == nil {
		return errors.New("nil block")
	}
	
	select {
	case dm.blockChan <- block:
		return nil
	case <-dm.ctx.Done():
		return errors.New("manager stopped")
	default:
		return errors.New("block channel full")
	}
}

// RecordShare - シェア送信を記録
func (dm *UnifiedDifficultyManager) RecordShare(timestamp time.Time) {
	dm.shareBuffer.Add(timestamp)
	
	// 統計を更新
	if avgTime := dm.shareBuffer.AverageInterval(); avgTime > 0 {
		dm.stats.AverageShareTime.Store(avgTime)
	}
	
	if variance := dm.shareBuffer.Variance(); variance >= 0 {
		dm.stats.ShareTimeVariance.Store(variance)
	}
}

// GetCurrentDifficulty - 現在の難易度を取得
func (dm *UnifiedDifficultyManager) GetCurrentDifficulty() *big.Float {
	diff := dm.currentDifficulty.Load()
	if diff == nil {
		return big.NewFloat(1.0)
	}
	return new(big.Float).Copy(diff.(*big.Float))
}

// GetShareDifficulty - シェア難易度を取得
func (dm *UnifiedDifficultyManager) GetShareDifficulty() float64 {
	// シェア間隔に基づいて動的に調整
	avgInterval := dm.shareBuffer.AverageInterval()
	if avgInterval == 0 {
		return 1.0
	}
	
	// ターゲット時間に対する比率を計算
	targetSeconds := dm.config.ShareTargetTime.Seconds()
	actualSeconds := avgInterval.Seconds()
	
	// 現在のシェア難易度を取得または初期化
	currentShareDiff := 1.0
	if diff := dm.stats.CurrentDifficulty.Load(); diff != nil {
		if bigDiff, ok := diff.(*big.Float); ok {
			currentShareDiff, _ = bigDiff.Float64()
			currentShareDiff = currentShareDiff / 1000000 // シェア用にスケール
		}
	}
	
	// 新しい難易度を計算
	newDiff := currentShareDiff * targetSeconds / actualSeconds
	
	// 制限を適用
	if newDiff < 0.001 {
		newDiff = 0.001
	} else if newDiff > 1000000 {
		newDiff = 1000000
	}
	
	return newDiff
}

// GetTargetForDifficulty - 難易度をターゲットに変換
func (dm *UnifiedDifficultyManager) GetTargetForDifficulty(difficulty *big.Float) *big.Int {
	// Target = MaxTarget / Difficulty
	maxTarget := new(big.Int).Lsh(big.NewInt(1), 256)
	maxTarget.Sub(maxTarget, big.NewInt(1))
	
	maxTargetFloat := new(big.Float).SetInt(maxTarget)
	targetFloat := new(big.Float).Quo(maxTargetFloat, difficulty)
	
	target, _ := targetFloat.Int(nil)
	return target
}

// GetDifficultyForTarget - ターゲットを難易度に変換
func (dm *UnifiedDifficultyManager) GetDifficultyForTarget(target *big.Int) *big.Float {
	// Difficulty = MaxTarget / Target
	maxTarget := new(big.Int).Lsh(big.NewInt(1), 256)
	maxTarget.Sub(maxTarget, big.NewInt(1))
	
	targetFloat := new(big.Float).SetInt(target)
	maxTargetFloat := new(big.Float).SetInt(maxTarget)
	
	return new(big.Float).Quo(maxTargetFloat, targetFloat)
}

// GetStats - 統計を取得
func (dm *UnifiedDifficultyManager) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_adjustments":     dm.stats.TotalAdjustments.Load(),
		"up_adjustments":        dm.stats.UpAdjustments.Load(),
		"down_adjustments":      dm.stats.DownAdjustments.Load(),
		"emergency_adjustments": dm.stats.EmergencyAdjustments.Load(),
		"active_algorithm":      dm.activeAlgorithm,
		"retarget_interval":     dm.config.RetargetInterval,
		"target_block_time":     dm.targetBlockTime.String(),
	}
	
	if avgBlockTime, ok := dm.stats.AverageBlockTime.Load().(time.Duration); ok {
		stats["average_block_time"] = avgBlockTime.String()
	}
	
	if avgShareTime, ok := dm.stats.AverageShareTime.Load().(time.Duration); ok {
		stats["average_share_time"] = avgShareTime.String()
		stats["share_difficulty"] = dm.GetShareDifficulty()
	}
	
	if variance, ok := dm.stats.ShareTimeVariance.Load().(float64); ok {
		stats["share_time_variance"] = variance
	}
	
	if hashRate, ok := dm.stats.CurrentHashRate.Load().(float64); ok {
		stats["current_hash_rate"] = hashRate
	}
	
	if lastAdj, ok := dm.stats.LastAdjustment.Load().(time.Time); ok {
		stats["last_adjustment"] = lastAdj
		stats["time_since_adjustment"] = time.Since(lastAdj).String()
	}
	
	if stability, ok := dm.stats.StabilityScore.Load().(float64); ok {
		stats["stability_score"] = stability
	}
	
	currentDiff := dm.GetCurrentDifficulty()
	if diffFloat, ok := currentDiff.Float64(); ok {
		stats["current_difficulty"] = diffFloat
	}
	
	return stats
}

// プライベートメソッド

// initializeAlgorithms - 難易度調整アルゴリズムを初期化
func (dm *UnifiedDifficultyManager) initializeAlgorithms() {
	dm.algorithms["bitcoin"] = &BitcoinAlgorithm{}
	dm.algorithms["ethereum"] = &EthereumAlgorithm{}
	dm.algorithms["digishield"] = &DigiShieldAlgorithm{}
	dm.algorithms["dark_gravity_wave"] = &DarkGravityWaveAlgorithm{}
	dm.algorithms["kimoto"] = &KimotoGravityWellAlgorithm{}
	dm.algorithms["ema"] = &EMAAlgorithm{alpha: 0.1}
	dm.algorithms["pid"] = &PIDAlgorithm{kp: 0.5, ki: 0.1, kd: 0.05}
	dm.algorithms["simple"] = &SimpleAlgorithm{}
}

// blockProcessor - ブロックを処理
func (dm *UnifiedDifficultyManager) blockProcessor() {
	defer dm.wg.Done()
	
	for {
		select {
		case <-dm.ctx.Done():
			return
		case block := <-dm.blockChan:
			dm.processBlock(block)
		}
	}
}

func (dm *UnifiedDifficultyManager) processBlock(block *BlockInfo) {
	// 履歴に追加
	dm.historyMu.Lock()
	dm.blockHistory = append(dm.blockHistory, block)
	
	// 履歴サイズを制限
	maxHistory := dm.config.RetargetInterval * 3
	if len(dm.blockHistory) > maxHistory {
		dm.blockHistory = dm.blockHistory[len(dm.blockHistory)-maxHistory:]
	}
	
	historyLen := len(dm.blockHistory)
	dm.historyMu.Unlock()
	
	// リターゲットが必要か確認
	if dm.shouldRetarget(block, historyLen) {
		dm.performRetarget(block)
	}
	
	// 統計を更新
	dm.updateBlockStats(block)
}

func (dm *UnifiedDifficultyManager) shouldRetarget(block *BlockInfo, historyLen int) bool {
	// 十分なブロックがあるか確認
	if historyLen < dm.config.RetargetInterval {
		return false
	}
	
	// リターゲットのタイミングか確認
	if block.Height%int64(dm.config.RetargetInterval) == 0 {
		return true
	}
	
	return false
}

func (dm *UnifiedDifficultyManager) performRetarget(triggerBlock *BlockInfo) {
	dm.historyMu.RLock()
	
	// アルゴリズムを取得
	algorithm, exists := dm.algorithms[dm.activeAlgorithm]
	if !exists {
		dm.historyMu.RUnlock()
		dm.logger.Error("Unknown algorithm", zap.String("algorithm", dm.activeAlgorithm))
		return
	}
	
	// 必要なブロック数を取得
	requiredBlocks := algorithm.RequiredBlocks()
	if len(dm.blockHistory) < requiredBlocks {
		dm.historyMu.RUnlock()
		return
	}
	
	// 関連ブロックを取得
	relevantBlocks := dm.blockHistory[len(dm.blockHistory)-requiredBlocks:]
	
	// ブロックをコピー
	blocks := make([]*BlockInfo, len(relevantBlocks))
	copy(blocks, relevantBlocks)
	dm.historyMu.RUnlock()
	
	// 新しい難易度を計算
	currentDiff := dm.GetCurrentDifficulty()
	newDiff, adjustmentFactor := algorithm.CalculateNewDifficulty(currentDiff, blocks, dm.config)
	
	// 調整制限を適用
	newDiff, adjustmentFactor = dm.applyAdjustmentLimits(currentDiff, newDiff, adjustmentFactor)
	
	// 難易度境界を適用
	newDiff = dm.applyDifficultyBounds(newDiff)
	
	// 調整を作成
	adjustment := &DifficultyAdjustment{
		Height:                    triggerBlock.Height,
		OldDifficulty:             currentDiff,
		NewDifficulty:             newDiff,
		AdjustmentFactor:          adjustmentFactor,
		Reason:                    "regular_retarget",
		Algorithm:                 dm.activeAlgorithm,
		Timestamp:                 time.Now(),
		BlocksSinceLastAdjustment: dm.config.RetargetInterval,
	}
	
	// 最後の調整からの時間を計算
	if lastAdj, ok := dm.stats.LastAdjustment.Load().(time.Time); ok {
		adjustment.TimeSinceLastAdjustment = time.Since(lastAdj)
	}
	
	// 調整を送信
	dm.adjustmentChan <- adjustment
}

// adjustmentProcessor - 難易度調整を処理
func (dm *UnifiedDifficultyManager) adjustmentProcessor() {
	defer dm.wg.Done()
	
	for {
		select {
		case <-dm.ctx.Done():
			return
		case adjustment := <-dm.adjustmentChan:
			dm.applyAdjustment(adjustment)
		}
	}
}

func (dm *UnifiedDifficultyManager) applyAdjustment(adjustment *DifficultyAdjustment) {
	// 現在の難易度を更新
	dm.currentDifficulty.Store(adjustment.NewDifficulty)
	dm.stats.CurrentDifficulty.Store(adjustment.NewDifficulty)
	
	// 統計を更新
	dm.stats.TotalAdjustments.Add(1)
	dm.stats.LastAdjustment.Store(time.Now())
	
	if adjustment.AdjustmentFactor > 1.0 {
		dm.stats.UpAdjustments.Add(1)
	} else if adjustment.AdjustmentFactor < 1.0 {
		dm.stats.DownAdjustments.Add(1)
	}
	
	if adjustment.Reason == "emergency" {
		dm.stats.EmergencyAdjustments.Add(1)
	}
	
	// ログ出力
	oldDiffFloat, _ := adjustment.OldDifficulty.Float64()
	newDiffFloat, _ := adjustment.NewDifficulty.Float64()
	
	dm.logger.Info("Difficulty adjusted",
		zap.Int64("height", adjustment.Height),
		zap.Float64("old_difficulty", oldDiffFloat),
		zap.Float64("new_difficulty", newDiffFloat),
		zap.Float64("adjustment_factor", adjustment.AdjustmentFactor),
		zap.String("reason", adjustment.Reason),
		zap.String("algorithm", adjustment.Algorithm))
}

// emergencyMonitor - 緊急調整を監視
func (dm *UnifiedDifficultyManager) emergencyMonitor() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-dm.ctx.Done():
			return
		case <-ticker.C:
			dm.checkEmergencyAdjustment()
		}
	}
}

func (dm *UnifiedDifficultyManager) checkEmergencyAdjustment() {
	dm.historyMu.RLock()
	defer dm.historyMu.RUnlock()
	
	if len(dm.blockHistory) < 10 {
		return
	}
	
	// 最近のブロックを取得
	recentBlocks := dm.blockHistory[len(dm.blockHistory)-10:]
	
	// 実際vs期待時間を計算
	actualTime := recentBlocks[len(recentBlocks)-1].Timestamp.Sub(recentBlocks[0].Timestamp)
	expectedTime := dm.targetBlockTime * time.Duration(len(recentBlocks)-1)
	
	// 偏差を計算
	deviation := math.Abs(float64(actualTime-expectedTime)) / float64(expectedTime)
	
	if deviation > dm.config.EmergencyThreshold {
		dm.triggerEmergencyAdjustment(deviation, actualTime, expectedTime)
	}
}

func (dm *UnifiedDifficultyManager) triggerEmergencyAdjustment(deviation float64, actualTime, expectedTime time.Duration) {
	currentDiff := dm.GetCurrentDifficulty()
	
	// 調整係数を計算
	adjustmentFactor := float64(expectedTime) / float64(actualTime)
	
	// 緊急制限を適用（より保守的）
	maxEmergencyAdjustment := 2.0
	minEmergencyAdjustment := 0.5
	
	if adjustmentFactor > maxEmergencyAdjustment {
		adjustmentFactor = maxEmergencyAdjustment
	} else if adjustmentFactor < minEmergencyAdjustment {
		adjustmentFactor = minEmergencyAdjustment
	}
	
	// 新しい難易度を計算
	newDiff := new(big.Float).Mul(currentDiff, big.NewFloat(adjustmentFactor))
	
	// 緊急調整を作成
	adjustment := &DifficultyAdjustment{
		Height:           dm.blockHistory[len(dm.blockHistory)-1].Height,
		OldDifficulty:    currentDiff,
		NewDifficulty:    newDiff,
		AdjustmentFactor: adjustmentFactor,
		Reason:           "emergency",
		Algorithm:        "emergency",
		Timestamp:        time.Now(),
	}
	
	dm.adjustmentChan <- adjustment
	
	dm.logger.Warn("Emergency difficulty adjustment triggered",
		zap.Float64("deviation", deviation),
		zap.Duration("actual_time", actualTime),
		zap.Duration("expected_time", expectedTime),
		zap.Float64("adjustment_factor", adjustmentFactor))
}

// shareAdjustmentLoop - シェア難易度調整ループ
func (dm *UnifiedDifficultyManager) shareAdjustmentLoop() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(dm.config.ShareTargetTime * 10) // 10倍の間隔で調整
	defer ticker.Stop()
	
	for {
		select {
		case <-dm.ctx.Done():
			return
		case <-ticker.C:
			dm.adjustShareDifficulty()
		}
	}
}

func (dm *UnifiedDifficultyManager) adjustShareDifficulty() {
	// シェアバッファに十分なデータがあるか確認
	if dm.shareBuffer.Count() < 10 {
		return
	}
	
	// 新しいシェア難易度を計算
	newDiff := dm.GetShareDifficulty()
	
	dm.logger.Debug("Share difficulty adjusted",
		zap.Float64("new_difficulty", newDiff),
		zap.Duration("average_time", dm.shareBuffer.AverageInterval()))
}

// statsUpdater - 統計を更新
func (dm *UnifiedDifficultyManager) statsUpdater() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-dm.ctx.Done():
			return
		case <-ticker.C:
			dm.updateStats()
		}
	}
}

func (dm *UnifiedDifficultyManager) updateStats() {
	dm.historyMu.RLock()
	defer dm.historyMu.RUnlock()
	
	if len(dm.blockHistory) < 2 {
		return
	}
	
	// 平均ブロック時間を計算
	totalTime := dm.blockHistory[len(dm.blockHistory)-1].Timestamp.Sub(dm.blockHistory[0].Timestamp)
	avgBlockTime := totalTime / time.Duration(len(dm.blockHistory)-1)
	dm.stats.AverageBlockTime.Store(avgBlockTime)
	
	// 現在のハッシュレートを計算
	currentDiff := dm.GetCurrentDifficulty()
	diffFloat, _ := currentDiff.Float64()
	hashRate := diffFloat * math.Pow(2, 32) / dm.targetBlockTime.Seconds()
	dm.stats.CurrentHashRate.Store(hashRate)
	
	// 安定性スコアを計算
	stability := dm.calculateStabilityScore()
	dm.stats.StabilityScore.Store(stability)
}

func (dm *UnifiedDifficultyManager) updateBlockStats(block *BlockInfo) {
	// ハッシュレート推定を更新
	if block.HashRate > 0 {
		dm.stats.CurrentHashRate.Store(block.HashRate)
	}
}

func (dm *UnifiedDifficultyManager) calculateStabilityScore() float64 {
	if len(dm.blockHistory) < 10 {
		return 0.5
	}
	
	// ブロック時間の分散を計算
	blockTimes := make([]float64, 0)
	for i := 1; i < len(dm.blockHistory); i++ {
		blockTime := dm.blockHistory[i].Timestamp.Sub(dm.blockHistory[i-1].Timestamp)
		blockTimes = append(blockTimes, blockTime.Seconds())
	}
	
	// 平均を計算
	sum := 0.0
	for _, bt := range blockTimes {
		sum += bt
	}
	mean := sum / float64(len(blockTimes))
	
	// 分散を計算
	variance := 0.0
	for _, bt := range blockTimes {
		variance += math.Pow(bt-mean, 2)
	}
	variance /= float64(len(blockTimes))
	
	// 変動係数を計算
	cv := math.Sqrt(variance) / mean
	
	// 安定性スコアに変換（0-1、1が最も安定）
	stability := 1.0 / (1.0 + cv)
	
	return stability
}

// ヘルパーメソッド

func (dm *UnifiedDifficultyManager) applyAdjustmentLimits(currentDiff, newDiff *big.Float, adjustmentFactor float64) (*big.Float, float64) {
	if adjustmentFactor > dm.config.MaxAdjustmentFactor {
		adjustmentFactor = dm.config.MaxAdjustmentFactor
		newDiff = new(big.Float).Mul(currentDiff, big.NewFloat(adjustmentFactor))
	} else if adjustmentFactor < dm.config.MinAdjustmentFactor {
		adjustmentFactor = dm.config.MinAdjustmentFactor
		newDiff = new(big.Float).Mul(currentDiff, big.NewFloat(adjustmentFactor))
	}
	return newDiff, adjustmentFactor
}

func (dm *UnifiedDifficultyManager) applyDifficultyBounds(diff *big.Float) *big.Float {
	if dm.config.MinDifficulty != nil && diff.Cmp(dm.config.MinDifficulty) < 0 {
		return new(big.Float).Copy(dm.config.MinDifficulty)
	}
	if dm.config.MaxDifficulty != nil && diff.Cmp(dm.config.MaxDifficulty) > 0 {
		return new(big.Float).Copy(dm.config.MaxDifficulty)
	}
	return diff
}

// ShareTimeBuffer実装

func newShareTimeBuffer(size int) *ShareTimeBuffer {
	return &ShareTimeBuffer{
		times:     make([]time.Time, size),
		intervals: make([]time.Duration, size),
		size:      size,
	}
}

func (b *ShareTimeBuffer) Add(t time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	// 循環バッファに追加
	b.times[b.index] = t
	
	// 前回からの間隔を計算
	if b.count > 0 {
		prevIndex := (b.index - 1 + b.size) % b.size
		if !b.times[prevIndex].IsZero() {
			b.intervals[b.index] = t.Sub(b.times[prevIndex])
		}
	}
	
	b.index = (b.index + 1) % b.size
	if b.count < b.size {
		b.count++
	}
}

func (b *ShareTimeBuffer) AverageInterval() time.Duration {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	if b.count < 2 {
		return 0
	}
	
	var sum time.Duration
	validCount := 0
	
	for i := 0; i < b.count && i < b.size; i++ {
		if b.intervals[i] > 0 {
			sum += b.intervals[i]
			validCount++
		}
	}
	
	if validCount == 0 {
		return 0
	}
	
	return sum / time.Duration(validCount)
}

func (b *ShareTimeBuffer) Variance() float64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	if b.count < 2 {
		return 0
	}
	
	avg := b.AverageInterval()
	if avg == 0 {
		return 0
	}
	
	avgSeconds := avg.Seconds()
	var sumSquares float64
	validCount := 0
	
	for i := 0; i < b.count && i < b.size; i++ {
		if b.intervals[i] > 0 {
			diff := b.intervals[i].Seconds() - avgSeconds
			sumSquares += diff * diff
			validCount++
		}
	}
	
	if validCount < 2 {
		return 0
	}
	
	return sumSquares / float64(validCount-1)
}

func (b *ShareTimeBuffer) Count() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.count
}

// アルゴリズム実装

// SimpleAlgorithm - シンプルな時間ベースの調整
type SimpleAlgorithm struct{}

func (sa *SimpleAlgorithm) Name() string {
	return "simple"
}

func (sa *SimpleAlgorithm) RequiredBlocks() int {
	return 10
}

func (sa *SimpleAlgorithm) CalculateNewDifficulty(currentDiff *big.Float, blocks []*BlockInfo, config DifficultyManagerConfig) (*big.Float, float64) {
	if len(blocks) < 2 {
		return currentDiff, 1.0
	}
	
	// 実際の時間を計算
	actualTime := blocks[len(blocks)-1].Timestamp.Sub(blocks[0].Timestamp)
	expectedTime := config.TargetBlockTime * time.Duration(len(blocks)-1)
	
	// 調整係数を計算
	adjustmentFactor := expectedTime.Seconds() / actualTime.Seconds()
	
	// 新しい難易度を計算
	newDiff := new(big.Float).Mul(currentDiff, big.NewFloat(adjustmentFactor))
	
	return newDiff, adjustmentFactor
}

// BitcoinAlgorithm - Bitcoinの難易度調整
type BitcoinAlgorithm struct{}

func (ba *BitcoinAlgorithm) Name() string {
	return "bitcoin"
}

func (ba *BitcoinAlgorithm) RequiredBlocks() int {
	return 2016
}

func (ba *BitcoinAlgorithm) CalculateNewDifficulty(currentDiff *big.Float, blocks []*BlockInfo, config DifficultyManagerConfig) (*big.Float, float64) {
	if len(blocks) < 2 {
		return currentDiff, 1.0
	}
	
	// 実際の時間を計算
	actualTimespan := blocks[len(blocks)-1].Timestamp.Sub(blocks[0].Timestamp)
	
	// 調整係数を計算
	adjustmentFactor := config.RetargetTimespan.Seconds() / actualTimespan.Seconds()
	
	// 制限を適用
	if adjustmentFactor > 4.0 {
		adjustmentFactor = 4.0
	} else if adjustmentFactor < 0.25 {
		adjustmentFactor = 0.25
	}
	
	// 新しい難易度を計算
	newDiff := new(big.Float).Mul(currentDiff, big.NewFloat(adjustmentFactor))
	
	return newDiff, adjustmentFactor
}

// 他のアルゴリズム実装（EthereumAlgorithm、DigiShieldAlgorithm等）も同様に実装...