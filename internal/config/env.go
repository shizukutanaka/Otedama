package config

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// EnvLoader loads configuration from environment variables
type EnvLoader struct {
	prefix string
}

// NewEnvLoader creates a new environment loader
func NewEnvLoader(prefix string) *EnvLoader {
	return &EnvLoader{
		prefix: prefix,
	}
}

// Load loads configuration from environment variables
func (el *EnvLoader) Load(config *Config) error {
	return el.loadStruct(reflect.ValueOf(config).Elem(), el.prefix)
}

// loadStruct recursively loads a struct from environment variables
func (el *EnvLoader) loadStruct(v reflect.Value, prefix string) error {
	t := v.Type()
	
	for i := 0; i < v.NumField(); i++ {
		field := v.Field(i)
		fieldType := t.Field(i)
		
		// Skip unexported fields
		if !field.CanSet() {
			continue
		}
		
		// Get the field name from yaml tag or use field name
		fieldName := fieldType.Tag.Get("yaml")
		if fieldName == "" || fieldName == "-" {
			fieldName = fieldType.Name
		}
		
		// Build environment variable name
		envName := el.buildEnvName(prefix, fieldName)
		
		// Handle different field types
		switch field.Kind() {
		case reflect.Struct:
			// Recursively handle nested structs
			if fieldType.Type.String() != "time.Duration" && fieldType.Type.String() != "time.Time" {
				if err := el.loadStruct(field, envName); err != nil {
					return err
				}
			} else {
				// Handle time.Duration and time.Time
				if err := el.loadField(field, envName); err != nil {
					return err
				}
			}
			
		case reflect.Slice:
			// Handle slices
			if err := el.loadSlice(field, envName); err != nil {
				return err
			}
			
		case reflect.Map:
			// Handle maps
			if err := el.loadMap(field, envName); err != nil {
				return err
			}
			
		default:
			// Handle primitive types
			if err := el.loadField(field, envName); err != nil {
				return err
			}
		}
	}
	
	return nil
}

// loadField loads a single field from environment variable
func (el *EnvLoader) loadField(field reflect.Value, envName string) error {
	value := os.Getenv(envName)
	if value == "" {
		return nil // Skip if not set
	}
	
	switch field.Kind() {
	case reflect.String:
		field.SetString(value)
		
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		// Special handling for time.Duration
		if field.Type().String() == "time.Duration" {
			duration, err := time.ParseDuration(value)
			if err != nil {
				return fmt.Errorf("invalid duration for %s: %w", envName, err)
			}
			field.Set(reflect.ValueOf(duration))
		} else {
			intVal, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return fmt.Errorf("invalid integer for %s: %w", envName, err)
			}
			field.SetInt(intVal)
		}
		
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		uintVal, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid unsigned integer for %s: %w", envName, err)
		}
		field.SetUint(uintVal)
		
	case reflect.Float32, reflect.Float64:
		floatVal, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fmt.Errorf("invalid float for %s: %w", envName, err)
		}
		field.SetFloat(floatVal)
		
	case reflect.Bool:
		boolVal, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid boolean for %s: %w", envName, err)
		}
		field.SetBool(boolVal)
		
	default:
		return fmt.Errorf("unsupported field type %s for %s", field.Kind(), envName)
	}
	
	return nil
}

// loadSlice loads a slice from environment variable
func (el *EnvLoader) loadSlice(field reflect.Value, envName string) error {
	value := os.Getenv(envName)
	if value == "" {
		return nil
	}
	
	// Split by comma
	parts := strings.Split(value, ",")
	
	// Create new slice
	slice := reflect.MakeSlice(field.Type(), len(parts), len(parts))
	
	// Set each element
	for i, part := range parts {
		part = strings.TrimSpace(part)
		elem := slice.Index(i)
		
		switch elem.Kind() {
		case reflect.String:
			elem.SetString(part)
			
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			intVal, err := strconv.ParseInt(part, 10, 64)
			if err != nil {
				return fmt.Errorf("invalid integer in slice for %s: %w", envName, err)
			}
			elem.SetInt(intVal)
			
		case reflect.Float32, reflect.Float64:
			floatVal, err := strconv.ParseFloat(part, 64)
			if err != nil {
				return fmt.Errorf("invalid float in slice for %s: %w", envName, err)
			}
			elem.SetFloat(floatVal)
			
		default:
			return fmt.Errorf("unsupported slice element type %s for %s", elem.Kind(), envName)
		}
	}
	
	field.Set(slice)
	return nil
}

