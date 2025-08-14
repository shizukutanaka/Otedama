// Package version provides version information for the Otedama system.
package utils

// Version information - these can be overridden during build
var (
	// Version is the current version of Otedama
	Version = ""
	
	// BuildDate is set during build time
	BuildDate = ""
	
	// GitCommit can be set via ldflags during build
	GitCommit = ""
	
	// GoVersion is the Go version used to build
	GoVersion = ""
)

// Info returns a struct with all version information
type Info struct {
	Version   string `json:"version,omitempty"`
	BuildDate string `json:"build_date,omitempty"`
	GitCommit string `json:"git_commit,omitempty"`
	GoVersion string `json:"go_version,omitempty"`
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