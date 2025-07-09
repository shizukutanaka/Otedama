/**
 * 統合通知システム
 * プッシュ通知、メール、WebSocketなど複数チャネル対応
 * 
 * 設計思想：
 * - Carmack: リアルタイムで効率的な通知配信
 * - Martin: 拡張可能な通知チャネル設計
 * - Pike: シンプルで信頼性の高い通知API
 */

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import { Redis } from 'ioredis';

// === 型定義 ===
export interface NotificationConfig {
  // WebPush設定
  vapidKeys: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  
  // メール設定
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: {
      user: string;
      pass: string;
    };
    from: string;
  };
  
  // Redis設定（キューイング用）
  redis?: {
    host: string;
    port: number;
    password?: string;
  };
  
  // 通知設定
  batchSize: number;              // バッチ送信サイズ
  retryAttempts: number;          // リトライ回数
  retryDelay: number;             // リトライ間隔（ms）
  ttl: number;                    // 通知の有効期限（秒）
  
  // レート制限
  rateLimits: {
    perUser: number;              // ユーザーあたりの制限（/時間）
    perChannel: number;           // チャネルあたりの制限（/時間）
    global: number;               // グローバル制限（/時間）
  };
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  
  // コンテンツ
  title: string;
  body: string;
  data?: any;
  icon?: string;
  image?: string;
  actions?: NotificationAction[];
  
  // メタデータ
  createdAt: number;
  scheduledAt?: number;
  expiresAt?: number;
  
  // 配信状態
  status: NotificationStatus;
  deliveryAttempts: DeliveryAttempt[];
  deliveredChannels: NotificationChannel[];
}

export type NotificationType = 
  | 'block_found'
  | 'payment_sent'
  | 'payment_received'
  | 'worker_offline'
  | 'worker_online'
  | 'hashrate_drop'
  | 'security_alert'
  | 'maintenance'
  | 'announcement'
  | 'custom';

export type NotificationPriority = 'urgent' | 'high' | 'normal' | 'low';

export type NotificationChannel = 'push' | 'email' | 'sms' | 'websocket' | 'webhook';

export type NotificationStatus = 
  | 'pending'
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'expired';

export interface NotificationAction {
  action: string;
  title: string;
  icon?: string;
}

export interface DeliveryAttempt {
  channel: NotificationChannel;
  timestamp: number;
  status: 'success' | 'failed';
  error?: string;
}

export interface UserPreferences {
  userId: string;
  channels: {
    push: boolean;
    email: boolean;
    sms: boolean;
    websocket: boolean;
    webhook: boolean;
  };
  
  // 通知タイプ別の設定
  types: {
    [key in NotificationType]?: {
      enabled: boolean;
      channels: NotificationChannel[];
      minPriority: NotificationPriority;
    };
  };
  
  // 時間設定
  quiet: {
    enabled: boolean;
    startTime: string;  // HH:MM
    endTime: string;    // HH:MM
    timezone: string;
  };
  
  // 配信設定
  batching: {
    enabled: boolean;
    interval: number;   // 秒
  };
}

export interface PushSubscription {
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  createdAt: number;
  lastUsed?: number;
}

// === 通知マネージャー ===
export class NotificationManager extends EventEmitter {
  private config: NotificationConfig;
  private redis?: Redis;
  private transporter?: nodemailer.Transporter;
  private wsClients: Map<string, WebSocket[]> = new Map();
  private pushSubscriptions: Map<string, PushSubscription[]> = new Map();
  private userPreferences: Map<string, UserPreferences> = new Map();
  private rateLimiter: RateLimiter;
  
  // メトリクス
  private metrics = {
    sent: { push: 0, email: 0, sms: 0, websocket: 0, webhook: 0 },
    delivered: { push: 0, email: 0, sms: 0, websocket: 0, webhook: 0 },
    failed: { push: 0, email: 0, sms: 0, websocket: 0, webhook: 0 },
    queued: 0,
    expired: 0
  };
  
  constructor(config: NotificationConfig) {
    super();
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimits);
    
