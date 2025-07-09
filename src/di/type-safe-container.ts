// Type-safe dependency injection container
// Following the principle: "Program to interfaces, not implementations"

import { 
  assertDefined, 
  isFunction, 
  isPresent,
  Result,
  ok,
  err
} from '../types/guards';

/**
 * Service identifier types
 */
export type ServiceIdentifier<T> = string | symbol | { new(...args: any[]): T };

/**
 * Factory function for creating services
 */
export type Factory<T> = (container: TypeSafeContainer) => T | Promise<T>;

/**
 * Service registration options
 */
export interface ServiceOptions {
  singleton?: boolean;
  eager?: boolean;
  dispose?: () => void | Promise<void>;
}

/**
 * Service metadata
 */
interface ServiceMetadata<T> {
  factory: Factory<T>;
  options: ServiceOptions;
  instance?: T;
  creating?: Promise<T>;
}

/**
 * Type-safe dependency injection container
 */
export class TypeSafeContainer {
  private services = new Map<ServiceIdentifier<any>, ServiceMetadata<any>>();
  private aliases = new Map<string | symbol, ServiceIdentifier<any>>();
  private disposed = false;

  /**
   * Register a service
   */
  register<T>(
    identifier: ServiceIdentifier<T>,
    factoryOrInstance: T | Factory<T>,
    options: ServiceOptions = {}
  ): this {
    this.assertNotDisposed();

    const factory: Factory<T> = isFunction(factoryOrInstance)
      ? factoryOrInstance as Factory<T>
      : () => factoryOrInstance;

    const metadata: ServiceMetadata<T> = {
      factory,
      options: { singleton: true, ...options },
      instance: !isFunction(factoryOrInstance) ? factoryOrInstance : undefined
    };

    this.services.set(identifier, metadata);

    // Eager instantiation if requested
    if (options.eager && metadata.instance === undefined) {
      this.resolve(identifier).catch(error => {
        console.error(`Failed to eagerly instantiate service ${String(identifier)}:`, error);
      });
    }

    return this;
  }

  /**
   * Register a singleton service
   */
  singleton<T>(
    identifier: ServiceIdentifier<T>,
    factory: Factory<T>,
    options: Omit<ServiceOptions, 'singleton'> = {}
  ): this {
    return this.register(identifier, factory, { ...options, singleton: true });
  }

  /**
   * Register a transient service
   */
  transient<T>(
    identifier: ServiceIdentifier<T>,
    factory: Factory<T>,
    options: Omit<ServiceOptions, 'singleton'> = {}
  ): this {
    return this.register(identifier, factory, { ...options, singleton: false });
  }

  /**
   * Register an alias
   */
  alias<T>(alias: string | symbol, identifier: ServiceIdentifier<T>): this {
    this.assertNotDisposed();
    this.aliases.set(alias, identifier);
    return this;
  }

  /**
   * Check if a service is registered
   */
  has<T>(identifier: ServiceIdentifier<T>): boolean {
    return this.services.has(this.resolveAlias(identifier));
  }

  /**
   * Get a service (returns undefined if not found)
   */
  get<T>(identifier: ServiceIdentifier<T>): T | undefined {
    try {
      return this.resolve(identifier);
    } catch {
      return undefined;
    }
  }

  /**
   * Get a service (throws if not found)
   */
  resolve<T>(identifier: ServiceIdentifier<T>): T {
    this.assertNotDisposed();

    const actualIdentifier = this.resolveAlias(identifier);
    const metadata = this.services.get(actualIdentifier);

    if (!metadata) {
      throw new Error(`Service not found: ${String(identifier)}`);
    }

    // Return existing instance for singletons
    if (metadata.options.singleton && metadata.instance !== undefined) {
      return metadata.instance;
    }

    // Handle concurrent creation for singletons
    if (metadata.options.singleton && metadata.creating) {
      throw new Error(`Circular dependency detected for service: ${String(identifier)}`);
    }

    // Create new instance
    const instance = this.createInstance(metadata, actualIdentifier);

    // Store singleton instance
    if (metadata.options.singleton) {
      metadata.instance = instance;
    }

    return instance;
  }

  /**
   * Resolve a service asynchronously
   */
  async resolveAsync<T>(identifier: ServiceIdentifier<T>): Promise<T> {
    this.assertNotDisposed();

    const actualIdentifier = this.resolveAlias(identifier);
    const metadata = this.services.get(actualIdentifier);

    if (!metadata) {
      throw new Error(`Service not found: ${String(identifier)}`);
    }

    // Return existing instance for singletons
    if (metadata.options.singleton && metadata.instance !== undefined) {
      return metadata.instance;
    }

    // Handle concurrent creation for singletons
    if (metadata.options.singleton && metadata.creating) {
      return metadata.creating;
    }

    // Create new instance
    const createPromise = this.createInstanceAsync(metadata, actualIdentifier);

    // Track creation for singletons
    if (metadata.options.singleton) {
      metadata.creating = createPromise;
    }

    try {
      const instance = await createPromise;

      // Store singleton instance
      if (metadata.options.singleton) {
        metadata.instance = instance;
        metadata.creating = undefined;
      }

      return instance;
    } catch (error) {
      // Clean up on error
      if (metadata.options.singleton) {
        metadata.creating = undefined;
      }
      throw error;
    }
  }

