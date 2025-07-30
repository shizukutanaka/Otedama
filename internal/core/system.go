package core

import (
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/logging"
	"go.uber.org/zap"
)

// System is a type alias to OtedamaSystem for backward compatibility
type System = OtedamaSystem

// NewSystem creates a new system instance for backward compatibility
func NewSystem(cfg *config.Config, logger *zap.Logger, logManager *logging.Manager) (*System, error) {
	// Use the new OtedamaSystem
	return NewOtedamaSystem(cfg, logger)
}
