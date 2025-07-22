/**
 * Auto Documentation System
 * ドキュメント自動生成システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import path from 'path';
import fs from 'fs/promises';
import { parse as parseAST } from '@babel/parser';
import traverse from '@babel/traverse';

const logger = getLogger('AutoDocumentationSystem');

// ドキュメントタイプ
export const DocumentationType = {
  API: 'api',
  CODE: 'code',
  USER_GUIDE: 'user_guide',
  DEVELOPER_GUIDE: 'developer_guide',
  ARCHITECTURE: 'architecture',
  DEPLOYMENT: 'deployment',
  CHANGELOG: 'changelog',
  README: 'readme'
};

// ドキュメントフォーマット
export const DocumentFormat = {
  MARKDOWN: 'markdown',
  HTML: 'html',
  PDF: 'pdf',
  DOCX: 'docx',
  SWAGGER: 'swagger',
  POSTMAN: 'postman',
  ASYNCAPI: 'asyncapi'
};

// ドキュメント品質レベル
export const QualityLevel = {
  MINIMAL: 1,
  BASIC: 2,
  STANDARD: 3,
  COMPREHENSIVE: 4,
  EXCELLENT: 5
};

export class AutoDocumentationSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    
    this.options = {
      // 基本設定
      enableAutoGeneration: options.enableAutoGeneration !== false,
      enableIncrementalUpdate: options.enableIncrementalUpdate !== false,
      enableMultiLanguage: options.enableMultiLanguage !== false,
      
      // 生成設定
      defaultFormat: options.defaultFormat || DocumentFormat.MARKDOWN,
      outputDirectory: options.outputDirectory || './docs',
      includeExamples: options.includeExamples !== false,
      includeTests: options.includeTests !== false,
      
      // 品質設定
      qualityLevel: options.qualityLevel || QualityLevel.STANDARD,
      enableSpellCheck: options.enableSpellCheck !== false,
      enableGrammarCheck: options.enableGrammarCheck !== false,
      
      // パーサー設定
      parsers: options.parsers || ['javascript', 'typescript', 'python', 'java'],
      ignorePatterns: options.ignorePatterns || ['node_modules', 'dist', 'build'],
      
      // 統合設定
      enableGitIntegration: options.enableGitIntegration !== false,
      enableCIIntegration: options.enableCIIntegration !== false,
      enableAPIExtraction: options.enableAPIExtraction !== false,
      
      // テンプレート設定
      customTemplates: options.customTemplates || {},
      styleGuide: options.styleGuide || 'default',
      
      ...options
    };
    
    // ドキュメントストア
    this.documents = new Map();
    this.templates = new Map();
    this.parsers = new Map();
    
    // メタデータ
    this.metadata = new Map();
    this.dependencies = new Map();
    this.crossReferences = new Map();
    
    // インデックス
    this.searchIndex = new Map();
    this.tagIndex = new Map();
    
    // 品質チェック
    this.qualityCheckers = new Map();
    this.validationRules = new Map();
    
    // メトリクス
    this.metrics = {
      totalDocuments: 0,
      totalLines: 0,
      coverage: 0,
      qualityScore: 0,
      lastGenerated: null,
      generationTime: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // テンプレートを読み込み
    await this.loadTemplates();
    
    // パーサーを初期化
    this.initializeParsers();
    
    // 品質チェッカーを設定
    this.setupQualityCheckers();
    
    // Git統合を設定
    if (this.options.enableGitIntegration) {
      await this.setupGitIntegration();
    }
    
    // 自動生成を開始
    if (this.options.enableAutoGeneration) {
      this.startAutoGeneration();
    }
    
    this.logger.info('Auto documentation system initialized');
  }
  
  /**
   * ドキュメントを生成
   */
  async generateDocumentation(options = {}) {
    const startTime = Date.now();
    
    this.logger.info('Starting documentation generation...');
    
    // ソースコードをスキャン
    const sourceData = await this.scanSourceCode();
    
    // メタデータを抽出
    const metadata = await this.extractMetadata(sourceData);
    
    // ドキュメントを生成
    const documents = await this.generateDocuments(metadata, options);
    
    // 品質チェック
    await this.performQualityCheck(documents);
    
    // ドキュメントを出力
    await this.outputDocuments(documents);
    
    // インデックスを更新
    await this.updateSearchIndex(documents);
    
    const endTime = Date.now();
    this.metrics.generationTime = endTime - startTime;
    this.metrics.lastGenerated = endTime;
    
    this.emit('documentation:generated', {
      count: documents.length,
      duration: this.metrics.generationTime
    });
    
    return documents;
  }
  
  /**
   * ソースコードをスキャン
   */
  async scanSourceCode() {
    const sourceData = [];
    const filePatterns = this.getFilePatterns();
    
    for (const pattern of filePatterns) {
      const files = await this.findFiles(pattern);
      
      for (const file of files) {
        if (this.shouldIgnoreFile(file)) continue;
        
        try {
          const content = await fs.readFile(file, 'utf-8');
          const parsed = await this.parseFile(file, content);
          
          sourceData.push({
            file,
            content,
            parsed,
            language: this.detectLanguage(file),
            metadata: await this.extractFileMetadata(file)
          });
          
        } catch (error) {
          this.logger.error(`Failed to parse file: ${file}`, error);
        }
      }
    }
    
    return sourceData;
  }
  
  /**
   * ファイルをパース
   */
  async parseFile(file, content) {
    const language = this.detectLanguage(file);
    const parser = this.parsers.get(language);
    
    if (!parser) {
      throw new Error(`No parser available for ${language}`);
    }
    
    return await parser.parse(content, file);
  }
  
  /**
   * JavaScript/TypeScriptパーサーを初期化
   */
  initializeJavaScriptParser() {
    this.parsers.set('javascript', {
      parse: async (content, file) => {
        const ast = parseAST(content, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript', 'decorators-legacy']
        });
        
        const extracted = {
          classes: [],
          functions: [],
          constants: [],
          exports: [],
          imports: [],
          comments: []
        };
        
        traverse(ast, {
          ClassDeclaration(path) {
            extracted.classes.push(extractClassInfo(path));
          },
          FunctionDeclaration(path) {
            extracted.functions.push(extractFunctionInfo(path));
          },
          VariableDeclaration(path) {
            if (path.node.kind === 'const') {
              extracted.constants.push(...extractConstantInfo(path));
            }
          },
          ExportNamedDeclaration(path) {
            extracted.exports.push(extractExportInfo(path));
          },
          ImportDeclaration(path) {
            extracted.imports.push(extractImportInfo(path));
          }
        });
        
        // JSDocコメントを抽出
        extracted.comments = this.extractJSDocComments(content);
        
        return extracted;
      }
    });
    
    // ヘルパー関数
    function extractClassInfo(path) {
      const node = path.node;
      const leadingComments = node.leadingComments || [];
      
      return {
        name: node.id.name,
        type: 'class',
        methods: [],
        properties: [],
        extends: node.superClass?.name,
        implements: [],
        decorators: node.decorators?.map(d => d.expression.name),
        comments: leadingComments.map(c => c.value),
        location: {
          start: node.loc.start,
          end: node.loc.end
        }
      };
    }
    
    function extractFunctionInfo(path) {
      const node = path.node;
      
      return {
        name: node.id?.name || 'anonymous',
        type: 'function',
        params: node.params.map(p => ({
          name: p.name || p.left?.name,
          type: p.typeAnnotation?.typeAnnotation?.type,
          optional: p.optional,
          default: p.right?.value
        })),
        returns: node.returnType?.typeAnnotation?.type,
        async: node.async,
        generator: node.generator,
        comments: node.leadingComments?.map(c => c.value) || [],
        location: {
          start: node.loc.start,
          end: node.loc.end
        }
      };
    }
    
    function extractConstantInfo(path) {
      return path.node.declarations.map(decl => ({
        name: decl.id.name,
        type: 'constant',
        value: decl.init?.value,
        valueType: decl.init?.type,
        comments: path.node.leadingComments?.map(c => c.value) || []
      }));
    }
    
    function extractExportInfo(path) {
      return {
        type: 'export',
        specifiers: path.node.specifiers?.map(s => s.exported.name) || [],
        source: path.node.source?.value
      };
    }
    
    function extractImportInfo(path) {
      return {
        type: 'import',
        specifiers: path.node.specifiers?.map(s => s.local.name) || [],
        source: path.node.source.value
      };
    }
  }
  
  /**
   * JSDocコメントを抽出
   */
  extractJSDocComments(content) {
    const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
    const comments = [];
    let match;
    
    while ((match = jsdocRegex.exec(content)) !== null) {
      const comment = match[1];
      const parsed = this.parseJSDoc(comment);
      comments.push(parsed);
    }
    
    return comments;
  }
  
  /**
   * JSDocをパース
   */
  parseJSDoc(comment) {
    const lines = comment.split('\n').map(line => 
      line.trim().replace(/^\* ?/, '')
    );
    
    const parsed = {
      description: '',
      tags: []
    };
    
    let currentTag = null;
    
    for (const line of lines) {
      if (line.startsWith('@')) {
        const [tag, ...rest] = line.split(' ');
        currentTag = {
          tag: tag.substring(1),
          value: rest.join(' '),
          description: ''
        };
        parsed.tags.push(currentTag);
      } else if (currentTag) {
        currentTag.description += line + ' ';
      } else {
        parsed.description += line + ' ';
      }
    }
    
    return parsed;
  }
  
  /**
   * メタデータを抽出
   */
  async extractMetadata(sourceData) {
    const metadata = {
      project: await this.extractProjectMetadata(),
      modules: [],
      classes: [],
      functions: [],
      apis: [],
      dependencies: await this.extractDependencies(),
      configuration: await this.extractConfiguration()
    };
    
    for (const source of sourceData) {
      // モジュール情報
      metadata.modules.push({
        file: source.file,
        name: this.extractModuleName(source.file),
        exports: source.parsed.exports,
        imports: source.parsed.imports,
        description: this.extractModuleDescription(source)
      });
      
      // クラス情報
      for (const cls of source.parsed.classes) {
        metadata.classes.push({
          ...cls,
          module: source.file,
          methods: await this.extractMethodsFromClass(cls, source)
        });
      }
      
      // 関数情報
      for (const func of source.parsed.functions) {
        metadata.functions.push({
          ...func,
          module: source.file,
          examples: await this.extractExamples(func, source)
        });
      }
      
      // API情報
      if (this.options.enableAPIExtraction) {
        const apis = await this.extractAPIs(source);
        metadata.apis.push(...apis);
      }
    }
    
    return metadata;
  }
  
  /**
   * ドキュメントを生成
   */
  async generateDocuments(metadata, options) {
    const documents = [];
    
    // READMEを生成
    if (this.shouldGenerateReadme(options)) {
      const readme = await this.generateReadme(metadata);
      documents.push(readme);
    }
    
    // APIドキュメントを生成
    if (metadata.apis.length > 0) {
      const apiDoc = await this.generateAPIDocumentation(metadata.apis);
      documents.push(apiDoc);
    }
    
    // クラスドキュメントを生成
    for (const cls of metadata.classes) {
      const classDoc = await this.generateClassDocumentation(cls);
      documents.push(classDoc);
    }
    
    // モジュールドキュメントを生成
    for (const module of metadata.modules) {
      const moduleDoc = await this.generateModuleDocumentation(module);
      documents.push(moduleDoc);
    }
    
    // アーキテクチャドキュメントを生成
    if (this.options.qualityLevel >= QualityLevel.COMPREHENSIVE) {
      const archDoc = await this.generateArchitectureDocumentation(metadata);
      documents.push(archDoc);
    }
    
    // デプロイメントガイドを生成
    if (this.shouldGenerateDeploymentGuide(options)) {
      const deployDoc = await this.generateDeploymentGuide(metadata);
      documents.push(deployDoc);
    }
    
    // 変更履歴を生成
    if (this.options.enableGitIntegration) {
      const changelog = await this.generateChangelog();
      documents.push(changelog);
    }
    
    return documents;
  }
  
  /**
   * READMEを生成
   */
  async generateReadme(metadata) {
    const template = this.templates.get('readme');
    
    const content = await template.render({
      project: metadata.project,
      description: metadata.project.description,
      installation: await this.generateInstallationGuide(),
      usage: await this.generateUsageExamples(metadata),
      api: this.generateAPIOverview(metadata.apis),
      configuration: this.generateConfigurationGuide(metadata.configuration),
      contributing: await this.generateContributingGuide(),
      license: metadata.project.license
    });
    
    return {
      type: DocumentationType.README,
      format: DocumentFormat.MARKDOWN,
      path: 'README.md',
      content,
      metadata: {
        generated: Date.now(),
        version: metadata.project.version
      }
    };
  }
  
  /**
   * APIドキュメントを生成
   */
  async generateAPIDocumentation(apis) {
    const template = this.templates.get('api');
    
    // APIをグループ化
    const grouped = this.groupAPIsByResource(apis);
    
    const sections = [];
    
    for (const [resource, endpoints] of grouped) {
      const section = await template.renderSection({
        resource,
        endpoints: endpoints.map(api => ({
          method: api.method,
          path: api.path,
          summary: api.summary,
          description: api.description,
          parameters: api.parameters,
          requestBody: api.requestBody,
          responses: api.responses,
          examples: api.examples,
          authentication: api.authentication,
          rateLimit: api.rateLimit
        }))
      });
      
      sections.push(section);
    }
    
    // OpenAPIスペックを生成
    const openApiSpec = await this.generateOpenAPISpec(apis);
    
    return {
      type: DocumentationType.API,
      format: DocumentFormat.MARKDOWN,
      path: 'docs/API.md',
      content: sections.join('\n\n'),
      additionalFormats: {
        openapi: {
          format: DocumentFormat.SWAGGER,
          path: 'docs/openapi.yaml',
          content: openApiSpec
        },
        postman: {
          format: DocumentFormat.POSTMAN,
          path: 'docs/postman-collection.json',
          content: await this.generatePostmanCollection(apis)
        }
      }
    };
  }
  
  /**
   * クラスドキュメントを生成
   */
  async generateClassDocumentation(cls) {
    const template = this.templates.get('class');
    
    const content = await template.render({
      name: cls.name,
      description: this.extractDescription(cls.comments),
      extends: cls.extends,
      implements: cls.implements,
      constructor: cls.constructor,
      properties: cls.properties.map(prop => ({
        name: prop.name,
        type: prop.type,
        visibility: prop.visibility || 'public',
        description: prop.description,
        default: prop.default
      })),
      methods: cls.methods.map(method => ({
        name: method.name,
        visibility: method.visibility || 'public',
        parameters: method.params,
        returns: method.returns,
        description: method.description,
        examples: method.examples,
        throws: method.throws
      })),
      examples: cls.examples,
      seeAlso: cls.seeAlso
    });
    
    return {
      type: DocumentationType.CODE,
      format: DocumentFormat.MARKDOWN,
      path: `docs/classes/${cls.name}.md`,
      content,
      metadata: {
        className: cls.name,
        module: cls.module
      }
    };
  }
  
  /**
   * 品質チェックを実行
   */
  async performQualityCheck(documents) {
    const issues = [];
    
    for (const doc of documents) {
      // 完全性チェック
      const completeness = await this.checkCompleteness(doc);
      if (completeness < 0.8) {
        issues.push({
          document: doc.path,
          type: 'completeness',
          score: completeness,
          message: 'Documentation is incomplete'
        });
      }
      
      // スペルチェック
      if (this.options.enableSpellCheck) {
        const spellingErrors = await this.checkSpelling(doc);
        issues.push(...spellingErrors);
      }
      
      // 文法チェック
      if (this.options.enableGrammarCheck) {
        const grammarErrors = await this.checkGrammar(doc);
        issues.push(...grammarErrors);
      }
      
      // リンクチェック
      const brokenLinks = await this.checkLinks(doc);
      issues.push(...brokenLinks);
      
      // コードサンプルの検証
      const codeErrors = await this.validateCodeSamples(doc);
      issues.push(...codeErrors);
    }
    
    // 品質スコアを計算
    this.metrics.qualityScore = this.calculateQualityScore(documents, issues);
    
    // 問題をレポート
    if (issues.length > 0) {
      this.emit('quality:issues', issues);
    }
    
    return issues;
  }
  
  /**
   * ドキュメントを出力
   */
  async outputDocuments(documents) {
    // 出力ディレクトリを作成
    await this.ensureOutputDirectory();
    
    for (const doc of documents) {
      const outputPath = path.join(this.options.outputDirectory, doc.path);
      
      // ディレクトリを作成
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      
      // メインドキュメントを出力
      await this.writeDocument(outputPath, doc);
      
      // 追加フォーマットを出力
      if (doc.additionalFormats) {
        for (const [key, format] of Object.entries(doc.additionalFormats)) {
          const formatPath = path.join(this.options.outputDirectory, format.path);
          await this.writeDocument(formatPath, format);
        }
      }
      
      this.logger.info(`Generated: ${outputPath}`);
    }
    
    // インデックスを生成
    await this.generateIndex(documents);
    
    // 検索用HTMLを生成
    if (this.options.defaultFormat === DocumentFormat.HTML) {
      await this.generateSearchPage();
    }
  }
  
  /**
   * ドキュメントを書き込み
   */
  async writeDocument(outputPath, doc) {
    let content = doc.content;
    
    // フォーマット変換
    if (doc.format !== this.options.defaultFormat) {
      content = await this.convertFormat(content, doc.format, this.options.defaultFormat);
    }
    
    // ポストプロセッシング
    content = await this.postProcess(content, doc);
    
    await fs.writeFile(outputPath, content);
  }
  
  /**
   * 検索インデックスを更新
   */
  async updateSearchIndex(documents) {
    for (const doc of documents) {
      // キーワードを抽出
      const keywords = await this.extractKeywords(doc);
      
      // インデックスに追加
      for (const keyword of keywords) {
        if (!this.searchIndex.has(keyword)) {
          this.searchIndex.set(keyword, []);
        }
        
        this.searchIndex.get(keyword).push({
          document: doc.path,
          title: this.extractTitle(doc),
          snippet: this.extractSnippet(doc, keyword),
          relevance: this.calculateRelevance(doc, keyword)
        });
      }
      
      // タグインデックスを更新
      const tags = await this.extractTags(doc);
      for (const tag of tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, []);
        }
        this.tagIndex.get(tag).push(doc.path);
      }
    }
    
    // インデックスを保存
    await this.saveSearchIndex();
  }
  
  /**
   * テンプレートを読み込み
   */
  async loadTemplates() {
    // READMEテンプレート
    this.templates.set('readme', {
      render: async (data) => {
        return `# ${data.project.name}

${data.description}

## Installation

${data.installation}

## Usage

${data.usage}

## API Reference

${data.api}

## Configuration

${data.configuration}

## Contributing

${data.contributing}

## License

${data.license}
`;
      }
    });
    
    // APIテンプレート
    this.templates.set('api', {
      renderSection: async (data) => {
        let content = `## ${data.resource}\n\n`;
        
        for (const endpoint of data.endpoints) {
          content += `### ${endpoint.method} ${endpoint.path}\n\n`;
          content += `${endpoint.summary}\n\n`;
          
          if (endpoint.description) {
            content += `${endpoint.description}\n\n`;
          }
          
          if (endpoint.parameters?.length > 0) {
            content += '#### Parameters\n\n';
            content += '| Name | Type | Required | Description |\n';
            content += '|------|------|----------|-------------|\n';
            
            for (const param of endpoint.parameters) {
              content += `| ${param.name} | ${param.type} | ${param.required ? 'Yes' : 'No'} | ${param.description} |\n`;
            }
            content += '\n';
          }
          
          if (endpoint.requestBody) {
            content += '#### Request Body\n\n';
            content += '```json\n';
            content += JSON.stringify(endpoint.requestBody.example, null, 2);
            content += '\n```\n\n';
          }
          
          if (endpoint.responses) {
            content += '#### Responses\n\n';
            for (const [code, response] of Object.entries(endpoint.responses)) {
              content += `##### ${code} ${response.description}\n\n`;
              if (response.example) {
                content += '```json\n';
                content += JSON.stringify(response.example, null, 2);
                content += '\n```\n\n';
              }
            }
          }
          
          if (endpoint.examples?.length > 0) {
            content += '#### Examples\n\n';
            for (const example of endpoint.examples) {
              content += `##### ${example.title}\n\n`;
              content += '```' + example.language + '\n';
              content += example.code;
              content += '\n```\n\n';
            }
          }
        }
        
        return content;
      }
    });
    
    // クラステンプレート
    this.templates.set('class', {
      render: async (data) => {
        let content = `# ${data.name}\n\n`;
        
        if (data.description) {
          content += `${data.description}\n\n`;
        }
        
        if (data.extends || data.implements?.length > 0) {
          content += '## Inheritance\n\n';
          if (data.extends) {
            content += `Extends: \`${data.extends}\`\n\n`;
          }
          if (data.implements?.length > 0) {
            content += `Implements: ${data.implements.map(i => `\`${i}\``).join(', ')}\n\n`;
          }
        }
        
        if (data.constructor) {
          content += '## Constructor\n\n';
          content += '```javascript\n';
          content += `new ${data.name}(${data.constructor.params.map(p => p.name).join(', ')})\n`;
          content += '```\n\n';
        }
        
        if (data.properties?.length > 0) {
          content += '## Properties\n\n';
          for (const prop of data.properties) {
            content += `### ${prop.name}\n\n`;
            content += `- Type: \`${prop.type}\`\n`;
            content += `- Visibility: \`${prop.visibility}\`\n`;
            if (prop.default) {
              content += `- Default: \`${prop.default}\`\n`;
            }
            if (prop.description) {
              content += `\n${prop.description}\n`;
            }
            content += '\n';
          }
        }
        
        if (data.methods?.length > 0) {
          content += '## Methods\n\n';
          for (const method of data.methods) {
            content += `### ${method.name}\n\n`;
            
            content += '```javascript\n';
            content += `${method.name}(${method.parameters?.map(p => p.name).join(', ') || ''})\n`;
            content += '```\n\n';
            
            if (method.description) {
              content += `${method.description}\n\n`;
            }
            
            if (method.parameters?.length > 0) {
              content += '#### Parameters\n\n';
              for (const param of method.parameters) {
                content += `- \`${param.name}\` (${param.type}) - ${param.description}\n`;
              }
              content += '\n';
            }
            
            if (method.returns) {
              content += `#### Returns\n\n\`${method.returns}\`\n\n`;
            }
            
            if (method.examples?.length > 0) {
              content += '#### Examples\n\n';
              for (const example of method.examples) {
                content += '```javascript\n';
                content += example;
                content += '\n```\n\n';
              }
            }
          }
        }
        
        return content;
      }
    });
    
    // カスタムテンプレートを読み込み
    for (const [name, template] of Object.entries(this.options.customTemplates)) {
      this.templates.set(name, template);
    }
  }
  
  /**
   * パーサーを初期化
   */
  initializeParsers() {
    // JavaScript/TypeScriptパーサー
    this.initializeJavaScriptParser();
    
    // Pythonパーサー
    if (this.options.parsers.includes('python')) {
      this.initializePythonParser();
    }
    
    // Javaパーサー
    if (this.options.parsers.includes('java')) {
      this.initializeJavaParser();
    }
    
    // Goパーサー
    if (this.options.parsers.includes('go')) {
      this.initializeGoParser();
    }
  }
  
  /**
   * 品質チェッカーを設定
   */
  setupQualityCheckers() {
    // 完全性チェッカー
    this.qualityCheckers.set('completeness', {
      check: async (doc) => {
        const required = ['description', 'parameters', 'returns', 'examples'];
        const found = required.filter(req => doc.content.includes(req));
        return found.length / required.length;
      }
    });
    
    // スペルチェッカー
    this.qualityCheckers.set('spelling', {
      check: async (doc) => {
        // スペルチェックライブラリを使用
        return [];
      }
    });
    
    // リンクチェッカー
    this.qualityCheckers.set('links', {
      check: async (doc) => {
        const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        const issues = [];
        let match;
        
        while ((match = linkRegex.exec(doc.content)) !== null) {
          const url = match[2];
          if (!await this.isValidLink(url)) {
            issues.push({
              type: 'broken-link',
              url,
              line: this.getLineNumber(doc.content, match.index)
            });
          }
        }
        
        return issues;
      }
    });
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    const documentsByType = {};
    for (const doc of this.documents.values()) {
      documentsByType[doc.type] = (documentsByType[doc.type] || 0) + 1;
    }
    
    return {
      metrics: this.metrics,
      documents: {
        total: this.documents.size,
        byType: documentsByType
      },
      quality: {
        score: this.metrics.qualityScore,
        coverage: this.metrics.coverage
      },
      search: {
        indexedTerms: this.searchIndex.size,
        tags: this.tagIndex.size
      }
    };
  }
  
  // ヘルパーメソッド
  detectLanguage(file) {
    const ext = path.extname(file).toLowerCase();
    const languageMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c'
    };
    
    return languageMap[ext] || 'unknown';
  }
  
  shouldIgnoreFile(file) {
    return this.options.ignorePatterns.some(pattern => 
      file.includes(pattern)
    );
  }
  
  async findFiles(pattern) {
    // globパターンでファイルを検索
    const glob = require('glob');
    return new Promise((resolve, reject) => {
      glob(pattern, (err, files) => {
        if (err) reject(err);
        else resolve(files);
      });
    });
  }
  
  getFilePatterns() {
    const patterns = [];
    
    if (this.options.parsers.includes('javascript')) {
      patterns.push('**/*.js', '**/*.jsx');
    }
    if (this.options.parsers.includes('typescript')) {
      patterns.push('**/*.ts', '**/*.tsx');
    }
    if (this.options.parsers.includes('python')) {
      patterns.push('**/*.py');
    }
    if (this.options.parsers.includes('java')) {
      patterns.push('**/*.java');
    }
    
    return patterns;
  }
  
  async extractFileMetadata(file) {
    const stats = await fs.stat(file);
    
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      lines: await this.countLines(file)
    };
  }
  
  async countLines(file) {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').length;
  }
  
  extractModuleName(file) {
    return path.basename(file, path.extname(file));
  }
  
  extractModuleDescription(source) {
    // ファイルの先頭コメントから説明を抽出
    const firstComment = source.parsed.comments[0];
    if (firstComment) {
      return this.extractDescription([firstComment]);
    }
    return '';
  }
  
  extractDescription(comments) {
    if (!comments || comments.length === 0) return '';
    
    const jsdoc = this.parseJSDoc(comments[0]);
    return jsdoc.description.trim();
  }
  
  async extractProjectMetadata() {
    try {
      const packageJson = await fs.readFile('package.json', 'utf-8');
      const pkg = JSON.parse(packageJson);
      
      return {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        author: pkg.author,
        license: pkg.license,
        repository: pkg.repository,
        keywords: pkg.keywords
      };
    } catch (error) {
      return {
        name: 'Unknown Project',
        version: '0.0.0',
        description: ''
      };
    }
  }
  
  async extractDependencies() {
    try {
      const packageJson = await fs.readFile('package.json', 'utf-8');
      const pkg = JSON.parse(packageJson);
      
      return {
        production: pkg.dependencies || {},
        development: pkg.devDependencies || {},
        peer: pkg.peerDependencies || {}
      };
    } catch (error) {
      return {
        production: {},
        development: {},
        peer: {}
      };
    }
  }
  
  async extractConfiguration() {
    // 設定ファイルを検索
    const configFiles = [
      '.env.example',
      'config/default.json',
      'config/production.json',
      'settings.json'
    ];
    
    const configuration = {};
    
    for (const file of configFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        configuration[file] = this.parseConfiguration(content, file);
      } catch (error) {
        // ファイルが存在しない場合はスキップ
      }
    }
    
    return configuration;
  }
  
  parseConfiguration(content, file) {
    if (file.endsWith('.json')) {
      return JSON.parse(content);
    } else if (file.includes('.env')) {
      const config = {};
      const lines = content.split('\n');
      
      for (const line of lines) {
        if (line && !line.startsWith('#')) {
          const [key, value] = line.split('=');
          config[key] = value;
        }
      }
      
      return config;
    }
    
    return content;
  }
  
  async extractMethodsFromClass(cls, source) {
    // ASTからメソッド情報を抽出
    return cls.methods || [];
  }
  
  async extractExamples(func, source) {
    // コメントからサンプルコードを抽出
    const examples = [];
    
    for (const comment of func.comments || []) {
      const jsdoc = this.parseJSDoc(comment);
      const exampleTags = jsdoc.tags.filter(tag => tag.tag === 'example');
      
      for (const tag of exampleTags) {
        examples.push(tag.description.trim());
      }
    }
    
    return examples;
  }
  
  async extractAPIs(source) {
    // Express.jsのAPIエンドポイントを抽出
    const apis = [];
    const routeRegex = /app\.(get|post|put|delete|patch)\s*\(['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = routeRegex.exec(source.content)) !== null) {
      apis.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: source.file,
        // 追加情報は周辺のコメントから抽出
      });
    }
    
    return apis;
  }
  
  groupAPIsByResource(apis) {
    const grouped = new Map();
    
    for (const api of apis) {
      const resource = api.path.split('/')[1] || 'root';
      
      if (!grouped.has(resource)) {
        grouped.set(resource, []);
      }
      
      grouped.get(resource).push(api);
    }
    
    return grouped;
  }
  
  async generateOpenAPISpec(apis) {
    const spec = {
      openapi: '3.0.0',
      info: {
        title: this.metadata.get('project')?.name || 'API',
        version: this.metadata.get('project')?.version || '1.0.0',
        description: this.metadata.get('project')?.description || ''
      },
      paths: {}
    };
    
    for (const api of apis) {
      if (!spec.paths[api.path]) {
        spec.paths[api.path] = {};
      }
      
      spec.paths[api.path][api.method.toLowerCase()] = {
        summary: api.summary,
        description: api.description,
        parameters: api.parameters,
        requestBody: api.requestBody,
        responses: api.responses
      };
    }
    
    return JSON.stringify(spec, null, 2);
  }
  
  async generatePostmanCollection(apis) {
    const collection = {
      info: {
        name: this.metadata.get('project')?.name || 'API Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: []
    };
    
    for (const api of apis) {
      collection.item.push({
        name: `${api.method} ${api.path}`,
        request: {
          method: api.method,
          url: {
            raw: `{{base_url}}${api.path}`,
            host: ['{{base_url}}'],
            path: api.path.split('/').filter(p => p)
          },
          header: api.headers || [],
          body: api.requestBody
        }
      });
    }
    
    return JSON.stringify(collection, null, 2);
  }
  
  shouldGenerateReadme(options) {
    return options.generateReadme !== false;
  }
  
  shouldGenerateDeploymentGuide(options) {
    return options.generateDeployment !== false || 
           this.options.qualityLevel >= QualityLevel.COMPREHENSIVE;
  }
  
  async generateInstallationGuide() {
    const deps = await this.extractDependencies();
    
    let guide = '```bash\n';
    guide += '# Clone the repository\n';
    guide += 'git clone <repository-url>\n';
    guide += 'cd <project-directory>\n\n';
    guide += '# Install dependencies\n';
    guide += 'npm install\n';
    
    if (Object.keys(deps.development).length > 0) {
      guide += '\n# For development\n';
      guide += 'npm install --dev\n';
    }
    
    guide += '```';
    
    return guide;
  }
  
  async generateUsageExamples(metadata) {
    let examples = '';
    
    // 基本的な使用例
    examples += '```javascript\n';
    examples += `const ${metadata.project.name} = require('${metadata.project.name}');\n\n`;
    
    // 主要な関数の例
    for (const func of metadata.functions.slice(0, 3)) {
      if (func.examples?.length > 0) {
        examples += `// ${func.name}\n`;
        examples += func.examples[0] + '\n\n';
      }
    }
    
    examples += '```';
    
    return examples;
  }
  
  generateAPIOverview(apis) {
    if (apis.length === 0) return 'No API endpoints found.';
    
    let overview = 'Available endpoints:\n\n';
    
    for (const api of apis.slice(0, 10)) {
      overview += `- \`${api.method} ${api.path}\` - ${api.summary || 'No description'}\n`;
    }
    
    if (apis.length > 10) {
      overview += `\n...and ${apis.length - 10} more endpoints.`;
    }
    
    return overview;
  }
  
  generateConfigurationGuide(configuration) {
    let guide = '';
    
    for (const [file, config] of Object.entries(configuration)) {
      guide += `### ${file}\n\n`;
      
      if (typeof config === 'object') {
        guide += '```json\n';
        guide += JSON.stringify(config, null, 2);
        guide += '\n```\n\n';
      } else {
        guide += '```\n';
        guide += config;
        guide += '\n```\n\n';
      }
    }
    
    return guide;
  }
  
  async generateContributingGuide() {
    return `Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.`;
  }
  
  async generateArchitectureDocumentation(metadata) {
    const template = this.templates.get('architecture') || this.templates.get('readme');
    
    const content = await template.render({
      title: 'Architecture Overview',
      modules: metadata.modules,
      dependencies: metadata.dependencies,
      patterns: await this.detectArchitecturePatterns(metadata)
    });
    
    return {
      type: DocumentationType.ARCHITECTURE,
      format: DocumentFormat.MARKDOWN,
      path: 'docs/ARCHITECTURE.md',
      content
    };
  }
  
  async generateDeploymentGuide(metadata) {
    const template = this.templates.get('deployment') || this.templates.get('readme');
    
    const content = await template.render({
      title: 'Deployment Guide',
      requirements: await this.extractSystemRequirements(),
      environments: await this.extractEnvironmentConfig(),
      steps: await this.generateDeploymentSteps()
    });
    
    return {
      type: DocumentationType.DEPLOYMENT,
      format: DocumentFormat.MARKDOWN,
      path: 'docs/DEPLOYMENT.md',
      content
    };
  }
  
  async generateChangelog() {
    // Gitコミットから変更履歴を生成
    const commits = await this.getGitCommits();
    const versions = this.groupCommitsByVersion(commits);
    
    let content = '# Changelog\n\n';
    
    for (const [version, versionCommits] of versions) {
      content += `## [${version}] - ${new Date().toISOString().split('T')[0]}\n\n`;
      
      const grouped = this.groupCommitsByType(versionCommits);
      
      for (const [type, typeCommits] of grouped) {
        content += `### ${type}\n\n`;
        
        for (const commit of typeCommits) {
          content += `- ${commit.message} ([${commit.hash.substring(0, 7)}](${commit.url}))\n`;
        }
        
        content += '\n';
      }
    }
    
    return {
      type: DocumentationType.CHANGELOG,
      format: DocumentFormat.MARKDOWN,
      path: 'CHANGELOG.md',
      content
    };
  }
  
  async ensureOutputDirectory() {
    await fs.mkdir(this.options.outputDirectory, { recursive: true });
  }
  
  async generateIndex(documents) {
    let index = '# Documentation Index\n\n';
    
    // タイプ別にグループ化
    const byType = {};
    
    for (const doc of documents) {
      if (!byType[doc.type]) {
        byType[doc.type] = [];
      }
      byType[doc.type].push(doc);
    }
    
    for (const [type, docs] of Object.entries(byType)) {
      index += `## ${type}\n\n`;
      
      for (const doc of docs) {
        const title = this.extractTitle(doc);
        index += `- [${title}](${doc.path})\n`;
      }
      
      index += '\n';
    }
    
    await fs.writeFile(
      path.join(this.options.outputDirectory, 'INDEX.md'),
      index
    );
  }
  
  async generateSearchPage() {
    // 検索用HTMLページを生成
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Documentation Search</title>
  <style>
    /* Styles */
  </style>
</head>
<body>
  <h1>Search Documentation</h1>
  <input type="text" id="search" placeholder="Search...">
  <div id="results"></div>
  <script>
    const searchIndex = ${JSON.stringify(Array.from(this.searchIndex.entries()))};
    // Search implementation
  </script>
</body>
</html>`;
    
    await fs.writeFile(
      path.join(this.options.outputDirectory, 'search.html'),
      html
    );
  }
  
  async convertFormat(content, from, to) {
    // フォーマット変換の実装
    if (from === DocumentFormat.MARKDOWN && to === DocumentFormat.HTML) {
      const marked = require('marked');
      return marked.parse(content);
    }
    
    return content;
  }
  
  async postProcess(content, doc) {
    // ポストプロセッシング
    // - リンクの相対パスを解決
    // - コードハイライトを適用
    // - テーブルオブコンテンツを生成
    
    return content;
  }
  
  async checkCompleteness(doc) {
    const checker = this.qualityCheckers.get('completeness');
    return await checker.check(doc);
  }
  
  async checkSpelling(doc) {
    const checker = this.qualityCheckers.get('spelling');
    return await checker.check(doc);
  }
  
  async checkGrammar(doc) {
    // 文法チェックの実装
    return [];
  }
  
  async checkLinks(doc) {
    const checker = this.qualityCheckers.get('links');
    return await checker.check(doc);
  }
  
  async validateCodeSamples(doc) {
    // コードサンプルの検証
    return [];
  }
  
  calculateQualityScore(documents, issues) {
    const totalPossible = documents.length * 100;
    const deductions = issues.length * 5;
    
    return Math.max(0, (totalPossible - deductions) / totalPossible);
  }
  
  async extractKeywords(doc) {
    // キーワード抽出の実装
    const words = doc.content.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const frequency = {};
    
    for (const word of words) {
      frequency[word] = (frequency[word] || 0) + 1;
    }
    
    // 頻度の高い上位10語
    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
  
  extractTitle(doc) {
    // タイトルを抽出
    const match = doc.content.match(/^#\s+(.+)$/m);
    return match ? match[1] : path.basename(doc.path);
  }
  
  extractSnippet(doc, keyword) {
    // キーワード周辺のスニペットを抽出
    const index = doc.content.toLowerCase().indexOf(keyword.toLowerCase());
    if (index === -1) return '';
    
    const start = Math.max(0, index - 50);
    const end = Math.min(doc.content.length, index + keyword.length + 50);
    
    return '...' + doc.content.substring(start, end) + '...';
  }
  
  calculateRelevance(doc, keyword) {
    // 関連性スコアを計算
    const content = doc.content.toLowerCase();
    const keywordLower = keyword.toLowerCase();
    
    let score = 0;
    
    // タイトルに含まれる
    if (this.extractTitle(doc).toLowerCase().includes(keywordLower)) {
      score += 10;
    }
    
    // 出現頻度
    const matches = content.match(new RegExp(keywordLower, 'g'));
    if (matches) {
      score += Math.min(matches.length, 5);
    }
    
    return score;
  }
  
  async extractTags(doc) {
    // タグを抽出
    const tagRegex = /#([a-zA-Z0-9]+)/g;
    const tags = [];
    let match;
    
    while ((match = tagRegex.exec(doc.content)) !== null) {
      tags.push(match[1]);
    }
    
    return [...new Set(tags)];
  }
  
  async saveSearchIndex() {
    const indexData = {
      terms: Array.from(this.searchIndex.entries()),
      tags: Array.from(this.tagIndex.entries()),
      generated: Date.now()
    };
    
    await fs.writeFile(
      path.join(this.options.outputDirectory, 'search-index.json'),
      JSON.stringify(indexData, null, 2)
    );
  }
  
  async isValidLink(url) {
    // URLの有効性をチェック
    if (url.startsWith('http')) {
      // 外部リンクのチェック
      return true; // 簡略化のためtrueを返す
    } else {
      // 内部リンクのチェック
      const filePath = path.join(this.options.outputDirectory, url);
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }
  }
  
  getLineNumber(content, index) {
    return content.substring(0, index).split('\n').length;
  }
  
  async setupGitIntegration() {
    // Git統合の設定
  }
  
  startAutoGeneration() {
    // ファイル監視を設定
    const chokidar = require('chokidar');
    
    this.watcher = chokidar.watch(this.getFilePatterns(), {
      ignored: this.options.ignorePatterns,
      persistent: true
    });
    
    this.watcher.on('change', async (file) => {
      if (this.options.enableIncrementalUpdate) {
        await this.updateDocumentationForFile(file);
      }
    });
  }
  
  async updateDocumentationForFile(file) {
    // 変更されたファイルのドキュメントを更新
    this.logger.info(`Updating documentation for: ${file}`);
    
    const content = await fs.readFile(file, 'utf-8');
    const parsed = await this.parseFile(file, content);
    
    // 関連ドキュメントを更新
    // ...
  }
  
  async detectArchitecturePatterns(metadata) {
    // アーキテクチャパターンを検出
    const patterns = [];
    
    // MVCパターン
    if (this.detectMVCPattern(metadata)) {
      patterns.push('MVC');
    }
    
    // マイクロサービス
    if (this.detectMicroservices(metadata)) {
      patterns.push('Microservices');
    }
    
    return patterns;
  }
  
  detectMVCPattern(metadata) {
    const hasModels = metadata.modules.some(m => m.file.includes('model'));
    const hasViews = metadata.modules.some(m => m.file.includes('view'));
    const hasControllers = metadata.modules.some(m => m.file.includes('controller'));
    
    return hasModels && hasViews && hasControllers;
  }
  
  detectMicroservices(metadata) {
    // マイクロサービスパターンの検出
    return false;
  }
  
  async extractSystemRequirements() {
    // システム要件を抽出
    return {
      node: '>=14.0.0',
      npm: '>=6.0.0',
      memory: '4GB',
      disk: '10GB'
    };
  }
  
  async extractEnvironmentConfig() {
    // 環境設定を抽出
    return ['development', 'staging', 'production'];
  }
  
  async generateDeploymentSteps() {
    // デプロイメント手順を生成
    return [
      'Install dependencies',
      'Build the project',
      'Run tests',
      'Deploy to server',
      'Verify deployment'
    ];
  }
  
  async getGitCommits() {
    // Gitコミットを取得
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      const { stdout } = await execAsync('git log --format="%H|%s|%an|%ad" --date=short -n 100');
      
      return stdout.trim().split('\n').map(line => {
        const [hash, message, author, date] = line.split('|');
        return { hash, message, author, date };
      });
    } catch (error) {
      return [];
    }
  }
  
  groupCommitsByVersion(commits) {
    // バージョン別にグループ化
    const versions = new Map();
    let currentVersion = '1.0.0';
    
    versions.set(currentVersion, []);
    
    for (const commit of commits) {
      if (commit.message.startsWith('release:')) {
        currentVersion = commit.message.match(/release:\s*(.+)/)?.[1] || currentVersion;
        versions.set(currentVersion, []);
      } else {
        versions.get(currentVersion).push(commit);
      }
    }
    
    return versions;
  }
  
  groupCommitsByType(commits) {
    const types = new Map([
      ['Features', []],
      ['Bug Fixes', []],
      ['Documentation', []],
      ['Performance', []],
      ['Other', []]
    ]);
    
    for (const commit of commits) {
      if (commit.message.startsWith('feat:')) {
        types.get('Features').push(commit);
      } else if (commit.message.startsWith('fix:')) {
        types.get('Bug Fixes').push(commit);
      } else if (commit.message.startsWith('docs:')) {
        types.get('Documentation').push(commit);
      } else if (commit.message.startsWith('perf:')) {
        types.get('Performance').push(commit);
      } else {
        types.get('Other').push(commit);
      }
    }
    
    return types;
  }
  
  // Pythonパーサーの初期化
  initializePythonParser() {
    // Python ASTパーサーの実装
  }
  
  // Javaパーサーの初期化  
  initializeJavaParser() {
    // Javaパーサーの実装
  }
  
  // Goパーサーの初期化
  initializeGoParser() {
    // Goパーサーの実装
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.watcher) {
      await this.watcher.close();
    }
  }
}

export default AutoDocumentationSystem;