  /**
   * Try to resolve a service
   */
  tryResolve<T>(identifier: ServiceIdentifier<T>): Result<T> {
    try {
      return ok(this.resolve(identifier));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Try to resolve a service asynchronously
   */
  async tryResolveAsync<T>(identifier: ServiceIdentifier<T>): Promise<Result<T>> {
    try {
      return ok(await this.resolveAsync(identifier));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Resolve multiple services
   */
  resolveMany<T extends readonly ServiceIdentifier<any>[]>(
    ...identifiers: T
  ): { [K in keyof T]: T[K] extends ServiceIdentifier<infer U> ? U : never } {
    return identifiers.map(id => this.resolve(id)) as any;
  }

  /**
   * Resolve multiple services asynchronously
   */
  async resolveManyAsync<T extends readonly ServiceIdentifier<any>[]>(
    ...identifiers: T
  ): Promise<{ [K in keyof T]: T[K] extends ServiceIdentifier<infer U> ? U : never }> {
    const promises = identifiers.map(id => this.resolveAsync(id));
    return Promise.all(promises) as any;
  }

  /**
   * Get all registered services
   */
  getAll(): Map<ServiceIdentifier<any>, any> {
    const result = new Map<ServiceIdentifier<any>, any>();

    for (const [identifier, metadata] of this.services) {
      if (metadata.instance !== undefined) {
        result.set(identifier, metadata.instance);
      }
    }

    return result;
  }

  /**
   * Clear all services
   */
  clear(): void {
    this.services.clear();
    this.aliases.clear();
  }

  /**
   * Dispose of the container and all services
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    // Dispose services in reverse registration order
    const services = Array.from(this.services.entries()).reverse();

    for (const [_, metadata] of services) {
      if (metadata.instance && metadata.options.dispose) {
        try {
          await metadata.options.dispose();
        } catch (error) {
          console.error('Error disposing service:', error);
        }
      }
    }

    this.clear();
  }

  /**
   * Create a child container
   */
  createChild(): TypeSafeContainer {
    const child = new TypeSafeContainer();

    // Copy all registrations (but not instances)
    for (const [identifier, metadata] of this.services) {
      child.services.set(identifier, {
        factory: metadata.factory,
        options: metadata.options,
        // Don't copy instances or creating promises
      });
    }

    // Copy aliases
    for (const [alias, identifier] of this.aliases) {
      child.aliases.set(alias, identifier);
    }

    return child;
  }

  /**
   * Create a service instance
   */
  private createInstance<T>(
    metadata: ServiceMetadata<T>,
    identifier: ServiceIdentifier<T>
  ): T {
    try {
      const result = metadata.factory(this);
      
      if (result instanceof Promise) {
        throw new Error(
          `Service ${String(identifier)} returns a Promise. Use resolveAsync() instead.`
        );
      }

      return result;
    } catch (error) {
      throw new Error(
        `Failed to create service ${String(identifier)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Create a service instance asynchronously
   */
  private async createInstanceAsync<T>(
    metadata: ServiceMetadata<T>,
    identifier: ServiceIdentifier<T>
  ): Promise<T> {
    try {
      return await metadata.factory(this);
    } catch (error) {
      throw new Error(
        `Failed to create service ${String(identifier)}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Resolve an alias
   */
  private resolveAlias<T>(identifier: ServiceIdentifier<T>): ServiceIdentifier<T> {
    if (typeof identifier === 'string' || typeof identifier === 'symbol') {
      return this.aliases.get(identifier) || identifier;
    }
    return identifier;
  }

  /**
   * Assert container is not disposed
   */
  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Container has been disposed');
    }
  }
}

/**
 * Service decorator for automatic registration
 */
export function Service<T>(
  identifier?: ServiceIdentifier<T>,
  options?: ServiceOptions
): ClassDecorator {
  return (target: any) => {
    const id = identifier || target;
    
    // Store metadata on the class
    Reflect.defineMetadata('di:service:id', id, target);
    Reflect.defineMetadata('di:service:options', options || {}, target);
  };
}

/**
 * Inject decorator for constructor parameters
 */
export function Inject<T>(identifier: ServiceIdentifier<T>): ParameterDecorator {
  return (target: any, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const existingTokens = Reflect.getMetadata('di:inject:tokens', target) || [];
    existingTokens[parameterIndex] = identifier;
    Reflect.defineMetadata('di:inject:tokens', existingTokens, target);
  };
}

/**
 * Auto-wiring container that supports decorators
 */
export class AutoWiringContainer extends TypeSafeContainer {
  /**
   * Register a class with automatic dependency injection
   */
  registerClass<T>(
    ClassConstructor: new (...args: any[]) => T,
    options?: ServiceOptions
  ): this {
    const serviceId = Reflect.getMetadata('di:service:id', ClassConstructor) || ClassConstructor;
    const serviceOptions = Reflect.getMetadata('di:service:options', ClassConstructor) || options || {};
    
    return this.register(serviceId, (container) => {
      const tokens = Reflect.getMetadata('di:inject:tokens', ClassConstructor) || [];
      const paramTypes = Reflect.getMetadata('design:paramtypes', ClassConstructor) || [];
      
      const args = paramTypes.map((type: any, index: number) => {
        const token = tokens[index] || type;
        return container.resolve(token);
      });
      
      return new ClassConstructor(...args);
    }, serviceOptions);
  }
}
