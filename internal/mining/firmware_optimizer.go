package mining

import (
    "encoding/json"
	"errors"
    "os"
	"sync"
	"time"

	"go.uber.org/zap"
    asic "github.com/otedama/otedama/internal/asic"
)

// FirmwareOptimizer optimizes ASIC firmware settings
type FirmwareOptimizer struct {
    logger *zap.Logger

    // Firmware parameters
    currentFirmware string
    customSettings  map[string]interface{}

    mu            sync.RWMutex
    backups       []map[string]interface{}
    lastAppliedAt time.Time

    // Operational controls
    minApplyInterval time.Duration
    maxBackups       int

    // Hardware integration
    asicMgr *asic.ASICManager
}

// NewFirmwareOptimizer creates a new firmware optimizer
func NewFirmwareOptimizer(logger *zap.Logger) *FirmwareOptimizer {
    return &FirmwareOptimizer{
        logger:         logger,
        customSettings: make(map[string]interface{}),
        minApplyInterval: 2 * time.Second,
        maxBackups:       10,
    }
}

// SetASICManager injects the advanced ASIC manager for hardware operations
func (fo *FirmwareOptimizer) SetASICManager(mgr *asic.ASICManager) {
    fo.mu.Lock()
    defer fo.mu.Unlock()
    fo.asicMgr = mgr
}

// SetMode sets the firmware's operational mode
func (fo *FirmwareOptimizer) SetMode(mode string) error {
    // Implementation would set firmware mode
    fo.mu.Lock()
    defer fo.mu.Unlock()
    fo.customSettings["mode"] = mode
    fo.currentFirmware = mode
    fo.logger.Info("Setting firmware mode", zap.String("mode", mode))
    return nil
}

// ApplyChipTuning applies per-chip tuning settings
func (fo *FirmwareOptimizer) ApplyChipTuning() error {
    // Implementation would apply per-chip tuning
    fo.logger.Info("Applying ASIC chip tuning")
    return nil
}

// SetCustomSetting sets a single firmware setting (thread-safe)
func (fo *FirmwareOptimizer) SetCustomSetting(key string, value interface{}) {
    fo.mu.Lock()
    defer fo.mu.Unlock()
    fo.customSettings[key] = value
    fo.logger.Debug("Custom setting updated", zap.String("key", key))
}

// GetSettings returns a shallow copy of current custom settings (thread-safe)
func (fo *FirmwareOptimizer) GetSettings() map[string]interface{} {
    fo.mu.RLock()
    defer fo.mu.RUnlock()
    out := make(map[string]interface{}, len(fo.customSettings))
    for k, v := range fo.customSettings {
        out[k] = v
    }
    return out
}

// BackupCurrent saves a backup snapshot of current settings
func (fo *FirmwareOptimizer) BackupCurrent() map[string]interface{} {
    fo.mu.Lock()
    defer fo.mu.Unlock()
    snap := make(map[string]interface{}, len(fo.customSettings))
    for k, v := range fo.customSettings {
        snap[k] = v
    }
    fo.backups = append(fo.backups, snap)
    // Trim backups if exceeding maxBackups
    if fo.maxBackups > 0 && len(fo.backups) > fo.maxBackups {
        fo.backups = fo.backups[len(fo.backups)-fo.maxBackups:]
    }
    fo.logger.Info("Firmware settings backed up", zap.Int("backups", len(fo.backups)))
    return snap
}

// RestoreLastBackup restores the most recent backup snapshot
func (fo *FirmwareOptimizer) RestoreLastBackup() (map[string]interface{}, error) {
    fo.mu.Lock()
    defer fo.mu.Unlock()
    if len(fo.backups) == 0 {
        return nil, errors.New("no backups available")
    }
    last := fo.backups[len(fo.backups)-1]
    fo.backups = fo.backups[:len(fo.backups)-1]
    fo.customSettings = make(map[string]interface{}, len(last))
    for k, v := range last {
        fo.customSettings[k] = v
    }
    fo.logger.Warn("Firmware settings restored from backup", zap.Int("remaining_backups", len(fo.backups)))
    return fo.GetSettings(), nil
}

