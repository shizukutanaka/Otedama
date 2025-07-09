import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, context, Span, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

// === カスタムトレーシングクラス ===
export class OtedamaTracer {
  private tracer = trace.getTracer('otedama-pool', '1.0.0');

  /**
   * 非同期関数のトレーシング
   */
  async traceAsync<T>(
    spanName: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>
  ): Promise<T> {
    return this.tracer.startActiveSpan(spanName, async (span) => {
      try {
        if (attributes) {
          span.setAttributes(attributes);
        }
        
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * 同期関数のトレーシング
   */
  traceSync<T>(
    spanName: string,
    fn: (span: Span) => T,
    attributes?: Record<string, string | number | boolean>
  ): T {
    return this.tracer.startActiveSpan(spanName, (span) => {
      try {
        if (attributes) {
          span.setAttributes(attributes);
        }
        
        const result = fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * マイニング関連のトレーシング
   */
  async traceMiningOperation<T>(
    operation: string,
    minerId: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.traceAsync(
      `mining.${operation}`,
      fn,
      {
        'mining.miner_id': minerId,
        'mining.operation': operation,
        'service.component': 'mining'
      }
    );
  }

  /**
   * P2P ネットワーク関連のトレーシング
   */
  async traceP2POperation<T>(
    operation: string,
    peerId?: string,
    fn?: (span: Span) => Promise<T>
  ): Promise<T | void> {
    const attributes: Record<string, string> = {
      'p2p.operation': operation,
      'service.component': 'p2p'
    };
    
    if (peerId) {
      attributes['p2p.peer_id'] = peerId;
    }

    if (fn) {
      return this.traceAsync(`p2p.${operation}`, fn, attributes);
    } else {
      // イベントトレーシング用
      const span = this.tracer.startSpan(`p2p.${operation}`, {
        kind: SpanKind.INTERNAL,
        attributes
      });
      span.end();
    }
  }

  /**
   * ブロックチェーン関連のトレーシング
   */
  async traceBlockchainOperation<T>(
    operation: string,
    fn: (span: Span) => Promise<T>,
    blockHeight?: number
  ): Promise<T> {
    const attributes: Record<string, string | number> = {
      'blockchain.operation': operation,
      'service.component': 'blockchain'
    };
    
    if (blockHeight !== undefined) {
      attributes['blockchain.block_height'] = blockHeight;
    }

    return this.traceAsync(`blockchain.${operation}`, fn, attributes);
  }

  /**
   * データベース操作のトレーシング
   */
  async traceDatabaseOperation<T>(
    operation: string,
    table: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.traceAsync(
      `db.${operation}`,
      fn,
      {
        'db.operation': operation,
        'db.table': table,
        'service.component': 'database'
      }
    );
  }

  /**
   * HTTP リクエストのトレーシング
   */
  async traceHttpRequest<T>(
    method: string,
    url: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.traceAsync(
      `http.${method.toLowerCase()}`,
      fn,
      {
        'http.method': method,
        'http.url': url,
        'service.component': 'http'
      }
    );
  }

  /**
   * カスタムイベントの記録
   */
  recordEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent(name, attributes);
    }
  }

  /**
   * エラーの記録
   */
  recordError(error: Error, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(error);
      if (attributes) {
        span.setAttributes(attributes);
      }
    }
  }
}

// === SDK 設定 ===
const createTracingSDK = () => {
  const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 
    (process.env.NODE_ENV === 'production' 
      ? 'http://otel-collector:4318/v1/traces'
      : 'http://localhost:4318/v1/traces');

  // メインのOTLPエクスポーター
  const otlpExporter = new OTLPTraceExporter({
    url: exporterUrl,
    headers: {
      'Authorization': process.env.OTEL_EXPORTER_OTLP_HEADERS || '',
    },
  });

  // Jaegerエクスポーター（フォールバック用）
  const jaegerExporter = new JaegerExporter({
    endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
    tags: [
      { key: 'service.version', value: '1.0.0' },
      { key: 'deployment.environment', value: process.env.NODE_ENV || 'development' },
    ],
  });

  return new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'otedama-pool',
      [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: 'mining',
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.HOSTNAME || 'unknown',
    }),
    spanProcessor: new BatchSpanProcessor(otlpExporter, {
      maxQueueSize: 1000,
      maxExportBatchSize: 100,
      scheduledDelayMillis: 1000,
    }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': {
        enabled: false, // ファイルシステム操作は除外
      },
    })],
  });
};

const sdk = createTracingSDK();
sdk.start();

// グローバルトレーサーインスタンス
export const tracer = new OtedamaTracer();

console.log('Otedama Enhanced Tracing initialized with Jaeger support');

// グレースフルシャットダウン
process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
    console.log('Tracing terminated gracefully');
  } catch (error) {
    console.error('Error terminating tracing:', error);
  } finally {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  try {
    await sdk.shutdown();
    console.log('Tracing terminated gracefully');
  } catch (error) {
    console.error('Error terminating tracing:', error);
  } finally {
    process.exit(0);
  }
});

// === エクスポート ===
export { trace, context, Span, SpanStatusCode, SpanKind } from '@opentelemetry/api';
