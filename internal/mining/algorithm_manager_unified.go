package mining

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
	"go.uber.org/zap"
)

// UnifiedAlgorithmManager - 統合されたアルゴリズム管理システム
// John Carmack, Robert C. Martin, Rob Pikeの設計原則を適用
type UnifiedAlgorithmManager struct {
	logger *zap.Logger
	config AlgorithmManagerConfig
	
	// 現在のアルゴリズム
	currentAlgorithm atomic.Value // AlgorithmInstance
	currentAlgoName  atomic.Value // string
	
	// アルゴリズムレジストリ
	algorithms  map[string]AlgorithmFactory
	algoInfo    map[string]*AlgorithmInfo
	algoMu      sync.RWMutex
	
	// 利益性追跡
	profitability map[string]*ProfitabilityData
	profitMu      sync.RWMutex
	
	// ベンチマーク
	benchmarks   map[HardwareType]map[string]float64
	benchmarksMu sync.RWMutex
	
	// 統計
	stats        *AlgorithmStats
	switchCount  atomic.Uint64
	lastSwitch   atomic.Value // time.Time
	
	// コールバック
	onSwitch     func(from, to string)
	
	// ライフサイクル
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// AlgorithmManagerConfig - アルゴリズムマネージャー設定
type AlgorithmManagerConfig struct {
	// 自動切り替え設定
	AutoSwitch          bool          `json:"auto_switch"`
	SwitchInterval      time.Duration `json:"switch_interval"`
	MinProfitDifference float64       `json:"min_profit_difference"`
	SwitchCooldown      time.Duration `json:"switch_cooldown"`
	
	// アルゴリズム設定
	EnabledAlgorithms   []string      `json:"enabled_algorithms"`
	PreferredAlgorithm  string        `json:"preferred_algorithm"`
	BenchmarkOnStart    bool          `json:"benchmark_on_start"`
	
	// 利益性設定
	ProfitabilitySource string        `json:"profitability_source"`
	UpdateInterval      time.Duration `json:"update_interval"`
	PowerCostPerKWh     float64       `json:"power_cost_per_kwh"`
	
	// ハードウェア優先設定
	PreferGPUAlgorithms bool          `json:"prefer_gpu_algorithms"`
	PreferASICAlgorithms bool         `json:"prefer_asic_algorithms"`
}

// AlgorithmInfo - アルゴリズム情報
type AlgorithmInfo struct {
	Name            string
	Version         string
	HardwareSupport map[HardwareType]bool
	OptimalHardware HardwareType
	Hashrate        map[HardwareType]float64
	PowerUsage      map[HardwareType]float64
	Description     string
	RequiresDAG     bool
	DAGSize         uint64
}

// AlgorithmInstance - マイニングアルゴリズム実装インターフェース
type AlgorithmInstance interface {
	// アルゴリズム情報
	Name() string
	Version() string
	Info() *AlgorithmInfo
	
	// マイニング操作
	Hash(data []byte) []byte
	HashWithNonce(header []byte, nonce uint32) []byte
	ValidateHash(hash []byte, target []byte) bool
	GenerateWork(template *BlockTemplate) (*Work, error)
	
	// パフォーマンス
	GetHashRate() uint64
	SupportsHardwareAcceleration() bool
	GetOptimalBatchSize() int
	
	// ライフサイクル
	Start() error
	Stop() error
}

// AlgorithmFactory - アルゴリズムインスタンスファクトリ
type AlgorithmFactory func(logger *zap.Logger) (AlgorithmInstance, error)

// AlgorithmStats - アルゴリズム統計
type AlgorithmStats struct {
	TotalAdjustments   atomic.Uint64
	SuccessfulSwitches atomic.Uint64
	FailedSwitches     atomic.Uint64
	CurrentHashRate    atomic.Uint64
	BestHashRate       atomic.Uint64
	LastBenchmark      atomic.Value // time.Time
}

// NewUnifiedAlgorithmManager - 統合アルゴリズムマネージャーを作成
func NewUnifiedAlgorithmManager(logger *zap.Logger, config AlgorithmManagerConfig) (*UnifiedAlgorithmManager, error) {
	// デフォルト値設定
	if config.SwitchInterval == 0 {
		config.SwitchInterval = 5 * time.Minute
	}
	if config.UpdateInterval == 0 {
		config.UpdateInterval = 1 * time.Minute
	}
	if config.MinProfitDifference == 0 {
		config.MinProfitDifference = 0.1 // 10%
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	manager := &UnifiedAlgorithmManager{
		logger:        logger,
		config:        config,
		algorithms:    make(map[string]AlgorithmFactory),
		algoInfo:      make(map[string]*AlgorithmInfo),
		profitability: make(map[string]*ProfitabilityData),
		benchmarks:    make(map[HardwareType]map[string]float64),
		stats:         &AlgorithmStats{},
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// デフォルトアルゴリズムを登録
	manager.registerDefaultAlgorithms()
	
	// 初期アルゴリズムを設定
	if config.PreferredAlgorithm != "" {
		if err := manager.SetAlgorithm(config.PreferredAlgorithm); err != nil {
			logger.Warn("Failed to set preferred algorithm", 
				zap.String("algorithm", config.PreferredAlgorithm),
				zap.Error(err))
		}
	}
	
	manager.lastSwitch.Store(time.Now())
	
	return manager, nil
}

// Start - マネージャーを開始
func (m *UnifiedAlgorithmManager) Start() error {
	m.logger.Info("Starting unified algorithm manager",
		zap.Bool("auto_switch", m.config.AutoSwitch),
		zap.Strings("enabled_algorithms", m.config.EnabledAlgorithms))
	
	// 現在のアルゴリズムを開始
	if algo := m.GetCurrentAlgorithm(); algo != nil {
		if err := algo.Start(); err != nil {
			return fmt.Errorf("failed to start algorithm: %w", err)
		}
	}
	
	// ベンチマークを実行
	if m.config.BenchmarkOnStart {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			m.runBenchmarks()
		}()
	}
	
	// 自動切り替えを開始
	if m.config.AutoSwitch {
		m.wg.Add(1)
		go m.autoSwitchLoop()
		
		m.wg.Add(1)
		go m.profitabilityUpdateLoop()
	}
	
	return nil
}

// Stop - マネージャーを停止
func (m *UnifiedAlgorithmManager) Stop() error {
	m.logger.Info("Stopping algorithm manager")
	
	m.cancel()
	m.wg.Wait()
	
	// 現在のアルゴリズムを停止
	if algo := m.GetCurrentAlgorithm(); algo != nil {
		algo.Stop()
	}
	
	return nil
}

// SetAlgorithm - アルゴリズムを設定
func (m *UnifiedAlgorithmManager) SetAlgorithm(name string) error {
	// アルゴリズムが有効か確認
	if !m.isAlgorithmEnabled(name) {
		return fmt.Errorf("algorithm %s is not enabled", name)
	}
	
	// クールダウンチェック
	if lastSwitch, ok := m.lastSwitch.Load().(time.Time); ok {
		if time.Since(lastSwitch) < m.config.SwitchCooldown {
			return errors.New("switch cooldown period active")
		}
	}
	
	// 新しいアルゴリズムインスタンスを作成
	newAlgo, err := m.createAlgorithm(name)
	if err != nil {
		return fmt.Errorf("failed to create algorithm: %w", err)
	}
	
	// 新しいアルゴリズムを開始
	if err := newAlgo.Start(); err != nil {
		return fmt.Errorf("failed to start new algorithm: %w", err)
	}
	
	// 現在のアルゴリズムを取得
	oldAlgo := m.GetCurrentAlgorithm()
	oldName := m.GetCurrentAlgorithmName()
	
	// アルゴリズムを切り替え
	m.currentAlgorithm.Store(newAlgo)
	m.currentAlgoName.Store(name)
	m.lastSwitch.Store(time.Now())
	m.switchCount.Add(1)
	m.stats.SuccessfulSwitches.Add(1)
	
	// 古いアルゴリズムを停止
	if oldAlgo != nil {
		go func() {
			time.Sleep(5 * time.Second) // グレース期間
			oldAlgo.Stop()
		}()
	}
	
	m.logger.Info("Algorithm switched",
		zap.String("from", oldName),
		zap.String("to", name),
		zap.Uint64("switch_count", m.switchCount.Load()))
	
	// コールバック
	if m.onSwitch != nil {
		m.onSwitch(oldName, name)
	}
	
	return nil
}

// GetCurrentAlgorithm - 現在のアルゴリズムを取得
func (m *UnifiedAlgorithmManager) GetCurrentAlgorithm() AlgorithmInstance {
	if algo := m.currentAlgorithm.Load(); algo != nil {
		return algo.(AlgorithmInstance)
	}
	return nil
}

// GetCurrentAlgorithmName - 現在のアルゴリズム名を取得
func (m *UnifiedAlgorithmManager) GetCurrentAlgorithmName() string {
	if name := m.currentAlgoName.Load(); name != nil {
		return name.(string)
	}
	return ""
}

// GetBestAlgorithmForHardware - ハードウェアに最適なアルゴリズムを取得
func (m *UnifiedAlgorithmManager) GetBestAlgorithmForHardware(hardware HardwareType) (*AlgorithmInfo, error) {
	m.algoMu.RLock()
	defer m.algoMu.RUnlock()
	
	var bestAlgo *AlgorithmInfo
	var bestHashrate float64
	
	for _, algo := range m.algoInfo {
		// ハードウェアサポートを確認
		if supported, ok := algo.HardwareSupport[hardware]; !ok || !supported {
			continue
		}
		
		// ハッシュレートを確認
		if hashrate, ok := algo.Hashrate[hardware]; ok && hashrate > bestHashrate {
			bestHashrate = hashrate
			bestAlgo = algo
		}
	}
	
	if bestAlgo == nil {
		return nil, fmt.Errorf("no suitable algorithm found for hardware type: %s", hardware)
	}
	
	return bestAlgo, nil
}

// GetProfitability - 利益性データを取得
func (m *UnifiedAlgorithmManager) GetProfitability() map[string]*ProfitabilityData {
	m.profitMu.RLock()
	defer m.profitMu.RUnlock()
	
	// コピーを返す
	result := make(map[string]*ProfitabilityData)
	for k, v := range m.profitability {
		result[k] = v
	}
	return result
}

// GetStats - 統計を取得
func (m *UnifiedAlgorithmManager) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"current_algorithm":    m.GetCurrentAlgorithmName(),
		"total_adjustments":    m.stats.TotalAdjustments.Load(),
		"successful_switches":  m.stats.SuccessfulSwitches.Load(),
		"failed_switches":      m.stats.FailedSwitches.Load(),
		"current_hashrate":     m.stats.CurrentHashRate.Load(),
		"best_hashrate":        m.stats.BestHashRate.Load(),
		"switch_count":         m.switchCount.Load(),
	}
	
	if lastSwitch, ok := m.lastSwitch.Load().(time.Time); ok {
		stats["last_switch"] = lastSwitch
		stats["time_since_switch"] = time.Since(lastSwitch).String()
	}
	
	if lastBenchmark, ok := m.stats.LastBenchmark.Load().(time.Time); ok {
		stats["last_benchmark"] = lastBenchmark
	}
	
	return stats
}

