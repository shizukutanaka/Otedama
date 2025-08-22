package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Result struct {
	Hash  string   `json:"hash"`
	Files []string `json:"files"`
	Size  int64    `json:"size"`
}

type Config struct {
	Root        string
	ExcludeDirs map[string]struct{}
	ExcludeExts map[string]struct{}
	MinSize     int64
	JSON        bool
	Relative    bool
}

func main() {
	var (
		root        = flag.String("root", ".", "scan root directory")
		excludeDirs = flag.String("exclude-dirs", ".git,node_modules,dist,build,bin,.idea,.vscode,vendor", "comma-separated directory names to exclude (match by base name)")
		excludeExts = flag.String("exclude-exts", "", "comma-separated file extensions to exclude (e.g. .png,.jpg)")
		minSize     = flag.Int64("min-size", 1, "minimum file size in bytes to consider")
		jsonOut     = flag.Bool("json", true, "output JSON (true) or text table (false)")
		relative    = flag.Bool("relative", true, "print paths relative to root")
	)
	flag.Parse()

	cfg := Config{
		Root:        *root,
		ExcludeDirs: toSet(*excludeDirs),
		ExcludeExts: toSet(*excludeExts),
		MinSize:     *minSize,
		JSON:        *jsonOut,
		Relative:    *relative,
	}

	results, err := scan(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// sort by descending group size, then path
	sort.Slice(results, func(i, j int) bool {
		if len(results[i].Files) == len(results[j].Files) {
			return results[i].Files[0] < results[j].Files[0]
		}
		return len(results[i].Files) > len(results[j].Files)
	})

	if cfg.JSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(results)
		return
	}

	for _, r := range results {
		fmt.Printf("%s\tsize=%d\tcount=%d\n", r.Hash, r.Size, len(r.Files))
		for _, f := range r.Files {
			fmt.Printf("  %s\n", f)
		}
	}
}

func toSet(csv string) map[string]struct{} {
	s := map[string]struct{}{}
	if csv == "" {
		return s
	}
	for _, p := range strings.Split(csv, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		s[p] = struct{}{}
	}
	return s
}

func scan(cfg Config) ([]Result, error) {
	hashToFiles := map[string][]string{}
	hashToSize := map[string]int64{}

	rootAbs, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, err
	}

	err = filepath.WalkDir(rootAbs, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		name := d.Name()
		if d.IsDir() {
			if _, skip := cfg.ExcludeDirs[name]; skip {
				return filepath.SkipDir
			}
			return nil
		}

		if !d.Type().IsRegular() {
			return nil
		}

		if ext := strings.ToLower(filepath.Ext(name)); ext != "" {
			if _, skip := cfg.ExcludeExts[ext]; skip {
				return nil
			}
		}

		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.Size() < cfg.MinSize {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()

		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		hash := hex.EncodeToString(h.Sum(nil))

		p := path
		if cfg.Relative {
			if rel, err := filepath.Rel(rootAbs, path); err == nil {
				p = rel
			}
		}
		hashToFiles[hash] = append(hashToFiles[hash], filepath.ToSlash(p))
		hashToSize[hash] = info.Size()
		return nil
	})
	if err != nil {
		return nil, err
	}

	out := make([]Result, 0, len(hashToFiles))
	for h, files := range hashToFiles {
		if len(files) <= 1 {
			continue
		}
		sort.Strings(files)
		out = append(out, Result{Hash: h, Files: files, Size: hashToSize[h]})
	}
	return out, nil
}
