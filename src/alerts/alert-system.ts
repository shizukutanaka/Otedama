// Alert System Implementation
import { AlertConfig, loadAlertConfig } from '../config/alerts';
import { Logger, LogLevel } from '../logging/logger';
import * as nodemailer from 'nodemailer';
import * as https from 'https';

export enum AlertType {
  PERFORMANCE = 'performance',
  POOL = 'pool',
  SECURITY = 'security'
}

export interface AlertEvent {
  type: AlertType;
  severity: 'warning' | 'critical' | 'emergency';
  metric: string;
  value: number;
  threshold: number;
  timestamp: Date;
  details?: any;
}

export class AlertSystem {
  private config: AlertConfig;
  private logger: Logger;
  private lastAlerts: Map<string, Date> = new Map();
  private alertQueue: AlertEvent[] = [];
  private processing: boolean = false;

  constructor(private pool: any) {
    this.config = loadAlertConfig();
    this.logger = Logger.getInstance();
    
    // Start alert processor
    this.startAlertProcessor();
  }

  private startAlertProcessor(): void {
    setInterval(() => {
      if (!this.processing && this.alertQueue.length > 0) {
        this.processAlerts();
      }
    }, 1000); // Check every second
  }

  private async processAlerts(): Promise<void> {
    this.processing = true;
    
    try {
      while (this.alertQueue.length > 0) {
        const alert = this.alertQueue.shift();
        if (!alert) break;

        // Check cooldown
        const alertKey = `${alert.type}-${alert.metric}`;
        const lastAlert = this.lastAlerts.get(alertKey);
        const cooldown = this.config.cooldown[alert.severity as keyof typeof this.config.cooldown];
        
        if (lastAlert && Date.now() - lastAlert.getTime() < cooldown) {
          continue;
        }

        // Send notifications
        await this.sendNotifications(alert);
        
        // Update last alert time
        this.lastAlerts.set(alertKey, new Date());
      }
    } catch (error) {
      this.logger.error('Error processing alerts:', error);
    } finally {
      this.processing = false;
    }
  }

  private async sendNotifications(alert: AlertEvent): Promise<void> {
    const message = this.formatAlertMessage(alert);
    
    // Send to console
    if (this.config.notifications.console.enabled) {
      const consoleLevel = this.config.notifications.console.level;
      switch (alert.severity) {
        case 'warning':
          this.logger.warn(message);
          break;
        case 'critical':
          this.logger.error(message);
          break;
        case 'emergency':
          this.logger.fatal(message);
          break;
      }
    }

    // Send email if configured
    if (this.config.notifications.email.enabled && this.config.notifications.email.smtp.host) {
      try {
        const transporter = nodemailer.createTransport({
          host: this.config.notifications.email.smtp.host,
          port: this.config.notifications.email.smtp.port,
          secure: true,
          auth: {
            user: this.config.notifications.email.smtp.user,
            pass: this.config.notifications.email.smtp.password
          }
        });

        await transporter.sendMail({
          from: 'Otedama Pool <pool@otedama.com>',
          to: this.config.notifications.email.recipients.join(','),
          subject: `[${alert.severity.toUpperCase()}] Otedama Pool Alert`,
          text: message
        });
      } catch (error) {
        this.logger.error('Failed to send email notification:', error);
      }
    }

    // Send webhook if configured
    if (this.config.notifications.webhook.enabled && this.config.notifications.webhook.urls.length > 0) {
      for (const url of this.config.notifications.webhook.urls) {
        try {
          const agent = new https.Agent({
            rejectUnauthorized: false // For testing, should be true in production
          });

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              severity: alert.severity,
              message: message,
              timestamp: alert.timestamp.toISOString(),
              details: alert.details
            }),
            agent: agent
          });

          if (!response.ok) {
            throw new Error(`Webhook failed: ${response.statusText}`);
          }
        } catch (error) {
          this.logger.error('Failed to send webhook notification:', error);
        }
      }
    }
  }

  private formatAlertMessage(alert: AlertEvent): string {
    const template = this.config.templates[alert.type as keyof typeof this.config.templates];
    return template
      .replace('{{type}}', alert.metric)
      .replace('{{value}}', alert.value.toString())
      .replace('{{threshold}}', alert.threshold.toString());
  }

  // Public methods to check metrics and trigger alerts
  public checkPerformanceMetric(metric: string, value: number): void {
    const threshold = this.getThreshold(metric, 'performance');
    if (value >= threshold) {
      this.queueAlert(AlertType.PERFORMANCE, metric, value, threshold);
    }
  }

  public checkPoolMetric(metric: string, value: number): void {
    const threshold = this.getThreshold(metric, 'pool');
    if (value >= threshold) {
      this.queueAlert(AlertType.POOL, metric, value, threshold);
    }
  }

  public checkSecurityMetric(metric: string, value: number, details?: any): void {
    const threshold = this.getThreshold(metric, 'security');
    if (value >= threshold) {
      this.queueAlert(AlertType.SECURITY, metric, value, threshold, details);
    }
  }

  private getThreshold(metric: string, category: keyof AlertConfig['types']): number {
    const thresholds = this.config.types[category];
    return thresholds[metric as keyof typeof thresholds];
  }

  private queueAlert(
    type: AlertType,
    metric: string,
    value: number,
    threshold: number,
    details?: any
  ): void {
    const severity = this.getAlertSeverity(value);
    const alert: AlertEvent = {
      type,
      severity,
      metric,
      value,
      threshold,
      timestamp: new Date(),
      details
    };
    
    this.alertQueue.push(alert);
  }

  private getAlertSeverity(value: number): 'warning' | 'critical' | 'emergency' {
    const thresholds = this.config.thresholds;
    if (value >= thresholds.emergency) {
      return 'emergency';
    } else if (value >= thresholds.critical) {
      return 'critical';
    } else if (value >= thresholds.warning) {
      return 'warning';
    }
    return 'warning'; // Default to warning
  }

  // Shutdown method
  public async shutdown(): Promise<void> {
    // Process remaining alerts before shutdown
    await this.processAlerts();
    this.processing = false;
    this.alertQueue = [];
    this.lastAlerts.clear();
  }
}
