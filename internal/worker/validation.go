package worker

import (
    "fmt"
    "strings"

    "github.com/shizukutanaka/Otedama/internal/common"
)

// ValidationError aggregates multiple field errors.
// It implements error and can be marshalled to JSON easily.
type ValidationError struct {
    Fields map[string]string `json:"fields"`
}

func (e *ValidationError) Error() string {
    if e == nil || len(e.Fields) == 0 {
        return "validation error"
    }
    var b strings.Builder
    for k, v := range e.Fields {
        b.WriteString(fmt.Sprintf("%s: %s; ", k, v))
    }
    return strings.TrimSuffix(b.String(), "; ")
}

func newValidationError() *ValidationError {
    return &ValidationError{Fields: make(map[string]string)}
}

func (e *ValidationError) add(field, msg string) {
    if _, ok := e.Fields[field]; !ok {
        e.Fields[field] = msg
    }
}

// Validate checks RegisterWorkerRequest fields according to SECURITY.md rules.
func (r *RegisterWorkerRequest) Validate() error {
    err := newValidationError()

    // Name required 3-50 characters
    fv := common.NewFieldValidator("name").Required().MinLength(3).MaxLength(50)
    if vErr := applyField(fv, r.Name); vErr != "" {
        err.add("name", vErr)
    }

    // HardwareType required
    if strings.TrimSpace(r.HardwareType) == "" {
        err.add("hardware_type", "is required")
    }

    // Algorithm required
    if strings.TrimSpace(r.Algorithm) == "" {
        err.add("algorithm", "is required")
    }

    // Currency required 3-10 uppercase letters
    currencyRule := common.NewFieldValidator("currency").Required().Pattern(`^[A-Z]{3,10}$`, "must be uppercase asset code")
    if vErr := applyField(currencyRule, r.Currency); vErr != "" {
        err.add("currency", vErr)
    }

    // Wallet required & format validation
    if wErr := common.ValidateWalletAddress(r.Currency, r.Wallet); wErr != nil {
        err.add("wallet", wErr.Error())
    }

    if len(err.Fields) > 0 {
        return err
    }
    return nil
}

// Validate checks UpdateWalletRequest.
func (r *UpdateWalletRequest) Validate() error {
    err := newValidationError()

    if strings.TrimSpace(r.Currency) == "" {
        err.add("currency", "is required")
    }
    if wErr := common.ValidateWalletAddress(r.Currency, r.Wallet); wErr != nil {
        err.add("wallet", wErr.Error())
    }

    if len(err.Fields) > 0 {
        return err
    }
    return nil
}

// Validate checks UpdateWorkerRequest (partial update).
func (r *UpdateWorkerRequest) Validate() error {
    err := newValidationError()

    if r.Name != "" {
        if vErr := applyField(common.NewFieldValidator("name").MinLength(3).MaxLength(50), r.Name); vErr != "" {
            err.add("name", vErr)
        }
    }
    // GroupID just sanity length
    if r.GroupID != "" && len(r.GroupID) > 64 {
        err.add("group_id", "too long")
    }

    if len(err.Fields) > 0 {
        return err
    }
    return nil
}

// applyField runs all validation rules and returns first failure message.
func applyField(fv *common.FieldValidator, value interface{}) string {
    for _, rule := range fv.Rules {
        if !rule.Check(value) {
            return rule.Message
        }
    }
    return ""
}