// ApplySettings validates and applies a batch of settings.
// If dryRun is true, only validates and returns the normalized settings without applying.
func (fo *FirmwareOptimizer) ApplySettings(settings map[string]interface{}, dryRun bool) (map[string]interface{}, error) {
    if settings == nil {
        return nil, errors.New("settings cannot be nil")
    }
    normalized, err := fo.validateAndNormalize(settings)
    if err != nil {
        return nil, err
    }

    // Rate limit apply operations
    if !dryRun {
        fo.mu.RLock()
        last := fo.lastAppliedAt
        minInt := fo.minApplyInterval
        fo.mu.RUnlock()
        if minInt > 0 && !last.IsZero() && time.Since(last) < minInt {
            return nil, errors.New("apply called too frequently")
        }
    }

    if dryRun {
        fo.logger.Info("Dry-run validated firmware settings", zap.Any("settings", normalized))
        return normalized, nil
    }

    fo.mu.Lock()
    // take backup before applying
    snap := make(map[string]interface{}, len(fo.customSettings))
    for k, v := range fo.customSettings {
        snap[k] = v
    }
    fo.backups = append(fo.backups, snap)
    if fo.maxBackups > 0 && len(fo.backups) > fo.maxBackups {
        fo.backups = fo.backups[len(fo.backups)-fo.maxBackups:]
    }
    for k, v := range normalized {
        fo.customSettings[k] = v
    }
    fo.lastAppliedAt = time.Now()
    fo.mu.Unlock()

    // Apply to hardware (stubbed)
    if err := fo.applyToHardware(normalized); err != nil {
        fo.logger.Error("Hardware apply failed; attempting rollback", zap.Error(err))
        if _, rbErr := fo.RestoreLastBackup(); rbErr != nil {
            fo.logger.Error("Rollback failed", zap.Error(rbErr))
        }
        return nil, err
    }

    fo.logger.Info("Firmware settings applied", zap.Any("settings", normalized))
    return fo.GetSettings(), nil
}

// validateAndNormalize validates allowed keys and ranges, and normalizes numeric types.
func (fo *FirmwareOptimizer) validateAndNormalize(in map[string]interface{}) (map[string]interface{}, error) {
    // Allowed keys and bounds
    const (
        minVoltageMV   = 500   // millivolts
        maxVoltageMV   = 1500
        minFreqMHz     = 100   // MHz
        maxFreqMHz     = 2000
        minFanPercent  = 0     // %
        maxFanPercent  = 100
        minPowerLimitW = 50    // Watts
        maxPowerLimitW = 5000
    )

    allowed := map[string]struct{}{
        "voltage_mv":   {},
        "frequency_mhz": {},
        "fan_percent":  {},
        "power_limit_w": {},
        "mode":         {},
    }

    out := make(map[string]interface{}, len(in))
    for k, v := range in {
        if _, ok := allowed[k]; !ok {
            return nil, errors.New("unsupported setting: " + k)
        }

        switch k {
        case "voltage_mv":
            val, ok := toInt(v)
            if !ok || val < minVoltageMV || val > maxVoltageMV {
                return nil, errors.New("voltage_mv out of range")
            }
            out[k] = val
        case "frequency_mhz":
            val, ok := toInt(v)
            if !ok || val < minFreqMHz || val > maxFreqMHz {
                return nil, errors.New("frequency_mhz out of range")
            }
            out[k] = val
        case "fan_percent":
            val, ok := toInt(v)
            if !ok || val < minFanPercent || val > maxFanPercent {
                return nil, errors.New("fan_percent out of range")
            }
            out[k] = val
        case "power_limit_w":
            val, ok := toInt(v)
            if !ok || val < minPowerLimitW || val > maxPowerLimitW {
                return nil, errors.New("power_limit_w out of range")
            }
            out[k] = val
        case "mode":
            s, ok := v.(string)
            if !ok || s == "" {
                return nil, errors.New("mode must be a non-empty string")
            }
            out[k] = s
        }
    }
    return out, nil
}

// SetFanPercent sets fan speed percentage (0-100)
func (fo *FirmwareOptimizer) SetFanPercent(p int) error {
    if p < 0 || p > 100 {
        return errors.New("fan_percent out of range")
    }
    fo.mu.Lock()
    fo.customSettings["fan_percent"] = p
    fo.mu.Unlock()
    fo.logger.Info("Fan percent updated", zap.Int("fan_percent", p))
    return nil
}

