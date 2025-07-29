package stratum

import (
	"math"
	"sync"
	"time"
)

// DifficultyAdjuster は高度な難易度調整アルゴリズム
type DifficultyAdjuster struct {
	config         DifficultyConfig
	shareHistory   *ShareHistory
	mu             sync.RWMutex
}

// DifficultyConfig は難易度調整設定
type DifficultyConfig struct {
	// 基本設定
	InitialDiff    float64
	MinDiff        float64
	MaxDiff        float64
	TargetTime     float64 // 目標シェア間隔（秒）
	RetargetTime   float64 // 難易度調整間隔（秒）
	VariancePercent float64 // 許容分散（%）
	
	// 高度な設定
	EnableVarDiff   bool    // 可変難易度有効化
	EnableJumpDiff  bool    // ジャンプ難易度有効化
	MaxJumpFactor   float64 // 最大ジャンプ係数
	SmoothingFactor float64 // 平滑化係数 (0-1)
	
	// パフォーマンス設定
	ShareBufferSize int           // シェア履歴バッファサイズ
	WindowSize      time.Duration // 分析ウィンドウサイズ
}

// ShareHistory はシェア履歴
type ShareHistory struct {
	shares      []ShareRecord
	maxSize     int
	currentIdx  int
	mu          sync.RWMutex
}

// ShareRecord はシェア記録
type ShareRecord struct {
	Timestamp  time.Time
	Difficulty float64
	Valid      bool
}

// WorkerStats はワーカー統計
type WorkerStats struct {
	LastShareTime   time.Time
	ShareCount      uint64
	CurrentDiff     float64
	AverageHashRate float64
	ShareTimes      []time.Duration
}

// NewDifficultyAdjuster は新しい難易度調整器を作成
func NewDifficultyAdjuster(config DifficultyConfig) *DifficultyAdjuster {
	return &DifficultyAdjuster{
		config: config,
		shareHistory: &ShareHistory{
			shares:  make([]ShareRecord, config.ShareBufferSize),
			maxSize: config.ShareBufferSize,
		},
	}
}

// AdjustDifficulty はワーカーの難易度を調整
func (da *DifficultyAdjuster) AdjustDifficulty(worker *WorkerStats) float64 {
	da.mu.Lock()
	defer da.mu.Unlock()
	
	// 初回または履歴不足の場合
	if len(worker.ShareTimes) < 3 {
		return worker.CurrentDiff
	}
	
	// 基本的な調整アルゴリズム
	newDiff := worker.CurrentDiff
	
	if da.config.EnableVarDiff {
		// 可変難易度アルゴリズム
		newDiff = da.calculateVarDiff(worker)
	}
	
	if da.config.EnableJumpDiff {
		// ジャンプ難易度アルゴリズム
		jumpDiff := da.calculateJumpDiff(worker)
		if math.Abs(jumpDiff-newDiff)/newDiff > 0.5 {
			newDiff = jumpDiff
		}
	}
	
	// 平滑化
	if da.config.SmoothingFactor > 0 {
		newDiff = da.smoothDifficulty(worker.CurrentDiff, newDiff)
	}
	
	// 制限適用
	newDiff = da.applyLimits(newDiff)
	
	return newDiff
}

// calculateVarDiff は可変難易度を計算
func (da *DifficultyAdjuster) calculateVarDiff(worker *WorkerStats) float64 {
	// 平均シェア時間を計算
	avgShareTime := da.calculateAverageShareTime(worker.ShareTimes)
	
	// 目標からの偏差を計算
	deviation := avgShareTime - da.config.TargetTime
	deviationPercent := deviation / da.config.TargetTime * 100
	
	// 新しい難易度を計算
	adjustmentFactor := 1.0
	
	if math.Abs(deviationPercent) > da.config.VariancePercent {
		// PID制御風のアルゴリズム
		proportional := deviation / da.config.TargetTime
		integral := da.calculateIntegral(worker)
		derivative := da.calculateDerivative(worker)
		
		// PID係数（調整可能）
		kp := 0.5
		ki := 0.1
		kd := 0.05
		
		adjustment := kp*proportional + ki*integral + kd*derivative
		adjustmentFactor = 1.0 + adjustment
	}
	
	return worker.CurrentDiff * adjustmentFactor
}

// calculateJumpDiff はジャンプ難易度を計算
func (da *DifficultyAdjuster) calculateJumpDiff(worker *WorkerStats) float64 {
	// ハッシュレートベースの難易度計算
	if worker.AverageHashRate > 0 {
		// 目標シェア時間を達成するための理論的難易度
		targetDiff := worker.AverageHashRate * da.config.TargetTime / math.Pow(2, 32)
		
		// 大幅な乖離がある場合はジャンプ
		currentToTarget := targetDiff / worker.CurrentDiff
		if currentToTarget > da.config.MaxJumpFactor {
			return worker.CurrentDiff * da.config.MaxJumpFactor
		} else if currentToTarget < 1.0/da.config.MaxJumpFactor {
			return worker.CurrentDiff / da.config.MaxJumpFactor
		}
		
		return targetDiff
	}
	
	// ハッシュレートが不明な場合は通常の調整
	return worker.CurrentDiff
}

