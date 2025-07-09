/**
 * Service Mesh Manager - Istio Integration System
 * 
 * Design Philosophy:
 * - Carmack: Lightweight proxy, minimal overhead
 * - Martin: Clear service definitions and contracts
 * - Pike: Simple configuration, transparent operation
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { UnifiedLogger } from '../logging/unified-logger';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ServiceDefinition {
  name: string;
  version: string;
  port: number;
  protocol: 'http' | 'tcp' | 'grpc';
  health?: string; // Health check endpoint
  metrics?: string; // Metrics endpoint
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface TrafficPolicy {
  serviceName: string;
  loadBalancer?: {
    simple?: 'ROUND_ROBIN' | 'LEAST_CONN' | 'RANDOM' | 'PASSTHROUGH';
    consistentHash?: {
      httpHeader?: string;
      httpCookie?: { name: string; ttl?: string };
    };
  };
  circuitBreaker?: {
    consecutiveErrors?: number;
    interval?: string;
    baseEjectionTime?: string;
    maxEjectionPercent?: number;
  };
  timeout?: string;
  retryPolicy?: {
    attempts?: number;
    perTryTimeout?: string;
    retryOn?: string;
  };
}

export interface SecurityPolicy {
  serviceName: string;
  authentication?: {
    mtls?: {
      mode: 'STRICT' | 'PERMISSIVE' | 'DISABLE';
    };
    jwt?: {
      issuer: string;
      audiences: string[];
      jwksUri?: string;
    };
  };
  authorization?: {
    rules: Array<{
      from?: Array<{ source: { principals?: string[] } }>;
      to?: Array<{ operation: { methods?: string[]; paths?: string[] } }>;
      when?: Array<{ key: string; values: string[] }>;
    }>;
  };
}

export interface IstioResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: any;
}

export class ServiceMeshManager extends EventEmitter {
  private services: Map<string, ServiceDefinition> = new Map();
  private trafficPolicies: Map<string, TrafficPolicy> = new Map();
  private securityPolicies: Map<string, SecurityPolicy> = new Map();
  private meshInstalled = false;
  private gatewayConfigured = false;
  private resourcesPath: string;

  constructor(
    private config: {
      namespace?: string;
      gatewayName?: string;
      resourcesPath?: string;
      autoInstall?: boolean;
      enableTracing?: boolean;
      enableMetrics?: boolean;
    } = {},
    private logger: UnifiedLogger
  ) {
    super();
    this.config = {
      namespace: 'default',
      gatewayName: 'otedama-gateway',
      resourcesPath: './k8s/istio',
      autoInstall: false,
      enableTracing: true,
      enableMetrics: true,
      ...config
    };
    this.resourcesPath = this.config.resourcesPath!;
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Service Mesh Manager...');
    
    try {
      // Check if Istio is installed
      await this.checkIstioInstallation();
      
      // Create resources directory
      await this.ensureResourcesDirectory();
      
      // Configure basic mesh components
      if (this.meshInstalled) {
        await this.configureGateway();
        await this.configureDefaultPolicies();
      }
      
      this.logger.info('Service Mesh Manager started');
    } catch (error) {
      this.logger.error('Error starting Service Mesh Manager:', error);
      if (this.config.autoInstall) {
        await this.installIstio();
      } else {
        this.logger.warn('Istio not available - some features will be disabled');
      }
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Service Mesh Manager...');
    // Cleanup would go here if needed
    this.logger.info('Service Mesh Manager stopped');
  }

  public async registerService(service: ServiceDefinition): Promise<void> {
    this.services.set(service.name, service);
    
    if (this.meshInstalled) {
      await this.createServiceResources(service);
      await this.applyVirtualService(service);
      
      this.emit('serviceRegistered', service);
      this.logger.info(`Registered service with mesh: ${service.name}`);
    } else {
      this.logger.warn(`Service registered but mesh not available: ${service.name}`);
    }
  }

  public async unregisterService(serviceName: string): Promise<void> {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    if (this.meshInstalled) {
      await this.deleteServiceResources(serviceName);
    }

    this.services.delete(serviceName);
    this.trafficPolicies.delete(serviceName);
    this.securityPolicies.delete(serviceName);

    this.emit('serviceUnregistered', service);
    this.logger.info(`Unregistered service: ${serviceName}`);
  }

  public async setTrafficPolicy(policy: TrafficPolicy): Promise<void> {
    this.trafficPolicies.set(policy.serviceName, policy);
    
    if (this.meshInstalled) {
      await this.applyDestinationRule(policy);
      this.emit('trafficPolicyApplied', policy);
      this.logger.info(`Applied traffic policy for service: ${policy.serviceName}`);
    }
  }

  public async setSecurityPolicy(policy: SecurityPolicy): Promise<void> {
    this.securityPolicies.set(policy.serviceName, policy);
    
    if (this.meshInstalled) {
      await this.applyPeerAuthentication(policy);
      await this.applyAuthorizationPolicy(policy);
      this.emit('securityPolicyApplied', policy);
      this.logger.info(`Applied security policy for service: ${policy.serviceName}`);
    }
  }

  public async getMeshStatus(): Promise<{
    installed: boolean;
    version?: string;
    components: Record<string, boolean>;
    services: string[];
    gateways: string[];
  }> {
    const status = {
      installed: this.meshInstalled,
      components: {} as Record<string, boolean>,
      services: Array.from(this.services.keys()),
      gateways: [] as string[]
    };

    if (this.meshInstalled) {
      try {
        // Check Istio components
        const components = ['istiod', 'istio-proxy', 'istio-ingressgateway'];
        for (const component of components) {
          try {
            execSync(`kubectl get pods -l app=${component} -o name`, { stdio: 'pipe' });
            status.components[component] = true;
          } catch {
            status.components[component] = false;
          }
        }

        // Get version
        try {
          const versionOutput = execSync('istioctl version --short', { encoding: 'utf8' });
          status.version = versionOutput.trim();
        } catch {
          status.version = 'unknown';
        }

        // Get gateways
        try {
          const gatewaysOutput = execSync(`kubectl get gateways -n ${this.config.namespace} -o name`, { encoding: 'utf8' });
          status.gateways = gatewaysOutput.trim().split('\n').filter(Boolean);
        } catch {
          status.gateways = [];
        }

      } catch (error) {
        this.logger.error('Error getting mesh status:', error);
      }
    }

    return status;
  }

  public async getServiceMetrics(serviceName: string): Promise<{
    requestRate: number;
    errorRate: number;
    latencyP50: number;
    latencyP90: number;
    latencyP99: number;
  }> {
    // In a real implementation, this would query Prometheus/Grafana
    // For now, return mock data
    return {
      requestRate: Math.random() * 1000,
      errorRate: Math.random() * 5,
      latencyP50: Math.random() * 100,
      latencyP90: Math.random() * 200,
      latencyP99: Math.random() * 500
    };
  }

  public async enableTracing(serviceName: string): Promise<void> {
    if (!this.meshInstalled) {
      throw new Error('Service mesh not installed');
    }

    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    // Add tracing annotations
    const tracingConfig = {
      'sidecar.istio.io/inject': 'true',
      'sidecar.istio.io/proxyCPU': '100m',
      'sidecar.istio.io/proxyMemory': '128Mi'
    };

    service.annotations = { ...service.annotations, ...tracingConfig };
    await this.updateServiceConfiguration(service);

    this.logger.info(`Enabled tracing for service: ${serviceName}`);
  }

  private async checkIstioInstallation(): Promise<void> {
    try {
      execSync('istioctl version', { stdio: 'pipe' });
      execSync('kubectl get namespace istio-system', { stdio: 'pipe' });
      this.meshInstalled = true;
      this.logger.info('Istio installation detected');
    } catch (error) {
      this.meshInstalled = false;
      this.logger.warn('Istio not detected');
    }
  }

  private async installIstio(): Promise<void> {
    this.logger.info('Installing Istio...');
    
    try {
      // Install Istio with minimal profile
      execSync('istioctl install --set values.defaultRevision=default -y', { stdio: 'inherit' });
      
      // Enable sidecar injection for default namespace
      execSync(`kubectl label namespace ${this.config.namespace} istio-injection=enabled --overwrite`, { stdio: 'inherit' });
      
      this.meshInstalled = true;
      this.logger.info('Istio installation completed');
      
    } catch (error) {
      this.logger.error('Failed to install Istio:', error);
      throw error;
    }
  }

  private async ensureResourcesDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.resourcesPath, { recursive: true });
    } catch (error) {
      this.logger.error('Error creating resources directory:', error);
    }
  }

  private async configureGateway(): Promise<void> {
    if (this.gatewayConfigured) return;

    const gateway: IstioResource = {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'Gateway',
      metadata: {
        name: this.config.gatewayName!,
        namespace: this.config.namespace!
      },
      spec: {
        selector: {
          istio: 'ingressgateway'
        },
        servers: [
          {
            port: {
              number: 80,
              name: 'http',
              protocol: 'HTTP'
            },
            hosts: ['*']
          },
          {
            port: {
              number: 443,
              name: 'https',
              protocol: 'HTTPS'
            },
            hosts: ['*'],
            tls: {
              mode: 'SIMPLE',
              credentialName: 'otedama-tls-secret'
            }
          }
        ]
      }
    };

    await this.applyResource(gateway);
    this.gatewayConfigured = true;
    this.logger.info('Gateway configured');
  }

  private async configureDefaultPolicies(): Promise<void> {
    // Default peer authentication (enable mTLS)
    const peerAuth: IstioResource = {
      apiVersion: 'security.istio.io/v1beta1',
      kind: 'PeerAuthentication',
      metadata: {
        name: 'default',
        namespace: this.config.namespace!
      },
      spec: {
        mtls: {
          mode: 'PERMISSIVE' // Allow both mTLS and plain text
        }
      }
    };

    await this.applyResource(peerAuth);
    this.logger.info('Default security policies configured');
  }

  private async createServiceResources(service: ServiceDefinition): Promise<void> {
    // Create Kubernetes Service
    const k8sService: IstioResource = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: service.name,
        namespace: this.config.namespace!,
        labels: service.labels
      },
      spec: {
        selector: { app: service.name },
        ports: [
          {
            name: service.protocol,
            port: service.port,
            targetPort: service.port,
            protocol: service.protocol.toUpperCase()
          }
        ]
      }
    };

    await this.applyResource(k8sService);
  }

  private async applyVirtualService(service: ServiceDefinition): Promise<void> {
    const virtualService: IstioResource = {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'VirtualService',
      metadata: {
        name: service.name,
        namespace: this.config.namespace!
      },
      spec: {
        hosts: [service.name],
        gateways: [this.config.gatewayName],
        http: [
          {
            match: [{ uri: { prefix: `/${service.name}/` } }],
            route: [{ destination: { host: service.name, port: { number: service.port } } }],
            timeout: '30s',
            retries: {
              attempts: 3,
              perTryTimeout: '10s'
            }
          }
        ]
      }
    };

    await this.applyResource(virtualService);
  }

  private async applyDestinationRule(policy: TrafficPolicy): Promise<void> {
    const destinationRule: IstioResource = {
      apiVersion: 'networking.istio.io/v1alpha3',
      kind: 'DestinationRule',
      metadata: {
        name: policy.serviceName,
        namespace: this.config.namespace!
      },
      spec: {
        host: policy.serviceName,
        trafficPolicy: {
          loadBalancer: policy.loadBalancer,
          connectionPool: {
            tcp: {
              maxConnections: 100
            },
            http: {
              http1MaxPendingRequests: 100,
              maxRequestsPerConnection: 2
            }
          },
          outlierDetection: policy.circuitBreaker
        }
      }
    };

    await this.applyResource(destinationRule);
  }

  private async applyPeerAuthentication(policy: SecurityPolicy): Promise<void> {
    if (!policy.authentication?.mtls) return;

    const peerAuth: IstioResource = {
      apiVersion: 'security.istio.io/v1beta1',
      kind: 'PeerAuthentication',
      metadata: {
        name: policy.serviceName,
        namespace: this.config.namespace!
      },
      spec: {
        selector: {
          matchLabels: { app: policy.serviceName }
        },
        mtls: policy.authentication.mtls
      }
    };

    await this.applyResource(peerAuth);
  }

  private async applyAuthorizationPolicy(policy: SecurityPolicy): Promise<void> {
    if (!policy.authorization) return;

    const authzPolicy: IstioResource = {
      apiVersion: 'security.istio.io/v1beta1',
      kind: 'AuthorizationPolicy',
      metadata: {
        name: policy.serviceName,
        namespace: this.config.namespace!
      },
      spec: {
        selector: {
          matchLabels: { app: policy.serviceName }
        },
        rules: policy.authorization.rules
      }
    };

    await this.applyResource(authzPolicy);
  }

  private async applyResource(resource: IstioResource): Promise<void> {
    const fileName = `${resource.metadata.name}-${resource.kind.toLowerCase()}.yaml`;
    const filePath = path.join(this.resourcesPath, fileName);
    
    try {
      const yamlContent = this.toYaml(resource);
      await fs.writeFile(filePath, yamlContent);
      
      if (this.meshInstalled) {
        execSync(`kubectl apply -f ${filePath}`, { stdio: 'pipe' });
        this.logger.debug(`Applied resource: ${fileName}`);
      }
    } catch (error) {
      this.logger.error(`Error applying resource ${fileName}:`, error);
      throw error;
    }
  }

  private async deleteServiceResources(serviceName: string): Promise<void> {
    try {
      if (this.meshInstalled) {
        execSync(`kubectl delete virtualservice ${serviceName} -n ${this.config.namespace}`, { stdio: 'pipe' });
        execSync(`kubectl delete destinationrule ${serviceName} -n ${this.config.namespace}`, { stdio: 'pipe' });
        execSync(`kubectl delete service ${serviceName} -n ${this.config.namespace}`, { stdio: 'pipe' });
      }
    } catch (error) {
      this.logger.warn(`Error deleting resources for ${serviceName}:`, error);
    }
  }

  private async updateServiceConfiguration(service: ServiceDefinition): Promise<void> {
    // Update service configuration
    await this.createServiceResources(service);
    this.logger.info(`Updated configuration for service: ${service.name}`);
  }

  private toYaml(obj: any): string {
    // Simple YAML serialization (in production, use a proper YAML library)
    return JSON.stringify(obj, null, 2)
      .replace(/"/g, '')
      .replace(/,$/gm, '')
      .replace(/\{$/gm, '')
      .replace(/\}$/gm, '')
      .replace(/\[$/gm, '')
      .replace(/\]$/gm, '')
      .replace(/^\s*[\r\n]/gm, '');
  }
}