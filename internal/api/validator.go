package api

import (
    "fmt"
    "regexp"
    "strings"
)

// InputValidator provides minimal validation helpers used by Server.
type InputValidator struct{}

// NewInputValidator returns a new minimal validator (API-local).
func NewInputValidator() *InputValidator { return &InputValidator{} }

// ValidateWorkerID ensures a safe worker identifier.
func (v *InputValidator) ValidateWorkerID(id string) error {
    if id == "" {
        return fmt.Errorf("worker id is required")
    }
    if len(id) > 64 {
        return fmt.Errorf("worker id too long")
    }
    if !workerIDRegex.MatchString(id) {
        return fmt.Errorf("invalid worker id format")
    }
    return nil
}

// ValidateAction checks supported control actions.
func (v *InputValidator) ValidateAction(action string) error {
    a := strings.ToLower(strings.TrimSpace(action))
    switch a {
    case "start", "stop", "pause", "resume", "restart":
        return nil
    default:
        return fmt.Errorf("unsupported action: %s", action)
    }
}

// ValidateAlgorithm checks that the algorithm is one we advertise/support.
func (v *InputValidator) ValidateAlgorithm(algorithm string) error {
	if !algorithmRegex.MatchString(algorithm) {
		return fmt.Errorf("invalid algorithm name: %s", algorithm)
	}
	a := strings.ToLower(strings.TrimSpace(algorithm))
	switch a {
	case "sha256d", "ethash", "kawpow", "randomx", "scrypt":
		return nil
	default:
		return fmt.Errorf("unsupported algorithm: %s", algorithm)
	}
}

// ValidateProfileName checks if the profile name is valid.
func (v *InputValidator) ValidateProfileName(name string) error {
	if !profileNameRegex.MatchString(name) {
		return fmt.Errorf("invalid profile name: %s", name)
	}
	return nil
}

// ValidateFilePath checks for safe file paths.
func (v *InputValidator) ValidateFilePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("file path is required")
	}
	if len(path) > 255 {
		return errors.New("file path is too long")
	}
	if strings.Contains(path, "..") {
		return errors.New("directory traversal is not allowed")
	}
	if !filePathRegex.MatchString(path) {
		return fmt.Errorf("invalid characters in file path: %s", path)
	}
	return nil
}

var (
	workerIDRegex    = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)
	actionRegex      = regexp.MustCompile(`^[a-zA-Z_]+$`)
	algorithmRegex   = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)
	profileNameRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	filePathRegex    = regexp.MustCompile(`^(/|([a-zA-Z]:\))?[^\x00\*\?<>\|:]+$`)
)
