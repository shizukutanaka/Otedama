const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * 暗号化管理システム
 * AES-256-GCMによる強力な暗号化とキー管理
 */
class EncryptionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            algorithm: config.algorithm || 'aes-256-gcm',
            keyLength: config.keyLength || 32,
            ivLength: config.ivLength || 16,
            tagLength: config.tagLength || 16,
            saltLength: config.saltLength || 64,
            pbkdf2Iterations: config.pbkdf2Iterations || 100000,
            keyRotationInterval: config.keyRotationInterval || 2592000000, // 30日
            ...config
        };
        
        this.masterKey = null;
        this.keys = new Map();
        this.keyMetadata = new Map();
        
        this.initialize();
    }
    
    /**
     * 初期化
     */
    initialize() {
        // マスターキーを生成または読み込み
        if (this.config.masterKey) {
            this.masterKey = Buffer.from(this.config.masterKey, 'hex');
        } else if (process.env.OTEDAMA_MASTER_KEY) {
            this.masterKey = Buffer.from(process.env.OTEDAMA_MASTER_KEY, 'hex');
        } else {
            // 警告: 本番環境では必ず外部から提供されたマスターキーを使用
            console.warn('No master key provided, generating temporary key');
            this.masterKey = crypto.randomBytes(32);
        }
        
        // デフォルトキーを生成
        this.generateKey('default');
        
        // キーローテーションを設定
        if (this.config.keyRotationInterval > 0) {
            this.startKeyRotation();
        }
    }
    
    /**
     * 暗号化キーを生成
     */
    generateKey(keyId = null) {
        keyId = keyId || `key_${Date.now()}`;
        
        const key = crypto.randomBytes(this.config.keyLength);
        const encryptedKey = this.encryptKey(key);
        
        this.keys.set(keyId, key);
        this.keyMetadata.set(keyId, {
            id: keyId,
            createdAt: Date.now(),
            algorithm: this.config.algorithm,
            encryptedKey: encryptedKey.toString('base64'),
            active: true
        });
        
        this.emit('key-generated', { keyId });
        
        return keyId;
    }
    
    /**
     * キーを暗号化（マスターキーで保護）
     */
    encryptKey(key) {
        const iv = crypto.randomBytes(this.config.ivLength);
        const cipher = crypto.createCipheriv(
            this.config.algorithm,
            this.masterKey,
            iv
        );
        
        const encrypted = Buffer.concat([
            cipher.update(key),
            cipher.final()
        ]);
        
        const tag = cipher.getAuthTag();
        
        return Buffer.concat([iv, tag, encrypted]);
    }
    
    /**
     * キーを復号化
     */
    decryptKey(encryptedKey) {
        const buffer = Buffer.from(encryptedKey, 'base64');
        
        const iv = buffer.slice(0, this.config.ivLength);
        const tag = buffer.slice(this.config.ivLength, this.config.ivLength + this.config.tagLength);
        const encrypted = buffer.slice(this.config.ivLength + this.config.tagLength);
        
        const decipher = crypto.createDecipheriv(
            this.config.algorithm,
            this.masterKey,
            iv
        );
        
        decipher.setAuthTag(tag);
        
        return Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
    }
    
    /**
     * データを暗号化
     */
    encrypt(data, keyId = 'default') {
        if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
            data = JSON.stringify(data);
        }
        
        const key = this.keys.get(keyId);
        if (!key) {
            throw new Error(`Key not found: ${keyId}`);
        }
        
        // IV（初期化ベクトル）を生成
        const iv = crypto.randomBytes(this.config.ivLength);
        
        // 暗号化
        const cipher = crypto.createCipheriv(
            this.config.algorithm,
            key,
            iv
        );
        
        const encrypted = Buffer.concat([
            cipher.update(data, 'utf8'),
            cipher.final()
        ]);
        
        // 認証タグを取得
        const tag = cipher.getAuthTag();
        
        // 結果を結合
        const result = {
            keyId,
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            data: encrypted.toString('base64'),
            timestamp: Date.now()
        };
        
        return Buffer.from(JSON.stringify(result)).toString('base64');
    }
    
    /**
     * データを復号化
     */
    decrypt(encryptedData) {
        try {
            // Base64デコード
            const decoded = Buffer.from(encryptedData, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            
            // キーを取得
            const key = this.keys.get(parsed.keyId);
            if (!key) {
                // キーがメモリにない場合、暗号化されたキーから復元を試みる
                const metadata = this.keyMetadata.get(parsed.keyId);
                if (metadata && metadata.encryptedKey) {
                    const decryptedKey = this.decryptKey(metadata.encryptedKey);
                    this.keys.set(parsed.keyId, decryptedKey);
                    return this.decrypt(encryptedData);
                }
                throw new Error(`Key not found: ${parsed.keyId}`);
            }
            
            // 復号化の準備
            const iv = Buffer.from(parsed.iv, 'base64');
            const tag = Buffer.from(parsed.tag, 'base64');
            const encrypted = Buffer.from(parsed.data, 'base64');
            
            // 復号化
            const decipher = crypto.createDecipheriv(
                this.config.algorithm,
                key,
                iv
            );
            
            decipher.setAuthTag(tag);
            
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
            
            // 文字列として返す
            return decrypted.toString('utf8');
            
        } catch (error) {
            this.emit('decryption-error', error);
            throw new Error('Failed to decrypt data');
        }
    }
    
    /**
     * パスワードをハッシュ化
     */
    async hashPassword(password) {
        const salt = crypto.randomBytes(this.config.saltLength);
        
        return new Promise((resolve, reject) => {
            crypto.pbkdf2(
                password,
                salt,
                this.config.pbkdf2Iterations,
                this.config.keyLength,
                'sha256',
                (err, derivedKey) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    const hash = {
                        salt: salt.toString('base64'),
                        hash: derivedKey.toString('base64'),
                        iterations: this.config.pbkdf2Iterations,
                        algorithm: 'pbkdf2-sha256'
                    };
                    
                    resolve(Buffer.from(JSON.stringify(hash)).toString('base64'));
                }
            );
        });
    }
    
    /**
     * パスワードを検証
     */
    async verifyPassword(password, hashedPassword) {
        try {
            const decoded = Buffer.from(hashedPassword, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            
            const salt = Buffer.from(parsed.salt, 'base64');
            const expectedHash = Buffer.from(parsed.hash, 'base64');
            
            return new Promise((resolve, reject) => {
                crypto.pbkdf2(
                    password,
                    salt,
                    parsed.iterations,
                    expectedHash.length,
                    'sha256',
                    (err, derivedKey) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        resolve(crypto.timingSafeEqual(derivedKey, expectedHash));
                    }
                );
            });
            
        } catch (error) {
            return false;
        }
    }
    
    /**
     * フィールドレベル暗号化
     */
    encryptObject(obj, fieldsToEncrypt = []) {
        const result = { ...obj };
        
        for (const field of fieldsToEncrypt) {
            if (field in result && result[field] !== null && result[field] !== undefined) {
                result[field] = this.encrypt(result[field]);
                result[`${field}_encrypted`] = true;
            }
        }
        
        return result;
    }
    
    /**
     * フィールドレベル復号化
     */
    decryptObject(obj, fieldsToDecrypt = []) {
        const result = { ...obj };
        
        // 自動検出モード
        if (fieldsToDecrypt.length === 0) {
            for (const key in obj) {
                if (key.endsWith('_encrypted') && obj[key] === true) {
                    const fieldName = key.replace('_encrypted', '');
                    if (fieldName in obj) {
                        fieldsToDecrypt.push(fieldName);
                    }
                }
            }
        }
        
        for (const field of fieldsToDecrypt) {
            if (field in result && result[field] !== null && result[field] !== undefined) {
                try {
                    result[field] = this.decrypt(result[field]);
                    delete result[`${field}_encrypted`];
                } catch (error) {
                    this.emit('field-decryption-error', { field, error });
                }
            }
        }
        
        return result;
    }
    
    /**
     * トークンを生成
     */
    generateToken(data = {}, expiresIn = 3600000) {
        const payload = {
            data,
            exp: Date.now() + expiresIn,
            iat: Date.now(),
            jti: crypto.randomBytes(16).toString('hex')
        };
        
        return this.encrypt(payload);
    }
    
    /**
     * トークンを検証
     */
    verifyToken(token) {
        try {
            const decrypted = this.decrypt(token);
            const payload = JSON.parse(decrypted);
            
            if (payload.exp && payload.exp < Date.now()) {
                throw new Error('Token expired');
            }
            
            return payload.data;
            
        } catch (error) {
            throw new Error('Invalid token');
        }
    }
    
    /**
     * キーローテーションを開始
     */
    startKeyRotation() {
        this.rotationInterval = setInterval(() => {
            this.rotateKeys();
        }, this.config.keyRotationInterval);
    }
    
    /**
     * キーをローテーション
     */
    rotateKeys() {
        const newKeyId = this.generateKey();
        
        // 古いキーを非アクティブ化
        for (const [keyId, metadata] of this.keyMetadata) {
            if (keyId !== newKeyId && metadata.active) {
                metadata.active = false;
                metadata.deactivatedAt = Date.now();
            }
        }
        
        this.emit('key-rotated', { newKeyId });
        
        // 古いキーをクリーンアップ（一定期間後）
        setTimeout(() => {
            this.cleanupOldKeys();
        }, 86400000); // 24時間後
    }
    
    /**
     * 古いキーをクリーンアップ
     */
    cleanupOldKeys() {
        const now = Date.now();
        const retentionPeriod = 604800000; // 7日間
        
        for (const [keyId, metadata] of this.keyMetadata) {
            if (!metadata.active && metadata.deactivatedAt && 
                now - metadata.deactivatedAt > retentionPeriod) {
                this.keys.delete(keyId);
                this.keyMetadata.delete(keyId);
                this.emit('key-cleaned', { keyId });
            }
        }
    }
    
    /**
     * キー情報を取得
     */
    getKeyInfo() {
        const info = [];
        
        for (const [keyId, metadata] of this.keyMetadata) {
            info.push({
                id: keyId,
                createdAt: new Date(metadata.createdAt).toISOString(),
                active: metadata.active,
                deactivatedAt: metadata.deactivatedAt ? 
                    new Date(metadata.deactivatedAt).toISOString() : null
            });
        }
        
        return info;
    }
    
    /**
     * Express用ミドルウェア
     */
    middleware(fieldsToEncrypt = []) {
        return (req, res, next) => {
            // リクエストボディの暗号化フィールドを復号化
            if (req.body && typeof req.body === 'object') {
                req.body = this.decryptObject(req.body);
            }
            
            // レスポンスの暗号化機能を追加
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                if (fieldsToEncrypt.length > 0 && typeof data === 'object') {
                    data = this.encryptObject(data, fieldsToEncrypt);
                }
                return originalJson(data);
            };
            
            next();
        };
    }
    
    /**
     * クリーンアップ
     */
    destroy() {
        if (this.rotationInterval) {
            clearInterval(this.rotationInterval);
            this.rotationInterval = null;
        }
        
        // キーを安全に削除
        for (const [keyId, key] of this.keys) {
            if (Buffer.isBuffer(key)) {
                key.fill(0);
            }
        }
        
        this.keys.clear();
        this.keyMetadata.clear();
        
        if (this.masterKey && Buffer.isBuffer(this.masterKey)) {
            this.masterKey.fill(0);
        }
        
        this.removeAllListeners();
    }
}

module.exports = EncryptionManager;