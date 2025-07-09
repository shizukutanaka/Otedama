// src/tracing/index.ts
export { 
  DistributedTracer,
  type TraceContext,
  type TraceSpan,
  type TraceLog,
  type TraceReference,
  type DistributedTracingConfig,
  type TraceMetrics
} from './distributed-tracer';

export { 
  TraceAnalyzer,
  type TraceAnalysis,
  type Bottleneck,
  type ServiceInteraction,
  type PerformanceInsight,
  type ServiceDependency
} from './trace-analyzer';

export { TraceUI } from './trace-ui';

// Convenience factory and integration
import { DistributedTracer, DistributedTracingConfig } from './distributed-tracer';
import { TraceAnalyzer } from './trace-analyzer';
import { TraceUI } from './trace-ui';
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import express from 'express';

export interface TracingSystemConfig extends DistributedTracingConfig {
  ui?: {
    enabled: boolean;
    path?: string;
  };
  integration?: {
    express?: boolean;
    autoInstrument?: boolean;
  };
}

export class TracingSystem {
  public tracer: DistributedTracer;
  public analyzer: TraceAnalyzer;
  public ui?: TraceUI;
  private logger: Logger;

  constructor(
    config: TracingSystemConfig,
    logger: Logger,
    cache: RedisCache
  ) {
    this.logger = logger;
    this.tracer = new DistributedTracer(config, logger, cache);
    this.analyzer = new TraceAnalyzer(logger, cache);

    if (config.ui?.enabled) {
      this.ui = new TraceUI(this.tracer, this.analyzer, logger);
    }

    this.setupIntegration();
  }

  private setupIntegration(): void {
    // Connect tracer and analyzer
    this.tracer.on('span-finished', (span) => {
      this.analyzer.addSpans([span]);
    });

    this.analyzer.on('insights-generated', (insights) => {
      this.logger.info(`Generated ${insights.length} performance insights`);
      
      // Log critical insights
      const critical = insights.filter(i => i.severity === 'critical');
      if (critical.length > 0) {
        this.logger.warn(`Critical performance issues detected:`, {
          count: critical.length,
          issues: critical.map(i => i.title)
        });
      }
    });
  }

  public setupRoutes(app: express.Application, basePath: string = '/tracing'): void {
    if (this.ui) {
      app.use(basePath, this.ui.getRouter());
      this.logger.info(`Tracing UI available at ${basePath}`);
    }
  }

  public setupMiddleware(): express.RequestHandler {
    return (req, res, next) => {
      // Extract trace context from headers
      const context = this.tracer.extractContext(req.headers as Record<string, string>);
      
      // Start request span
      const span = this.tracer.startSpan(`http.${req.method.toLowerCase()}`, context, {
        'http.method': req.method,
        'http.url': req.url,
        'http.route': req.route?.path,
        'http.user_agent': req.headers['user-agent'],
        'component': 'http'
      });

      // Store span in request for access by route handlers
      (req as any).traceSpan = span;
      (req as any).traceContext = {
        traceId: span.traceId,
        spanId: span.spanId
      };

      // Log request start
      this.tracer.logSpanEvent(span.spanId, 'info', 'HTTP request started', {
        method: req.method,
        url: req.url,
        ip: req.ip
      });

      // Finish span when response ends
      const originalEnd = res.end;
      res.end = function(this: express.Response, ...args: any[]) {
        // Set response tags
        span.tags['http.status_code'] = this.statusCode;
        span.tags['http.response_size'] = this.getHeader('content-length') || 0;

        // Determine status
        let status: 'ok' | 'error' = 'ok';
        if (this.statusCode >= 400) {
          status = 'error';
          this.tracer.logSpanEvent(span.spanId, 'error', `HTTP ${this.statusCode}`, {
            statusCode: this.statusCode
          });
        }

        this.tracer.finishSpan(span.spanId, status);
        originalEnd.apply(this, args);
      }.bind(res);

      next();
    };
  }

