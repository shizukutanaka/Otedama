
package p2p

import (
	"fmt"
	"sync"
	"time"
)

// LendingProtocol represents the lending and borrowing protocol.
type LendingProtocol struct {
	positions map[string]*LendingPosition
	mu        sync.RWMutex
}

// NewLendingProtocol creates a new LendingProtocol instance.
func NewLendingProtocol() *LendingProtocol {
	return &LendingProtocol{
		positions: make(map[string]*LendingPosition),
	}
}

// DepositCollateral deposits collateral for a user.
func (l *LendingProtocol) DepositCollateral(user, token string, amount uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	position, exists := l.positions[user]
	if !exists {
		position = &LendingPosition{
			User:       user,
			Collateral: make(map[string]uint64),
			Borrowed:   make(map[string]uint64),
		}
		l.positions[user] = position
	}

	position.Collateral[token] += amount
	position.Timestamp = time.Now().Unix()

	return nil
}

// Borrow allows a user to borrow a token against their collateral.
func (l *LendingProtocol) Borrow(user, token string, amount uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	position, exists := l.positions[user]
	if !exists {
		return fmt.Errorf("user has no collateral")
	}

	// TODO: Add collateralization ratio check

	position.Borrowed[token] += amount
	position.Timestamp = time.Now().Unix()

	return nil
}

// Liquidate liquidates a user's position if it is undercollateralized.
func (l *LendingProtocol) Liquidate(user string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	position, exists := l.positions[user]
	if !exists {
		return fmt.Errorf("user position not found")
	}

	// TODO: Add liquidation logic

	delete(l.positions, user)

	return nil
}
