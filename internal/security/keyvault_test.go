package security

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestKeyVault(t *testing.T) (*KeyVault, func()) {
	t.Helper()

	// Set a valid master key for the test environment
	originalMasterKey := os.Getenv("OTEDAMA_MASTER_KEY")
	t.Setenv("OTEDAMA_MASTER_KEY", "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890") // 32-byte key

	tempDir := t.TempDir()
	vaultFile := filepath.Join(tempDir, "test_vault.json")

	kv, err := NewKeyVault(vaultFile)
	require.NoError(t, err, "NewKeyVault should succeed with a valid master key and file path")

	cleanup := func() {
		os.Setenv("OTEDAMA_MASTER_KEY", originalMasterKey)
	}

	return kv, cleanup
}

func TestKeyVault(t *testing.T) {
	kv, cleanup := setupTestKeyVault(t)
	defer cleanup()

	t.Run("Set and Get", func(t *testing.T) {
		keyName := "test_api_key"
		secretValue := []byte("super-secret-value")

		err := kv.Set(keyName, secretValue)
		require.NoError(t, err, "Set should not return an error")

		retrievedValue, err := kv.Get(keyName)
		require.NoError(t, err, "Get should not return an error for an existing key")

		assert.Equal(t, secretValue, retrievedValue, "Retrieved value should match the original secret value")
	})

	t.Run("Get non-existent key", func(t *testing.T) {
		_, err := kv.Get("non_existent_key")
		assert.Error(t, err, "Get should return an error for a non-existent key")
	})
}

func TestKeyVault_Persistence(t *testing.T) {
	kv, cleanup := setupTestKeyVault(t)
	defer cleanup()

	keyName := "persistent_key"
	secretValue := []byte("this should be saved")

	// 1. Set a key and verify it's persisted.
	err := kv.Set(keyName, secretValue)
	require.NoError(t, err)

	// 2. Create a new vault instance from the same file.
	newKv, err := NewKeyVault(kv.filePath)
	require.NoError(t, err)

	// 3. Get the key from the new instance.
	retrievedValue, err := newKv.Get(keyName)
	require.NoError(t, err)
	assert.Equal(t, secretValue, retrievedValue, "Value should be retrieved after reloading from file")

	// 4. Delete the key and verify.
	err = newKv.Delete(keyName)
	require.NoError(t, err)

	_, err = newKv.Get(keyName)
	assert.Error(t, err, "Get should fail after key is deleted")

	// 5. Create a third instance to ensure deletion was persisted.
	finalKv, err := NewKeyVault(kv.filePath)
	require.NoError(t, err)

	_, err = finalKv.Get(keyName)
	assert.Error(t, err, "Get should fail on a new instance after deletion")
}

func TestKeyVault_ConcurrentAccess(t *testing.T) {
	kv, cleanup := setupTestKeyVault(t)
	defer cleanup()

	var wg sync.WaitGroup
	numGoroutines := 100
	wg.Add(numGoroutines)

	// Concurrently set values
	for i := 0; i < numGoroutines; i++ {
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("key_%d", i)
			value := []byte(fmt.Sprintf("value_%d", i))
			err := kv.Set(key, value)
			assert.NoError(t, err)
		}(i)
	}

	wg.Wait()

	// Concurrently get and verify values
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("key_%d", i)
			expectedValue := []byte(fmt.Sprintf("value_%d", i))

			retrievedValue, err := kv.Get(key)
			assert.NoError(t, err)
			assert.Equal(t, expectedValue, retrievedValue)
		}(i)
	}

	wg.Wait()
}

func TestNewKeyVault_InvalidMasterKey(t *testing.T) {
	tempDir := t.TempDir()
	vaultFile := filepath.Join(tempDir, "test_vault.json")

	t.Run("missing master key", func(t *testing.T) {
		originalMasterKey := os.Getenv("OTEDAMA_MASTER_KEY")
		t.Setenv("OTEDAMA_MASTER_KEY", "")
		defer os.Setenv("OTEDAMA_MASTER_KEY", originalMasterKey)

		_, err := NewKeyVault(vaultFile)
		assert.Error(t, err, "NewKeyVault should fail if master key is missing")
	})

	t.Run("short master key", func(t *testing.T) {
		originalMasterKey := os.Getenv("OTEDAMA_MASTER_KEY")
		t.Setenv("OTEDAMA_MASTER_KEY", "short")
		defer os.Setenv("OTEDAMA_MASTER_KEY", originalMasterKey)

		_, err := NewKeyVault(vaultFile)
		assert.Error(t, err, "NewKeyVault should fail if master key is too short")
	})
}
