// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCappedLogFile_RotatesAtCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "otedama.log")

	old := maxLogFileBytes
	maxLogFileBytes = 256
	defer func() { maxLogFileBytes = old }()

	c, err := openCappedLogFile(path)
	if err != nil {
		t.Fatalf("openCappedLogFile: %v", err)
	}
	defer c.Close()

	// Three 200-byte writes force at least one rotation under a 256 cap.
	for i := 0; i < 3; i++ {
		if _, err := c.Write([]byte(strings.Repeat("a", 200) + "\n")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	oldData, err := os.ReadFile(path + ".old")
	if err != nil {
		t.Fatalf("rotated backup missing: %v", err)
	}
	if len(oldData) == 0 {
		t.Error("rotated backup should contain the pre-rotation contents")
	}
	cur, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cur), "log rotated") {
		t.Error("fresh file should carry a rotation marker")
	}
	if int64(len(cur)) > maxLogFileBytes {
		t.Errorf("active file %d bytes exceeds cap %d", len(cur), maxLogFileBytes)
	}
}

func TestCappedLogFile_BoundsTotalDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "otedama.log")

	old := maxLogFileBytes
	maxLogFileBytes = 512
	defer func() { maxLogFileBytes = old }()

	c, err := openCappedLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if _, err := c.Write([]byte(strings.Repeat("b", 300) + "\n")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}

	var total int64
	for _, p := range []string{path, path + ".old"} {
		if info, err := os.Stat(p); err == nil {
			total += info.Size()
		}
	}
	// Active ≤ cap+one write; backup ≤ cap+one write — total bounded.
	limit := 2 * (maxLogFileBytes + 301)
	if total > limit {
		t.Errorf("log disk %d exceeds bound %d", total, limit)
	}
	// Only one backup generation exists — no .old.old.
	if _, err := os.Stat(path + ".old.old"); !errors.Is(err, os.ErrNotExist) {
		t.Error("single-backup invariant violated")
	}
}

func TestCappedLogFile_AppendReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "otedama.log")

	old := maxLogFileBytes
	maxLogFileBytes = 1 << 20 // effectively no rotation
	defer func() { maxLogFileBytes = old }()

	c1, err := openCappedLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c1.Write([]byte("first\n")); err != nil {
		t.Fatal(err)
	}
	if err := c1.Close(); err != nil {
		t.Fatal(err)
	}

	c2, err := openCappedLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if _, err := c2.Write([]byte("second\n")); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\nsecond\n" {
		t.Errorf("reopen should append, got %q", data)
	}
}

func TestCappedLogFile_Mode0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "otedama.log")
	c, err := openCappedLogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("log file mode = %o, want 600", info.Mode().Perm())
	}
}
