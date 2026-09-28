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

	"gopkg.in/yaml.v3"

	"github.com/shizukutanaka/Otedama/internal/config"
)

func loadConfigFile(path string, stderr io.Writer) config.Config {
	// --config and OTEDAMA_CONFIG are both user-named paths: a missing
	// file there is a typo or mount failure to warn about, whereas the
	// default location being absent is completely normal.
	explicit := path != "" || os.Getenv("OTEDAMA_CONFIG") != ""
	if path == "" {
		path = defaultConfigPath()
	}
	if path == "" {
		return config.Config{}
	}
	f, err := os.Open(path)
	if err != nil {
		// A missing default-location file is normal; a missing path the
		// user explicitly named (--config / OTEDAMA_CONFIG) is a typo or
		// mount failure they need to hear about — silently mining on
		// defaults would hide it.
		if !os.IsNotExist(err) || explicit {
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