// smoothDifficulty は難易度を平滑化
func (da *DifficultyAdjuster) smoothDifficulty(current, target float64) float64 {
	// 指数移動平均（EMA）を使用
	alpha := da.config.SmoothingFactor
	return alpha*target + (1-alpha)*current
}

// applyLimits は難易度制限を適用
func (da *DifficultyAdjuster) applyLimits(diff float64) float64 {
	if diff < da.config.MinDiff {
		return da.config.MinDiff
	}
	if diff > da.config.MaxDiff {
		return da.config.MaxDiff
	}
	return diff
}

// calculateAverageShareTime は平均シェア時間を計算
func (da *DifficultyAdjuster) calculateAverageShareTime(shareTimes []time.Duration) float64 {
	if len(shareTimes) == 0 {
		return da.config.TargetTime
	}
	
	// 外れ値を除外した平均を計算
	sorted := make([]time.Duration, len(shareTimes))
	copy(sorted, shareTimes)
	
	// 簡易的な外れ値除去（上下10%を除外）
	trimCount := len(sorted) / 10
	if trimCount > 0 && len(sorted) > 2*trimCount {
		sorted = sorted[trimCount : len(sorted)-trimCount]
	}
	
	var sum time.Duration
	for _, t := range sorted {
		sum += t
	}
	
	return sum.Seconds() / float64(len(sorted))
}

// calculateIntegral は積分項を計算
func (da *DifficultyAdjuster) calculateIntegral(worker *WorkerStats) float64 {
	// 簡易的な積分計算
	integral := 0.0
	for i, shareTime := range worker.ShareTimes {
		if i > 0 {
			deviation := shareTime.Seconds() - da.config.TargetTime
			integral += deviation
		}
	}
	return integral / float64(len(worker.ShareTimes))
}

// calculateDerivative は微分項を計算
func (da *DifficultyAdjuster) calculateDerivative(worker *WorkerStats) float64 {
	// 簡易的な微分計算
	if len(worker.ShareTimes) < 2 {
		return 0.0
	}
	
	lastIdx := len(worker.ShareTimes) - 1
	lastDeviation := worker.ShareTimes[lastIdx].Seconds() - da.config.TargetTime
	prevDeviation := worker.ShareTimes[lastIdx-1].Seconds() - da.config.TargetTime
	
	return lastDeviation - prevDeviation
}

// RecordShare はシェアを記録
func (da *DifficultyAdjuster) RecordShare(timestamp time.Time, difficulty float64, valid bool) {
	da.shareHistory.mu.Lock()
	defer da.shareHistory.mu.Unlock()
	
	record := ShareRecord{
		Timestamp:  timestamp,
		Difficulty: difficulty,
		Valid:      valid,
	}
	
	da.shareHistory.shares[da.shareHistory.currentIdx] = record
	da.shareHistory.currentIdx = (da.shareHistory.currentIdx + 1) % da.shareHistory.maxSize
}

// GetShareStats はシェア統計を取得
func (da *DifficultyAdjuster) GetShareStats(window time.Duration) map[string]interface{} {
	da.shareHistory.mu.RLock()
	defer da.shareHistory.mu.RUnlock()
	
	cutoff := time.Now().Add(-window)
	validShares := 0
	totalShares := 0
	var totalDiff float64
	
	for _, share := range da.shareHistory.shares {
		if share.Timestamp.After(cutoff) && !share.Timestamp.IsZero() {
			totalShares++
			totalDiff += share.Difficulty
			if share.Valid {
				validShares++
			}
		}
	}
	
	avgDiff := float64(0)
	acceptRate := float64(0)
	
	if totalShares > 0 {
		avgDiff = totalDiff / float64(totalShares)
		acceptRate = float64(validShares) / float64(totalShares) * 100
	}
	
	return map[string]interface{}{
		"total_shares":      totalShares,
		"valid_shares":      validShares,
		"accept_rate":       acceptRate,
		"average_difficulty": avgDiff,
		"window_seconds":    window.Seconds(),
	}
}

// DefaultDifficultyConfig はデフォルトの難易度設定
func DefaultDifficultyConfig() DifficultyConfig {
	return DifficultyConfig{
		InitialDiff:     1000.0,
		MinDiff:         100.0,
		MaxDiff:         1000000.0,
		TargetTime:      10.0,
		RetargetTime:    60.0,
		VariancePercent: 30.0,
		EnableVarDiff:   true,
		EnableJumpDiff:  true,
		MaxJumpFactor:   4.0,
		SmoothingFactor: 0.3,
		ShareBufferSize: 1000,
		WindowSize:      10 * time.Minute,
	}
}