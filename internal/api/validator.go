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
    re := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
    if !re.MatchString(id) {
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
func (v *InputValidator) ValidateAlgorithm(algo string) error {
    a := strings.ToLower(strings.TrimSpace(algo))
    switch a {
    case "sha256d", "ethash", "kawpow", "randomx", "scrypt":
        return nil
    default:
        return fmt.Errorf("unsupported algorithm: %s", algo)
    }
}
