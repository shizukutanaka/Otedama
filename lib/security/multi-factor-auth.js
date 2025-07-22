/**
 * Multi-Factor Authentication System
 * 多要素認証・生体認証システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { randomBytes, createHash, createHmac } from 'crypto';
import speakeasy from 'speakeasy';

const logger = getLogger('MultiFactorAuth');

// 認証要素タイプ
export const AuthFactorType = {
  // 知識要素（Something you know）
  PASSWORD: 'password',
  PIN: 'pin',
  SECURITY_QUESTION: 'security_question',
  
  // 所有要素（Something you have）
  TOTP: 'totp',              // Time-based One-Time Password
  SMS: 'sms',
  EMAIL: 'email',
  HARDWARE_TOKEN: 'hardware_token',
  PUSH_NOTIFICATION: 'push_notification',
  
  // 生体要素（Something you are）
  FINGERPRINT: 'fingerprint',
  FACE_RECOGNITION: 'face_recognition',
  VOICE_RECOGNITION: 'voice_recognition',
  IRIS_SCAN: 'iris_scan',
  BEHAVIORAL_BIOMETRICS: 'behavioral_biometrics',
  
  // 場所要素（Somewhere you are）
  GEOLOCATION: 'geolocation',
  IP_ADDRESS: 'ip_address',
  DEVICE_TRUST: 'device_trust'
};

// 認証レベル
export const AuthenticationLevel = {
  NONE: 0,
  SINGLE_FACTOR: 1,
  TWO_FACTOR: 2,
  MULTI_FACTOR: 3,
  ADAPTIVE: 4
};

// 生体認証精度レベル
export const BiometricAccuracy = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  VERY_HIGH: 'very_high'
};

export class MultiFactorAuth extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.crypto = getCryptoUtils();
    
    this.options = {
      // 基本設定
      requiredFactors: options.requiredFactors || 2,
      adaptiveAuth: options.adaptiveAuth !== false,
      
      // TOTP設定
      totpWindow: options.totpWindow || 1,
      totpDigits: options.totpDigits || 6,
      totpPeriod: options.totpPeriod || 30,
      
      // 生体認証設定
      biometricAccuracy: options.biometricAccuracy || BiometricAccuracy.HIGH,
      enableLivenessDetection: options.enableLivenessDetection !== false,
      biometricTimeout: options.biometricTimeout || 30000, // 30秒
      
      // セキュリティ設定
      maxAttempts: options.maxAttempts || 5,
      lockoutDuration: options.lockoutDuration || 300000, // 5分
      sessionTimeout: options.sessionTimeout || 3600000, // 1時間
      
      // 適応認証設定
      riskThreshold: options.riskThreshold || 0.7,
      contextualFactors: options.contextualFactors || [
        'device', 'location', 'time', 'behavior'
      ],
      
      // バックアップ設定
      enableBackupCodes: options.enableBackupCodes !== false,
      backupCodeCount: options.backupCodeCount || 10,
      
      ...options
    };
    
    // ユーザー認証データ
    this.userAuthData = new Map();
    this.authSessions = new Map();
    
    // 認証試行追跡
    this.authAttempts = new Map();
    this.lockouts = new Map();
    
    // 生体認証テンプレート
    this.biometricTemplates = new Map();
    
    // デバイス信頼管理
    this.trustedDevices = new Map();
    
    // リスク評価エンジン
    this.riskProfiles = new Map();
    
    // メトリクス
    this.metrics = {
      totalAuthentications: 0,
      successfulAuthentications: 0,
      failedAuthentications: 0,
      biometricAuthentications: 0,
      adaptiveDecisions: 0,
      lockouts: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // リスク評価エンジンを初期化
    this.initializeRiskEngine();
    
    // セッションクリーンアップを開始
    this.startSessionCleanup();
    
    this.logger.info('Multi-factor authentication system initialized');
  }
  
  /**
   * ユーザーを登録
   */
  async registerUser(userId, authFactors) {
    const userData = {
      userId,
      factors: new Map(),
      backupCodes: [],
      registeredAt: Date.now(),
      lastAuthenticated: null
    };
    
    try {
      // 各認証要素を登録
      for (const factor of authFactors) {
        await this.registerAuthFactor(userData, factor);
      }
      
      // バックアップコードを生成
      if (this.options.enableBackupCodes) {
        userData.backupCodes = await this.generateBackupCodes();
      }
      
      this.userAuthData.set(userId, userData);
      
      this.emit('user:registered', {
        userId,
        factors: Array.from(userData.factors.keys())
      });
      
      return {
        success: true,
        backupCodes: userData.backupCodes
      };
      
    } catch (error) {
      this.logger.error('User registration failed', error);
      throw error;
    }
  }
  
  /**
   * 認証要素を登録
   */
  async registerAuthFactor(userData, factor) {
    switch (factor.type) {
      case AuthFactorType.TOTP:
        return await this.registerTOTP(userData);
        
      case AuthFactorType.FINGERPRINT:
      case AuthFactorType.FACE_RECOGNITION:
      case AuthFactorType.VOICE_RECOGNITION:
        return await this.registerBiometric(userData, factor);
        
      case AuthFactorType.HARDWARE_TOKEN:
        return await this.registerHardwareToken(userData, factor);
        
      default:
        userData.factors.set(factor.type, factor.data);
    }
  }
  
  /**
   * TOTPを登録
   */
  async registerTOTP(userData) {
    const secret = speakeasy.generateSecret({
      length: 32,
      name: `Otedama:${userData.userId}`,
      issuer: 'Otedama'
    });
    
    userData.factors.set(AuthFactorType.TOTP, {
      secret: secret.base32,
      encoding: 'base32',
      qrcode: secret.otpauth_url
    });
    
    return {
      secret: secret.base32,
      qrcode: secret.otpauth_url
    };
  }
  
  /**
   * 生体認証を登録
   */
  async registerBiometric(userData, factor) {
    const biometricId = this.generateBiometricId();
    
    // 生体データをテンプレートに変換
    const template = await this.createBiometricTemplate(factor.data, factor.type);
    
    // テンプレートを暗号化して保存
    const encryptedTemplate = await this.encryptBiometricTemplate(template);
    
    this.biometricTemplates.set(biometricId, {
      userId: userData.userId,
      type: factor.type,
      template: encryptedTemplate,
      accuracy: this.options.biometricAccuracy,
      createdAt: Date.now()
    });
    
    userData.factors.set(factor.type, {
      biometricId,
      enrolled: true
    });
    
    return { biometricId };
  }
  
  /**
   * ユーザーを認証
   */
  async authenticateUser(userId, providedFactors) {
    const userData = this.userAuthData.get(userId);
    if (!userData) {
      throw new Error('User not found');
    }
    
    // ロックアウトをチェック
    if (this.isLockedOut(userId)) {
      throw new Error('Account locked due to too many failed attempts');
    }
    
    const sessionId = this.generateSessionId();
    const authSession = {
      sessionId,
      userId,
      startTime: Date.now(),
      completedFactors: [],
      requiredFactors: await this.determineRequiredFactors(userId, providedFactors),
      riskScore: 0,
      status: 'pending'
    };
    
    this.authSessions.set(sessionId, authSession);
    
    try {
      // リスク評価
      authSession.riskScore = await this.assessRisk(userId, providedFactors);
      
      // 適応認証
      if (this.options.adaptiveAuth) {
        await this.applyAdaptiveAuth(authSession);
      }
      
      // 各要素を検証
      const results = await this.verifyFactors(userData, providedFactors, authSession);
      
      // 認証結果を評価
      const authResult = this.evaluateAuthResult(authSession, results);
      
      if (authResult.success) {
        await this.completeAuthentication(userData, authSession);
        this.metrics.successfulAuthentications++;
      } else {
        await this.handleFailedAuthentication(userId, authSession);
        this.metrics.failedAuthentications++;
      }
      
      return authResult;
      
    } catch (error) {
      this.logger.error('Authentication failed', error);
      await this.handleFailedAuthentication(userId, authSession);
      throw error;
    }
  }
  
  /**
   * 必要な認証要素を決定
   */
  async determineRequiredFactors(userId, providedFactors) {
    const userData = this.userAuthData.get(userId);
    const availableFactors = Array.from(userData.factors.keys());
    
    // 基本要件
    let requiredCount = this.options.requiredFactors;
    
    // リスクベースで調整
    const context = await this.gatherContext(userId);
    if (context.riskLevel === 'high') {
      requiredCount = Math.min(availableFactors.length, requiredCount + 1);
    }
    
    // 必須要素を選択
    const required = [];
    
    // 生体認証を優先
    const biometricFactors = availableFactors.filter(f => 
      [AuthFactorType.FINGERPRINT, AuthFactorType.FACE_RECOGNITION].includes(f)
    );
    
    if (biometricFactors.length > 0) {
      required.push(biometricFactors[0]);
    }
    
    // TOTPを追加
    if (availableFactors.includes(AuthFactorType.TOTP)) {
      required.push(AuthFactorType.TOTP);
    }
    
    // 不足分を補完
    for (const factor of availableFactors) {
      if (!required.includes(factor) && required.length < requiredCount) {
        required.push(factor);
      }
    }
    
    return required;
  }
  
  /**
   * リスクを評価
   */
  async assessRisk(userId, providedFactors) {
    const riskFactors = {
      device: await this.assessDeviceRisk(userId, providedFactors.device),
      location: await this.assessLocationRisk(userId, providedFactors.location),
      time: await this.assessTimeRisk(userId),
      behavior: await this.assessBehaviorRisk(userId, providedFactors)
    };
    
    // 重み付けスコア計算
    const weights = {
      device: 0.3,
      location: 0.3,
      time: 0.2,
      behavior: 0.2
    };
    
    let totalRisk = 0;
    for (const [factor, risk] of Object.entries(riskFactors)) {
      totalRisk += risk * weights[factor];
    }
    
    return totalRisk;
  }
  
  /**
   * 適応認証を適用
   */
  async applyAdaptiveAuth(authSession) {
    const { riskScore } = authSession;
    
    if (riskScore > this.options.riskThreshold) {
      // 高リスクの場合、追加の認証要素を要求
      authSession.requiredFactors.push(AuthFactorType.BIOMETRIC);
      
      // セッションタイムアウトを短縮
      authSession.timeout = this.options.sessionTimeout / 2;
      
      this.metrics.adaptiveDecisions++;
    }
    
    // コンテキストに基づいた調整
    const context = await this.gatherContext(authSession.userId);
    
    if (context.trustedDevice && riskScore < 0.3) {
      // 信頼できるデバイスからの低リスクアクセス
      authSession.requiredFactors = authSession.requiredFactors.slice(0, 1);
    }
  }
  
  /**
   * 認証要素を検証
   */
  async verifyFactors(userData, providedFactors, authSession) {
    const results = [];
    
    for (const [factorType, factorData] of Object.entries(providedFactors)) {
      if (!authSession.requiredFactors.includes(factorType)) {
        continue;
      }
      
      try {
        const result = await this.verifyFactor(userData, factorType, factorData);
        
        results.push({
          factor: factorType,
          success: result.success,
          confidence: result.confidence || 1.0
        });
        
        if (result.success) {
          authSession.completedFactors.push(factorType);
        }
        
      } catch (error) {
        results.push({
          factor: factorType,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * 個別の認証要素を検証
   */
  async verifyFactor(userData, factorType, factorData) {
    const storedFactor = userData.factors.get(factorType);
    if (!storedFactor) {
      throw new Error(`Factor ${factorType} not registered`);
    }
    
    switch (factorType) {
      case AuthFactorType.PASSWORD:
        return await this.verifyPassword(factorData, storedFactor);
        
      case AuthFactorType.TOTP:
        return await this.verifyTOTP(factorData, storedFactor);
        
      case AuthFactorType.FINGERPRINT:
      case AuthFactorType.FACE_RECOGNITION:
      case AuthFactorType.VOICE_RECOGNITION:
        return await this.verifyBiometric(factorType, factorData, storedFactor);
        
      case AuthFactorType.HARDWARE_TOKEN:
        return await this.verifyHardwareToken(factorData, storedFactor);
        
      default:
        throw new Error(`Unsupported factor type: ${factorType}`);
    }
  }
  
  /**
   * TOTPを検証
   */
  async verifyTOTP(token, storedFactor) {
    const verified = speakeasy.totp.verify({
      secret: storedFactor.secret,
      encoding: storedFactor.encoding,
      token: token,
      window: this.options.totpWindow
    });
    
    return { success: verified };
  }
  
  /**
   * 生体認証を検証
   */
  async verifyBiometric(type, biometricData, storedFactor) {
    const biometricRecord = this.biometricTemplates.get(storedFactor.biometricId);
    if (!biometricRecord) {
      throw new Error('Biometric template not found');
    }
    
    // ライブネス検出
    if (this.options.enableLivenessDetection) {
      const isLive = await this.performLivenessDetection(biometricData, type);
      if (!isLive) {
        throw new Error('Liveness detection failed');
      }
    }
    
    // テンプレートを復号
    const template = await this.decryptBiometricTemplate(biometricRecord.template);
    
    // 生体データを比較
    const matchResult = await this.compareBiometric(
      biometricData,
      template,
      type,
      this.options.biometricAccuracy
    );
    
    this.metrics.biometricAuthentications++;
    
    return {
      success: matchResult.match,
      confidence: matchResult.confidence
    };
  }
  
  /**
   * 生体認証テンプレートを作成
   */
  async createBiometricTemplate(biometricData, type) {
    // 特徴抽出（実装は生体認証タイプに依存）
    switch (type) {
      case AuthFactorType.FINGERPRINT:
        return this.extractFingerprintFeatures(biometricData);
        
      case AuthFactorType.FACE_RECOGNITION:
        return this.extractFaceFeatures(biometricData);
        
      case AuthFactorType.VOICE_RECOGNITION:
        return this.extractVoiceFeatures(biometricData);
        
      default:
        throw new Error(`Unsupported biometric type: ${type}`);
    }
  }
  
  /**
   * 指紋特徴を抽出
   */
  extractFingerprintFeatures(fingerprintData) {
    // 実際の実装では適切な指紋認識アルゴリズムを使用
    // ここでは簡略化
    return {
      minutiae: this.detectMinutiae(fingerprintData),
      ridgePattern: this.analyzeRidgePattern(fingerprintData),
      corePoints: this.detectCorePoints(fingerprintData)
    };
  }
  
  /**
   * 顔特徴を抽出
   */
  extractFaceFeatures(faceData) {
    // 実際の実装では適切な顔認識アルゴリズムを使用
    // ここでは簡略化
    return {
      landmarks: this.detectFaceLandmarks(faceData),
      embeddings: this.generateFaceEmbeddings(faceData),
      geometry: this.analyzeFaceGeometry(faceData)
    };
  }
  
  /**
   * ライブネス検出を実行
   */
  async performLivenessDetection(biometricData, type) {
    switch (type) {
      case AuthFactorType.FACE_RECOGNITION:
        // まばたき検出、頭の動き、テクスチャ分析など
        return this.detectFaceLiveness(biometricData);
        
      case AuthFactorType.FINGERPRINT:
        // 血流検出、圧力変化、温度など
        return this.detectFingerprintLiveness(biometricData);
        
      default:
        return true;
    }
  }
  
  /**
   * 生体データを比較
   */
  async compareBiometric(inputData, storedTemplate, type, accuracy) {
    // 特徴抽出
    const inputTemplate = await this.createBiometricTemplate(inputData, type);
    
    // 類似度計算
    let similarity = 0;
    
    switch (type) {
      case AuthFactorType.FINGERPRINT:
        similarity = this.compareFingerprintTemplates(inputTemplate, storedTemplate);
        break;
        
      case AuthFactorType.FACE_RECOGNITION:
        similarity = this.compareFaceTemplates(inputTemplate, storedTemplate);
        break;
        
      case AuthFactorType.VOICE_RECOGNITION:
        similarity = this.compareVoiceTemplates(inputTemplate, storedTemplate);
        break;
    }
    
    // しきい値判定
    const threshold = this.getAccuracyThreshold(accuracy);
    
    return {
      match: similarity >= threshold,
      confidence: similarity
    };
  }
  
  /**
   * 認証結果を評価
   */
  evaluateAuthResult(authSession, results) {
    const successfulFactors = results.filter(r => r.success);
    const requiredFactorsCompleted = authSession.requiredFactors.every(
      factor => authSession.completedFactors.includes(factor)
    );
    
    const success = requiredFactorsCompleted && 
                   successfulFactors.length >= this.options.requiredFactors;
    
    return {
      success,
      sessionId: authSession.sessionId,
      completedFactors: authSession.completedFactors,
      authenticationLevel: this.calculateAuthLevel(authSession.completedFactors),
      riskScore: authSession.riskScore,
      expiresIn: authSession.timeout || this.options.sessionTimeout
    };
  }
  
  /**
   * 認証レベルを計算
   */
  calculateAuthLevel(completedFactors) {
    if (completedFactors.length === 0) {
      return AuthenticationLevel.NONE;
    } else if (completedFactors.length === 1) {
      return AuthenticationLevel.SINGLE_FACTOR;
    } else if (completedFactors.length === 2) {
      return AuthenticationLevel.TWO_FACTOR;
    } else {
      return AuthenticationLevel.MULTI_FACTOR;
    }
  }
  
  /**
   * 認証を完了
   */
  async completeAuthentication(userData, authSession) {
    userData.lastAuthenticated = Date.now();
    authSession.status = 'completed';
    
    // 認証試行をリセット
    this.authAttempts.delete(userData.userId);
    
    // デバイス信頼を更新
    if (authSession.completedFactors.includes(AuthFactorType.DEVICE_TRUST)) {
      await this.updateDeviceTrust(userData.userId, authSession);
    }
    
    this.emit('authentication:completed', {
      userId: userData.userId,
      sessionId: authSession.sessionId,
      factors: authSession.completedFactors
    });
  }
  
  /**
   * 失敗した認証を処理
   */
  async handleFailedAuthentication(userId, authSession) {
    authSession.status = 'failed';
    
    // 失敗回数を増加
    const attempts = (this.authAttempts.get(userId) || 0) + 1;
    this.authAttempts.set(userId, attempts);
    
    // ロックアウトチェック
    if (attempts >= this.options.maxAttempts) {
      this.lockouts.set(userId, {
        lockedAt: Date.now(),
        duration: this.options.lockoutDuration
      });
      this.metrics.lockouts++;
      
      this.emit('account:locked', { userId });
    }
    
    this.emit('authentication:failed', {
      userId,
      sessionId: authSession.sessionId,
      attempts
    });
  }
  
  /**
   * バックアップコードを生成
   */
  async generateBackupCodes() {
    const codes = [];
    
    for (let i = 0; i < this.options.backupCodeCount; i++) {
      const code = randomBytes(6).toString('hex');
      const hashedCode = createHash('sha256').update(code).digest('hex');
      
      codes.push({
        code,
        hash: hashedCode,
        used: false
      });
    }
    
    return codes;
  }
  
  /**
   * バックアップコードを検証
   */
  async verifyBackupCode(userId, code) {
    const userData = this.userAuthData.get(userId);
    if (!userData) return false;
    
    const codeHash = createHash('sha256').update(code).digest('hex');
    
    for (const backupCode of userData.backupCodes) {
      if (backupCode.hash === codeHash && !backupCode.used) {
        backupCode.used = true;
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * デバイスリスクを評価
   */
  async assessDeviceRisk(userId, deviceInfo) {
    if (!deviceInfo) return 0.5;
    
    // 信頼できるデバイスかチェック
    const trustedDevice = this.trustedDevices.get(
      `${userId}_${deviceInfo.deviceId}`
    );
    
    if (trustedDevice) {
      return 0.1; // 低リスク
    }
    
    // デバイスフィンガープリントを分析
    const fingerprint = this.calculateDeviceFingerprint(deviceInfo);
    const knownDevices = this.getKnownDevices(userId);
    
    for (const known of knownDevices) {
      if (this.compareFingerprints(fingerprint, known.fingerprint) > 0.8) {
        return 0.3; // 中低リスク
      }
    }
    
    return 0.8; // 高リスク
  }
  
  /**
   * 場所リスクを評価
   */
  async assessLocationRisk(userId, location) {
    if (!location) return 0.5;
    
    const userProfile = this.riskProfiles.get(userId) || {};
    const knownLocations = userProfile.knownLocations || [];
    
    // 既知の場所からの距離を計算
    for (const known of knownLocations) {
      const distance = this.calculateDistance(location, known);
      if (distance < 50) { // 50km以内
        return 0.2;
      }
    }
    
    // 異常な場所かチェック
    if (location.country !== userProfile.homeCountry) {
      return 0.9;
    }
    
    return 0.5;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      metrics: this.metrics,
      users: {
        total: this.userAuthData.size,
        lockedOut: this.lockouts.size
      },
      sessions: {
        active: Array.from(this.authSessions.values()).filter(
          s => s.status === 'completed' && 
               Date.now() - s.startTime < this.options.sessionTimeout
        ).length
      },
      factors: {
        biometric: this.biometricTemplates.size,
        trustedDevices: this.trustedDevices.size
      }
    };
  }
  
  // ヘルパーメソッド
  generateSessionId() {
    return `mfa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateBiometricId() {
    return `bio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  isLockedOut(userId) {
    const lockout = this.lockouts.get(userId);
    if (!lockout) return false;
    
    const elapsed = Date.now() - lockout.lockedAt;
    if (elapsed > lockout.duration) {
      this.lockouts.delete(userId);
      return false;
    }
    
    return true;
  }
  
  async gatherContext(userId) {
    // ユーザーコンテキストを収集（簡略化）
    return {
      riskLevel: 'medium',
      trustedDevice: false,
      knownLocation: true
    };
  }
  
  getAccuracyThreshold(accuracy) {
    const thresholds = {
      [BiometricAccuracy.LOW]: 0.7,
      [BiometricAccuracy.MEDIUM]: 0.8,
      [BiometricAccuracy.HIGH]: 0.9,
      [BiometricAccuracy.VERY_HIGH]: 0.95
    };
    
    return thresholds[accuracy] || 0.9;
  }
  
  async encryptBiometricTemplate(template) {
    // 生体認証テンプレートを暗号化（実装は省略）
    return this.crypto.encrypt(JSON.stringify(template));
  }
  
  async decryptBiometricTemplate(encryptedTemplate) {
    // 生体認証テンプレートを復号（実装は省略）
    const decrypted = await this.crypto.decrypt(encryptedTemplate);
    return JSON.parse(decrypted);
  }
  
  // 生体認証関連のヘルパーメソッド（実装は省略）
  detectMinutiae(fingerprintData) { return []; }
  analyzeRidgePattern(fingerprintData) { return {}; }
  detectCorePoints(fingerprintData) { return []; }
  detectFaceLandmarks(faceData) { return []; }
  generateFaceEmbeddings(faceData) { return []; }
  analyzeFaceGeometry(faceData) { return {}; }
  detectFaceLiveness(faceData) { return true; }
  detectFingerprintLiveness(fingerprintData) { return true; }
  compareFingerprintTemplates(t1, t2) { return 0.95; }
  compareFaceTemplates(t1, t2) { return 0.92; }
  compareVoiceTemplates(t1, t2) { return 0.88; }
  calculateDeviceFingerprint(deviceInfo) { return randomBytes(32).toString('hex'); }
  getKnownDevices(userId) { return []; }
  compareFingerprints(f1, f2) { return 0.9; }
  calculateDistance(loc1, loc2) { return 10; }
  
  /**
   * リスクエンジンを初期化
   */
  initializeRiskEngine() {
    // リスク評価エンジンの初期化（実装は省略）
  }
  
  /**
   * セッションクリーンアップを開始
   */
  startSessionCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [sessionId, session] of this.authSessions) {
        if (now - session.startTime > this.options.sessionTimeout) {
          this.authSessions.delete(sessionId);
        }
      }
    }, 60000); // 1分ごと
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.authSessions.clear();
    this.authAttempts.clear();
    this.lockouts.clear();
  }
}

export default MultiFactorAuth;