// RegisterAlgorithm - アルゴリズムを登録
func (m *UnifiedAlgorithmManager) RegisterAlgorithm(name string, factory AlgorithmFactory, info *AlgorithmInfo) {
	m.algoMu.Lock()
	defer m.algoMu.Unlock()
	
	m.algorithms[name] = factory
	m.algoInfo[name] = info
	
	m.logger.Info("Algorithm registered",
		zap.String("algorithm", name),
	)
}

// プライベートメソッド

// registerDefaultAlgorithms - デフォルトアルゴリズムを登録
func (m *UnifiedAlgorithmManager) registerDefaultAlgorithms() {
	// SHA256d (Bitcoin)
	m.RegisterAlgorithm("sha256d", 
		func(logger *zap.Logger) (AlgorithmInstance, error) {
			return NewSHA256dAlgorithm(logger)
		},
		&AlgorithmInfo{
			Name:    "SHA256d",
			Version: "1.0.0",
			HardwareSupport: map[HardwareType]bool{
				HardwareCPU:  true,
				HardwareGPU:  true,
				HardwareASIC: true,
			},
			OptimalHardware: HardwareASIC,
			Hashrate: map[HardwareType]float64{
				HardwareCPU:  100e6,    // 100 MH/s
				HardwareGPU:  1e9,      // 1 GH/s
				HardwareASIC: 100e12,   // 100 TH/s
			},
			PowerUsage: map[HardwareType]float64{
				HardwareCPU:  100,  // 100W
				HardwareGPU:  200,  // 200W
				HardwareASIC: 3000, // 3000W
			},
			Description: "Double SHA256 used by Bitcoin",
		})
	
	// Ethash (Ethereum Classic)
	m.RegisterAlgorithm("ethash",
		func(logger *zap.Logger) (AlgorithmInstance, error) {
			return NewEthashAlgorithm(logger)
		},
		&AlgorithmInfo{
			Name:    "Ethash",
			Version: "1.0.0",
			HardwareSupport: map[HardwareType]bool{
				HardwareCPU:  false,
				HardwareGPU:  true,
				HardwareASIC: true,
			},
			OptimalHardware: HardwareGPU,
			Hashrate: map[HardwareType]float64{
				HardwareGPU:  30e6,   // 30 MH/s
				HardwareASIC: 200e6,  // 200 MH/s
			},
			PowerUsage: map[HardwareType]float64{
				HardwareGPU:  150, // 150W
				HardwareASIC: 800, // 800W
			},
			Description: "Memory-hard algorithm for Ethereum Classic",
			RequiresDAG: true,
			DAGSize:     4e9, // 4GB
		})
	
	// RandomX (Monero)
	m.RegisterAlgorithm("randomx",
		func(logger *zap.Logger) (AlgorithmInstance, error) {
			return NewRandomXAlgorithm(logger)
		},
		&AlgorithmInfo{
			Name:    "RandomX",
			Version: "1.0.0",
			HardwareSupport: map[HardwareType]bool{
				HardwareCPU: true,
				HardwareGPU: false,
				HardwareASIC: false,
			},
			OptimalHardware: HardwareCPU,
			Hashrate: map[HardwareType]float64{
				HardwareCPU: 10e3, // 10 KH/s
			},
			PowerUsage: map[HardwareType]float64{
				HardwareCPU: 100, // 100W
			},
			Description: "CPU-optimized algorithm for Monero",
		})
	
	// Scrypt (Litecoin)
	m.RegisterAlgorithm("scrypt",
		func(logger *zap.Logger) (AlgorithmInstance, error) {
			return NewScryptAlgorithm(logger)
		},
		&AlgorithmInfo{
			Name:    "Scrypt",
			Version: "1.0.0",
			HardwareSupport: map[HardwareType]bool{
				HardwareCPU:  true,
				HardwareGPU:  true,
				HardwareASIC: true,
			},
			OptimalHardware: HardwareASIC,
			Hashrate: map[HardwareType]float64{
				HardwareCPU:  100e3,  // 100 KH/s
				HardwareGPU:  1e6,    // 1 MH/s
				HardwareASIC: 500e6,  // 500 MH/s
			},
			PowerUsage: map[HardwareType]float64{
				HardwareCPU:  100,  // 100W
				HardwareGPU:  200,  // 200W
				HardwareASIC: 1000, // 1000W
			},
			Description: "Memory-hard algorithm for Litecoin",
		})
	
	// KawPow (Ravencoin)
	m.RegisterAlgorithm("kawpow",
		func(logger *zap.Logger) (AlgorithmInstance, error) {
			return NewKawPowAlgorithm(logger)
		},
		&AlgorithmInfo{
			Name:    "KawPow",
			Version: "1.0.0",
			HardwareSupport: map[HardwareType]bool{
				HardwareCPU:  false,
				HardwareGPU:  true,
				HardwareASIC: false,
			},
			OptimalHardware: HardwareGPU,
			Hashrate: map[HardwareType]float64{
				HardwareGPU: 20e6, // 20 MH/s
			},
			PowerUsage: map[HardwareType]float64{
				HardwareGPU: 180, // 180W
			},
			Description: "ASIC-resistant algorithm for Ravencoin",
			RequiresDAG: true,
			DAGSize:     3e9, // 3GB
		})
}

