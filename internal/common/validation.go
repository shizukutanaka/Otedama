package common

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// Validator interface for validating values
type Validator interface {
	Validate(value interface{}) error
}

// ValidationRule represents a single validation rule
type ValidationRule struct {
	Name    string
	Message string
	Check   func(value interface{}) bool
}

// FieldValidator validates a single field
type FieldValidator struct {
	Field string
	Rules []ValidationRule
}

// NewFieldValidator creates a new field validator
func NewFieldValidator(field string) *FieldValidator {
	return &FieldValidator{
		Field: field,
		Rules: make([]ValidationRule, 0),
	}
}

// Required adds required validation
func (v *FieldValidator) Required() *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "required",
		Message: "is required",
		Check: func(value interface{}) bool {
			if value == nil {
				return false
			}
			switch v := value.(type) {
			case string:
				return strings.TrimSpace(v) != ""
			case []byte:
				return len(v) > 0
			default:
				return true
			}
		},
	})
	return v
}

// MinLength adds minimum length validation
func (v *FieldValidator) MinLength(min int) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "min_length",
		Message: fmt.Sprintf("must be at least %d characters", min),
		Check: func(value interface{}) bool {
			switch v := value.(type) {
			case string:
				return len(v) >= min
			case []byte:
				return len(v) >= min
			default:
				return false
			}
		},
	})
	return v
}

// MaxLength adds maximum length validation
func (v *FieldValidator) MaxLength(max int) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "max_length",
		Message: fmt.Sprintf("must be at most %d characters", max),
		Check: func(value interface{}) bool {
			switch v := value.(type) {
			case string:
				return len(v) <= max
			case []byte:
				return len(v) <= max
			default:
				return false
			}
		},
	})
	return v
}

// Pattern adds regex pattern validation
func (v *FieldValidator) Pattern(pattern string, message string) *FieldValidator {
	regex := regexp.MustCompile(pattern)
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "pattern",
		Message: message,
		Check: func(value interface{}) bool {
			str, ok := value.(string)
			if !ok {
				return false
			}
			return regex.MatchString(str)
		},
	})
	return v
}

// Email adds email validation
func (v *FieldValidator) Email() *FieldValidator {
	return v.Pattern(RegexEmail, "must be a valid email address")
}

// URL adds URL validation
func (v *FieldValidator) URL() *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "url",
		Message: "must be a valid URL",
		Check: func(value interface{}) bool {
			str, ok := value.(string)
			if !ok {
				return false
			}
			u, err := url.Parse(str)
			return err == nil && u.Scheme != "" && u.Host != ""
		},
	})
	return v
}

// IP adds IP address validation
func (v *FieldValidator) IP() *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "ip",
		Message: "must be a valid IP address",
		Check: func(value interface{}) bool {
			str, ok := value.(string)
			if !ok {
				return false
			}
			return net.ParseIP(str) != nil
		},
	})
	return v
}

// Port adds port number validation
func (v *FieldValidator) Port() *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "port",
		Message: "must be a valid port number (1-65535)",
		Check: func(value interface{}) bool {
			switch v := value.(type) {
			case int:
				return v > 0 && v <= 65535
			case int64:
				return v > 0 && v <= 65535
			default:
				return false
			}
		},
	})
	return v
}

// Min adds minimum value validation
func (v *FieldValidator) Min(min float64) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "min",
		Message: fmt.Sprintf("must be at least %g", min),
		Check: func(value interface{}) bool {
			switch v := value.(type) {
			case int:
				return float64(v) >= min
			case int64:
				return float64(v) >= min
			case float32:
				return float64(v) >= min
			case float64:
				return v >= min
			default:
				return false
			}
		},
	})
	return v
}

// Max adds maximum value validation
func (v *FieldValidator) Max(max float64) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "max",
		Message: fmt.Sprintf("must be at most %g", max),
		Check: func(value interface{}) bool {
			switch v := value.(type) {
			case int:
				return float64(v) <= max
			case int64:
				return float64(v) <= max
			case float32:
				return float64(v) <= max
			case float64:
				return v <= max
			default:
				return false
			}
		},
	})
	return v
}

// Range adds range validation
func (v *FieldValidator) Range(min, max float64) *FieldValidator {
	return v.Min(min).Max(max)
}

// In adds value in list validation
func (v *FieldValidator) In(values ...interface{}) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "in",
		Message: fmt.Sprintf("must be one of: %v", values),
		Check: func(value interface{}) bool {
			for _, v := range values {
				if value == v {
					return true
				}
			}
			return false
		},
	})
	return v
}

