package dex

import "errors"

// Common DEX errors
var (
	// Validation errors
	ErrInvalidUser      = errors.New("invalid user")
	ErrInvalidToken     = errors.New("invalid token")
	ErrSameToken        = errors.New("cannot swap same token")
	ErrInvalidAmount    = errors.New("invalid amount")
	ErrExpiredDeadline  = errors.New("deadline expired")
	ErrInvalidSlippage  = errors.New("invalid slippage")
	
	// Liquidity errors
	ErrInsufficientLiquidity = errors.New("insufficient liquidity")
	ErrSlippageTooHigh       = errors.New("slippage too high")
	ErrPriceImpactTooHigh    = errors.New("price impact too high")
	
	// Pool errors
	ErrPoolNotFound      = errors.New("pool not found")
	ErrPoolAlreadyExists = errors.New("pool already exists")
	ErrInvalidRatio      = errors.New("invalid token ratio")
	
	// Order errors
	ErrOrderNotFound     = errors.New("order not found")
	ErrOrderExpired      = errors.New("order expired")
	ErrOrderCancelled    = errors.New("order cancelled")
	ErrInsufficientFunds = errors.New("insufficient funds")
	
	// Route errors
	ErrNoRouteFound = errors.New("no route found")
	ErrRouteTooLong = errors.New("route too long")
	
	// Oracle errors
	ErrPriceNotAvailable = errors.New("price not available")
	ErrStalePrice        = errors.New("price data is stale")
)