/**
 * API ドキュメント自動生成システム
 * Swagger/OpenAPI 3.0 対応
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  summary: string;
  description?: string;
  tags?: string[];
  parameters?: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses: ApiResponse[];
  security?: SecurityRequirement[];
  deprecated?: boolean;
}

export interface ApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema: ApiSchema;
  example?: any;
}

export interface ApiRequestBody {
  description?: string;
  required?: boolean;
  content: {
    [mediaType: string]: {
      schema: ApiSchema;
      example?: any;
    };
  };
}

export interface ApiResponse {
  statusCode: number;
  description: string;
  headers?: { [name: string]: ApiHeader };
  content?: {
    [mediaType: string]: {
      schema: ApiSchema;
      example?: any;
    };
  };
}

export interface ApiHeader {
  description?: string;
  schema: ApiSchema;
}

export interface ApiSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  format?: string;
  items?: ApiSchema;
  properties?: { [name: string]: ApiSchema };
  required?: string[];
  example?: any;
  description?: string;
  enum?: any[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface SecurityRequirement {
  [name: string]: string[];
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
    license?: {
      name: string;
      url?: string;
    };
  };
  servers: Array<{
    url: string;
    description?: string;
  }>;
  paths: { [path: string]: any };
  components: {
    schemas?: { [name: string]: ApiSchema };
    securitySchemes?: { [name: string]: any };
  };
  tags?: Array<{
    name: string;
    description?: string;
  }>;
}

export class ApiDocGenerator {
  private endpoints: ApiEndpoint[] = [];
  private schemas: { [name: string]: ApiSchema } = {};
  private tags: Array<{ name: string; description?: string }> = [];
  private spec: OpenApiSpec;

  constructor() {
    this.spec = {
      openapi: '3.0.3',
      info: {
        title: 'Otedama Pool API',
        version: '1.0.0',
        description: 'P2P分散マイニングプール REST API',
        contact: {
          name: 'Otedama Pool Team',
          email: 'support@otedama.pool'
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT'
        }
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server'
        },
        {
          url: 'https://api.otedama.pool',
          description: 'Production server'
        }
      ],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          },
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key'
          }
        }
      },
      tags: []
    };

    this.initializeCommonSchemas();
    this.initializeTags();
  }

  /**
   * 共通スキーマの初期化
   */
  private initializeCommonSchemas(): void {
    this.addSchema('Error', {
      type: 'object',
      properties: {
        error: { type: 'string', description: 'エラーメッセージ' },
        code: { type: 'integer', description: 'エラーコード' },
        details: { type: 'object', description: '詳細情報' }
      },
      required: ['error', 'code']
    });

    this.addSchema('SuccessResponse', {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', description: '成功メッセージ' }
      },
      required: ['success']
    });

    this.addSchema('Pagination', {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, description: 'ページ番号' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '1ページあたりの件数' },
        total: { type: 'integer', description: '総件数' },
        totalPages: { type: 'integer', description: '総ページ数' }
      },
      required: ['page', 'limit', 'total', 'totalPages']
    });

    // マイニングプール固有のスキーマ
    this.addSchema('PoolStats', {
      type: 'object',
      properties: {
        hashrate: { type: 'number', description: 'プールハッシュレート (H/s)' },
        miners: { type: 'integer', description: 'アクティブマイナー数' },
        blocks: { type: 'integer', description: '発見ブロック数' },
        lastBlock: { type: 'string', format: 'date-time', description: '最後のブロック発見時刻' },
        difficulty: { type: 'number', description: '現在の難易度' },
        networkHashrate: { type: 'number', description: 'ネットワークハッシュレート' }
      },
      required: ['hashrate', 'miners', 'blocks', 'difficulty']
    });

    this.addSchema('MinerStats', {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'マイナー名' },
        hashrate: { type: 'number', description: 'ハッシュレート (H/s)' },
        shares: { type: 'integer', description: '提出シェア数' },
        validShares: { type: 'integer', description: '有効シェア数' },
        invalidShares: { type: 'integer', description: '無効シェア数' },
        lastSeen: { type: 'string', format: 'date-time', description: '最後の接続時刻' },
        balance: { type: 'number', description: '残高' }
      },
      required: ['username', 'hashrate', 'shares', 'validShares', 'invalidShares']
    });

    this.addSchema('Block', {
      type: 'object',
      properties: {
        height: { type: 'integer', description: 'ブロック高' },
        hash: { type: 'string', description: 'ブロックハッシュ' },
        timestamp: { type: 'string', format: 'date-time', description: '発見時刻' },
        difficulty: { type: 'number', description: '難易度' },
        reward: { type: 'number', description: '報酬額' },
        miner: { type: 'string', description: '発見者' },
        confirmations: { type: 'integer', description: '確認数' }
      },
      required: ['height', 'hash', 'timestamp', 'difficulty', 'reward']
    });
  }

  /**
   * タグの初期化
   */
  private initializeTags(): void {
    this.addTag('Pool', 'プール統計情報API');
    this.addTag('Miners', 'マイナー管理API');
    this.addTag('Blocks', 'ブロック情報API');
    this.addTag('Payments', '支払い管理API');
    this.addTag('Admin', '管理者用API');
    this.addTag('Health', 'ヘルスチェックAPI');
  }

  /**
   * エンドポイントを追加
   */
  public addEndpoint(endpoint: ApiEndpoint): void {
    this.endpoints.push(endpoint);
    this.buildPathsObject();
  }

  /**
   * スキーマを追加
   */
  public addSchema(name: string, schema: ApiSchema): void {
    this.schemas[name] = schema;
    this.spec.components.schemas![name] = schema;
  }

  /**
   * タグを追加
   */
  public addTag(name: string, description?: string): void {
    this.tags.push({ name, description });
    this.spec.tags = this.tags;
  }

  /**
   * パスオブジェクトを構築
   */
  private buildPathsObject(): void {
    this.spec.paths = {};

    for (const endpoint of this.endpoints) {
      const pathKey = endpoint.path.replace(/{([^}]+)}/g, '{$1}'); // パラメータ形式を統一
      
      if (!this.spec.paths[pathKey]) {
        this.spec.paths[pathKey] = {};
      }

      this.spec.paths[pathKey][endpoint.method.toLowerCase()] = {
        summary: endpoint.summary,
        description: endpoint.description,
        tags: endpoint.tags || [],
        parameters: endpoint.parameters || [],
        requestBody: endpoint.requestBody,
        responses: this.buildResponsesObject(endpoint.responses),
        security: endpoint.security,
        deprecated: endpoint.deprecated || false
      };
    }
  }

  /**
   * レスポンスオブジェクトを構築
   */
  private buildResponsesObject(responses: ApiResponse[]): any {
    const responsesObj: any = {};

    for (const response of responses) {
      responsesObj[response.statusCode.toString()] = {
        description: response.description,
        headers: response.headers,
        content: response.content
      };
    }

    return responsesObj;
  }

  /**
   * 一般的なAPIエンドポイントを自動追加
   */
  public generateStandardEndpoints(): void {
    // プール統計
    this.addEndpoint({
      method: 'GET',
      path: '/api/pool/stats',
      summary: 'プール統計情報取得',
      description: 'プール全体の統計情報を取得します',
      tags: ['Pool'],
      responses: [
        {
          statusCode: 200,
          description: '成功',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PoolStats' } as any
            }
          }
        }
      ]
    });

    // マイナー一覧
    this.addEndpoint({
      method: 'GET',
      path: '/api/miners',
      summary: 'マイナー一覧取得',
      tags: ['Miners'],
      parameters: [
        {
          name: 'page',
          in: 'query',
          schema: { type: 'integer', minimum: 1, example: 1 },
          description: 'ページ番号'
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, example: 10 },
          description: '1ページあたりの件数'
        }
      ],
      responses: [
        {
          statusCode: 200,
          description: '成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  miners: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/MinerStats' } as any
                  },
                  pagination: { $ref: '#/components/schemas/Pagination' } as any
                }
              } as any
            }
          }
        }
      ]
    });

    // ブロック一覧
    this.addEndpoint({
      method: 'GET',
      path: '/api/blocks',
      summary: 'ブロック一覧取得',
      tags: ['Blocks'],
      parameters: [
        {
          name: 'page',
          in: 'query',
          schema: { type: 'integer', minimum: 1 }
        }
      ],
      responses: [
        {
          statusCode: 200,
          description: '成功',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  blocks: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Block' } as any
                  }
                }
              } as any
            }
          }
        }
      ]
    });

    // ヘルスチェック
    this.addEndpoint({
      method: 'GET',
      path: '/api/health',
      summary: 'ヘルスチェック',
      description: 'サービスの正常性を確認します',
      tags: ['Health'],
      responses: [
        {
          statusCode: 200,
          description: '正常',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'healthy' },
                  timestamp: { type: 'string', format: 'date-time' },
                  version: { type: 'string', example: '1.0.0' }
                }
              } as any
            }
          }
        }
      ]
    });
  }

  /**
   * OpenAPI仕様書を生成
   */
  public generateSpec(): OpenApiSpec {
    this.buildPathsObject();
    return { ...this.spec };
  }

  /**
   * JSON形式でエクスポート
   */
  public exportJson(): string {
    return JSON.stringify(this.generateSpec(), null, 2);
  }

  /**
   * YAML形式でエクスポート（簡易）
   */
  public exportYaml(): string {
    const spec = this.generateSpec();
    
    // 簡易YAML変換（本格的な実装にはyamlライブラリを使用）
    let yaml = `openapi: ${spec.openapi}\n`;
    yaml += `info:\n`;
    yaml += `  title: "${spec.info.title}"\n`;
    yaml += `  version: "${spec.info.version}"\n`;
    
    if (spec.info.description) {
      yaml += `  description: "${spec.info.description}"\n`;
    }
    
    yaml += `servers:\n`;
    for (const server of spec.servers) {
      yaml += `  - url: ${server.url}\n`;
      if (server.description) {
        yaml += `    description: ${server.description}\n`;
      }
    }
    
    return yaml;
  }

  /**
   * ファイルに保存
   */
  public saveToFile(filename: string, format: 'json' | 'yaml' = 'json'): void {
    const content = format === 'json' ? this.exportJson() : this.exportYaml();
    const ext = format === 'json' ? '.json' : '.yaml';
    const fullPath = path.join(process.cwd(), 'docs', filename + ext);
    
    // ディレクトリが存在しない場合は作成
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`[API Docs] Documentation saved to: ${fullPath}`);
  }

  /**
   * Swagger UI用のHTMLを生成
   */
  public generateSwaggerHtml(): string {
    return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Pool API Documentation</title>
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui.css" />
    <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin:0; background: #fafafa; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-standalone-preset.js"></script>
    <script>
        window.onload = function() {
            const ui = SwaggerUIBundle({
                url: '/api/docs/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "StandaloneLayout",
                tryItOutEnabled: true,
                filter: true,
                supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
                onComplete: function() {
                    console.log('Swagger UI loaded');
                }
            });
        };
    </script>
</body>
</html>`;
  }

  /**
   * Express ルーターを作成
   */
  public createRouter(): Router {
    const router = Router();

    // OpenAPI JSON
    router.get('/openapi.json', (req: Request, res: Response) => {
      res.json(this.generateSpec());
    });

    // Swagger UI HTML
    router.get('/swagger', (req: Request, res: Response) => {
      res.send(this.generateSwaggerHtml());
    });

    // ドキュメントルート
    router.get('/', (req: Request, res: Response) => {
      res.redirect('/api/docs/swagger');
    });

    return router;
  }
}

// デフォルトインスタンス
export const apiDocs = new ApiDocGenerator();

// 標準エンドポイントを生成
apiDocs.generateStandardEndpoints();

export default ApiDocGenerator;