  public createSpanDecorator() {
    return (operationName: string, tags?: Record<string, any>) => {
      return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
        const method = descriptor.value;

        descriptor.value = async function (this: any, ...args: any[]) {
          // Get parent context from request if available
          const context = this.req?.traceContext;
          
          return this.tracer.traceAsyncOperation(
            operationName,
            async (span) => {
              if (tags) {
                Object.entries(tags).forEach(([key, value]) => {
                  this.tracer.setSpanTag(span.spanId, key, value);
                });
              }
              
              return method.apply(this, args);
            },
            context
          );
        };
      };
    };
  }

  public createDatabaseTracer() {
    return {
      query: <T>(sql: string, params?: any[]) => {
        return async (fn: () => Promise<T>): Promise<T> => {
          const span = this.tracer.startSpan('db.query', undefined, {
            'db.statement': sql.substring(0, 200), // Truncate for privacy
            'db.type': 'sql',
            'component': 'database'
          });

          try {
            const result = await fn();
            
            // Log query completion
            this.tracer.logSpanEvent(span.spanId, 'info', 'Query completed');
            this.tracer.finishSpan(span.spanId, 'ok');
            
            return result;
          } catch (error) {
            this.tracer.recordSpanError(span.spanId, error as Error);
            this.tracer.finishSpan(span.spanId, 'error');
            throw error;
          }
        };
      }
    };
  }

  public createP2PTracer() {
    return {
      sendMessage: (messageType: string, peerId: string, size: number) => {
        return this.tracer.startSpan('p2p.send_message', undefined, {
          'p2p.message_type': messageType,
          'p2p.peer_id': peerId,
          'p2p.message_size': size,
          'component': 'p2p'
        });
      },

      receiveMessage: (messageType: string, peerId: string, size: number) => {
        return this.tracer.startSpan('p2p.receive_message', undefined, {
          'p2p.message_type': messageType,
          'p2p.peer_id': peerId,
          'p2p.message_size': size,
          'component': 'p2p'
        });
      }
    };
  }

  public createMiningTracer() {
    return {
      startWork: (minerId: string, workId: string, algorithm: string) => {
        return this.tracer.traceMiningWork(minerId, workId, algorithm);
      },

      submitShare: (minerId: string, shareId: string, difficulty: number) => {
        return this.tracer.traceShareSubmission(minerId, shareId, difficulty);
      },

      validateShare: (shareId: string, result: 'valid' | 'invalid') => {
        const span = this.tracer.startSpan('mining.validate_share', undefined, {
          'mining.share_id': shareId,
          'mining.validation_result': result,
          'component': 'mining'
        });

        if (result === 'invalid') {
          this.tracer.logSpanEvent(span.spanId, 'warn', 'Invalid share submitted');
        }

        return span;
      }
    };
  }

  public async getSystemHealth(): Promise<{
    tracer: {
      totalSpans: number;
      activeSpans: number;
      errorRate: number;
      throughput: number;
    };
    analyzer: {
      totalTraces: number;
      criticalInsights: number;
      serviceHealth: Record<string, string>;
    };
  }> {
    const tracerMetrics = this.tracer.getMetrics();
    const analyzerStats = this.analyzer.getTraceStatistics();
    const insights = this.analyzer.getInsights('critical');
    const serviceDeps = this.analyzer.getServiceDependencies();

    const serviceHealth: Record<string, string> = {};
    for (const [service, dep] of serviceDeps.entries()) {
      serviceHealth[service] = dep.health;
    }

    return {
      tracer: {
        totalSpans: tracerMetrics.totalSpans,
        activeSpans: tracerMetrics.activeSpans,
        errorRate: tracerMetrics.errorSpans / Math.max(tracerMetrics.totalSpans, 1) * 100,
        throughput: tracerMetrics.throughput
      },
      analyzer: {
        totalTraces: analyzerStats.totalTraces,
        criticalInsights: insights.length,
        serviceHealth
      }
    };
  }

  public destroy(): void {
    this.tracer.destroy();
    this.analyzer.destroy();
    
    this.logger.info('Tracing system destroyed');
  }
}

// Helper functions for common tracing patterns
export const createDefaultTracingConfig = (serviceName: string): TracingSystemConfig => ({
  enabled: true,
  serviceName,
  sampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  maxSpanDuration: 30000, // 30 seconds
  exporters: {
    jaeger: {
      enabled: !!process.env.JAEGER_ENDPOINT,
      endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces'
    },
    otlp: {
      enabled: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
    }
  },
  propagation: {
    b3: true,
    jaeger: true,
    tracecontext: true
  },
  ui: {
    enabled: process.env.NODE_ENV !== 'production',
    path: '/tracing'
  },
  integration: {
    express: true,
    autoInstrument: true
  }
});

// Express middleware helper
export const createTracingMiddleware = (tracingSystem: TracingSystem) => {
  return tracingSystem.setupMiddleware();
};

// Decorators
export const trace = (operationName: string, tags?: Record<string, any>) => {
  return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
    // This would be implemented as a proper decorator in a real system
    console.warn('Trace decorator requires TracingSystem instance');
  };
};

export default TracingSystem;
