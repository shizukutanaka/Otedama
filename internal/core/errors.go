package core

import (
	"github.com/shizukutanaka/Otedama/internal/common"
)

// Re-export common error types for backward compatibility
type ErrorSeverity = common.ErrorSeverity

const (
	SeverityLow      = common.SeverityLow
	SeverityMedium   = common.SeverityMedium
	SeverityHigh     = common.SeverityHigh
	SeverityCritical = common.SeverityCritical
	SeverityFatal    = common.SeverityFatal
)

type ErrorCategory = common.ErrorCategory

const (
	CategoryMining     = common.CategoryMining
	CategoryNetwork    = common.CategoryNetwork
	CategoryStorage    = common.CategoryStorage
	CategorySecurity   = common.CategorySecurity
	CategoryHardware   = common.CategoryHardware
	CategoryAPI        = common.CategoryAPI
	CategoryP2P        = common.CategoryP2P
	CategoryStratum    = common.CategoryStratum
	CategorySystem     = common.CategorySystem
	CategoryValidation = common.CategoryValidation
	CategoryPool       = common.CategoryPool
	CategoryWallet     = common.CategoryWallet
)

// Re-export common error functions
var (
	NewError        = common.NewError
	GetErrorCode    = common.GetErrorCode
	GetErrorSeverity = common.GetErrorSeverity
	IsRetryable     = common.IsRetryable
	IsFatal         = common.IsFatal
	IsTemporary     = common.IsTemporary
)

// Re-export error types
type (
	OtedamaError    = common.OtedamaError
	ValidationError = common.ValidationError
	MultiError      = common.MultiError
	OperationError  = common.OperationError
	ErrorMetrics    = common.ErrorMetrics
	ErrorHandler    = common.ErrorHandler
)

// Re-export constructor functions
var (
	NewErrorMetrics = common.NewErrorMetrics
	NewErrorHandler = common.NewErrorHandler
	WrapError      = common.WrapError
)

// Error builder functions for common scenarios
func NewMiningError(code string, message string, severity ErrorSeverity) *OtedamaError {
	return NewError(code, message, CategoryMining, severity)
}

func NewNetworkError(code string, message string, severity ErrorSeverity) *OtedamaError {
	return NewError(code, message, CategoryNetwork, severity)
}

func NewSecurityError(code string, message string, severity ErrorSeverity) *OtedamaError {
	return NewError(code, message, CategorySecurity, severity)
}

func NewHardwareError(code string, message string, severity ErrorSeverity) *OtedamaError {
	return NewError(code, message, CategoryHardware, severity)
}

func NewSystemError(code string, message string, severity ErrorSeverity) *OtedamaError {
	return NewError(code, message, CategorySystem, severity)
}

// IsRecoverable determines if an error is recoverable
func IsRecoverable(err error) bool {
	if err == nil {
		return true
	}
	
	// Use common IsFatal logic (inverse of fatal is recoverable)
	return !IsFatal(err)
}