// autoSwitchLoop - 自動切り替えループ
func (m *UnifiedAlgorithmManager) autoSwitchLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.SwitchInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.evaluateSwitch()
		}
	}
}

// evaluateSwitch - 切り替えを評価
func (m *UnifiedAlgorithmManager) evaluateSwitch() {
	currentAlgo := m.GetCurrentAlgorithmName()
	
	// 利益性データを取得
	m.profitMu.RLock()
	currentProfit := m.profitability[currentAlgo]
	
	var bestAlgo string
	var bestProfit float64
	
	for algo, data := range m.profitability {
		if !m.isAlgorithmEnabled(algo) {
			continue
		}
		
		// ハードウェア優先設定を確認
		if !m.meetsHardwarePreferences(algo) {
			continue
		}
		
		if data.Profitability > bestProfit {
			bestAlgo = algo
			bestProfit = data.Profitability
		}
	}
	m.profitMu.RUnlock()
	
	// 切り替えが有益か確認
	if bestAlgo != "" && bestAlgo != currentAlgo {
		if currentProfit == nil || 
		   bestProfit > currentProfit.Profitability*(1+m.config.MinProfitDifference) {
			// より収益性の高いアルゴリズムに切り替え
			if err := m.SetAlgorithm(bestAlgo); err != nil {
				m.stats.FailedSwitches.Add(1)
				m.logger.Warn("Failed to switch algorithm",
					zap.String("algorithm", bestAlgo),
					zap.Error(err))
			}
		}
	}
}

