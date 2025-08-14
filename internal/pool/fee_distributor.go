package pool

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// FeeDistributor handles automatic pool fee distribution
type FeeDistributor struct {
	logger          *zap.Logger
	db              *database.DB
	payoutRepo      *database.PayoutRepository
	blockRepo       *database.BlockRepository
	currencyManager *currency.CurrencyManager
	clientManager   *currency.BlockchainClientManager
	
	// Configuration
	config          FeeDistributorConfig
	
	// State
	mu              sync.RWMutex
	lastDistribution map[string]time.Time
	
	// Control
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// FeeDistributorConfig contains fee distribution configuration
type FeeDistributorConfig struct {
	// Pool operator addresses by currency
	OperatorAddresses map[string]string
	
	// Fee distribution settings
	DistributionInterval time.Duration
	MinimumDistribution  map[string]*big.Int // Minimum amount to distribute per currency
	
	// Fee split configuration (percentages)
	OperatorFeePercent   float64 // Pool operator fee
	DevelopmentFeePercent float64 // Development fund
	ReserveFeePercent    float64 // Reserve fund
	
	// Special addresses
	DevelopmentAddress   string
	ReserveAddress       string
	
	// Batch settings
	MaxBatchSize         int
	ConfirmationTimeout  time.Duration
}

// FeeDistribution represents a fee distribution transaction
type FeeDistribution struct {
	ID            int64
	Currency      string
	BlockHeight   int64
	TotalFees     *big.Int
	OperatorFee   *big.Int
	DevelopmentFee *big.Int
	ReserveFee    *big.Int
	TxID          string
	Status        string
	CreatedAt     time.Time
	CompletedAt   *time.Time
}

// NewFeeDistributor creates a new fee distributor
func NewFeeDistributor(
	logger *zap.Logger,
	db *database.DB,
	currencyManager *currency.CurrencyManager,
	clientManager *currency.BlockchainClientManager,
	config FeeDistributorConfig,
) *FeeDistributor {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Validate fee percentages
	totalPercent := config.OperatorFeePercent + config.DevelopmentFeePercent + config.ReserveFeePercent
	if totalPercent > 100 {
		logger.Warn("Fee percentages exceed 100%, normalizing",
			zap.Float64("total", totalPercent))
		// Normalize percentages
		config.OperatorFeePercent = config.OperatorFeePercent / totalPercent * 100
		config.DevelopmentFeePercent = config.DevelopmentFeePercent / totalPercent * 100
		config.ReserveFeePercent = config.ReserveFeePercent / totalPercent * 100
	}
	
	return &FeeDistributor{
		logger:           logger,
		db:               db,
		payoutRepo:       database.NewPayoutRepository(db, logger),
		blockRepo:        database.NewBlockRepository(db, logger),
		currencyManager:  currencyManager,
		clientManager:    clientManager,
		config:           config,
		lastDistribution: make(map[string]time.Time),
		ctx:              ctx,
		cancel:           cancel,
	}
}

// Start starts the fee distribution service
func (fd *FeeDistributor) Start() error {
	fd.logger.Info("Starting fee distributor",
		zap.Float64("operator_fee", fd.config.OperatorFeePercent),
		zap.Float64("development_fee", fd.config.DevelopmentFeePercent),
		zap.Float64("reserve_fee", fd.config.ReserveFeePercent),
	)
	
	// Start distribution worker for each currency
	currencies := fd.currencyManager.ListCurrencies()
	for _, curr := range currencies {
		if fd.config.OperatorAddresses[curr.Symbol] == "" {
			fd.logger.Warn("No operator address configured for currency",
				zap.String("currency", curr.Symbol))
			continue
		}
		
		fd.wg.Add(1)
		go fd.distributionWorker(curr.Symbol)
	}
	
	return nil
}

// Stop stops the fee distribution service
func (fd *FeeDistributor) Stop() error {
	fd.logger.Info("Stopping fee distributor")
	fd.cancel()
	fd.wg.Wait()
	return nil
}

// distributionWorker handles fee distribution for a specific currency
func (fd *FeeDistributor) distributionWorker(currency string) {
	defer fd.wg.Done()
	
	ticker := time.NewTicker(fd.config.DistributionInterval)
	defer ticker.Stop()
	
	// Initial distribution check
	if err := fd.checkAndDistributeFees(currency); err != nil {
		fd.logger.Error("Initial fee distribution failed",
			zap.String("currency", currency),
			zap.Error(err))
	}
	
	for {
		select {
		case <-fd.ctx.Done():
			return
			
		case <-ticker.C:
			if err := fd.checkAndDistributeFees(currency); err != nil {
				fd.logger.Error("Fee distribution failed",
					zap.String("currency", currency),
					zap.Error(err))
			}
		}
	}
}

// checkAndDistributeFees checks and distributes accumulated fees
func (fd *FeeDistributor) checkAndDistributeFees(currency string) error {
	fd.mu.Lock()
	lastDist := fd.lastDistribution[currency]
	fd.mu.Unlock()
	
	// Check if enough time has passed
	if time.Since(lastDist) < fd.config.DistributionInterval {
		return nil
	}
	
	// Get accumulated fees
	fees, blockHeight, err := fd.getAccumulatedFees(currency, lastDist)
	if err != nil {
		return fmt.Errorf("failed to get accumulated fees: %w", err)
	}
	
	// Check minimum distribution amount
	minAmount := fd.config.MinimumDistribution[currency]
	if minAmount != nil && fees.Cmp(minAmount) < 0 {
		fd.logger.Debug("Accumulated fees below minimum",
			zap.String("currency", currency),
			zap.String("fees", fees.String()),
			zap.String("minimum", minAmount.String()))
		return nil
	}
	
	// Calculate fee splits
	distribution := fd.calculateFeeDistribution(fees)
	distribution.Currency = currency
	distribution.BlockHeight = blockHeight
	distribution.TotalFees = fees
	distribution.CreatedAt = time.Now()
	
	// Create distribution transaction
	if err := fd.createDistributionTransaction(distribution); err != nil {
		return fmt.Errorf("failed to create distribution transaction: %w", err)
	}
	
	// Update last distribution time
	fd.mu.Lock()
	fd.lastDistribution[currency] = time.Now()
	fd.mu.Unlock()
	
	fd.logger.Info("Fee distribution completed",
		zap.String("currency", currency),
		zap.String("total_fees", fees.String()),
		zap.String("operator_fee", distribution.OperatorFee.String()),
		zap.String("development_fee", distribution.DevelopmentFee.String()),
		zap.String("reserve_fee", distribution.ReserveFee.String()),
	)
	
	return nil
}

// getAccumulatedFees calculates accumulated fees since last distribution
func (fd *FeeDistributor) getAccumulatedFees(currency string, since time.Time) (*big.Int, int64, error) {
	ctx, cancel := context.WithTimeout(fd.ctx, 30*time.Second)
	defer cancel()
	
	// Get blocks found since last distribution
	blocks, err := fd.blockRepo.GetBlocksInPeriod(ctx, currency, since, time.Now())
	if err != nil {
		return nil, 0, err
	}
	
	totalFees := big.NewInt(0)
	var lastBlockHeight int64
	
	// Calculate total pool fees from blocks
	for _, block := range blocks {
		if block.Status != "confirmed" {
			continue
		}
		
		// Get block reward
		blockReward := big.NewInt(block.Reward)
		
		// Calculate pool fee
		poolFeePercent := fd.getPoolFeePercent(currency)
		poolFee := new(big.Int).Mul(blockReward, big.NewInt(int64(poolFeePercent*100)))
		poolFee.Div(poolFee, big.NewInt(10000)) // Divide by 10000 for percentage
		
		totalFees.Add(totalFees, poolFee)
		
		if block.Height > lastBlockHeight {
			lastBlockHeight = block.Height
		}
	}
	
	// Add transaction fees if applicable
	txFees, err := fd.getTransactionFees(ctx, currency, since)
	if err == nil {
		totalFees.Add(totalFees, txFees)
	}
	
	return totalFees, lastBlockHeight, nil
}

// calculateFeeDistribution calculates how to split the fees
func (fd *FeeDistributor) calculateFeeDistribution(totalFees *big.Int) *FeeDistribution {
	dist := &FeeDistribution{
		Status: "pending",
	}
	
	// Calculate operator fee
	operatorFee := new(big.Int).Mul(totalFees, big.NewInt(int64(fd.config.OperatorFeePercent*100)))
	operatorFee.Div(operatorFee, big.NewInt(10000))
	dist.OperatorFee = operatorFee
	
	// Calculate development fee
	devFee := new(big.Int).Mul(totalFees, big.NewInt(int64(fd.config.DevelopmentFeePercent*100)))
	devFee.Div(devFee, big.NewInt(10000))
	dist.DevelopmentFee = devFee
	
	// Calculate reserve fee
	reserveFee := new(big.Int).Mul(totalFees, big.NewInt(int64(fd.config.ReserveFeePercent*100)))
	reserveFee.Div(reserveFee, big.NewInt(10000))
	dist.ReserveFee = reserveFee
	
	// Handle rounding (give remainder to operator)
	totalDistributed := new(big.Int).Add(operatorFee, devFee)
	totalDistributed.Add(totalDistributed, reserveFee)
	remainder := new(big.Int).Sub(totalFees, totalDistributed)
	dist.OperatorFee.Add(dist.OperatorFee, remainder)
	
	return dist
}

// createDistributionTransaction creates and sends the distribution transaction
func (fd *FeeDistributor) createDistributionTransaction(dist *FeeDistribution) error {
	ctx, cancel := context.WithTimeout(fd.ctx, fd.config.ConfirmationTimeout)
	defer cancel()
	
	// Get blockchain client
	client, err := fd.clientManager.GetClient(dist.Currency)
	if err != nil {
		return fmt.Errorf("failed to get blockchain client: %w", err)
	}
	
	// Prepare payments
	payments := []currency.Payment{}
	
	// Add operator payment
	if dist.OperatorFee.Cmp(big.NewInt(0)) > 0 {
		payments = append(payments, currency.Payment{
			Address: fd.config.OperatorAddresses[dist.Currency],
			Amount:  dist.OperatorFee,
		})
	}
	
	// Add development payment
	if dist.DevelopmentFee.Cmp(big.NewInt(0)) > 0 && fd.config.DevelopmentAddress != "" {
		payments = append(payments, currency.Payment{
			Address: fd.config.DevelopmentAddress,
			Amount:  dist.DevelopmentFee,
		})
	}
	
	// Add reserve payment
	if dist.ReserveFee.Cmp(big.NewInt(0)) > 0 && fd.config.ReserveAddress != "" {
		payments = append(payments, currency.Payment{
			Address: fd.config.ReserveAddress,
			Amount:  dist.ReserveFee,
		})
	}
	
	// Send payments
	if len(payments) > 0 {
		txID, err := client.SendPayment(ctx, payments)
		if err != nil {
			return fmt.Errorf("failed to send fee distribution: %w", err)
		}
		
		dist.TxID = txID
		dist.Status = "completed"
		now := time.Now()
		dist.CompletedAt = &now
		
		// Record distribution in database
		if err := fd.recordDistribution(ctx, dist); err != nil {
			fd.logger.Error("Failed to record distribution",
				zap.String("currency", dist.Currency),
				zap.String("tx_id", txID),
				zap.Error(err))
		}
	}
	
	return nil
}

// recordDistribution records the fee distribution in the database
func (fd *FeeDistributor) recordDistribution(ctx context.Context, dist *FeeDistribution) error {
	query := `
		INSERT INTO fee_distributions (
			currency, block_height, total_fees, operator_fee,
			development_fee, reserve_fee, tx_id, status,
			created_at, completed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`
	
	_, err := fd.db.Exec(ctx, query,
		dist.Currency, dist.BlockHeight, dist.TotalFees.String(),
		dist.OperatorFee.String(), dist.DevelopmentFee.String(),
		dist.ReserveFee.String(), dist.TxID, dist.Status,
		dist.CreatedAt, dist.CompletedAt,
	)
	
	return err
}

// getPoolFeePercent returns the pool fee percentage for a currency
func (fd *FeeDistributor) getPoolFeePercent(currency string) float64 {
	// This would typically come from currency configuration
	// For now, return a default value
	return 2.0 // 2% pool fee
}

// getTransactionFees gets transaction fees collected since a given time
func (fd *FeeDistributor) getTransactionFees(ctx context.Context, currency string, since time.Time) (*big.Int, error) {
	// This would query transaction fees from the database
	// For now, return zero
	return big.NewInt(0), nil
}

// GetDistributionHistory returns fee distribution history
func (fd *FeeDistributor) GetDistributionHistory(currency string, limit int) ([]*FeeDistribution, error) {
    
	query := `
		SELECT id, currency, block_height, total_fees, operator_fee,
		       development_fee, reserve_fee, tx_id, status,
		       created_at, completed_at
		FROM fee_distributions
		WHERE currency = $1
		ORDER BY created_at DESC
		LIMIT $2
	`
	
	rows, err := fd.db.Query(query, currency, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	distributions := make([]*FeeDistribution, 0, limit)
	
	for rows.Next() {
		dist := &FeeDistribution{}
		var totalFees, operatorFee, devFee, reserveFee string
		
		err := rows.Scan(
			&dist.ID, &dist.Currency, &dist.BlockHeight,
			&totalFees, &operatorFee, &devFee, &reserveFee,
			&dist.TxID, &dist.Status, &dist.CreatedAt, &dist.CompletedAt,
		)
		if err != nil {
			return nil, err
		}
		
		// Convert string amounts back to big.Int
		dist.TotalFees, _ = new(big.Int).SetString(totalFees, 10)
		dist.OperatorFee, _ = new(big.Int).SetString(operatorFee, 10)
		dist.DevelopmentFee, _ = new(big.Int).SetString(devFee, 10)
		dist.ReserveFee, _ = new(big.Int).SetString(reserveFee, 10)
		
		distributions = append(distributions, dist)
	}
	
	return distributions, nil
}

// GetPendingDistributions returns pending fee distributions
func (fd *FeeDistributor) GetPendingDistributions() ([]*FeeDistribution, error) {
    
	query := `
		SELECT id, currency, block_height, total_fees, operator_fee,
		       development_fee, reserve_fee, tx_id, status,
		       created_at, completed_at
		FROM fee_distributions
		WHERE status = 'pending'
		ORDER BY created_at ASC
	`
	
	rows, err := fd.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	distributions := make([]*FeeDistribution, 0)
	
	for rows.Next() {
		dist := &FeeDistribution{}
		var totalFees, operatorFee, devFee, reserveFee string
		
		err := rows.Scan(
			&dist.ID, &dist.Currency, &dist.BlockHeight,
			&totalFees, &operatorFee, &devFee, &reserveFee,
			&dist.TxID, &dist.Status, &dist.CreatedAt, &dist.CompletedAt,
		)
		if err != nil {
			return nil, err
		}
		
		// Convert string amounts back to big.Int
		dist.TotalFees, _ = new(big.Int).SetString(totalFees, 10)
		dist.OperatorFee, _ = new(big.Int).SetString(operatorFee, 10)
		dist.DevelopmentFee, _ = new(big.Int).SetString(devFee, 10)
		dist.ReserveFee, _ = new(big.Int).SetString(reserveFee, 10)
		
		distributions = append(distributions, dist)
	}
	
	return distributions, nil
}