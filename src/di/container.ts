/**
 * 依存性注入システム - 軽量DIコンテナ
 * テスタビリティとコードの保守性向上
 */

export enum ServiceLifetime {
  SINGLETON = 'singleton',    // インスタンスは1つのみ
  TRANSIENT = 'transient',    // 毎回新しいインスタンス
  SCOPED = 'scoped'          // スコープ内で1つのインスタンス
}

export interface ServiceDescriptor<T = any> {
  token: string | symbol;
  implementation?: new (...args: any[]) => T;
  factory?: (container: Container) => T;
  instance?: T;
  lifetime: ServiceLifetime;
  dependencies?: (string | symbol)[];
}

interface ServiceInstance<T = any> {
  value: T;
  lifetime: ServiceLifetime;
  created: Date;
  accessCount: number;
}

export class Container {
  private services = new Map<string | symbol, ServiceDescriptor>();
  private instances = new Map<string | symbol, ServiceInstance>();
  private resolving = new Set<string | symbol>(); // 循環依存検出用
  private scopes = new Map<string, Map<string | symbol, any>>();
  private stats = {
    registrations: 0,
    resolutions: 0,
    singletonHits: 0,
    factoryCallsCount: 0,
    circularDependencies: 0
  };

  /**
   * サービスを登録
   */
  public register<T>(
    token: string | symbol,
    implementation: new (...args: any[]) => T,
    lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT,
    dependencies: (string | symbol)[] = []
  ): this {
    this.services.set(token, {
      token,
      implementation,
      lifetime,
      dependencies
    });
    this.stats.registrations++;
    return this;
  }

  /**
   * ファクトリーでサービスを登録
   */
  public registerFactory<T>(
    token: string | symbol,
    factory: (container: Container) => T,
    lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT
  ): this {
    this.services.set(token, {
      token,
      factory,
      lifetime
    });
    this.stats.registrations++;
    return this;
  }

  /**
   * インスタンスを直接登録（Singleton）
   */
  public registerInstance<T>(token: string | symbol, instance: T): this {
    this.services.set(token, {
      token,
      instance,
      lifetime: ServiceLifetime.SINGLETON
    });
    
    this.instances.set(token, {
      value: instance,
      lifetime: ServiceLifetime.SINGLETON,
      created: new Date(),
      accessCount: 0
    });
    
    this.stats.registrations++;
    return this;
  }

