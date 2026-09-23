// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// YAML config-file loading, shared by the run, config, and doctor
// subcommands. The file path resolves from an explicit --config flag,
// then the OTEDAMA_CONFIG env var, then the platform default location.

package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"go.yaml.in/yaml/v3"

	"github.com/shizukutanaka/Otedama/internal/config"
)

// loadConfigFile decodes the YAML config file at path (or the resolved
// default when path is empty). A *missing* file is not an error — it
// just means "no file layer", so callers get the zero Config and nil
// error. A file that exists but cannot be opened or parsed is an
// error: silently falling back to defaults would run the engine on a
// configuration the operator never wrote — a typo'd pools list or
// bitcoin_address would vanish instead of failing loudly.
func loadConfigFile(path string) (config.Config, error) {
	if path == "" {
		path = defaultConfigPath()
	}
	if path == "" {
		return config.Config{}, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return config.Config{}, nil
		}
		return config.Config{}, fmt.Errorf("cannot open config file %q: %w", path, err)
	}
	defer f.Close()
	var cfg config.Config
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		// An empty or comments-only file yields io.EOF (no YAML document);
		// that is not a parse error — it means "use defaults".
		if err == io.EOF {
			return config.Config{}, nil
		}
		return config.Config{}, fmt.Errorf("cannot parse config file %q: %w", path, err)
	}
	return cfg, nil
}

func defaultConfigPath() string {
	if p := os.Getenv("OTEDAMA_CONFIG"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.config/otedama/config.yaml"
}
