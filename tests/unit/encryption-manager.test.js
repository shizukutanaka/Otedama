const EncryptionManager = require('../../lib/core/encryption-manager');

describe('EncryptionManager', () => {
    let encryptionManager;
    
    beforeEach(() => {
        encryptionManager = new EncryptionManager({
            masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            keyRotationInterval: 0 // テストではローテーションを無効化
        });
    });
    
    afterEach(() => {
        encryptionManager.destroy();
    });
    
    describe('Key Management', () => {
        test('should generate encryption keys', () => {
            const keyId = encryptionManager.generateKey('test-key');
            
            expect(keyId).toBe('test-key');
            expect(encryptionManager.keys.has(keyId)).toBe(true);
            expect(encryptionManager.keyMetadata.has(keyId)).toBe(true);
            
            const metadata = encryptionManager.keyMetadata.get(keyId);
            expect(metadata.id).toBe(keyId);
            expect(metadata.active).toBe(true);
            expect(metadata.algorithm).toBe('aes-256-gcm');
        });
        
        test('should encrypt and decrypt keys with master key', () => {
            const testKey = Buffer.from('test-key-data-32-bytes-long-here');
            const encrypted = encryptionManager.encryptKey(testKey);
            const decrypted = encryptionManager.decryptKey(encrypted.toString('base64'));
            
            expect(Buffer.compare(testKey, decrypted)).toBe(0);
        });
    });
    
    describe('Data Encryption', () => {
        test('should encrypt and decrypt strings', () => {
            const plaintext = 'This is a secret message';
            const encrypted = encryptionManager.encrypt(plaintext);
            const decrypted = encryptionManager.decrypt(encrypted);
            
            expect(decrypted).toBe(plaintext);
            expect(encrypted).not.toBe(plaintext);
            expect(typeof encrypted).toBe('string');
        });
        
        test('should encrypt and decrypt objects', () => {
            const data = {
                username: 'testuser',
                email: 'test@example.com',
                balance: 1000
            };
            
            const encrypted = encryptionManager.encrypt(data);
            const decrypted = encryptionManager.decrypt(encrypted);
            
            expect(JSON.parse(decrypted)).toEqual(data);
        });
        
        test('should handle Buffer data', () => {
            const buffer = Buffer.from('binary data here');
            const encrypted = encryptionManager.encrypt(buffer);
            const decrypted = encryptionManager.decrypt(encrypted);
            
            expect(decrypted).toBe(buffer.toString('utf8'));
        });
        
        test('should fail decryption with invalid data', () => {
            expect(() => {
                encryptionManager.decrypt('invalid-encrypted-data');
            }).toThrow('Failed to decrypt data');
        });
    });
    
    describe('Password Hashing', () => {
        test('should hash passwords', async () => {
            const password = 'MySecurePassword123!';
            const hashed = await encryptionManager.hashPassword(password);
            
            expect(hashed).not.toBe(password);
            expect(typeof hashed).toBe('string');
            
            // ハッシュが適切な形式か確認
            const decoded = JSON.parse(Buffer.from(hashed, 'base64').toString('utf8'));
            expect(decoded).toHaveProperty('salt');
            expect(decoded).toHaveProperty('hash');
            expect(decoded).toHaveProperty('iterations');
            expect(decoded).toHaveProperty('algorithm');
        });
        
        test('should verify correct passwords', async () => {
            const password = 'MySecurePassword123!';
            const hashed = await encryptionManager.hashPassword(password);
            
            const isValid = await encryptionManager.verifyPassword(password, hashed);
            expect(isValid).toBe(true);
        });
        
        test('should reject incorrect passwords', async () => {
            const password = 'MySecurePassword123!';
            const wrongPassword = 'WrongPassword123!';
            const hashed = await encryptionManager.hashPassword(password);
            
            const isValid = await encryptionManager.verifyPassword(wrongPassword, hashed);
            expect(isValid).toBe(false);
        });
        
        test('should handle invalid hashed password format', async () => {
            const isValid = await encryptionManager.verifyPassword('password', 'invalid-hash');
            expect(isValid).toBe(false);
        });
    });
    
    describe('Field-Level Encryption', () => {
        test('should encrypt specific fields in object', () => {
            const user = {
                id: 1,
                username: 'john_doe',
                email: 'john@example.com',
                ssn: '123-45-6789',
                balance: 1000.50
            };
            
            const encrypted = encryptionManager.encryptObject(user, ['ssn', 'balance']);
            
            expect(encrypted.id).toBe(1);
            expect(encrypted.username).toBe('john_doe');
            expect(encrypted.email).toBe('john@example.com');
            expect(encrypted.ssn).not.toBe('123-45-6789');
            expect(encrypted.balance).not.toBe(1000.50);
            expect(encrypted.ssn_encrypted).toBe(true);
            expect(encrypted.balance_encrypted).toBe(true);
        });
        
        test('should decrypt specific fields in object', () => {
            const user = {
                id: 1,
                username: 'john_doe',
                email: 'john@example.com',
                ssn: '123-45-6789',
                balance: 1000.50
            };
            
            const encrypted = encryptionManager.encryptObject(user, ['ssn', 'balance']);
            const decrypted = encryptionManager.decryptObject(encrypted);
            
            expect(decrypted.ssn).toBe('123-45-6789');
            expect(decrypted.balance).toBe(1000.50);
            expect(decrypted.ssn_encrypted).toBeUndefined();
            expect(decrypted.balance_encrypted).toBeUndefined();
        });
        
        test('should auto-detect encrypted fields', () => {
            const encrypted = {
                id: 1,
                data: 'encrypted-data-here',
                data_encrypted: true,
                secret: 'encrypted-secret',
                secret_encrypted: true,
                normal: 'plain-text'
            };
            
            // フィールドを明示的に指定しない
            const decrypted = encryptionManager.decryptObject(encrypted);
            
            // _encryptedフラグがあるフィールドのみ復号化される
            expect(decrypted.normal).toBe('plain-text');
        });
    });
    
    describe('Token Management', () => {
        test('should generate tokens', () => {
            const tokenData = { userId: 123, role: 'admin' };
            const token = encryptionManager.generateToken(tokenData, 3600000);
            
            expect(typeof token).toBe('string');
            
            const verified = encryptionManager.verifyToken(token);
            expect(verified).toEqual(tokenData);
        });
        
        test('should reject expired tokens', () => {
            const tokenData = { userId: 123 };
            const token = encryptionManager.generateToken(tokenData, -1000); // 既に期限切れ
            
            expect(() => {
                encryptionManager.verifyToken(token);
            }).toThrow('Token expired');
        });
        
        test('should reject invalid tokens', () => {
            expect(() => {
                encryptionManager.verifyToken('invalid-token');
            }).toThrow('Invalid token');
        });
    });
    
    describe('Key Rotation', () => {
        test('should rotate keys', () => {
            const originalKeyCount = encryptionManager.keys.size;
            
            encryptionManager.rotateKeys();
            
            expect(encryptionManager.keys.size).toBe(originalKeyCount + 1);
            
            // 新しいキーがアクティブであることを確認
            let activeCount = 0;
            for (const [, metadata] of encryptionManager.keyMetadata) {
                if (metadata.active) activeCount++;
            }
            expect(activeCount).toBe(1);
        });
        
        test('should emit key rotation event', (done) => {
            encryptionManager.on('key-rotated', (event) => {
                expect(event).toHaveProperty('newKeyId');
                done();
            });
            
            encryptionManager.rotateKeys();
        });
    });
    
    describe('Key Information', () => {
        test('should provide key information', () => {
            encryptionManager.generateKey('key1');
            encryptionManager.generateKey('key2');
            
            const keyInfo = encryptionManager.getKeyInfo();
            
            expect(keyInfo.length).toBeGreaterThanOrEqual(3); // default + key1 + key2
            
            keyInfo.forEach(info => {
                expect(info).toHaveProperty('id');
                expect(info).toHaveProperty('createdAt');
                expect(info).toHaveProperty('active');
                expect(info).toHaveProperty('deactivatedAt');
            });
        });
    });
    
    describe('Express Middleware', () => {
        test('should create middleware for field encryption', () => {
            const middleware = encryptionManager.middleware(['password', 'creditCard']);
            const req = global.testHelpers.mockRequest({
                body: {
                    username: 'test',
                    password: 'encrypted-password',
                    password_encrypted: true
                }
            });
            const res = global.testHelpers.mockResponse();
            const next = jest.fn();
            
            middleware(req, res, next);
            
            expect(next).toHaveBeenCalled();
            // ボディの暗号化フィールドが復号化されているはず
            expect(req.body.password_encrypted).toBeUndefined();
        });
    });
    
    describe('Security', () => {
        test('should securely destroy keys on cleanup', () => {
            const keyId = encryptionManager.generateKey('secure-key');
            const key = encryptionManager.keys.get(keyId);
            
            encryptionManager.destroy();
            
            // キーがクリアされていることを確認
            expect(encryptionManager.keys.size).toBe(0);
            expect(encryptionManager.keyMetadata.size).toBe(0);
            
            // バッファが0で埋められていることを確認（可能な場合）
            if (Buffer.isBuffer(key)) {
                const isZeroed = key.every(byte => byte === 0);
                expect(isZeroed).toBe(true);
            }
        });
    });
});