  /**
   * サービスを解決
   */
  public resolve<T>(token: string | symbol, scopeId?: string): T {
    this.stats.resolutions++;

    // 循環依存チェック
    if (this.resolving.has(token)) {
      this.stats.circularDependencies++;
      throw new Error(`Circular dependency detected for token: ${String(token)}`);
    }

    const service = this.services.get(token);
    if (!service) {
      throw new Error(`Service not registered for token: ${String(token)}`);
    }

    // インスタンスが直接登録されている場合
    if (service.instance !== undefined) {
      this.updateAccessCount(token);
      return service.instance;
    }

    // Singletonの場合、既存インスタンスをチェック
    if (service.lifetime === ServiceLifetime.SINGLETON) {
      const existing = this.instances.get(token);
      if (existing) {
        existing.accessCount++;
        this.stats.singletonHits++;
        return existing.value;
      }
    }

    // Scopedの場合、スコープ内の既存インスタンスをチェック
    if (service.lifetime === ServiceLifetime.SCOPED && scopeId) {
      const scope = this.scopes.get(scopeId);
      if (scope && scope.has(token)) {
        this.updateAccessCount(token);
        return scope.get(token);
      }
    }

    // 新しいインスタンスを作成
    this.resolving.add(token);
    
    try {
      let instance: T;

      if (service.factory) {
        // ファクトリーで作成
        instance = service.factory(this);
        this.stats.factoryCallsCount++;
      } else if (service.implementation) {
        // コンストラクターで作成
        const dependencies = this.resolveDependencies(service.dependencies || [], scopeId);
        instance = new service.implementation(...dependencies);
      } else {
        throw new Error(`No implementation or factory provided for token: ${String(token)}`);
      }

      // インスタンスを保存（ライフタイムに応じて）
      this.storeInstance(token, instance, service.lifetime, scopeId);

      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * 依存関係を解決
   */
  private resolveDependencies(dependencies: (string | symbol)[], scopeId?: string): any[] {
    return dependencies.map(dep => this.resolve(dep, scopeId));
  }

  /**
   * インスタンスを保存
   */
  private storeInstance<T>(
    token: string | symbol,
    instance: T,
    lifetime: ServiceLifetime,
    scopeId?: string
  ): void {
    const serviceInstance: ServiceInstance<T> = {
      value: instance,
      lifetime,
      created: new Date(),
      accessCount: 1
    };

    if (lifetime === ServiceLifetime.SINGLETON) {
      this.instances.set(token, serviceInstance);
    } else if (lifetime === ServiceLifetime.SCOPED && scopeId) {
      if (!this.scopes.has(scopeId)) {
        this.scopes.set(scopeId, new Map());
      }
      this.scopes.get(scopeId)!.set(token, instance);
    }
  }

  /**
   * アクセス回数を更新
   */
  private updateAccessCount(token: string | symbol): void {
    const instance = this.instances.get(token);
    if (instance) {
      instance.accessCount++;
    }
  }

  /**
   * サービスが登録されているかチェック
   */
  public isRegistered(token: string | symbol): boolean {
    return this.services.has(token);
  }

  /**
   * スコープを作成
   */
  public createScope(scopeId: string): this {
    if (!this.scopes.has(scopeId)) {
      this.scopes.set(scopeId, new Map());
    }
    return this;
  }

  /**
   * スコープを削除
   */
  public destroyScope(scopeId: string): this {
    this.scopes.delete(scopeId);
    return this;
  }

  /**
   * 登録されているサービス一覧を取得
   */
  public getRegisteredServices(): Array<{
    token: string | symbol;
    lifetime: ServiceLifetime;
    hasInstance: boolean;
    accessCount: number;
  }> {
    const services: Array<{
      token: string | symbol;
      lifetime: ServiceLifetime;
      hasInstance: boolean;
      accessCount: number;
    }> = [];

    for (const [token, service] of this.services) {
      const instance = this.instances.get(token);
      services.push({
        token,
        lifetime: service.lifetime,
        hasInstance: instance !== undefined || service.instance !== undefined,
        accessCount: instance?.accessCount || 0
      });
    }

    return services;
  }

  /**
   * 統計情報を取得
   */
  public getStats() {
    return {
      ...this.stats,
      servicesCount: this.services.size,
      instancesCount: this.instances.size,
      scopesCount: this.scopes.size,
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  /**
   * メモリ使用量の推定
   */
  private estimateMemoryUsage(): number {
    // 簡易的な推定（バイト）
    let size = 0;
    size += this.services.size * 100; // サービス記述子
    size += this.instances.size * 50;  // インスタンス参照
    
    for (const scope of this.scopes.values()) {
      size += scope.size * 50;
    }
    
    return size;
  }

  /**
   * Singletonインスタンスをクリア
   */
  public clearSingletons(): this {
    for (const [token, instance] of this.instances) {
      if (instance.lifetime === ServiceLifetime.SINGLETON) {
        this.instances.delete(token);
      }
    }
    return this;
  }

  /**
   * 全てクリア
   */
  public clear(): this {
    this.services.clear();
    this.instances.clear();
    this.scopes.clear();
    this.resolving.clear();
    
    this.stats = {
      registrations: 0,
      resolutions: 0,
      singletonHits: 0,
      factoryCallsCount: 0,
      circularDependencies: 0
    };
    
    return this;
  }

  /**
   * デバッグ情報
   */
  public debug(): void {
    console.log('=== DI Container Debug Info ===');
    console.log('Services:', this.services.size);
    console.log('Instances:', this.instances.size);
    console.log('Scopes:', this.scopes.size);
    console.log('Stats:', this.stats);
    
    console.log('\nRegistered Services:');
    for (const service of this.getRegisteredServices()) {
      console.log(`  ${String(service.token)}: ${service.lifetime} (accessed: ${service.accessCount})`);
    }
  }
}

// サービストークン用シンボル
export const SERVICE_TOKENS = {
  LOGGER: Symbol('Logger'),
  DATABASE: Symbol('Database'),
  CONFIG: Symbol('Config'),
  CACHE: Symbol('Cache'),
  STRATUM_SERVER: Symbol('StratumServer'),
  MINER_MANAGER: Symbol('MinerManager'),
  SHARE_VALIDATOR: Symbol('ShareValidator'),
  PAYOUT_MANAGER: Symbol('PayoutManager'),
  SECURITY_MANAGER: Symbol('SecurityManager'),
  MONITORING: Symbol('Monitoring')
} as const;

// デコレーター（実験的）
export function Injectable(token?: string | symbol) {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    if (token) {
      Reflect.defineMetadata('di:token', token, constructor);
    }
    return constructor;
  };
}

export function Inject(token: string | symbol) {
  return function (target: any, propertyKey: string | symbol | undefined, parameterIndex: number) {
    const existingTokens = Reflect.getMetadata('di:dependencies', target) || [];
    existingTokens[parameterIndex] = token;
    Reflect.defineMetadata('di:dependencies', existingTokens, target);
  };
}

// グローバルコンテナ
export const globalContainer = new Container();

// ヘルパー関数
export function registerService<T>(
  token: string | symbol,
  implementation: new (...args: any[]) => T,
  lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT,
  dependencies: (string | symbol)[] = []
): void {
  globalContainer.register(token, implementation, lifetime, dependencies);
}

export function resolve<T>(token: string | symbol): T {
  return globalContainer.resolve<T>(token);
}

export default Container;