// profitabilityUpdateLoop - 利益性更新ループ
func (m *UnifiedAlgorithmManager) profitabilityUpdateLoop() {
	defer m.wg.Done()
	
	// 初期更新
	m.updateProfitability()
	
	ticker := time.NewTicker(m.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.updateProfitability()
		}
	}
}

// updateProfitability - 利益性データを更新
func (m *UnifiedAlgorithmManager) updateProfitability() {
	m.profitMu.Lock()
	defer m.profitMu.Unlock()
	
	// 各アルゴリズムを更新
	for _, algo := range m.config.EnabledAlgorithms {
		hashrate := m.getExpectedHashRate(algo)
		difficulty := m.getNetworkDifficulty(algo)
		blockReward := m.getBlockReward(algo)
		coinPrice := m.getCoinPrice(algo)
		powerCost := m.getPowerCost(algo)
		
		data := &ProfitabilityData{
			Algorithm:     AlgorithmType(algo),
			Hashrate:      hashrate,
			Difficulty:    difficulty,
			BlockReward:   blockReward,
			CoinPrice:     coinPrice,
			PowerCost:     powerCost,
			Profitability: 0,
			LastUpdate:    time.Now(),
		}
		
		// 利益性を計算
		data.Profitability = m.calculateProfitability(data)
		m.profitability[algo] = data
	}
	
	m.stats.TotalAdjustments.Add(1)
}

