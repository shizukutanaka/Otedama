// Package version provides version information for the Otedama system.
package utils

// Version information - these can be overridden during build
var (
	// Version is the current version of Otedama
	Version = "2.1.5"
	
	// BuildDate is set during build time
	BuildDate = "2025-08-05"
	
	// GitCommit can be set via ldflags during build
	GitCommit = "unknown"
	
	// GoVersion is the Go version used to build
	GoVersion = "1.21"
)

// Info returns a struct with all version information
type Info struct {
	Version   string `json:"version"`
	BuildDate string `json:"build_date"`
	GitCommit string `json:"git_commit"`
	GoVersion string `json:"go_version"`
}

// GetInfo returns the current version information
func GetInfo() Info {
	return Info{
		Version:   Version,
		BuildDate: BuildDate,
		GitCommit: GitCommit,
		GoVersion: GoVersion,
	}
}