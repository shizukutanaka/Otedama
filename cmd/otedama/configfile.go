// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// YAML config-file loading, shared by the run, config, and doctor
// subcommands. The file path resolves from an explicit --config flag,
// then the OTEDAMA_CONFIG env var, then the platform default location.

package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"github.com/shizukutanaka/Otedama/internal/config"
)

func loadConfigFile(path string, stderr io.Writer) config.Config {
	if path == "" {
		path = defaultConfigPath()
	}
	if path == "" {
		return config.Config{}
	}
	f, err := os.Open(path)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Fprintf(stderr, "warning: cannot open config file %q: %v\n", path, err)
		}
		return config.Config{}
	}
	defer f.Close()
	var cfg config.Config
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		// An empty or comments-only file yields io.EOF (no YAML document);
		// that is not a parse error — it means "use defaults".
		if err == io.EOF {
			return config.Config{}
		}
		fmt.Fprintf(stderr, "warning: cannot parse config file %q: %v\n", path, err)
		return config.Config{}
	}
	return cfg
}

// defaultConfigPath returns the config file location used when neither
// --config nor OTEDAMA_CONFIG names one.
//
// XDG_CONFIG_HOME is honoured (session 263). It was previously ignored while
// config.DefaultDataDir honoured XDG_DATA_HOME, so an operator who relocated
// their XDG directories got their data dir moved but their config file
// quietly not found — with no error, since a missing config file is a normal
// "use defaults" outcome. As with the data dir, the variable is only used
// when it holds an absolute path: the XDG Base Directory Specification
// requires that, and a relative value would make the config file resolve
// against the working directory. The $HOME/.config fallback is unchanged on
// every platform, so no existing installation's file stops being found.
func defaultConfigPath() string {
	if p := os.Getenv("OTEDAMA_CONFIG"); p != "" {
		return p
	}
	// filepath.IsAbs("") is false, so this also covers "unset".
	if xdg := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(xdg) {
		return filepath.Join(xdg, "otedama", "config.yaml")
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return ""
	}
	return filepath.Join(home, ".config", "otedama", "config.yaml")
}
