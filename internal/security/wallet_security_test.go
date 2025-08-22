package security

import (
    "context"
    "encoding/json"
    "os"
    "path/filepath"
    "sort"
    "strings"
    "testing"
    "time"

    "go.uber.org/zap"
)

// testMFA is a simple MFAProvider used in tests
type testMFA struct {
    expectUser      string
    expectChallenge string
    expectResponse  string
    verifyErr       error
}

func TestRestoreWalletsPlaintext_IDMismatch(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "diff", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1} },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "idmismatch.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "key ID mismatch for k1: diff") {
        t.Fatalf("expected ID mismatch error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_EmptyIDNormalizes(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1} },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "emptyid.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err != nil {
        t.Fatalf("restore failed: %v", err)
    }
    if _, err := wsm.keyStore.Retrieve("k1"); err != nil {
        t.Fatalf("expected k1 to be stored, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidArgon2Memory(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        MemoryKiB:  4096, // too small
        Parallelism: 4,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_argon2_mem.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported argon2 memory_kib") {
        t.Fatalf("expected argon2 memory_kib error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidArgon2Parallelism(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        MemoryKiB:  64*1024,
        Parallelism: 0, // invalid
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_argon2_par.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported argon2 parallelism") {
        t.Fatalf("expected argon2 parallelism error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidScryptR(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "scrypt",
        Iterations: 4096,
        R:          4, // invalid
        P:          1,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_scrypt_r.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported scrypt r") {
        t.Fatalf("expected scrypt r error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidScryptP(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "scrypt",
        Iterations: 4096,
        R:          8,
        P:          0, // invalid
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_scrypt_p.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported scrypt p") {
        t.Fatalf("expected scrypt p error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_UnknownField(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Start from a valid encrypted backup struct, then inject an unknown field
    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    // inject ,"Extra":true before final }
    b = append(b[:len(b)-1], append([]byte(`,"Extra":true}`), []byte{}...)...)
    path := filepath.Join(dir, "unknown_field.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(strings.ToLower(err.Error()), "unknown field") {
        t.Fatalf("expected unknown field error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_UnknownField(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Build raw JSON with an extra field inside key object. EncryptedKey one byte => base64 "AQ=="
    raw := []byte(`{"k1":{"ID":"k1","Algorithm":"aes-256-gcm","EncryptedKey":"AQ==","Extra":true}}`)
    path := filepath.Join(dir, "unknown_plain.json")
    if err := os.WriteFile(path, raw, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(strings.ToLower(err.Error()), "unknown field") {
        t.Fatalf("expected unknown field error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_UnsupportedAlgorithm(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "chacha20-poly1305",
        KDF:        "argon2",
        Iterations: 3,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_algo.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported encryption algorithm") {
        t.Fatalf("expected unsupported algorithm error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidSaltLength(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        Salt:       []byte{1,2,3,4,5,6,7,8},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_salt.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "invalid salt length") {
        t.Fatalf("expected invalid salt length error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_EmptyCiphertext(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: nil,
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "empty_ct.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "backup ciphertext is empty") {
        t.Fatalf("expected empty ciphertext error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidNonceSize(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 3,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_nonce.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "invalid nonce size") {
        t.Fatalf("expected invalid nonce size error, got %v", err)
    }
}

func (m *testMFA) GenerateChallenge(userID string) (string, error) {
    return m.expectChallenge, nil
}

func (m *testMFA) VerifyResponse(userID, challenge, response string) (bool, error) {
    if m.verifyErr != nil {
        return false, m.verifyErr
    }
    return userID == m.expectUser && challenge == m.expectChallenge && response == m.expectResponse, nil
}

func (m *testMFA) EnrollUser(userID string, data interface{}) error { return nil }

func TestFileKeyStoreCRUD(t *testing.T) {
    dir := t.TempDir()
    ks := NewFileKeyStore(dir)

    key := &EncryptedKey{
        ID:        "testkey1",
        Algorithm: "aes-256-gcm",
        // Minimal fields for persistence
        EncryptedKey: []byte{1, 2, 3},
        Nonce:        []byte{4, 5, 6},
        Salt:         []byte{7, 8, 9},
        CreatedAt:    time.Now(),
        Metadata:     map[string]string{"user_id": "u1"},
    }

    if err := ks.Store(key); err != nil {
        t.Fatalf("Store failed: %v", err)
    }

    got, err := ks.Retrieve("testkey1")
    if err != nil {
        t.Fatalf("Retrieve failed: %v", err)
    }
    if got == nil || got.ID != key.ID {
        t.Fatalf("Retrieve mismatch: got %+v", got)
    }

    ids, err := ks.List()
    if err != nil {
        t.Fatalf("List failed: %v", err)
    }
    if len(ids) != 1 || ids[0] != "testkey1" {
        t.Fatalf("List mismatch: %v", ids)
    }

    if err := ks.Delete("testkey1"); err != nil {
        t.Fatalf("Delete failed: %v", err)
    }

    // After delete, file should not exist
    if _, err := ks.Retrieve("testkey1"); err == nil {
        t.Fatalf("expected error retrieving deleted key")
    }
}

func TestRestoreWalletsPlaintext(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()

    // Prepare keystore with two keys
    ks := NewFileKeyStore(dir)
    if err := ks.Store(&EncryptedKey{ID: "k1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now()}); err != nil {
        t.Fatalf("Store k1 failed: %v", err)
    }
    if err := ks.Store(&EncryptedKey{ID: "k2", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}, CreatedAt: time.Now()}); err != nil {
        t.Fatalf("Store k2 failed: %v", err)
    }

    // Create plaintext backup file
    backupPath := filepath.Join(dir, "backup.json")
    if err := ks.Backup(backupPath); err != nil {
        t.Fatalf("Backup failed: %v", err)
    }

    // Wipe keystore files (simulate lost state)
    entries, _ := os.ReadDir(dir)
    for _, e := range entries {
        if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
            _ = os.Remove(filepath.Join(dir, e.Name()))
        }
    }

    // Create WSM and restore from plaintext backup
    cfg := WalletSecurityConfig{KeyStoreDir: dir}
    wsm, err := NewWalletSecurityManager(logger, cfg)
    if err != nil {
        t.Fatalf("NewWalletSecurityManager: %v", err)
    }

    if err := wsm.RestoreWallets(context.Background(), backupPath, ""); err != nil {
        t.Fatalf("RestoreWallets plaintext failed: %v", err)
    }

    // Validate keys present again
    ids, err := ks.List()
    if err != nil {
        t.Fatalf("List after restore failed: %v", err)
    }
    if len(ids) != 2 {
        t.Fatalf("expected 2 keys after restore, got %d (%v)", len(ids), ids)
    }
}

func TestRestoreWalletsEncrypted(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()

    // Prepare keystore with two keys
    ks := NewFileKeyStore(dir)
    if err := ks.Store(&EncryptedKey{ID: "k1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now()}); err != nil {
        t.Fatalf("Store k1 failed: %v", err)
    }
    if err := ks.Store(&EncryptedKey{ID: "k2", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}, CreatedAt: time.Now()}); err != nil {
        t.Fatalf("Store k2 failed: %v", err)
    }

    // Create WSM configured for encrypted backups into dir
    cfg := WalletSecurityConfig{
        KeyStoreDir:     dir,
        EnableBackup:    true,
        BackupEncrypted: true,
        BackupLocation:  dir,
        KDFAlgo:         "argon2",
        KDFIterations:   3,
    }
    wsm, err := NewWalletSecurityManager(logger, cfg)
    if err != nil {
        t.Fatalf("NewWalletSecurityManager: %v", err)
    }

    // Create encrypted backup
    path, err := wsm.BackupWallets(context.Background(), "password123")
    if err != nil {
        t.Fatalf("BackupWallets encrypted failed: %v", err)
    }

    // Wipe keystore files
    entries, _ := os.ReadDir(dir)
    for _, e := range entries {
        if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
            _ = os.Remove(filepath.Join(dir, e.Name()))
        }
    }

    // Restore from encrypted backup
    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err != nil {
        t.Fatalf("RestoreWallets encrypted failed: %v", err)
    }

    // Validate keys present again
    ids, err := ks.List()
    if err != nil {
        t.Fatalf("List after restore failed: %v", err)
    }
    if len(ids) != 2 {
        t.Fatalf("expected 2 keys after restore, got %d (%v)", len(ids), ids)
    }
}

func TestFileKeyStoreBackup(t *testing.T) {
    dir := t.TempDir()
    ks := NewFileKeyStore(dir)

    k1 := &EncryptedKey{ID: "a", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}}
    k2 := &EncryptedKey{ID: "b", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}}

    if err := ks.Store(k1); err != nil {
        t.Fatalf("Store k1 failed: %v", err)
    }
    if err := ks.Store(k2); err != nil {
        t.Fatalf("Store k2 failed: %v", err)
    }

    backupPath := filepath.Join(dir, "backup.json")
    if err := ks.Backup(backupPath); err != nil {
        t.Fatalf("Backup failed: %v", err)
    }

    // Verify backup file exists and is non-empty
    info, err := os.Stat(backupPath)
    if err != nil {
        t.Fatalf("stat backup failed: %v", err)
    }
    if info.Size() == 0 {
        t.Fatalf("backup file is empty")
    }
}

func TestWSM_ListWalletIDs(t *testing.T) {
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // populate
    _ = wsm.keyStore.Store(&EncryptedKey{ID: "x1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now()})
    _ = wsm.keyStore.Store(&EncryptedKey{ID: "x2", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}, CreatedAt: time.Now()})

    ids, err := wsm.ListWalletIDs()
    if err != nil { t.Fatalf("ListWalletIDs: %v", err) }
    sort.Strings(ids)
    if len(ids) != 2 || ids[0] != "x1" || ids[1] != "x2" {
        t.Fatalf("unexpected ids: %v", ids)
    }
}

func TestWSM_DeleteWalletsWithAuth_Success(t *testing.T) {
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // keys
    _ = wsm.keyStore.Store(&EncryptedKey{ID: "d1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now()})
    _ = wsm.keyStore.Store(&EncryptedKey{ID: "d2", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}, CreatedAt: time.Now()})

    // auth
    mfa := &testMFA{expectUser: "u1", expectChallenge: "c", expectResponse: "r"}
    wsm.SetMFAProvider(mfa)
    wsm.EnableMFA(true)
    wsm.GrantPermission("u1", Permission{Operation: OpWalletDelete, ExpiresAt: time.Now().Add(time.Hour)})

    if err := wsm.DeleteWalletsWithAuth(context.Background(), "u1", "c", "r", []string{"d1"}); err != nil {
        t.Fatalf("DeleteWalletsWithAuth failed: %v", err)
    }

    if _, err := wsm.keyStore.Retrieve("d1"); err == nil {
        t.Fatalf("d1 should be deleted")
    }
    if _, err := wsm.keyStore.Retrieve("d2"); err != nil {
        t.Fatalf("d2 should exist: %v", err)
    }
}

func TestWSM_DeleteWalletsWithAuth_NoPermission(t *testing.T) {
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    _ = wsm.keyStore.Store(&EncryptedKey{ID: "d1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now()})

    // MFA enabled but no permission
    mfa := &testMFA{expectUser: "u1", expectChallenge: "c", expectResponse: "r"}
    wsm.SetMFAProvider(mfa)
    wsm.EnableMFA(true)

    if err := wsm.DeleteWalletsWithAuth(context.Background(), "u1", "c", "r", []string{"d1"}); err == nil {
        t.Fatalf("expected access denied without permission")
    }
}

func TestWSM_RotateKeysWithAuth_Success(t *testing.T) {
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir, KeyRotation: true, KeyLifetime: time.Minute})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // create old and new keys
    old := &EncryptedKey{ID: "old", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, CreatedAt: time.Now().Add(-time.Hour)}
    newk := &EncryptedKey{ID: "new", Algorithm: "aes-256-gcm", EncryptedKey: []byte{2}, CreatedAt: time.Now()}
    _ = wsm.keyStore.Store(old)
    _ = wsm.keyStore.Store(newk)

    // auth
    mfa := &testMFA{expectUser: "u1", expectChallenge: "c", expectResponse: "r"}
    wsm.SetMFAProvider(mfa)
    wsm.EnableMFA(true)
    wsm.GrantPermission("u1", Permission{Operation: OpWalletRotate, ExpiresAt: time.Now().Add(time.Hour)})

    rotated, err := wsm.RotateKeysWithAuth(context.Background(), "u1", "c", "r")
    if err != nil { t.Fatalf("RotateKeysWithAuth failed: %v", err) }
    if len(rotated) != 1 || rotated[0] != "old" {
        t.Fatalf("unexpected rotated: %v", rotated)
    }

    got, err := wsm.keyStore.Retrieve("old")
    if err != nil { t.Fatalf("retrieve old: %v", err) }
    if got.Metadata == nil || got.Metadata["rotated_at"] == "" {
        t.Fatalf("expected rotated_at metadata, got: %+v", got.Metadata)
    }
    if time.Since(got.CreatedAt) > time.Minute {
        t.Fatalf("expected CreatedAt refreshed, got %v", got.CreatedAt)
    }
}

func TestWSM_RotateKeysWithAuth_Disabled(t *testing.T) {
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir, KeyRotation: false})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // auth
    mfa := &testMFA{expectUser: "u1", expectChallenge: "c", expectResponse: "r"}
    wsm.SetMFAProvider(mfa)
    wsm.EnableMFA(true)
    wsm.GrantPermission("u1", Permission{Operation: OpWalletRotate, ExpiresAt: time.Now().Add(time.Hour)})

    if _, err := wsm.RotateKeysWithAuth(context.Background(), "u1", "c", "r"); err == nil {
        t.Fatalf("expected error when rotation disabled")
    }
}

func TestRestoreWalletsEncrypted_InvalidArgon2Iterations(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Craft invalid encrypted backup: argon2 with iterations 0
    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "argon2",
        Iterations: 0,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_argon2.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported argon2 iterations") {
        t.Fatalf("expected argon2 iterations error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_InvalidScryptN(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Craft invalid encrypted backup: scrypt with non power-of-two N
    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "scrypt",
        Iterations: 10000,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_scrypt.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported scrypt N value") {
        t.Fatalf("expected scrypt N error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_EmptyBackup(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    path := filepath.Join(dir, "empty.json")
    if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "backup contains no keys") {
        t.Fatalf("expected empty backup error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_UnsupportedAlgorithmPerKey(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "k1", Algorithm: "chacha20-poly1305", EncryptedKey: []byte{1}, Nonce: []byte{1,2,3,4,5,6,7,8,9,10,11,12} },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "bad_alg.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "unsupported key algorithm") {
        t.Fatalf("expected unsupported algorithm error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_InvalidNonceSize(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "k1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, Nonce: []byte{1,2,3,4,5} },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "bad_nonce.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "invalid nonce size") {
        t.Fatalf("expected invalid nonce size error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_InvalidSaltLength(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "k1", Algorithm: "aes-256-gcm", EncryptedKey: []byte{1}, Nonce: []byte{1,2,3,4,5,6,7,8,9,10,11,12}, Salt: []byte{1,2,3,4,5,6,7,8} },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "bad_salt.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "invalid salt length") {
        t.Fatalf("expected invalid salt length error, got %v", err)
    }
}

func TestRestoreWalletsPlaintext_MissingEncryptedPayload(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    export := map[string]*EncryptedKey{
        "k1": { ID: "k1", Algorithm: "aes-256-gcm" },
    }
    b, _ := json.Marshal(export)
    path := filepath.Join(dir, "bad_plain.json")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, ""); err == nil || !strings.Contains(err.Error(), "empty encrypted payload") {
        t.Fatalf("expected empty payload error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_UnsupportedKDF(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Craft encrypted backup with unsupported KDF
    enc := encryptedBackupFile{
        Algorithm:  "aes-256-gcm",
        KDF:        "pbkdf2",
        Iterations: 1000,
        Salt:       []byte{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16},
        Nonce:      []byte{1,2,3,4,5,6,7,8,9,10,11,12},
        Ciphertext: []byte{1},
        CreatedAt:  time.Now(),
    }
    b, _ := json.Marshal(enc)
    path := filepath.Join(dir, "bad_kdf.enc")
    if err := os.WriteFile(path, b, 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "password123"); err == nil || !strings.Contains(err.Error(), "unsupported KDF algorithm in backup") {
        t.Fatalf("expected unsupported KDF algorithm error, got %v", err)
    }
}

func TestRestoreWalletsEncrypted_PasswordTooShort(t *testing.T) {
    t.Parallel()
    dir := t.TempDir()
    logger := zap.NewNop()
    wsm, err := NewWalletSecurityManager(logger, WalletSecurityConfig{KeyStoreDir: dir})
    if err != nil { t.Fatalf("NewWalletSecurityManager: %v", err) }

    // Create minimal .enc file; length check happens before parsing
    path := filepath.Join(dir, "tiny.enc")
    if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil { t.Fatalf("write: %v", err) }

    if err := wsm.RestoreWallets(context.Background(), path, "pass"); err == nil || !strings.Contains(err.Error(), "to decrypt backup") {
        t.Fatalf("expected password length error, got %v", err)
    }
}