// calculateProfitability - 利益性を計算
func (m *UnifiedAlgorithmManager) calculateProfitability(data *ProfitabilityData) float64 {
	if data.Difficulty == 0 {
		return 0
	}
	
	// 一日あたりのブロック数を計算
	blocksPerDay := (data.Hashrate / data.Difficulty) * 86400
	
	// 一日あたりの収益を計算
	revenuePerDay := blocksPerDay * data.BlockReward * data.CoinPrice
	
	// 一日あたりの電力コストを計算
	powerCostPerDay := data.PowerCost * 24 * m.config.PowerCostPerKWh / 1000
	
	// 利益を計算
	return revenuePerDay - powerCostPerDay
}

// runBenchmarks - ベンチマークを実行
func (m *UnifiedAlgorithmManager) runBenchmarks() {
	m.logger.Info("Running algorithm benchmarks")
	
	// ベンチマーク結果を初期化
	m.benchmarksMu.Lock()
	for _, hw := range []HardwareType{HardwareCPU, HardwareGPU, HardwareASIC} {
		m.benchmarks[hw] = make(map[string]float64)
	}
	m.benchmarksMu.Unlock()
	
	// 各アルゴリズムをベンチマーク
	for algoName, algoInfo := range m.algoInfo {
		for hw, supported := range algoInfo.HardwareSupport {
			if !supported {
				continue
			}
			
			// ベンチマークを実行
			hashrate := m.runSingleBenchmark(algoName, hw)
			
			m.benchmarksMu.Lock()
			m.benchmarks[hw][algoName] = hashrate
			m.benchmarksMu.Unlock()
			
			// ハッシュレートを更新
			if hashrate > 0 {
				algoInfo.Hashrate[hw] = hashrate
			}
			
			m.logger.Info("Benchmark complete",
				zap.String("algorithm", algoName),
				zap.String("hardware", string(hw)),
				zap.Float64("hashrate", hashrate))
		}
	}
	
	m.stats.LastBenchmark.Store(time.Now())
}

