package blockchain

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/otedama/otedama/internal/defi"
)

type AccountState struct {
	Address         string
	Nonce           uint64
	TokenBalances   map[string]uint64
	LendingState    *defi.LendingPosition
	LPTokenBalances map[string]uint64
}

type StateDB struct {
	accounts map[string]*AccountState
	mu       sync.RWMutex
}

func NewStateDB() *StateDB {
	return &StateDB{
		accounts: make(map[string]*AccountState),
	}
}

func (s *StateDB) GetAccount(address string) (*AccountState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	account, exists := s.accounts[address]
	if !exists {
		return nil, fmt.Errorf("account not found: %s", address)
	}

	return account, nil
}

func (s *StateDB) CreateAccount(address string) *AccountState {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.accounts[address]; exists {
		return s.accounts[address]
	}

	account := &AccountState{
		Address:         address,
		Nonce:           0,
		TokenBalances:   make(map[string]uint64),
		LPTokenBalances: make(map[string]uint64),
	}

	s.accounts[address] = account
	return account
}

func (s *StateDB) UpdateTokenBalance(address, token string, balance uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	account, exists := s.accounts[address]
	if !exists {
		account = &AccountState{
			Address:         address,
			TokenBalances:   make(map[string]uint64),
			LPTokenBalances: make(map[string]uint64),
		}
		s.accounts[address] = account
	}

	account.TokenBalances[token] = balance
	return nil
}

func (s *StateDB) GetTokenBalance(address, token string) (uint64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	account, exists := s.accounts[address]
	if !exists {
		return 0, nil
	}

	return account.TokenBalances[token], nil
}

func (s *StateDB) UpdateLPTokenBalance(address, lpToken string, balance uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	account, exists := s.accounts[address]
	if !exists {
		account = &AccountState{
			Address:         address,
			TokenBalances:   make(map[string]uint64),
			LPTokenBalances: make(map[string]uint64),
		}
		s.accounts[address] = account
	}

	account.LPTokenBalances[lpToken] = balance
	return nil
}

func (s *StateDB) UpdateLendingPosition(address string, position *defi.LendingPosition) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	account, exists := s.accounts[address]
	if !exists {
		account = &AccountState{
			Address:         address,
			TokenBalances:   make(map[string]uint64),
			LPTokenBalances: make(map[string]uint64),
		}
		s.accounts[address] = account
	}

	account.LendingState = position
	return nil
}

func (s *StateDB) IncrementNonce(address string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	account, exists := s.accounts[address]
	if !exists {
		return fmt.Errorf("account not found: %s", address)
	}

	account.Nonce++
	return nil
}

func (s *StateDB) ApplyBlock(block *Block) error {
	for _, tx := range block.Transactions {
		if err := s.applyTransaction(tx); err != nil {
			return fmt.Errorf("failed to apply transaction %s: %v", tx.TxHash, err)
		}
	}

	return nil
}

func (s *StateDB) applyTransaction(tx Transaction) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	fromAccount, exists := s.accounts[tx.From]
	if !exists {
		return fmt.Errorf("from account not found: %s", tx.From)
	}

	toAccount, exists := s.accounts[tx.To]
	if !exists {
		toAccount = &AccountState{
			Address:         tx.To,
			TokenBalances:   make(map[string]uint64),
			LPTokenBalances: make(map[string]uint64),
		}
		s.accounts[tx.To] = toAccount
	}

	fromAccount.Nonce++

	return nil
}

func (s *StateDB) GetStateRoot() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := json.Marshal(s.accounts)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("%x", data), nil
}

func (s *StateDB) Snapshot() *StateSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snapshot := &StateSnapshot{
		Accounts: make(map[string]*AccountState),
	}

	for addr, account := range s.accounts {
		accCopy := &AccountState{
			Address:         account.Address,
			Nonce:           account.Nonce,
			TokenBalances:   make(map[string]uint64),
			LPTokenBalances: make(map[string]uint64),
		}

		for token, balance := range account.TokenBalances {
			accCopy.TokenBalances[token] = balance
		}

		for lpToken, balance := range account.LPTokenBalances {
			accCopy.LPTokenBalances[lpToken] = balance
		}

		if account.LendingState != nil {
			accCopy.LendingState = &defi.LendingPosition{
				User:                 account.LendingState.User,
				Collateral:           make(map[string]uint64),
				Borrowed:             make(map[string]uint64),
				InterestRate:         account.LendingState.InterestRate,
				LastUpdateBlock:      account.LendingState.LastUpdateBlock,
				AccruedInterest:      make(map[string]uint64),
				HealthFactor:         account.LendingState.HealthFactor,
				LiquidationThreshold: account.LendingState.LiquidationThreshold,
			}

			for token, amount := range account.LendingState.Collateral {
				accCopy.LendingState.Collateral[token] = amount
			}

			for token, amount := range account.LendingState.Borrowed {
				accCopy.LendingState.Borrowed[token] = amount
			}

			for token, amount := range account.LendingState.AccruedInterest {
				accCopy.LendingState.AccruedInterest[token] = amount
			}
		}

		snapshot.Accounts[addr] = accCopy
	}

	return snapshot
}

func (s *StateDB) RestoreSnapshot(snapshot *StateSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.accounts = snapshot.Accounts
}

type StateSnapshot struct {
	Accounts map[string]*AccountState
}

type StateManager struct {
	stateDB   *StateDB
	snapshots map[uint64]*StateSnapshot
	mu        sync.RWMutex
}

func NewStateManager() *StateManager {
	return &StateManager{
		stateDB:   NewStateDB(),
		snapshots: make(map[uint64]*StateSnapshot),
	}
}

func (sm *StateManager) CreateSnapshot(blockHeight uint64) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	snapshot := sm.stateDB.Snapshot()
	sm.snapshots[blockHeight] = snapshot
}

func (sm *StateManager) RestoreSnapshot(blockHeight uint64) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	snapshot, exists := sm.snapshots[blockHeight]
	if !exists {
		return fmt.Errorf("snapshot not found for block height %d", blockHeight)
	}

	sm.stateDB.RestoreSnapshot(snapshot)
	return nil
}

func (sm *StateManager) PruneSnapshots(keepLast uint64) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	var maxHeight uint64
	for height := range sm.snapshots {
		if height > maxHeight {
			maxHeight = height
		}
	}

	pruneBelow := maxHeight - keepLast
	for height := range sm.snapshots {
		if height < pruneBelow {
			delete(sm.snapshots, height)
		}
	}
}