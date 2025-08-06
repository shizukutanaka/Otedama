package defi

import (
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// StakingPool represents a staking pool for DeFi functionality
type StakingPool struct {
	ID             string
	Token          Token
	RewardToken    Token
	TotalStaked    *big.Int
	RewardRate     *big.Int // Rewards per second
	LastUpdateTime time.Time
	
	// Staker information
	stakers        map[string]*Staker
	stakersMu      sync.RWMutex
	
	// Pool statistics
	totalRewards   *big.Int
	totalStakers   atomic.Uint64
	
	// Configuration
	minStakeAmount *big.Int
	lockPeriod     time.Duration
	active         bool
	
	mu             sync.RWMutex
}

// Staker represents an individual staker
type Staker struct {
	Address        string
	StakedAmount   *big.Int
	RewardDebt     *big.Int
	StakedAt       time.Time
	LastClaimAt    time.Time
	TotalRewards   *big.Int
	LockUntil      time.Time
}

// Token represents a token for staking
type Token struct {
	Address  string
	Symbol   string
	Decimals uint8
	Name     string
}

// LendingPosition represents a user's lending position in the DeFi system
type LendingPosition struct {
	User                 string
	Collateral           map[string]uint64
	Borrowed             map[string]uint64
	InterestRate         float64
	LastUpdateBlock      uint64
	AccruedInterest      map[string]uint64
	HealthFactor         float64
	LiquidationThreshold float64
}

// StakingManager manages multiple staking pools
type StakingManager struct {
	logger *zap.Logger
	
	// Staking pools
	pools    map[string]*StakingPool
	poolsMu  sync.RWMutex
	
	// Statistics
	totalPools   atomic.Uint64
	totalTVL     atomic.Uint64
}

// NewStakingManager creates a new staking manager
func NewStakingManager(logger *zap.Logger) *StakingManager {
	return &StakingManager{
		logger: logger,
		pools:  make(map[string]*StakingPool),
	}
}

// CreateStakingPool creates a new staking pool
func (sm *StakingManager) CreateStakingPool(
	poolID string,
	stakingToken, rewardToken Token,
	rewardRate *big.Int,
	minStakeAmount *big.Int,
	lockPeriod time.Duration,
) (*StakingPool, error) {
	sm.poolsMu.Lock()
	defer sm.poolsMu.Unlock()
	
	// Check if pool already exists
	if _, exists := sm.pools[poolID]; exists {
		return nil, fmt.Errorf("staking pool already exists: %s", poolID)
	}
	
	pool := &StakingPool{
		ID:             poolID,
		Token:          stakingToken,
		RewardToken:    rewardToken,
		TotalStaked:    big.NewInt(0),
		RewardRate:     new(big.Int).Set(rewardRate),
		LastUpdateTime: time.Now(),
		stakers:        make(map[string]*Staker),
		totalRewards:   big.NewInt(0),
		minStakeAmount: new(big.Int).Set(minStakeAmount),
		lockPeriod:     lockPeriod,
		active:         true,
	}
	
	sm.pools[poolID] = pool
	sm.totalPools.Add(1)
	
	sm.logger.Info("Created staking pool",
		zap.String("pool_id", poolID),
		zap.String("staking_token", stakingToken.Symbol),
		zap.String("reward_token", rewardToken.Symbol),
		zap.String("reward_rate", rewardRate.String()),
		zap.Duration("lock_period", lockPeriod),
	)
	
	return pool, nil
}

// Stake allows a user to stake tokens
func (sm *StakingManager) Stake(poolID, userAddress string, amount *big.Int) error {
	sm.poolsMu.RLock()
	pool, exists := sm.pools[poolID]
	sm.poolsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("staking pool not found: %s", poolID)
	}
	
	if !pool.active {
		return fmt.Errorf("staking pool is not active: %s", poolID)
	}
	
	// Check minimum stake amount
	if amount.Cmp(pool.minStakeAmount) < 0 {
		return fmt.Errorf("stake amount below minimum: %s < %s", 
			amount.String(), pool.minStakeAmount.String())
	}
	
	pool.mu.Lock()
	defer pool.mu.Unlock()
	
	// Update pool rewards before staking
	sm.updatePoolRewards(pool)
	
	pool.stakersMu.Lock()
	defer pool.stakersMu.Unlock()
	
	staker, exists := pool.stakers[userAddress]
	if !exists {
		// New staker
		staker = &Staker{
			Address:      userAddress,
			StakedAmount: big.NewInt(0),
			RewardDebt:   big.NewInt(0),
			StakedAt:     time.Now(),
			LastClaimAt:  time.Now(),
			TotalRewards: big.NewInt(0),
			LockUntil:    time.Now().Add(pool.lockPeriod),
		}
		pool.stakers[userAddress] = staker
		pool.totalStakers.Add(1)
	} else {
		// Existing staker - claim pending rewards first
		pendingRewards := sm.calculatePendingRewards(pool, staker)
		staker.TotalRewards.Add(staker.TotalRewards, pendingRewards)
		staker.LastClaimAt = time.Now()
	}
	
	// Add to stake
	staker.StakedAmount.Add(staker.StakedAmount, amount)
	pool.TotalStaked.Add(pool.TotalStaked, amount)
	
	// Update lock period for new stake
	staker.LockUntil = time.Now().Add(pool.lockPeriod)
	
	// Calculate reward debt (amount of rewards user has already "earned")
	if pool.TotalStaked.Cmp(big.NewInt(0)) > 0 {
		rewardPerToken := new(big.Int).Mul(pool.RewardRate, big.NewInt(int64(time.Since(pool.LastUpdateTime).Seconds())))
		rewardPerToken.Div(rewardPerToken, pool.TotalStaked)
		staker.RewardDebt.Mul(staker.StakedAmount, rewardPerToken)
	}
	
	sm.logger.Info("Tokens staked",
		zap.String("pool_id", poolID),
		zap.String("user", userAddress),
		zap.String("amount", amount.String()),
		zap.String("total_staked", staker.StakedAmount.String()),
		zap.Time("lock_until", staker.LockUntil),
	)
	
	return nil
}