    // WebPush設定
    webpush.setVapidDetails(
      config.vapidKeys.subject,
      config.vapidKeys.publicKey,
      config.vapidKeys.privateKey
    );
    
    // メールトランスポーター設定
    this.setupEmailTransporter();
    
    // Redis設定
    if (config.redis) {
      this.setupRedis();
    }
  }
  
  // メールトランスポーターのセットアップ
  private setupEmailTransporter(): void {
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: this.config.smtp.auth
    });
  }
  
  // Redisのセットアップ
  private setupRedis(): void {
    if (!this.config.redis) return;
    
    this.redis = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password
    });
    
    // キューワーカーの開始
    this.startQueueWorker();
  }
  
  // 通知の送信
  async send(notification: Notification): Promise<void> {
    try {
      // ユーザー設定の取得
      const preferences = await this.getUserPreferences(notification.userId);
      
      // 有効なチャネルのフィルタリング
      const enabledChannels = this.filterEnabledChannels(
        notification,
        preferences
      );
      
      if (enabledChannels.length === 0) {
        this.emit('notificationSkipped', { notification, reason: 'no_enabled_channels' });
        return;
      }
      
      // レート制限チェック
      const allowed = await this.rateLimiter.checkLimit(
        notification.userId,
        enabledChannels
      );
      
      if (!allowed) {
        // キューに追加
        await this.queueNotification(notification);
        return;
      }
      
      // 各チャネルへの送信
      const deliveryPromises = enabledChannels.map(channel =>
        this.sendToChannel(notification, channel)
      );
      
      const results = await Promise.allSettled(deliveryPromises);
      
      // 結果の処理
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const channel = enabledChannels[i];
        
        if (result.status === 'fulfilled') {
          notification.deliveredChannels.push(channel);
          notification.deliveryAttempts.push({
            channel,
            timestamp: Date.now(),
            status: 'success'
          });
          this.metrics.delivered[channel]++;
        } else {
          notification.deliveryAttempts.push({
            channel,
            timestamp: Date.now(),
            status: 'failed',
            error: result.reason?.message
          });
          this.metrics.failed[channel]++;
          
          // リトライが必要な場合
          if (this.shouldRetry(notification, channel)) {
            await this.scheduleRetry(notification, channel);
          }
        }
      }
      
      // ステータスの更新
      notification.status = notification.deliveredChannels.length > 0 
        ? 'delivered' 
        : 'failed';
      
      this.emit('notificationSent', notification);
      
    } catch (error) {
      this.emit('error', { error, context: 'send', notification });
      throw error;
    }
  }
  
  // チャネル別送信
  private async sendToChannel(
    notification: Notification,
    channel: NotificationChannel
  ): Promise<void> {
    this.metrics.sent[channel]++;
    
    switch (channel) {
      case 'push':
        return this.sendPushNotification(notification);
        
      case 'email':
        return this.sendEmailNotification(notification);
        
      case 'sms':
        return this.sendSMSNotification(notification);
        
      case 'websocket':
        return this.sendWebSocketNotification(notification);
        
      case 'webhook':
        return this.sendWebhookNotification(notification);
        
      default:
        throw new Error(`Unknown channel: ${channel}`);
    }
  }
  
  // プッシュ通知の送信
  private async sendPushNotification(notification: Notification): Promise<void> {
    const subscriptions = this.pushSubscriptions.get(notification.userId) || [];
    
    if (subscriptions.length === 0) {
      throw new Error('No push subscriptions found');
    }
    
    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      icon: notification.icon,
      image: notification.image,
      data: notification.data,
      actions: notification.actions,
      timestamp: notification.createdAt,
      tag: notification.id
    });
    
    const options = {
      TTL: this.config.ttl,
      urgency: this.mapPriorityToUrgency(notification.priority)
    };
    
    // 全サブスクリプションに送信
    const sendPromises = subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys
          },
          payload,
          options
        );
      } catch (error: any) {
        // 無効なサブスクリプションの削除
        if (error.statusCode === 410) {
          await this.removePushSubscription(notification.userId, subscription.endpoint);
        }
        throw error;
      }
    });
    
    await Promise.all(sendPromises);
  }
  
  // メール通知の送信
  private async sendEmailNotification(notification: Notification): Promise<void> {
    if (!this.transporter) {
      throw new Error('Email transporter not configured');
    }
    
    const user = await this.getUser(notification.userId);
    if (!user?.email) {
      throw new Error('User email not found');
    }
    
    const htmlContent = this.generateEmailHTML(notification);
    const textContent = this.generateEmailText(notification);
    
    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to: user.email,
      subject: notification.title,
      text: textContent,
      html: htmlContent,
      priority: this.mapPriorityToEmailPriority(notification.priority)
    });
  }
  
  // SMS通知の送信（実装依存）
  private async sendSMSNotification(notification: Notification): Promise<void> {
    // SMS provider integration (Twilio, etc.)
    throw new Error('SMS notification not implemented');
  }
  
  // WebSocket通知の送信
  private async sendWebSocketNotification(notification: Notification): Promise<void> {
    const clients = this.wsClients.get(notification.userId) || [];
    
    if (clients.length === 0) {
      throw new Error('No WebSocket clients connected');
    }
    
    const message = JSON.stringify({
      type: 'notification',
      data: notification
    });
    
    // アクティブなクライアントに送信
    const activeClients: WebSocket[] = [];
    
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        activeClients.push(client);
      }
    }
    
    // 非アクティブなクライアントを削除
    if (activeClients.length < clients.length) {
      this.wsClients.set(notification.userId, activeClients);
    }
    
    if (activeClients.length === 0) {
      throw new Error('No active WebSocket clients');
    }
  }
  
  // Webhook通知の送信
  private async sendWebhookNotification(notification: Notification): Promise<void> {
    const user = await this.getUser(notification.userId);
    if (!user?.webhookUrl) {
      throw new Error('Webhook URL not configured');
    }
    
    const response = await fetch(user.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Notification-Type': notification.type,
        'X-Notification-Priority': notification.priority
      },
      body: JSON.stringify(notification)
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  }
  
  // プッシュサブスクリプションの登録
  async registerPushSubscription(
    userId: string,
    subscription: PushSubscription
  ): Promise<void> {
    const userSubs = this.pushSubscriptions.get(userId) || [];
    
    // 既存のサブスクリプションをチェック
    const existingIndex = userSubs.findIndex(
      s => s.endpoint === subscription.endpoint
    );
    
    if (existingIndex >= 0) {
      // 既存のものを更新
      userSubs[existingIndex] = subscription;
    } else {
      // 新規追加
      userSubs.push(subscription);
    }
    
    this.pushSubscriptions.set(userId, userSubs);
    
    // データベースに保存
    await this.savePushSubscription(subscription);
    
    this.emit('pushSubscriptionRegistered', { userId, subscription });
  }
  
  // WebSocketクライアントの登録
  registerWebSocketClient(userId: string, ws: WebSocket): void {
    const clients = this.wsClients.get(userId) || [];
    clients.push(ws);
    this.wsClients.set(userId, clients);
    
    ws.on('close', () => {
      const updatedClients = this.wsClients.get(userId)?.filter(c => c !== ws) || [];
      if (updatedClients.length > 0) {
        this.wsClients.set(userId, updatedClients);
      } else {
        this.wsClients.delete(userId);
      }
    });
  }
  
  // ユーザー設定の更新
  async updateUserPreferences(
    userId: string,
    preferences: Partial<UserPreferences>
  ): Promise<void> {
    const current = await this.getUserPreferences(userId);
    const updated = { ...current, ...preferences, userId };
    
    this.userPreferences.set(userId, updated);
    
    // データベースに保存
    await this.saveUserPreferences(updated);
    
    this.emit('preferencesUpdated', { userId, preferences: updated });
  }
  
  // 通知のキューイング
  private async queueNotification(notification: Notification): Promise<void> {
    if (!this.redis) {
      throw new Error('Redis not configured for queuing');
    }
    
    notification.status = 'queued';
    this.metrics.queued++;
    
    await this.redis.zadd(
      'notification_queue',
      notification.scheduledAt || Date.now(),
      JSON.stringify(notification)
    );
    
    this.emit('notificationQueued', notification);
  }
  
  // キューワーカー
  private startQueueWorker(): void {
    if (!this.redis) return;
    
    setInterval(async () => {
      try {
        const now = Date.now();
        
        // 送信時刻になった通知を取得
        const notifications = await this.redis.zrangebyscore(
          'notification_queue',
          0,
          now,
          'LIMIT',
          0,
          this.config.batchSize
        );
        
        for (const notificationStr of notifications) {
          const notification = JSON.parse(notificationStr) as Notification;
          
          // 有効期限チェック
          if (notification.expiresAt && notification.expiresAt < now) {
            notification.status = 'expired';
            this.metrics.expired++;
            await this.redis.zrem('notification_queue', notificationStr);
            continue;
          }
          
          // 送信処理
          try {
            await this.send(notification);
            await this.redis.zrem('notification_queue', notificationStr);
          } catch (error) {
            // エラー時は再度キューに戻す
            const nextRetry = now + this.config.retryDelay;
            await this.redis.zadd('notification_queue', nextRetry, notificationStr);
          }
        }
      } catch (error) {
        this.emit('error', { error, context: 'queueWorker' });
      }
    }, 1000); // 1秒ごとにチェック
  }
  
  // ヘルパーメソッド
  private filterEnabledChannels(
    notification: Notification,
    preferences: UserPreferences
  ): NotificationChannel[] {
    const typePrefs = preferences.types[notification.type];
    
    if (!typePrefs?.enabled) {
      return [];
    }
    
    // 優先度チェック
    const priorityOrder = ['urgent', 'high', 'normal', 'low'];
    const minPriorityIndex = priorityOrder.indexOf(typePrefs.minPriority || 'low');
    const notificationPriorityIndex = priorityOrder.indexOf(notification.priority);
    
    if (notificationPriorityIndex > minPriorityIndex) {
      return [];
    }
    
    // 静寂時間チェック
    if (preferences.quiet.enabled && this.isQuietTime(preferences.quiet)) {
      return notification.priority === 'urgent' ? ['push'] : [];
    }
    
    // 有効なチャネルをフィルタ
    return notification.channels.filter(channel => {
      return preferences.channels[channel] && 
             (typePrefs.channels.length === 0 || typePrefs.channels.includes(channel));
    });
  }
  
  private isQuietTime(quiet: UserPreferences['quiet']): boolean {
    const now = new Date();
    const timezone = quiet.timezone || 'UTC';
    
    // タイムゾーン変換（簡略化）
    const currentTime = now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    });
    
    return currentTime >= quiet.startTime && currentTime <= quiet.endTime;
  }
  
  private shouldRetry(notification: Notification, channel: NotificationChannel): boolean {
    const attempts = notification.deliveryAttempts.filter(
      a => a.channel === channel && a.status === 'failed'
    ).length;
    
    return attempts < this.config.retryAttempts;
  }
  
  private async scheduleRetry(
    notification: Notification,
    channel: NotificationChannel
  ): Promise<void> {
    const retryNotification = {
      ...notification,
      channels: [channel],
      scheduledAt: Date.now() + this.config.retryDelay
    };
    
    await this.queueNotification(retryNotification);
  }
  
  private mapPriorityToUrgency(priority: NotificationPriority): string {
    switch (priority) {
      case 'urgent': return 'very-high';
      case 'high': return 'high';
      case 'normal': return 'normal';
      case 'low': return 'low';
    }
  }
  
  private mapPriorityToEmailPriority(priority: NotificationPriority): string {
    switch (priority) {
      case 'urgent': return 'high';
      case 'high': return 'high';
      case 'normal': return 'normal';
      case 'low': return 'low';
    }
  }
  
  private generateEmailHTML(notification: Notification): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #00ff41; color: #000; padding: 20px; text-align: center; }
    .content { background: #f4f4f4; padding: 20px; margin: 20px 0; }
    .footer { text-align: center; color: #666; font-size: 12px; }
    .button { display: inline-block; padding: 10px 20px; background: #00ff41; color: #000; text-decoration: none; border-radius: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${notification.title}</h1>
    </div>
    <div class="content">
      <p>${notification.body}</p>
      ${notification.actions?.map(action => 
        `<a href="#" class="button">${action.title}</a>`
      ).join(' ') || ''}
    </div>
    <div class="footer">
      <p>Otedama Mining Pool</p>
      <p>You received this email because you have notifications enabled.</p>
    </div>
  </div>
</body>
</html>`;
  }
  
  private generateEmailText(notification: Notification): string {
    return `${notification.title}\n\n${notification.body}\n\n---\nOtedama Mining Pool`;
  }
  
  // データベース操作（実装依存）
  private async getUser(userId: string): Promise<any> {
    // ユーザー情報の取得
    return { email: 'user@example.com', webhookUrl: null };
  }
  
  private async getUserPreferences(userId: string): Promise<UserPreferences> {
    const cached = this.userPreferences.get(userId);
    if (cached) return cached;
    
    // デフォルト設定
    return {
      userId,
      channels: {
        push: true,
        email: true,
        sms: false,
        websocket: true,
        webhook: false
      },
      types: {},
      quiet: {
        enabled: false,
        startTime: '22:00',
        endTime: '08:00',
        timezone: 'UTC'
      },
      batching: {
        enabled: false,
        interval: 300
      }
    };
  }
  
  private async saveUserPreferences(preferences: UserPreferences): Promise<void> {
    // データベースに保存
  }
  
  private async savePushSubscription(subscription: PushSubscription): Promise<void> {
    // データベースに保存
  }
  
  private async removePushSubscription(userId: string, endpoint: string): Promise<void> {
    const subs = this.pushSubscriptions.get(userId) || [];
    const filtered = subs.filter(s => s.endpoint !== endpoint);
    this.pushSubscriptions.set(userId, filtered);
    
    // データベースから削除
  }
  
  // 統計情報の取得
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }
  
  // 通知履歴の取得
  async getNotificationHistory(
    userId: string,
    limit = 100
  ): Promise<Notification[]> {
    // データベースから取得
    return [];
  }
}

// === レート制限 ===
class RateLimiter {
  private limits: NotificationConfig['rateLimits'];
  private counters: Map<string, number[]> = new Map();
  
  constructor(limits: NotificationConfig['rateLimits']) {
    this.limits = limits;
  }
  
  async checkLimit(userId: string, channels: NotificationChannel[]): Promise<boolean> {
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    // ユーザー制限
    const userKey = `user:${userId}`;
    const userCount = this.getCount(userKey, hourAgo);
    if (userCount >= this.limits.perUser) {
      return false;
    }
    
    // チャネル制限
    for (const channel of channels) {
      const channelKey = `channel:${channel}`;
      const channelCount = this.getCount(channelKey, hourAgo);
      if (channelCount >= this.limits.perChannel) {
        return false;
      }
    }
    
    // グローバル制限
    const globalCount = this.getCount('global', hourAgo);
    if (globalCount >= this.limits.global) {
      return false;
    }
    
    // カウンターを更新
    this.incrementCounters([userKey, 'global', ...channels.map(c => `channel:${c}`)], now);
    
    return true;
  }
  
  private getCount(key: string, since: number): number {
    const timestamps = this.counters.get(key) || [];
    return timestamps.filter(t => t > since).length;
  }
  
  private incrementCounters(keys: string[], timestamp: number): void {
    for (const key of keys) {
      const timestamps = this.counters.get(key) || [];
      timestamps.push(timestamp);
      
      // 古いエントリを削除
      const hourAgo = timestamp - 3600000;
      const filtered = timestamps.filter(t => t > hourAgo);
      
      this.counters.set(key, filtered);
    }
  }
}

export default NotificationManager;