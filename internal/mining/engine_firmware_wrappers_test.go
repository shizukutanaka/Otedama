package mining

import (
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestEngineFirmwareWrappers_BasicFlow(t *testing.T) {
	logger := zap.NewNop()
	e := NewEngine(logger, &Config{Algorithm: "SHA256D", CPU: CPUConfig{Threads: 1}})

	// Ensure initialized
	if e.firmware == nil {
		t.Fatalf("expected firmware optimizer initialized")
	}

	// Set limits
	if err := e.SetFirmwareMaxBackups(3); err != nil {
		t.Fatalf("SetFirmwareMaxBackups error: %v", err)
	}
	if err := e.SetFirmwareMinApplyInterval(0); err != nil {
		t.Fatalf("SetFirmwareMinApplyInterval error: %v", err)
	}

	// Apply profile via engine (dry-run)
	_, err := e.ApplyFirmwareProfile("eco", true)
	if err != nil {
		t.Fatalf("ApplyFirmwareProfile dry-run error: %v", err)
	}

	// Apply settings via engine
	settings := map[string]interface{}{
		"mode":           "balanced",
		"voltage_mv":     900,
		"frequency_mhz":  1200,
		"fan_percent":    70,
		"power_limit_w":  1200,
	}
	applied, err := e.ApplyFirmwareSettings(settings, false)
	if err != nil {
		t.Fatalf("ApplyFirmwareSettings error: %v", err)
	}
	if applied["mode"] != "balanced" {
		t.Fatalf("mode mismatch got %v", applied["mode"])
	}

	// Backup and count
	_ = e.GetFirmwareSettings() // ensure accessor compiles
	if _, err := e.BackupFirmware(); err != nil {
		t.Fatalf("BackupFirmware error: %v", err)
	}
	cnt, err := e.GetFirmwareBackupCount()
	if err != nil {
		t.Fatalf("GetFirmwareBackupCount error: %v", err)
	}
	if cnt < 1 {
		t.Fatalf("expected >=1 backups, got %d", cnt)
	}

	// Save/Load
	tmp := t.TempDir()
	p := filepath.Join(tmp, "fw.json")
	if err := e.SaveFirmwareToFile(p); err != nil {
		t.Fatalf("SaveFirmwareToFile error: %v", err)
	}
	_, err = e.LoadFirmwareFromFile(p, true)
	if err != nil {
		t.Fatalf("LoadFirmwareFromFile dry-run error: %v", err)
	}
	_, err = e.LoadFirmwareFromFile(p, false)
	if err != nil {
		t.Fatalf("LoadFirmwareFromFile apply error: %v", err)
	}

	// Last applied at
	if ts, err := e.GetFirmwareLastAppliedAt(); err != nil || ts.IsZero() {
		t.Fatalf("GetFirmwareLastAppliedAt invalid: ts=%v err=%v", ts, err)
	}

	// Reset defaults
	res, err := e.ResetFirmwareDefaults()
	if err != nil {
		t.Fatalf("ResetFirmwareDefaults error: %v", err)
	}
	if res["mode"] != "balanced" {
		t.Fatalf("reset defaults mode mismatch: %v", res["mode"])
	}

	// Profiles list
	names, err := e.ListFirmwareProfiles()
	if err != nil || len(names) == 0 {
		t.Fatalf("ListFirmwareProfiles invalid: names=%v err=%v", names, err)
	}
}

func TestEngineFirmwareWrappers_RateLimit(t *testing.T) {
	logger := zap.NewNop()
	e := NewEngine(logger, &Config{Algorithm: "SHA256D", CPU: CPUConfig{Threads: 1}})

	if err := e.SetFirmwareMinApplyInterval(150 * time.Millisecond); err != nil {
		t.Fatalf("SetFirmwareMinApplyInterval error: %v", err)
	}

	set := map[string]interface{}{
		"mode":           "balanced",
		"voltage_mv":     900,
		"frequency_mhz":  1200,
		"fan_percent":    70,
		"power_limit_w":  1200,
	}

	if _, err := e.ApplyFirmwareSettings(set, false); err != nil {
		t.Fatalf("first apply error: %v", err)
	}
	if _, err := e.ApplyFirmwareSettings(set, false); err == nil {
		t.Fatalf("expected rate limit error on immediate second apply")
	}
	time.Sleep(160 * time.Millisecond)
	if _, err := e.ApplyFirmwareSettings(set, false); err != nil {
		t.Fatalf("apply after interval error: %v", err)
	}
}
