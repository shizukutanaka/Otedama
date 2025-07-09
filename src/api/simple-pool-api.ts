import express, { Express } from 'express';
import { Logger } from '../logging/logger';

export interface SimpleApiConfig {
  port: number;
  host: string;
}

export class SimplePoolApi {
  private app: Express;
  private server?: any;
  private logger: Logger;

  constructor(private config: SimpleApiConfig, logger: Logger) {
    this.app = express();
    this.logger = logger;

    // basic health endpoint
    this.app.get('/health', (_, res) => {
      res.json({ status: 'ok' });
    });
  }

  public start(): void {
    if (!this.config.port) {
      this.config.port = 8080;
    }
    if (!this.config.host) {
      this.config.host = '0.0.0.0';
    }
    this.server = this.app.listen(this.config.port, this.config.host, () => {
      this.logger.info(`Simple API listening on http://${this.config.host}:${this.config.port}`);
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close(() => this.logger.info('Simple API stopped'));
    }
  }
}