// runSingleBenchmark - 単一ベンチマークを実行
func (m *UnifiedAlgorithmManager) runSingleBenchmark(algorithm string, hardware HardwareType) float64 {
	// アルゴリズムインスタンスを作成
	algo, err := m.createAlgorithm(algorithm)
	if err != nil {
		m.logger.Warn("Failed to create algorithm for benchmark",
			zap.String("algorithm", algorithm),
			zap.Error(err))
		return 0
	}
	
	// アルゴリズムを開始
	if err := algo.Start(); err != nil {
		m.logger.Warn("Failed to start algorithm for benchmark",
			zap.String("algorithm", algorithm),
			zap.Error(err))
		return 0
	}
	defer algo.Stop()
	
	// ベンチマークを実行
	start := time.Now()
	iterations := 1000
	testData := make([]byte, 80)
	
	for i := 0; i < iterations; i++ {
		_ = algo.Hash(testData)
	}
	
	duration := time.Since(start)
	hashrate := float64(iterations) / duration.Seconds()
	
	// 実際のハッシュレートに変換（アルゴリズム固有の係数を適用）
	switch hardware {
	case HardwareGPU:
		hashrate *= 1000 // GPU並列度を考慮
	case HardwareASIC:
		hashrate *= 10000 // ASIC効率を考慮
	}
	
	return hashrate
}

// ヘルパーメソッド

func (m *UnifiedAlgorithmManager) createAlgorithm(name string) (AlgorithmInstance, error) {
	m.algoMu.RLock()
	factory, exists := m.algorithms[name]
	m.algoMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("algorithm factory for '%s' not found", name)
	}
	
	return factory(m.logger)
}

func (m *UnifiedAlgorithmManager) isAlgorithmEnabled(name string) bool {
	for _, enabledAlgo := range m.config.EnabledAlgorithms {
		if enabledAlgo == name {
			return true
		}
	}
	return false
}