// Custom adds custom validation
func (v *FieldValidator) Custom(check func(interface{}) bool, message string) *FieldValidator {
	v.Rules = append(v.Rules, ValidationRule{
		Name:    "custom",
		Message: message,
		Check:   check,
	})
	return v
}

// Validate performs validation
func (v *FieldValidator) Validate(value interface{}) error {
	for _, rule := range v.Rules {
		if !rule.Check(value) {
			return ValidationError{
				Field:   v.Field,
				Value:   value,
				Message: rule.Message,
			}
		}
	}
	return nil
}

// StructValidator validates a struct
type StructValidator struct {
	validators map[string]*FieldValidator
}

// NewStructValidator creates a new struct validator
func NewStructValidator() *StructValidator {
	return &StructValidator{
		validators: make(map[string]*FieldValidator),
	}
}

// Field adds a field validator
func (v *StructValidator) Field(name string) *FieldValidator {
	validator := NewFieldValidator(name)
	v.validators[name] = validator
	return validator
}

// Validate validates all fields
func (v *StructValidator) Validate(fields map[string]interface{}) error {
	errors := &MultiError{}
	
	for name, validator := range v.validators {
		value, exists := fields[name]
		if !exists {
			value = nil
		}
		
		if err := validator.Validate(value); err != nil {
			errors.Add(err)
		}
	}
	
	return errors.ErrorOrNil()
}

// Common validation functions

// ValidateEmail validates email address
func ValidateEmail(email string) error {
	if !regexp.MustCompile(RegexEmail).MatchString(email) {
		return fmt.Errorf("invalid email address: %s", email)
	}
	return nil
}

// ValidateURL validates URL
func ValidateURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("URL must have scheme and host: %s", rawURL)
	}
	return nil
}

// ValidateIPAddress validates IP address
func ValidateIPAddress(ip string) error {
	if net.ParseIP(ip) == nil {
		return fmt.Errorf("invalid IP address: %s", ip)
	}
	return nil
}

// ValidatePort validates port number
func ValidatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535, got %d", port)
	}
	return nil
}

// ValidateAddress validates network address (host:port)
func ValidateAddress(address string) error {
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid address format: %w", err)
	}
	
	// Validate host (IP or hostname)
	if host == "" {
		return fmt.Errorf("host cannot be empty")
	}
	
	// Validate port
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		return fmt.Errorf("invalid port: %s", portStr)
	}
	
	return ValidatePort(port)
}

// ValidateWalletAddress validates cryptocurrency wallet address
func ValidateWalletAddress(address string, coinType string) error {
	switch strings.ToLower(coinType) {
	case "bitcoin", "btc":
		if !regexp.MustCompile(RegexWalletAddress).MatchString(address) {
			return fmt.Errorf("invalid Bitcoin address: %s", address)
		}
	case "ethereum", "eth":
		if !strings.HasPrefix(address, "0x") || len(address) != 42 {
			return fmt.Errorf("invalid Ethereum address: %s", address)
		}
	default:
		// Generic validation - just check if not empty
		if address == "" {
			return fmt.Errorf("wallet address cannot be empty")
		}
	}
	return nil
}

// ValidatePassword validates password strength
func ValidatePassword(password string) error {
	if len(password) < MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	if len(password) > MaxPasswordLength {
		return fmt.Errorf("password must be at most %d characters", MaxPasswordLength)
	}
	
	// Check for required character types
	var hasUpper, hasLower, hasDigit bool
	for _, r := range password {
		switch {
		case 'A' <= r && r <= 'Z':
			hasUpper = true
		case 'a' <= r && r <= 'z':
			hasLower = true
		case '0' <= r && r <= '9':
			hasDigit = true
		case strings.ContainsRune("!@#$%^&*()_+-=[]{}|;:,.<>?", r):
			// hasSpecial = true // Reserved for future use
		}
	}
	
	if !hasUpper || !hasLower || !hasDigit {
		return fmt.Errorf("password must contain uppercase, lowercase, and digit characters")
	}
	
	return nil
}

// ValidateUsername validates username
func ValidateUsername(username string) error {
	if len(username) < 3 {
		return fmt.Errorf("username must be at least 3 characters")
	}
	if len(username) > 32 {
		return fmt.Errorf("username must be at most 32 characters")
	}
	
	// Allow alphanumeric, underscore, and dash
	if !regexp.MustCompile("^[a-zA-Z0-9_-]+$").MatchString(username) {
		return fmt.Errorf("username can only contain letters, numbers, underscore, and dash")
	}
	
	return nil
}