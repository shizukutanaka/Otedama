package mining

import (
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestFirmwarePersistenceAndRollback(t *testing.T) {
	logger := zap.NewNop()
	fo := NewFirmwareOptimizer(logger)
	fo.SetMaxBackups(5)

	base := map[string]interface{}{
		"mode":           "balanced",
		"voltage_mv":     900,
		"frequency_mhz":  1200,
		"fan_percent":    70,
		"power_limit_w":  1200,
	}

	if _, err := fo.ApplySettings(base, false); err != nil {
		t.Fatalf("apply base settings failed: %v", err)
	}

	tmp := t.TempDir()
	path := filepath.Join(tmp, "firmware.json")
	if err := fo.SaveToFile(path); err != nil {
		t.Fatalf("save to file failed: %v", err)
	}

	// Dry-run load should validate and return normalized settings without applying
	normalized, err := fo.LoadFromFile(path, true)
	if err != nil {
		t.Fatalf("dry-run load failed: %v", err)
	}
	if normalized["mode"] != base["mode"] {
		t.Fatalf("dry-run normalized mode mismatch: got %v want %v", normalized["mode"], base["mode"])
	}

	// Actual load should apply and take a backup of the previous state
	applied, err := fo.LoadFromFile(path, false)
	if err != nil {
		t.Fatalf("load apply failed: %v", err)
	}
	if applied["frequency_mhz"] != base["frequency_mhz"] {
		t.Fatalf("applied frequency mismatch: got %v want %v", applied["frequency_mhz"], base["frequency_mhz"])
	}

	if fo.GetBackupCount() < 1 {
		t.Fatalf("expected at least one backup after load, got %d", fo.GetBackupCount())
	}
	if fo.GetLastAppliedAt().IsZero() {
		t.Fatalf("expected last applied at to be set")
	}

	// Modify settings, then rollback should restore previous
	updated := map[string]interface{}{
		"mode":           "balanced",
		"voltage_mv":     950,
		"frequency_mhz":  1300,
		"fan_percent":    75,
		"power_limit_w":  1300,
	}
	if _, err := fo.ApplySettings(updated, false); err != nil {
		t.Fatalf("apply updated failed: %v", err)
	}
	rolled, err := fo.Rollback()
	if err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	if rolled["frequency_mhz"] != base["frequency_mhz"] {
		t.Fatalf("rollback frequency mismatch: got %v want %v", rolled["frequency_mhz"], base["frequency_mhz"])
	}
}

func TestApplySettingsRateLimit(t *testing.T) {
	logger := zap.NewNop()
	fo := NewFirmwareOptimizer(logger)
	fo.SetMinApplyInterval(200 * time.Millisecond)

	set := map[string]interface{}{
		"mode":           "balanced",
		"voltage_mv":     900,
		"frequency_mhz":  1200,
		"fan_percent":    70,
		"power_limit_w":  1200,
	}

	if _, err := fo.ApplySettings(set, false); err != nil {
		t.Fatalf("first apply failed: %v", err)
	}
	if _, err := fo.ApplySettings(set, false); err == nil {
		t.Fatalf("expected rate limit error on immediate second apply")
	}
	time.Sleep(210 * time.Millisecond)
	if _, err := fo.ApplySettings(set, false); err != nil {
		t.Fatalf("apply after interval failed: %v", err)
	}
}

func TestProfiles(t *testing.T) {
	logger := zap.NewNop()
	fo := NewFirmwareOptimizer(logger)

	names := fo.ListProfiles()
	want := map[string]bool{"eco": true, "balanced": true, "turbo": true}
	for _, n := range names {
		delete(want, n)
	}
	if len(want) != 0 {
		t.Fatalf("missing profiles: %v", want)
	}

	// Dry-run eco
	dr, err := fo.ApplyProfile("eco", true)
	if err != nil {
		t.Fatalf("dry-run profile apply failed: %v", err)
	}
	if dr["mode"] != "eco" {
		t.Fatalf("dry-run profile mode mismatch: got %v", dr["mode"])
	}

	// Apply eco
	if _, err := fo.ApplyProfile("eco", false); err != nil {
		t.Fatalf("apply profile failed: %v", err)
	}

	// Reset to defaults (balanced)
	applied, err := fo.ResetToDefaults()
	if err != nil {
		t.Fatalf("reset to defaults failed: %v", err)
	}
	if applied["mode"] != "balanced" {
		t.Fatalf("reset defaults mode mismatch: got %v", applied["mode"])
	}
}