// loadMap loads a map from environment variables
func (el *EnvLoader) loadMap(field reflect.Value, envPrefix string) error {
	// For maps, we look for environment variables with a specific pattern
	// e.g., OTEDAMA_MINING_ALGORITHM_PARAMS_KEY=value
	
	if field.Type().Key().Kind() != reflect.String {
		return fmt.Errorf("only string keys are supported for maps in env vars")
	}
	
	// Create new map if needed
	if field.IsNil() {
		field.Set(reflect.MakeMap(field.Type()))
	}
	
	// Look for all environment variables with the prefix
	prefix := envPrefix + "_"
	for _, env := range os.Environ() {
		parts := strings.SplitN(env, "=", 2)
		if len(parts) != 2 {
			continue
		}
		
		key := parts[0]
		value := parts[1]
		
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		
		// Extract map key
		mapKey := strings.TrimPrefix(key, prefix)
		mapKey = strings.ToLower(mapKey)
		
		// Set map value
		mapValue := reflect.New(field.Type().Elem()).Elem()
		
		switch mapValue.Kind() {
		case reflect.String:
			mapValue.SetString(value)
			
		case reflect.Interface:
			// For interface{}, try to parse as different types
			if intVal, err := strconv.ParseInt(value, 10, 64); err == nil {
				mapValue.Set(reflect.ValueOf(intVal))
			} else if floatVal, err := strconv.ParseFloat(value, 64); err == nil {
				mapValue.Set(reflect.ValueOf(floatVal))
			} else if boolVal, err := strconv.ParseBool(value); err == nil {
				mapValue.Set(reflect.ValueOf(boolVal))
			} else {
				mapValue.Set(reflect.ValueOf(value))
			}
			
		default:
			return fmt.Errorf("unsupported map value type %s for %s", mapValue.Kind(), key)
		}
		
		field.SetMapIndex(reflect.ValueOf(mapKey), mapValue)
	}
	
	return nil
}

// buildEnvName builds environment variable name from prefix and field name
func (el *EnvLoader) buildEnvName(prefix, fieldName string) string {
	// Convert to uppercase and replace separators
	envName := strings.ToUpper(fieldName)
	envName = strings.ReplaceAll(envName, "-", "_")
	envName = strings.ReplaceAll(envName, ".", "_")
	
	if prefix != "" {
		return prefix + "_" + envName
	}
	return envName
}

// Override specific helper functions for common overrides

// OverrideFromEnv applies common environment variable overrides
func (el *EnvLoader) OverrideFromEnv(config *Config) {
	// System overrides
	if nodeID := os.Getenv(el.prefix + "_NODE_ID"); nodeID != "" {
		config.System.NodeID = nodeID
	}
	
	if dataDir := os.Getenv(el.prefix + "_DATA_DIR"); dataDir != "" {
		config.System.DataDir = dataDir
	}
	
	// Mining overrides
	if algo := os.Getenv(el.prefix + "_MINING_ALGORITHM"); algo != "" {
		config.Mining.Algorithm = algo
	}
	
	if workers := os.Getenv(el.prefix + "_MINING_WORKERS"); workers != "" {
		if val, err := strconv.Atoi(workers); err == nil {
			config.Mining.CPUThreads = val
		}
	}
	
	// API overrides
	if apiAddr := os.Getenv(el.prefix + "_API_LISTEN_ADDR"); apiAddr != "" {
		config.API.ListenAddr = apiAddr
	}
	
	if apiEnabled := os.Getenv(el.prefix + "_API_ENABLED"); apiEnabled != "" {
		if val, err := strconv.ParseBool(apiEnabled); err == nil {
			config.API.Enabled = val
		}
	}
	
	// Security overrides
	if jwtSecret := os.Getenv(el.prefix + "_SECURITY_JWT_SECRET"); jwtSecret != "" {
		config.Security.JWTSecret = jwtSecret
	}
	
	// Database overrides
	if dbDSN := os.Getenv(el.prefix + "_DATABASE_DSN"); dbDSN != "" {
		config.Database.DSN = dbDSN
	}
	
	// Logging overrides
	if logLevel := os.Getenv(el.prefix + "_LOGGING_LEVEL"); logLevel != "" {
		config.Logging.Level = logLevel
	}
}