// SetPowerLimit sets power limit in Watts
func (fo *FirmwareOptimizer) SetPowerLimit(w int) error {
    if w < 50 || w > 5000 {
        return errors.New("power_limit_w out of range")
    }
    fo.mu.Lock()
    fo.customSettings["power_limit_w"] = w
    fo.mu.Unlock()
    fo.logger.Info("Power limit updated", zap.Int("power_limit_w", w))
    return nil
}

// TuneForTemperature adjusts settings based on temperature heuristics
func (fo *FirmwareOptimizer) TuneForTemperature(tempC float64) {
    // Basic heuristic: if too hot, increase fan and reduce power limit; if cool, relax fan
    fo.mu.Lock()
    defer fo.mu.Unlock()

    // Ensure map exists
    if fo.customSettings == nil {
        fo.customSettings = make(map[string]interface{})
    }

    // Default values if missing
    fan := getIntOrDefault(fo.customSettings["fan_percent"], 70)
    power := getIntOrDefault(fo.customSettings["power_limit_w"], 1200)

    if tempC >= 85 {
        fan = 100
        if power > 200 {
            power = int(float64(power) * 0.9) // reduce by 10%
        }
    } else if tempC >= 80 {
        if fan < 90 {
            fan = 90
        }
        if power > 200 {
            power = int(float64(power) * 0.95)
        }
    } else if tempC <= 60 {
        if fan > 60 {
            fan = 60
        }
    }

    // clamp
    if fan < 0 {
        fan = 0
    } else if fan > 100 {
        fan = 100
    }
    if power < 50 {
        power = 50
    } else if power > 5000 {
        power = 5000
    }

    fo.customSettings["fan_percent"] = fan
    fo.customSettings["power_limit_w"] = power
    fo.lastAppliedAt = time.Now()
    fo.logger.Info("Temperature-based tuning applied", zap.Float64("temp_c", tempC), zap.Int("fan_percent", fan), zap.Int("power_limit_w", power))
}

// Helpers
func toInt(v interface{}) (int, bool) {
    switch t := v.(type) {
    case int:
        return t, true
    case int32:
        return int(t), true
    case int64:
        return int(t), true
    case float32:
        return int(t), true
    case float64:
        return int(t), true
    default:
        return 0, false
    }
}

func getIntOrDefault(v interface{}, d int) int {
    if val, ok := toInt(v); ok {
        return val
    }
    return d
}

// Persistence structures and operations
type firmwareState struct {
    CurrentFirmware string                 `json:"current_firmware"`
    CustomSettings  map[string]interface{} `json:"custom_settings"`
    LastAppliedAt   time.Time              `json:"last_applied_at"`
}

// SaveToFile persists current firmware settings and metadata to a JSON file
func (fo *FirmwareOptimizer) SaveToFile(path string) error {
    fo.mu.RLock()
    state := firmwareState{
        CurrentFirmware: fo.currentFirmware,
        CustomSettings:  make(map[string]interface{}, len(fo.customSettings)),
        LastAppliedAt:   fo.lastAppliedAt,
    }
    for k, v := range fo.customSettings {
        state.CustomSettings[k] = v
    }
    fo.mu.RUnlock()

    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    enc := json.NewEncoder(f)
    enc.SetIndent("", "  ")
    return enc.Encode(&state)
}

// LoadFromFile loads firmware settings from a JSON file and optionally applies them
func (fo *FirmwareOptimizer) LoadFromFile(path string, dryRun bool) (map[string]interface{}, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    var state firmwareState
    dec := json.NewDecoder(f)
    if err := dec.Decode(&state); err != nil {
        return nil, err
    }

    // Validate settings before applying
    normalized, err := fo.validateAndNormalize(state.CustomSettings)
    if err != nil {
        return nil, err
    }

    if dryRun {
        fo.logger.Info("Dry-run loaded firmware settings from file", zap.String("path", path), zap.Any("settings", normalized))
        return normalized, nil
    }

    fo.mu.Lock()
    // backup current
    snap := make(map[string]interface{}, len(fo.customSettings))
    for k, v := range fo.customSettings {
        snap[k] = v
    }
    fo.backups = append(fo.backups, snap)
    if fo.maxBackups > 0 && len(fo.backups) > fo.maxBackups {
        fo.backups = fo.backups[len(fo.backups)-fo.maxBackups:]
    }
    // apply
    fo.customSettings = make(map[string]interface{}, len(normalized))
    for k, v := range normalized {
        fo.customSettings[k] = v
    }
    fo.currentFirmware = state.CurrentFirmware
    fo.lastAppliedAt = time.Now()
    fo.mu.Unlock()

    if err := fo.applyToHardware(normalized); err != nil {
        fo.logger.Error("Hardware apply failed after load; attempting rollback", zap.Error(err))
        if _, rbErr := fo.RestoreLastBackup(); rbErr != nil {
            fo.logger.Error("Rollback failed", zap.Error(rbErr))
        }
        return nil, err
    }

    fo.logger.Info("Firmware settings loaded and applied", zap.String("path", path))
    return fo.GetSettings(), nil
}

