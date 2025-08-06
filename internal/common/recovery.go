package common

import (
	"fmt"
	"runtime/debug"
)

// Recover recovers from a panic and returns an error
func Recover() error {
	if r := recover(); r != nil {
		// Get stack trace
		stack := debug.Stack()
		
		// Convert panic to error
		var err error
		switch v := r.(type) {
		case error:
			err = v
		case string:
			err = fmt.Errorf(v)
		default:
			err = fmt.Errorf("panic: %v", v)
		}
		
		// Include stack trace in error
		return fmt.Errorf("%w\nStack trace:\n%s", err, stack)
	}
	return nil
}

// SafeGo runs a function in a goroutine with panic recovery
func SafeGo(fn func()) {
	go func() {
		defer func() {
			if err := Recover(); err != nil {
				// Log the error (without importing logger to avoid cycles)
				fmt.Printf("Goroutine panic recovered: %v\n", err)
			}
		}()
		fn()
	}()
}

// SafeFunc wraps a function with panic recovery
func SafeFunc(fn func() error) error {
	var err error
	func() {
		defer func() {
			if panicErr := Recover(); panicErr != nil {
				err = panicErr
			}
		}()
		err = fn()
	}()
	return err
}