func (m *UnifiedAlgorithmManager) meetsHardwarePreferences(algoName string) bool {
	m.algoMu.RLock()
	algoInfo, exists := m.algoInfo[algoName]
	m.algoMu.RUnlock()
	
	if !exists {
		return false
	}
	
	// GPU優先設定を確認
	if m.config.PreferGPUAlgorithms {
		if !algoInfo.HardwareSupport[HardwareGPU] {
			return false
		}
	}
	
	// ASIC優先設定を確認
	if m.config.PreferASICAlgorithms {
		if !algoInfo.HardwareSupport[HardwareASIC] {
			return false
		}
	}
	
	return true
}

// プレースホルダーメソッド（実際の実装では外部APIを使用）

func (m *UnifiedAlgorithmManager) getExpectedHashRate(algo string) float64 {
	// ベンチマーク結果を使用
	m.benchmarksMu.RLock()
	defer m.benchmarksMu.RUnlock()
	
	// 利用可能なハードウェアの最高ハッシュレートを返す
	maxHashrate := 0.0
	for _, hwBenchmarks := range m.benchmarks {
		if rate, ok := hwBenchmarks[algo]; ok && rate > maxHashrate {
			maxHashrate = rate
		}
	}
	
	if maxHashrate > 0 {
		return maxHashrate
	}
	
	// デフォルト値
	switch algo {
	case "sha256d":
		return 100_000_000_000 // 100 GH/s
	case "scrypt":
		return 1_000_000 // 1 MH/s
	case "ethash":
		return 50_000_000 // 50 MH/s
	case "randomx":
		return 10_000 // 10 KH/s
	case "kawpow":
		return 20_000_000 // 20 MH/s
	default:
		return 1_000_000
	}
}

func (m *UnifiedAlgorithmManager) getNetworkDifficulty(algo string) float64 {
	// 実際の実装ではネットワークから取得
	return 1000000.0
}

func (m *UnifiedAlgorithmManager) getBlockReward(algo string) float64 {
	// 実際の実装ではネットワークから取得
	switch algo {
	case "sha256d":
		return 6.25 // BTC
	case "scrypt":
		return 12.5 // LTC
	case "ethash":
		return 2.0 // ETC
	case "randomx":
		return 0.6 // XMR
	case "kawpow":
		return 5000 // RVN
	default:
		return 1.0
	}
}

func (m *UnifiedAlgorithmManager) getCoinPrice(algo string) float64 {
	// 実際の実装では価格APIから取得
	switch algo {
	case "sha256d":
		return 50000.0 // USD
	case "scrypt":
		return 200.0
	case "ethash":
		return 30.0
	case "randomx":
		return 150.0
	case "kawpow":
		return 0.05
	default:
		return 100.0
	}
}

func (m *UnifiedAlgorithmManager) getPowerCost(algo string) float64 {
	// 実際の実装ではハードウェア情報から計算
	m.algoMu.RLock()
	algoInfo, exists := m.algoInfo[algo]
	m.algoMu.RUnlock()
	
	if !exists {
		return 100 // デフォルト100W
	}
	
	// 利用可能なハードウェアの最小電力使用量を返す
	minPower := math.MaxFloat64
	for hw, power := range algoInfo.PowerUsage {
		if algoInfo.HardwareSupport[hw] && power < minPower {
			minPower = power
		}
	}
	
	if minPower == math.MaxFloat64 {
		return 100
	}
	
	return minPower
}

// BlockTemplate - ブロックテンプレート
type BlockTemplate struct {
	Height      uint64
	PrevHash    [32]byte
	MerkleRoot  [32]byte
	Timestamp   int64
	Bits        uint32
	ExtraNonce1 uint32
	ExtraNonce2 uint32
}

// ProfitabilityData は `internal/mining/types.go` で定義されています。
// ここでの重複定義は削除しました。（重複による再宣言エラー回避のため）