// Rollback restores the most recent backup and applies it
func (fo *FirmwareOptimizer) Rollback() (map[string]interface{}, error) {
    settings, err := fo.RestoreLastBackup()
    if err != nil {
        return nil, err
    }
    if err := fo.applyToHardware(settings); err != nil {
        return nil, err
    }
    return settings, nil
}

// GetLastAppliedAt returns the last time settings were applied
func (fo *FirmwareOptimizer) GetLastAppliedAt() time.Time {
    fo.mu.RLock()
    defer fo.mu.RUnlock()
    return fo.lastAppliedAt
}

// SetMinApplyInterval sets the minimum interval between apply operations
func (fo *FirmwareOptimizer) SetMinApplyInterval(d time.Duration) {
    fo.mu.Lock()
    fo.minApplyInterval = d
    fo.mu.Unlock()
}

// SetMaxBackups sets the maximum number of backup snapshots retained (<=0 disables trimming)
func (fo *FirmwareOptimizer) SetMaxBackups(n int) {
    fo.mu.Lock()
    fo.maxBackups = n
    if n > 0 && len(fo.backups) > n {
        fo.backups = fo.backups[len(fo.backups)-n:]
    }
    fo.mu.Unlock()
}

// applyToHardware applies the given settings to the actual device firmware.
// This is a stub implementation; integrate with device drivers/SDKs as needed.
func (fo *FirmwareOptimizer) applyToHardware(settings map[string]interface{}) error {
    // Validate manager availability when ASIC-related settings are present
    needsHW := false
    if _, ok := settings["fan_percent"]; ok { needsHW = true }
    if _, ok := settings["frequency_mhz"]; ok { needsHW = true }
    if _, ok := settings["mode"]; ok { needsHW = true }
    if needsHW && fo.asicMgr == nil {
        return errors.New("ASICManager not configured")
    }

    // No hardware work to do
    if fo.asicMgr == nil {
        fo.logger.Debug("No ASICManager configured; skipping hardware apply")
        return nil
    }

    devices := fo.asicMgr.GetAllDevices()
    if len(devices) == 0 {
        fo.logger.Warn("No ASIC devices managed; skipping hardware apply")
        return nil
    }

    // Snapshot previous settings for rollback attempt
    var prev map[string]interface{}
    fo.mu.RLock()
    if n := len(fo.backups); n > 0 {
        prev = make(map[string]interface{}, len(fo.backups[n-1]))
        for k, v := range fo.backups[n-1] {
            prev[k] = v
        }
    }
    fo.mu.RUnlock()

    // Map mode string to asic.WorkMode
    toMode := func(s string) asic.WorkMode {
        switch s {
        case "eco":
            return asic.ModeLowPower
        case "balanced":
            return asic.ModeNormal
        case "turbo":
            return asic.ModeHighPerformance
        case "silent":
            return asic.ModeSilent
        default:
            return asic.ModeNormal
        }
    }

    // Extract desired values
    fan, _ := toInt(settings["fan_percent"])
    freq, _ := toInt(settings["frequency_mhz"])
    modeStr, _ := settings["mode"].(string)
    haveFan := settings["fan_percent"] != nil
    haveFreq := settings["frequency_mhz"] != nil
    haveMode := modeStr != ""

    // Track which devices we modified to attempt rollback on partial failure
    type appliedOps struct{ fan, freq, mode bool }
    applied := make(map[string]appliedOps)

    // Apply sequentially per device to keep it simple and safe
    var firstErr error
    for _, d := range devices {
        var ops appliedOps
        // Apply fan
        if haveFan {
            if err := d.SetFanSpeed(fan); err != nil {
                fo.logger.Error("Failed to set fan speed", zap.String("device_id", d.ID), zap.Error(err))
                firstErr = err
                break
            }
            ops.fan = true
        }
        // Apply frequency
        if haveFreq {
            if err := d.SetFrequency(freq); err != nil {
                fo.logger.Error("Failed to set frequency", zap.String("device_id", d.ID), zap.Error(err))
                firstErr = err
                break
            }
            ops.freq = true
        }
        // Apply mode
        if haveMode {
            if err := d.SetWorkMode(toMode(modeStr)); err != nil {
                fo.logger.Error("Failed to set work mode", zap.String("device_id", d.ID), zap.Error(err))
                firstErr = err
                break
            }
            ops.mode = true
        }
        applied[d.ID] = ops
    }

    // Power limit is currently not directly supported by device API; log and continue
    if _, ok := settings["power_limit_w"]; ok {
        fo.logger.Debug("power_limit_w not directly supported by ASIC API; consider vendor-specific implementation")
    }

    if firstErr != nil {
        // Attempt best-effort rollback for devices already modified
        if prev != nil {
            prevFan, _ := toInt(prev["fan_percent"])
            prevFreq, _ := toInt(prev["frequency_mhz"])
            prevModeStr, _ := prev["mode"].(string)
            for _, d := range devices {
                if ops, ok := applied[d.ID]; ok {
                    if ops.fan {
                        if err := d.SetFanSpeed(prevFan); err != nil {
                            fo.logger.Warn("Rollback fan failed", zap.String("device_id", d.ID), zap.Error(err))
                        }
                    }
                    if ops.freq {
                        if err := d.SetFrequency(prevFreq); err != nil {
                            fo.logger.Warn("Rollback frequency failed", zap.String("device_id", d.ID), zap.Error(err))
                        }
                    }
                    if ops.mode {
                        if err := d.SetWorkMode(toMode(prevModeStr)); err != nil {
                            fo.logger.Warn("Rollback mode failed", zap.String("device_id", d.ID), zap.Error(err))
                        }
                    }
                }
            }
        }
        return firstErr
    }

    fo.logger.Info("Applied firmware settings to ASIC hardware",
        zap.Int("devices", len(devices)),
        zap.Bool("fan", haveFan),
        zap.Bool("frequency", haveFreq),
        zap.Bool("mode", haveMode),
    )
    return nil
}

