import { logger } from '../logging/logger';
import { EventBus } from '../event/bus';
import { PoolEvent } from '../event/types';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

export interface TwoFactorAuth {
  id: string;
  userId: string;
  secret: string;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class TwoFactorAuthService {
  private twoFactorAuths: Map<string, TwoFactorAuth>;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.twoFactorAuths = new Map();
    this.eventBus = eventBus;

    // Setup event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.eventBus.on('2faEnabled', (data: { userId: string; secret: string }) => {
      const auth = this.twoFactorAuths.get(data.userId);
      if (auth) {
        auth.enabled = true;
        auth.secret = data.secret;
        auth.updatedAt = new Date().toISOString();
        this.twoFactorAuths.set(data.userId, auth);
        logger.info(`2FA enabled for user: ${data.userId}`);
      }
    });

    this.eventBus.on('2faDisabled', (userId: string) => {
      const auth = this.twoFactorAuths.get(userId);
      if (auth) {
        auth.enabled = false;
        auth.updatedAt = new Date().toISOString();
        this.twoFactorAuths.set(userId, auth);
        logger.info(`2FA disabled for user: ${userId}`);
      }
    });

    this.eventBus.on('2faUsed', (userId: string) => {
      const auth = this.twoFactorAuths.get(userId);
      if (auth) {
        auth.lastUsedAt = new Date().toISOString();
        this.twoFactorAuths.set(userId, auth);
      }
    });
  }

  public async generateSecret(userId: string): Promise<string> {
    const secret = speakeasy.generateSecret({
      name: `Otedama Pool:${userId}`,
      length: 20,
    });

    const auth: TwoFactorAuth = {
      id: uuidv4(),
      userId,
      secret: secret.base32,
      enabled: false,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.twoFactorAuths.set(userId, auth);
    logger.info(`Generated 2FA secret for user: ${userId}`);

    return secret.base32;
  }

  public async generateQRCode(userId: string): Promise<string> {
    const auth = this.twoFactorAuths.get(userId);
    if (!auth) {
      logger.warn(`2FA not configured for user: ${userId}`);
      throw new Error('2FA not configured');
    }

    const otpauthUrl = speakeasy.otpauthURL({
      secret: auth.secret,
      label: `Otedama Pool:${userId}`,
      issuer: 'Otedama Pool',
    });

    return qrcode.toString(otpauthUrl, { type: 'svg' });
  }

  public async verifyToken(userId: string, token: string): Promise<boolean> {
    const auth = this.twoFactorAuths.get(userId);
    if (!auth) {
      logger.warn(`2FA not configured for user: ${userId}`);
      return false;
    }

    const verified = speakeasy.totp.verify({
      secret: auth.secret,
      encoding: 'base32',
      token,
    });

    if (verified) {
      this.eventBus.emit('2faUsed', userId);
      logger.info(`2FA verified for user: ${userId}`);
    } else {
      logger.warn(`2FA verification failed for user: ${userId}`);
    }

    return verified;
  }

  public async enable2FA(userId: string): Promise<boolean> {
    const auth = this.twoFactorAuths.get(userId);
    if (!auth) {
      logger.warn(`2FA not configured for user: ${userId}`);
      return false;
    }

    auth.enabled = true;
    auth.updatedAt = new Date().toISOString();
    this.twoFactorAuths.set(userId, auth);
    this.eventBus.emit('2faEnabled', { userId, secret: auth.secret });
    logger.info(`2FA enabled for user: ${userId}`);

    return true;
  }

  public async disable2FA(userId: string): Promise<boolean> {
    const auth = this.twoFactorAuths.get(userId);
    if (!auth) {
      logger.warn(`2FA not configured for user: ${userId}`);
      return false;
    }

    auth.enabled = false;
    auth.updatedAt = new Date().toISOString();
    this.twoFactorAuths.set(userId, auth);
    this.eventBus.emit('2faDisabled', userId);
    logger.info(`2FA disabled for user: ${userId}`);

    return true;
  }

  public is2FAEnabled(userId: string): boolean {
    const auth = this.twoFactorAuths.get(userId);
    return auth ? auth.enabled : false;
  }

  public get2FAStatus(userId: string): TwoFactorAuth | null {
    return this.twoFactorAuths.get(userId) || null;
  }

  public async rotateSecret(userId: string): Promise<string> {
    const auth = this.twoFactorAuths.get(userId);
    if (!auth) {
      logger.warn(`2FA not configured for user: ${userId}`);
      throw new Error('2FA not configured');
    }

    const newSecret = speakeasy.generateSecret({
      name: `Otedama Pool:${userId}`,
      length: 20,
    });

    auth.secret = newSecret.base32;
    auth.updatedAt = new Date().toISOString();
    this.twoFactorAuths.set(userId, auth);
    logger.info(`2FA secret rotated for user: ${userId}`);

    return newSecret.base32;
  }
}
