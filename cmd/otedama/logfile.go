// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Size-capped --log-file writer: a miner running unattended for months
// must not grow its audit log without bound. The file rotates to a
// single ".old" backup once it exceeds the cap, bounding total log disk.
package main

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

// maxLogFileBytes caps the active --log-file at 32 MiB before rotation.
// One ".old" backup is retained, bounding total log disk at ~64 MiB.
// A variable so tests can shrink it.
var maxLogFileBytes int64 = 32 << 20

// cappedLogFile is an io.Writer that appends to a 0600 file until it
// exceeds maxLogFileBytes, then rotates it to path+".old" and starts a
// fresh file. Rotation is single-backup and best-effort: a failed rotate
// falls back to continuing the existing file rather than losing writes.
type cappedLogFile struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
}

func openCappedLogFile(path string) (*cappedLogFile, error) {
	c := &cappedLogFile{path: path}
	if err := c.openLocked(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *cappedLogFile) openLocked() error {
	f, err := os.OpenFile(c.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if info, err := f.Stat(); err == nil {
		c.size = info.Size()
	}
	c.f = f
	return nil
}

func (c *cappedLogFile) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.size > 0 && c.size+int64(len(p)) > maxLogFileBytes {
		if err := c.rotateLocked(); err != nil {
			return 0, err
		}
	}
	n, err := c.f.Write(p)
	c.size += int64(n)
	return n, err
}

// rotateLocked moves the current file to path+".old" (replacing any
// previous backup) and opens a fresh file seeded with a rotation marker.
// Callers hold c.mu. On failure the writer falls back to appending to
// the (possibly reopened) existing file.
func (c *cappedLogFile) rotateLocked() error {
	oldSize := c.size
	_ = c.f.Close()
	oldPath := c.path + ".old"
	_ = os.Remove(oldPath)
	if err := os.Rename(c.path, oldPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return c.openLocked()
	}
	c.size = 0
	if err := c.openLocked(); err != nil {
		return err
	}
	_, err := fmt.Fprintf(c.f, "[info] log rotated at %d bytes\n", oldSize)
	if err == nil {
		if info, serr := c.f.Stat(); serr == nil {
			c.size = info.Size()
		}
	}
	return err
}

func (c *cappedLogFile) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.f.Close()
}