// GetBackupCount returns the number of retained backups
func (fo *FirmwareOptimizer) GetBackupCount() int {
    fo.mu.RLock()
    defer fo.mu.RUnlock()
    return len(fo.backups)
}

// ApplyProfile applies a predefined firmware profile (eco, balanced, turbo)
// If dryRun is true, validates only and returns normalized settings
func (fo *FirmwareOptimizer) ApplyProfile(name string, dryRun bool) (map[string]interface{}, error) {
    prof := fo.profileSettings(name)
    if prof == nil {
        return nil, errors.New("unknown profile: " + name)
    }
    fo.logger.Info("Applying firmware profile", zap.String("profile", name), zap.Bool("dry_run", dryRun))
    return fo.ApplySettings(prof, dryRun)
}

// ResetToDefaults resets firmware to the balanced default profile
func (fo *FirmwareOptimizer) ResetToDefaults() (map[string]interface{}, error) {
    return fo.ApplySettings(fo.profileSettings("balanced"), false)
}

// ListProfiles returns available firmware profile names
func (fo *FirmwareOptimizer) ListProfiles() []string {
    return []string{"eco", "balanced", "turbo"}
}

// profileSettings returns the settings for a given named profile
func (fo *FirmwareOptimizer) profileSettings(name string) map[string]interface{} {
    switch name {
    case "eco":
        return map[string]interface{}{
            "mode":          "eco",
            "voltage_mv":    700,
            "frequency_mhz": 800,
            "fan_percent":   80,
            "power_limit_w": 800,
        }
    case "balanced":
        return map[string]interface{}{
            "mode":          "balanced",
            "voltage_mv":    850,
            "frequency_mhz": 1200,
            "fan_percent":   70,
            "power_limit_w": 1200,
        }
    case "turbo":
        return map[string]interface{}{
            "mode":          "turbo",
            "voltage_mv":    1000,
            "frequency_mhz": 1600,
            "fan_percent":   100,
            "power_limit_w": 1600,
        }
    default:
        return nil
    }
}