// Unstake allows a user to unstake tokens
func (sm *StakingManager) Unstake(poolID, userAddress string, amount *big.Int) error {
	sm.poolsMu.RLock()
	pool, exists := sm.pools[poolID]
	sm.poolsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("staking pool not found: %s", poolID)
	}
	
	pool.stakersMu.Lock()
	defer pool.stakersMu.Unlock()
	
	staker, exists := pool.stakers[userAddress]
	if !exists {
		return fmt.Errorf("user has no stake in pool: %s", userAddress)
	}
	
	// Check lock period
	if time.Now().Before(staker.LockUntil) {
		return fmt.Errorf("tokens are still locked until: %s", staker.LockUntil.Format(time.RFC3339))
	}
	
	// Check sufficient staked amount
	if amount.Cmp(staker.StakedAmount) > 0 {
		return fmt.Errorf("insufficient staked amount: %s > %s", 
			amount.String(), staker.StakedAmount.String())
	}
	
	pool.mu.Lock()
	defer pool.mu.Unlock()
	
	// Update pool rewards before unstaking
	sm.updatePoolRewards(pool)
	
	// Calculate and distribute pending rewards
	pendingRewards := sm.calculatePendingRewards(pool, staker)
	staker.TotalRewards.Add(staker.TotalRewards, pendingRewards)
	staker.LastClaimAt = time.Now()
	
	// Remove from stake
	staker.StakedAmount.Sub(staker.StakedAmount, amount)
	pool.TotalStaked.Sub(pool.TotalStaked, amount)
	
	// Remove staker if no tokens left
	if staker.StakedAmount.Cmp(big.NewInt(0)) == 0 {
		delete(pool.stakers, userAddress)
		pool.totalStakers.Add(^uint64(0)) // Atomic decrement
	}
	
	sm.logger.Info("Tokens unstaked",
		zap.String("pool_id", poolID),
		zap.String("user", userAddress),
		zap.String("amount", amount.String()),
		zap.String("remaining_staked", staker.StakedAmount.String()),
		zap.String("rewards_earned", pendingRewards.String()),
	)
	
	return nil
}

