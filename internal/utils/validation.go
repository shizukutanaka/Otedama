package utils

import (
    "fmt"
    "net"
    "regexp"
    "strings"
)

var (
    alphaNumRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
    hexRegex      = regexp.MustCompile(`^[a-fA-F0-9]+$`)
)

// ValidateAddress validates network addresses
func ValidateAddress(addr string) error {
    if addr == "" {
        return fmt.Errorf("address cannot be empty")
    }
    
    _, _, err := net.SplitHostPort(addr)
    if err != nil {
        return fmt.Errorf("invalid address format: %w", err)
    }
    
    return nil
}

// ValidateHex validates hexadecimal strings
func ValidateHex(s string) error {
    if s == "" {
        return fmt.Errorf("hex string cannot be empty")
    }
    
    if !hexRegex.MatchString(s) {
        return fmt.Errorf("invalid hex string")
    }
    
    return nil
}

// ValidateAlphaNum validates alphanumeric strings
func ValidateAlphaNum(s string) error {
    if s == "" {
        return fmt.Errorf("string cannot be empty")
    }
    
    if !alphaNumRegex.MatchString(s) {
        return fmt.Errorf("string must be alphanumeric")
    }
    
    return nil
}

// ValidateWorkerID validates worker IDs
func ValidateWorkerID(id string) error {
    if len(id) < 3 || len(id) > 64 {
        return fmt.Errorf("worker ID must be 3-64 characters")
    }
    
    return ValidateAlphaNum(id)
}

// SanitizeString removes potentially dangerous characters
func SanitizeString(s string) string {
    // Remove null bytes and control characters
    s = strings.ReplaceAll(s, "\x00", "")
    s = strings.TrimSpace(s)
    return s
}