// ClaimRewards allows a user to claim their accumulated rewards
func (sm *StakingManager) ClaimRewards(poolID, userAddress string) (*big.Int, error) {
	sm.poolsMu.RLock()
	pool, exists := sm.pools[poolID]
	sm.poolsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("staking pool not found: %s", poolID)
	}
	
	pool.stakersMu.Lock()
	defer pool.stakersMu.Unlock()
	
	staker, exists := pool.stakers[userAddress]
	if !exists {
		return nil, fmt.Errorf("user has no stake in pool: %s", userAddress)
	}
	
	pool.mu.Lock()
	defer pool.mu.Unlock()
	
	// Update pool rewards
	sm.updatePoolRewards(pool)
	
	// Calculate pending rewards
	pendingRewards := sm.calculatePendingRewards(pool, staker)
	totalRewards := new(big.Int).Add(staker.TotalRewards, pendingRewards)
	
	if totalRewards.Cmp(big.NewInt(0)) == 0 {
		return big.NewInt(0), nil
	}
	
	// Reset rewards
	staker.TotalRewards = big.NewInt(0)
	staker.LastClaimAt = time.Now()
	
	pool.totalRewards.Add(pool.totalRewards, totalRewards)
	
	sm.logger.Info("Rewards claimed",
		zap.String("pool_id", poolID),
		zap.String("user", userAddress),
		zap.String("rewards", totalRewards.String()),
	)
	
	return totalRewards, nil
}

// calculatePendingRewards calculates pending rewards for a staker
func (sm *StakingManager) calculatePendingRewards(pool *StakingPool, staker *Staker) *big.Int {
	if pool.TotalStaked.Cmp(big.NewInt(0)) == 0 {
		return big.NewInt(0)
	}
	
	// Time since last claim
	timeDiff := time.Since(staker.LastClaimAt).Seconds()
	
	// Rewards = (stakedAmount / totalStaked) * rewardRate * timeDiff
	userShare := new(big.Float).Quo(
		new(big.Float).SetInt(staker.StakedAmount),
		new(big.Float).SetInt(pool.TotalStaked),
	)
	
	timeRewards := new(big.Float).Mul(
		new(big.Float).SetInt(pool.RewardRate),
		big.NewFloat(timeDiff),
	)
	
	pendingRewards := new(big.Float).Mul(userShare, timeRewards)
	
	result, _ := pendingRewards.Int(nil)
	return result
}

// updatePoolRewards updates the reward calculations for a pool
func (sm *StakingManager) updatePoolRewards(pool *StakingPool) {
	now := time.Now()
	if now.After(pool.LastUpdateTime) {
		pool.LastUpdateTime = now
	}
}

// GetPoolInfo returns information about a staking pool
func (sm *StakingManager) GetPoolInfo(poolID string) (map[string]interface{}, error) {
	sm.poolsMu.RLock()
	pool, exists := sm.pools[poolID]
	sm.poolsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("staking pool not found: %s", poolID)
	}
	
	pool.mu.RLock()
	defer pool.mu.RUnlock()
	
	return map[string]interface{}{
		"pool_id":         pool.ID,
		"staking_token":   pool.Token.Symbol,
		"reward_token":    pool.RewardToken.Symbol,
		"total_staked":    pool.TotalStaked.String(),
		"reward_rate":     pool.RewardRate.String(),
		"total_stakers":   pool.totalStakers.Load(),
		"total_rewards":   pool.totalRewards.String(),
		"min_stake":       pool.minStakeAmount.String(),
		"lock_period":     pool.lockPeriod.String(),
		"active":          pool.active,
	}, nil
}

// GetUserStake returns staking information for a user
func (sm *StakingManager) GetUserStake(poolID, userAddress string) (map[string]interface{}, error) {
	sm.poolsMu.RLock()
	pool, exists := sm.pools[poolID]
	sm.poolsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("staking pool not found: %s", poolID)
	}
	
	pool.stakersMu.RLock()
	staker, exists := pool.stakers[userAddress]
	pool.stakersMu.RUnlock()
	
	if !exists {
		return map[string]interface{}{
			"staked_amount":   "0",
			"pending_rewards": "0",
			"total_rewards":   "0",
		}, nil
	}
	
	// Calculate pending rewards
	pendingRewards := sm.calculatePendingRewards(pool, staker)
	
	return map[string]interface{}{
		"staked_amount":   staker.StakedAmount.String(),
		"pending_rewards": pendingRewards.String(),
		"total_rewards":   staker.TotalRewards.String(),
		"staked_at":       staker.StakedAt,
		"lock_until":      staker.LockUntil,
		"last_claim":      staker.LastClaimAt,
	}, nil
}