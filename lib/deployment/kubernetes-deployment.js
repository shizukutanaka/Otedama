/**
 * Kubernetes Deployment Support
 * Kubernetesデプロイメントサポート
 */

const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

class KubernetesDeployment extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Cluster configuration
            namespace: config.namespace || 'otedama-pool',
            appName: config.appName || 'otedama',
            
            // Deployment configuration
            replicas: config.replicas || 3,
            minReplicas: config.minReplicas || 2,
            maxReplicas: config.maxReplicas || 10,
            
            // Resource limits
            resources: {
                requests: {
                    cpu: config.resources?.requests?.cpu || '500m',
                    memory: config.resources?.requests?.memory || '512Mi'
                },
                limits: {
                    cpu: config.resources?.limits?.cpu || '2000m',
                    memory: config.resources?.limits?.memory || '2Gi'
                }
            },
            
            // Auto-scaling
            enableHPA: config.enableHPA !== false,
            targetCPUUtilization: config.targetCPUUtilization || 70,
            targetMemoryUtilization: config.targetMemoryUtilization || 80,
            
            // Service configuration
            serviceType: config.serviceType || 'LoadBalancer',
            ports: config.ports || [
                { name: 'stratum', port: 3333, protocol: 'TCP' },
                { name: 'http', port: 8080, protocol: 'TCP' },
                { name: 'ws', port: 8081, protocol: 'TCP' }
            ],
            
            // Storage
            enablePersistentStorage: config.enablePersistentStorage !== false,
            storageClass: config.storageClass || 'standard',
            storageSize: config.storageSize || '10Gi',
            
            // ConfigMaps and Secrets
            configMapName: config.configMapName || 'otedama-config',
            secretName: config.secretName || 'otedama-secrets',
            
            // Health checks
            livenessProbe: {
                httpGet: {
                    path: '/health',
                    port: 8080
                },
                initialDelaySeconds: config.livenessProbe?.initialDelaySeconds || 30,
                periodSeconds: config.livenessProbe?.periodSeconds || 10,
                timeoutSeconds: config.livenessProbe?.timeoutSeconds || 5,
                failureThreshold: config.livenessProbe?.failureThreshold || 3
            },
            
            readinessProbe: {
                httpGet: {
                    path: '/ready',
                    port: 8080
                },
                initialDelaySeconds: config.readinessProbe?.initialDelaySeconds || 5,
                periodSeconds: config.readinessProbe?.periodSeconds || 5,
                timeoutSeconds: config.readinessProbe?.timeoutSeconds || 3,
                failureThreshold: config.readinessProbe?.failureThreshold || 3
            },
            
            // Network policies
            enableNetworkPolicies: config.enableNetworkPolicies || false,
            allowedNamespaces: config.allowedNamespaces || [],
            
            // Pod disruption budget
            enablePDB: config.enablePDB !== false,
            minAvailable: config.minAvailable || '50%',
            
            // Ingress
            enableIngress: config.enableIngress || false,
            ingressHost: config.ingressHost || 'pool.example.com',
            ingressTLS: config.ingressTLS !== false,
            
            // Service mesh
            enableIstio: config.enableIstio || false,
            enableLinkerd: config.enableLinkerd || false,
            
            // Monitoring
            enablePrometheusMonitoring: config.enablePrometheusMonitoring !== false,
            prometheusPort: config.prometheusPort || 9090,
            
            // Output directory
            outputDir: config.outputDir || './k8s',
            
            ...config
        };
        
        // Kubernetes manifests
        this.manifests = {};
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('Kubernetesデプロイメント設定を初期化中...');
        
        // Ensure output directory exists
        await fs.mkdir(this.config.outputDir, { recursive: true });
        
        console.log('✓ Kubernetesデプロイメント設定の初期化完了');
    }
    
    /**
     * Generate all Kubernetes manifests
     */
    async generateManifests() {
        console.log('Kubernetesマニフェストを生成中...');
        
        // Generate namespace
        this.manifests.namespace = this.generateNamespace();
        
        // Generate ConfigMap
        this.manifests.configMap = await this.generateConfigMap();
        
        // Generate Secret
        this.manifests.secret = await this.generateSecret();
        
        // Generate PersistentVolumeClaim
        if (this.config.enablePersistentStorage) {
            this.manifests.pvc = this.generatePVC();
        }
        
        // Generate Deployment
        this.manifests.deployment = this.generateDeployment();
        
        // Generate Service
        this.manifests.service = this.generateService();
        
        // Generate HorizontalPodAutoscaler
        if (this.config.enableHPA) {
            this.manifests.hpa = this.generateHPA();
        }
        
        // Generate PodDisruptionBudget
        if (this.config.enablePDB) {
            this.manifests.pdb = this.generatePDB();
        }
        
        // Generate NetworkPolicy
        if (this.config.enableNetworkPolicies) {
            this.manifests.networkPolicy = this.generateNetworkPolicy();
        }
        
        // Generate Ingress
        if (this.config.enableIngress) {
            this.manifests.ingress = this.generateIngress();
        }
        
        // Generate ServiceMonitor for Prometheus
        if (this.config.enablePrometheusMonitoring) {
            this.manifests.serviceMonitor = this.generateServiceMonitor();
        }
        
        // Generate Istio/Linkerd specific resources
        if (this.config.enableIstio) {
            this.manifests.virtualService = this.generateIstioVirtualService();
            this.manifests.destinationRule = this.generateIstioDestinationRule();
        }
        
        // Save manifests
        await this.saveManifests();
        
        console.log('✓ Kubernetesマニフェストの生成完了');
        
        return this.manifests;
    }
    
    /**
     * Generate namespace manifest
     */
    generateNamespace() {
        return {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: this.config.namespace,
                labels: {
                    app: this.config.appName,
                    'app.kubernetes.io/name': this.config.appName,
                    'app.kubernetes.io/part-of': 'otedama-pool'
                }
            }
        };
    }
    
    /**
     * Generate ConfigMap manifest
     */
    async generateConfigMap() {
        const configData = {
            'pool.conf': `# Otedama Pool Configuration
NODE_ENV=production
POOL_NAME=${this.config.appName}
STRATUM_PORT=3333
HTTP_PORT=8080
WS_PORT=8081
LOG_LEVEL=info
ENABLE_METRICS=true
METRICS_PORT=${this.config.prometheusPort}
`,
            'network.conf': `# Network Configuration
MAX_CONNECTIONS=10000
CONNECTION_TIMEOUT=30000
KEEP_ALIVE_INTERVAL=60000
`,
            'mining.conf': `# Mining Configuration
DIFFICULTY_ADJUSTMENT_INTERVAL=2016
BLOCK_TIME_TARGET=600
MIN_DIFFICULTY=1
MAX_DIFFICULTY=1000000000
`
        };
        
        return {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
                name: this.config.configMapName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            data: configData
        };
    }
    
    /**
     * Generate Secret manifest
     */
    async generateSecret() {
        // In production, these should be provided externally
        const secretData = {
            'database-url': Buffer.from('postgresql://user:pass@postgres:5432/otedama').toString('base64'),
            'redis-url': Buffer.from('redis://redis:6379').toString('base64'),
            'jwt-secret': Buffer.from(crypto.randomBytes(32).toString('hex')).toString('base64'),
            'encryption-key': Buffer.from(crypto.randomBytes(32).toString('hex')).toString('base64')
        };
        
        return {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
                name: this.config.secretName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            type: 'Opaque',
            data: secretData
        };
    }
    
    /**
     * Generate PersistentVolumeClaim manifest
     */
    generatePVC() {
        return {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            metadata: {
                name: `${this.config.appName}-pvc`,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: this.config.storageClass,
                resources: {
                    requests: {
                        storage: this.config.storageSize
                    }
                }
            }
        };
    }
    
    /**
     * Generate Deployment manifest
     */
    generateDeployment() {
        const deployment = {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName,
                    version: 'v1.0.6'
                }
            },
            spec: {
                replicas: this.config.replicas,
                selector: {
                    matchLabels: {
                        app: this.config.appName
                    }
                },
                template: {
                    metadata: {
                        labels: {
                            app: this.config.appName,
                            version: 'v1.0.6'
                        },
                        annotations: {
                            'prometheus.io/scrape': 'true',
                            'prometheus.io/port': String(this.config.prometheusPort),
                            'prometheus.io/path': '/metrics'
                        }
                    },
                    spec: {
                        serviceAccountName: this.config.appName,
                        containers: [{
                            name: this.config.appName,
                            image: `${this.config.appName}:latest`,
                            imagePullPolicy: 'Always',
                            ports: this.config.ports.map(p => ({
                                name: p.name,
                                containerPort: p.port,
                                protocol: p.protocol
                            })).concat([{
                                name: 'metrics',
                                containerPort: this.config.prometheusPort,
                                protocol: 'TCP'
                            }]),
                            env: [
                                {
                                    name: 'NODE_ENV',
                                    value: 'production'
                                },
                                {
                                    name: 'DATABASE_URL',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.config.secretName,
                                            key: 'database-url'
                                        }
                                    }
                                },
                                {
                                    name: 'REDIS_URL',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.config.secretName,
                                            key: 'redis-url'
                                        }
                                    }
                                },
                                {
                                    name: 'JWT_SECRET',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.config.secretName,
                                            key: 'jwt-secret'
                                        }
                                    }
                                },
                                {
                                    name: 'ENCRYPTION_KEY',
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: this.config.secretName,
                                            key: 'encryption-key'
                                        }
                                    }
                                }
                            ],
                            resources: this.config.resources,
                            livenessProbe: this.config.livenessProbe,
                            readinessProbe: this.config.readinessProbe,
                            volumeMounts: [
                                {
                                    name: 'config',
                                    mountPath: '/app/config'
                                }
                            ]
                        }],
                        volumes: [
                            {
                                name: 'config',
                                configMap: {
                                    name: this.config.configMapName
                                }
                            }
                        ]
                    }
                }
            }
        };
        
        // Add persistent volume if enabled
        if (this.config.enablePersistentStorage) {
            deployment.spec.template.spec.containers[0].volumeMounts.push({
                name: 'data',
                mountPath: '/app/data'
            });
            
            deployment.spec.template.spec.volumes.push({
                name: 'data',
                persistentVolumeClaim: {
                    claimName: `${this.config.appName}-pvc`
                }
            });
        }
        
        // Add service mesh annotations
        if (this.config.enableIstio) {
            deployment.spec.template.metadata.annotations['sidecar.istio.io/inject'] = 'true';
        }
        
        if (this.config.enableLinkerd) {
            deployment.spec.template.metadata.annotations['linkerd.io/inject'] = 'enabled';
        }
        
        return deployment;
    }
    
    /**
     * Generate Service manifest
     */
    generateService() {
        return {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                type: this.config.serviceType,
                selector: {
                    app: this.config.appName
                },
                ports: this.config.ports.map(p => ({
                    name: p.name,
                    port: p.port,
                    targetPort: p.port,
                    protocol: p.protocol
                }))
            }
        };
    }
    
    /**
     * Generate HorizontalPodAutoscaler manifest
     */
    generateHPA() {
        return {
            apiVersion: 'autoscaling/v2',
            kind: 'HorizontalPodAutoscaler',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                scaleTargetRef: {
                    apiVersion: 'apps/v1',
                    kind: 'Deployment',
                    name: this.config.appName
                },
                minReplicas: this.config.minReplicas,
                maxReplicas: this.config.maxReplicas,
                metrics: [
                    {
                        type: 'Resource',
                        resource: {
                            name: 'cpu',
                            target: {
                                type: 'Utilization',
                                averageUtilization: this.config.targetCPUUtilization
                            }
                        }
                    },
                    {
                        type: 'Resource',
                        resource: {
                            name: 'memory',
                            target: {
                                type: 'Utilization',
                                averageUtilization: this.config.targetMemoryUtilization
                            }
                        }
                    }
                ],
                behavior: {
                    scaleDown: {
                        stabilizationWindowSeconds: 300,
                        policies: [
                            {
                                type: 'Percent',
                                value: 10,
                                periodSeconds: 60
                            }
                        ]
                    },
                    scaleUp: {
                        stabilizationWindowSeconds: 0,
                        policies: [
                            {
                                type: 'Percent',
                                value: 100,
                                periodSeconds: 15
                            },
                            {
                                type: 'Pods',
                                value: 4,
                                periodSeconds: 15
                            }
                        ],
                        selectPolicy: 'Max'
                    }
                }
            }
        };
    }
    
    /**
     * Generate PodDisruptionBudget manifest
     */
    generatePDB() {
        return {
            apiVersion: 'policy/v1',
            kind: 'PodDisruptionBudget',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                minAvailable: this.config.minAvailable,
                selector: {
                    matchLabels: {
                        app: this.config.appName
                    }
                }
            }
        };
    }
    
    /**
     * Generate NetworkPolicy manifest
     */
    generateNetworkPolicy() {
        return {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                podSelector: {
                    matchLabels: {
                        app: this.config.appName
                    }
                },
                policyTypes: ['Ingress', 'Egress'],
                ingress: [
                    {
                        from: [
                            {
                                namespaceSelector: {
                                    matchLabels: {
                                        name: this.config.namespace
                                    }
                                }
                            },
                            ...this.config.allowedNamespaces.map(ns => ({
                                namespaceSelector: {
                                    matchLabels: {
                                        name: ns
                                    }
                                }
                            }))
                        ],
                        ports: this.config.ports.map(p => ({
                            protocol: p.protocol,
                            port: p.port
                        }))
                    }
                ],
                egress: [
                    {
                        to: [
                            {
                                namespaceSelector: {}
                            }
                        ],
                        ports: [
                            {
                                protocol: 'TCP',
                                port: 53
                            },
                            {
                                protocol: 'UDP',
                                port: 53
                            },
                            {
                                protocol: 'TCP',
                                port: 443
                            },
                            {
                                protocol: 'TCP',
                                port: 5432
                            },
                            {
                                protocol: 'TCP',
                                port: 6379
                            }
                        ]
                    }
                ]
            }
        };
    }
    
    /**
     * Generate Ingress manifest
     */
    generateIngress() {
        const ingress = {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'Ingress',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                },
                annotations: {
                    'kubernetes.io/ingress.class': 'nginx',
                    'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
                    'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
                    'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600'
                }
            },
            spec: {
                rules: [
                    {
                        host: this.config.ingressHost,
                        http: {
                            paths: [
                                {
                                    path: '/',
                                    pathType: 'Prefix',
                                    backend: {
                                        service: {
                                            name: this.config.appName,
                                            port: {
                                                number: 8080
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                ]
            }
        };
        
        if (this.config.ingressTLS) {
            ingress.spec.tls = [
                {
                    hosts: [this.config.ingressHost],
                    secretName: `${this.config.appName}-tls`
                }
            ];
            
            ingress.metadata.annotations['cert-manager.io/cluster-issuer'] = 'letsencrypt-prod';
        }
        
        return ingress;
    }
    
    /**
     * Generate ServiceMonitor for Prometheus
     */
    generateServiceMonitor() {
        return {
            apiVersion: 'monitoring.coreos.com/v1',
            kind: 'ServiceMonitor',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName,
                    prometheus: 'kube-prometheus'
                }
            },
            spec: {
                selector: {
                    matchLabels: {
                        app: this.config.appName
                    }
                },
                endpoints: [
                    {
                        port: 'metrics',
                        interval: '30s',
                        path: '/metrics'
                    }
                ]
            }
        };
    }
    
    /**
     * Generate Istio VirtualService
     */
    generateIstioVirtualService() {
        return {
            apiVersion: 'networking.istio.io/v1beta1',
            kind: 'VirtualService',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                hosts: [this.config.ingressHost],
                gateways: ['istio-system/istio-gateway'],
                http: [
                    {
                        match: [
                            {
                                uri: {
                                    prefix: '/'
                                }
                            }
                        ],
                        route: [
                            {
                                destination: {
                                    host: this.config.appName,
                                    port: {
                                        number: 8080
                                    }
                                }
                            }
                        ],
                        timeout: '30s',
                        retries: {
                            attempts: 3,
                            perTryTimeout: '10s'
                        }
                    }
                ]
            }
        };
    }
    
    /**
     * Generate Istio DestinationRule
     */
    generateIstioDestinationRule() {
        return {
            apiVersion: 'networking.istio.io/v1beta1',
            kind: 'DestinationRule',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            spec: {
                host: this.config.appName,
                trafficPolicy: {
                    connectionPool: {
                        tcp: {
                            maxConnections: 100
                        },
                        http: {
                            http1MaxPendingRequests: 100,
                            http2MaxRequests: 100
                        }
                    },
                    loadBalancer: {
                        simple: 'LEAST_REQUEST'
                    },
                    outlierDetection: {
                        consecutiveErrors: 5,
                        interval: '30s',
                        baseEjectionTime: '30s',
                        maxEjectionPercent: 50,
                        minHealthPercent: 50
                    }
                }
            }
        };
    }
    
    /**
     * Generate ServiceAccount manifest
     */
    generateServiceAccount() {
        return {
            apiVersion: 'v1',
            kind: 'ServiceAccount',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            }
        };
    }
    
    /**
     * Generate RBAC manifests
     */
    generateRBAC() {
        const role = {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'Role',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            rules: [
                {
                    apiGroups: [''],
                    resources: ['configmaps'],
                    verbs: ['get', 'list', 'watch']
                },
                {
                    apiGroups: [''],
                    resources: ['secrets'],
                    verbs: ['get']
                }
            ]
        };
        
        const roleBinding = {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'RoleBinding',
            metadata: {
                name: this.config.appName,
                namespace: this.config.namespace,
                labels: {
                    app: this.config.appName
                }
            },
            subjects: [
                {
                    kind: 'ServiceAccount',
                    name: this.config.appName,
                    namespace: this.config.namespace
                }
            ],
            roleRef: {
                kind: 'Role',
                name: this.config.appName,
                apiGroup: 'rbac.authorization.k8s.io'
            }
        };
        
        return { role, roleBinding };
    }
    
    /**
     * Save manifests to files
     */
    async saveManifests() {
        // Create subdirectories
        const dirs = ['base', 'overlays/dev', 'overlays/staging', 'overlays/production'];
        for (const dir of dirs) {
            await fs.mkdir(path.join(this.config.outputDir, dir), { recursive: true });
        }
        
        // Save base manifests
        const baseDir = path.join(this.config.outputDir, 'base');
        
        for (const [name, manifest of Object.entries(this.manifests)) {
            const filename = `${name.toLowerCase()}.yaml`;
            const filepath = path.join(baseDir, filename);
            
            await fs.writeFile(
                filepath,
                yaml.dump(manifest, { indent: 2 })
            );
        }
        
        // Generate kustomization.yaml for base
        const kustomizationBase = {
            apiVersion: 'kustomize.config.k8s.io/v1beta1',
            kind: 'Kustomization',
            resources: Object.keys(this.manifests).map(name => `${name.toLowerCase()}.yaml`)
        };
        
        await fs.writeFile(
            path.join(baseDir, 'kustomization.yaml'),
            yaml.dump(kustomizationBase, { indent: 2 })
        );
        
        // Generate overlay kustomizations
        await this.generateOverlays();
        
        // Generate Helm chart
        await this.generateHelmChart();
        
        // Generate deployment scripts
        await this.generateDeploymentScripts();
    }
    
    /**
     * Generate overlay configurations
     */
    async generateOverlays() {
        const environments = ['dev', 'staging', 'production'];
        
        for (const env of environments) {
            const overlayDir = path.join(this.config.outputDir, 'overlays', env);
            
            // Environment-specific patches
            const patches = {
                dev: {
                    deployment: {
                        spec: {
                            replicas: 1
                        }
                    }
                },
                staging: {
                    deployment: {
                        spec: {
                            replicas: 2
                        }
                    }
                },
                production: {
                    deployment: {
                        spec: {
                            replicas: this.config.replicas
                        }
                    }
                }
            };
            
            // Save patch
            if (patches[env].deployment) {
                await fs.writeFile(
                    path.join(overlayDir, 'deployment-patch.yaml'),
                    yaml.dump({
                        apiVersion: 'apps/v1',
                        kind: 'Deployment',
                        metadata: {
                            name: this.config.appName
                        },
                        ...patches[env].deployment
                    }, { indent: 2 })
                );
            }
            
            // Kustomization for overlay
            const kustomization = {
                apiVersion: 'kustomize.config.k8s.io/v1beta1',
                kind: 'Kustomization',
                namespace: `${this.config.namespace}-${env}`,
                bases: ['../../base'],
                patchesStrategicMerge: ['deployment-patch.yaml'],
                configMapGenerator: [
                    {
                        name: this.config.configMapName,
                        behavior: 'merge',
                        literals: [`ENVIRONMENT=${env}`]
                    }
                ]
            };
            
            await fs.writeFile(
                path.join(overlayDir, 'kustomization.yaml'),
                yaml.dump(kustomization, { indent: 2 })
            );
        }
    }
    
    /**
     * Generate Helm chart
     */
    async generateHelmChart() {
        const chartDir = path.join(this.config.outputDir, 'helm-chart');
        const templatesDir = path.join(chartDir, 'templates');
        
        await fs.mkdir(templatesDir, { recursive: true });
        
        // Chart.yaml
        const chart = {
            apiVersion: 'v2',
            name: this.config.appName,
            description: 'Otedama Mining Pool - P2P Mining Pool Software',
            type: 'application',
            version: '1.0.6',
            appVersion: '1.0.6',
            keywords: ['mining', 'pool', 'p2p', 'blockchain'],
            home: 'https://github.com/otedama/otedama',
            maintainers: [
                {
                    name: 'Otedama Team',
                    email: 'team@otedama.io'
                }
            ]
        };
        
        await fs.writeFile(
            path.join(chartDir, 'Chart.yaml'),
            yaml.dump(chart, { indent: 2 })
        );
        
        // values.yaml
        const values = {
            replicaCount: this.config.replicas,
            image: {
                repository: this.config.appName,
                pullPolicy: 'IfNotPresent',
                tag: '1.0.6'
            },
            service: {
                type: this.config.serviceType,
                ports: this.config.ports
            },
            ingress: {
                enabled: this.config.enableIngress,
                className: 'nginx',
                hosts: [
                    {
                        host: this.config.ingressHost,
                        paths: [
                            {
                                path: '/',
                                pathType: 'Prefix'
                            }
                        ]
                    }
                ],
                tls: []
            },
            resources: this.config.resources,
            autoscaling: {
                enabled: this.config.enableHPA,
                minReplicas: this.config.minReplicas,
                maxReplicas: this.config.maxReplicas,
                targetCPUUtilizationPercentage: this.config.targetCPUUtilization,
                targetMemoryUtilizationPercentage: this.config.targetMemoryUtilization
            },
            persistence: {
                enabled: this.config.enablePersistentStorage,
                storageClass: this.config.storageClass,
                size: this.config.storageSize
            }
        };
        
        await fs.writeFile(
            path.join(chartDir, 'values.yaml'),
            yaml.dump(values, { indent: 2 })
        );
        
        // Templates
        // Convert manifests to Helm templates
        for (const [name, manifest] of Object.entries(this.manifests)) {
            const template = this.convertToHelmTemplate(manifest);
            await fs.writeFile(
                path.join(templatesDir, `${name.toLowerCase()}.yaml`),
                yaml.dump(template, { indent: 2 })
            );
        }
    }
    
    /**
     * Convert manifest to Helm template
     */
    convertToHelmTemplate(manifest) {
        // Replace hardcoded values with Helm template variables
        let manifestStr = JSON.stringify(manifest);
        
        // Replace common values
        manifestStr = manifestStr.replace(
            new RegExp(this.config.appName, 'g'),
            '{{ .Release.Name }}'
        );
        
        manifestStr = manifestStr.replace(
            new RegExp(this.config.namespace, 'g'),
            '{{ .Release.Namespace }}'
        );
        
        // Replace replica count
        manifestStr = manifestStr.replace(
            /"replicas":\s*\d+/,
            '"replicas": {{ .Values.replicaCount }}'
        );
        
        return JSON.parse(manifestStr);
    }
    
    /**
     * Generate deployment scripts
     */
    async generateDeploymentScripts() {
        const scriptsDir = path.join(this.config.outputDir, 'scripts');
        await fs.mkdir(scriptsDir, { recursive: true });
        
        // deploy.sh
        const deployScript = `#!/bin/bash
# Otedama Kubernetes Deployment Script

set -e

NAMESPACE="${this.config.namespace}"
ENVIRONMENT="\${1:-production}"

echo "Deploying Otedama to Kubernetes (\$ENVIRONMENT)..."

# Apply base resources
echo "Applying base resources..."
kubectl apply -k ./overlays/\$ENVIRONMENT

# Wait for deployment to be ready
echo "Waiting for deployment to be ready..."
kubectl -n \$NAMESPACE-\$ENVIRONMENT rollout status deployment/${this.config.appName}

# Check pod status
echo "Checking pod status..."
kubectl -n \$NAMESPACE-\$ENVIRONMENT get pods -l app=${this.config.appName}

# Display service info
echo "Service information:"
kubectl -n \$NAMESPACE-\$ENVIRONMENT get svc ${this.config.appName}

echo "Deployment complete!"
`;
        
        await fs.writeFile(
            path.join(scriptsDir, 'deploy.sh'),
            deployScript,
            { mode: 0o755 }
        );
        
        // rollback.sh
        const rollbackScript = `#!/bin/bash
# Otedama Kubernetes Rollback Script

set -e

NAMESPACE="${this.config.namespace}"
ENVIRONMENT="\${1:-production}"

echo "Rolling back Otedama deployment..."

kubectl -n \$NAMESPACE-\$ENVIRONMENT rollout undo deployment/${this.config.appName}

echo "Rollback initiated. Monitoring status..."
kubectl -n \$NAMESPACE-\$ENVIRONMENT rollout status deployment/${this.config.appName}

echo "Rollback complete!"
`;
        
        await fs.writeFile(
            path.join(scriptsDir, 'rollback.sh'),
            rollbackScript,
            { mode: 0o755 }
        );
        
        // scale.sh
        const scaleScript = `#!/bin/bash
# Otedama Kubernetes Scaling Script

set -e

NAMESPACE="${this.config.namespace}"
ENVIRONMENT="\${1:-production}"
REPLICAS="\${2:-3}"

echo "Scaling Otedama to \$REPLICAS replicas..."

kubectl -n \$NAMESPACE-\$ENVIRONMENT scale deployment/${this.config.appName} --replicas=\$REPLICAS

echo "Scaling complete!"
kubectl -n \$NAMESPACE-\$ENVIRONMENT get pods -l app=${this.config.appName}
`;
        
        await fs.writeFile(
            path.join(scriptsDir, 'scale.sh'),
            scaleScript,
            { mode: 0o755 }
        );
    }
    
    /**
     * Validate Kubernetes configuration
     */
    async validateConfiguration() {
        console.log('Kubernetes設定を検証中...');
        
        const errors = [];
        const warnings = [];
        
        // Check resource limits
        const cpuRequest = parseInt(this.config.resources.requests.cpu);
        const cpuLimit = parseInt(this.config.resources.limits.cpu);
        
        if (cpuLimit < cpuRequest) {
            errors.push('CPU limit must be greater than or equal to CPU request');
        }
        
        // Check replica configuration
        if (this.config.minReplicas > this.config.replicas) {
            warnings.push('minReplicas is greater than replicas');
        }
        
        if (this.config.maxReplicas < this.config.replicas) {
            errors.push('maxReplicas must be greater than or equal to replicas');
        }
        
        // Check storage
        if (this.config.enablePersistentStorage && !this.config.storageClass) {
            warnings.push('No storage class specified, will use cluster default');
        }
        
        // Check ingress
        if (this.config.enableIngress && !this.config.ingressHost) {
            errors.push('Ingress enabled but no host specified');
        }
        
        if (errors.length > 0) {
            throw new Error(`Validation errors: ${errors.join(', ')}`);
        }
        
        if (warnings.length > 0) {
            console.warn('Validation warnings:', warnings);
        }
        
        console.log('✓ Kubernetes設定の検証完了');
    }
    
    /**
     * Get deployment status
     */
    getDeploymentStatus() {
        return {
            manifests: Object.keys(this.manifests),
            outputDirectory: this.config.outputDir,
            configuration: {
                namespace: this.config.namespace,
                replicas: this.config.replicas,
                autoscaling: {
                    enabled: this.config.enableHPA,
                    min: this.config.minReplicas,
                    max: this.config.maxReplicas
                },
                storage: {
                    enabled: this.config.enablePersistentStorage,
                    size: this.config.storageSize
                },
                ingress: {
                    enabled: this.config.enableIngress,
                    host: this.config.ingressHost
                },
                monitoring: {
                    prometheus: this.config.enablePrometheusMonitoring
                },
                serviceMesh: {
                    istio: this.config.enableIstio,
                    linkerd: this.config.enableLinkerd
                }
            }
        };
    }
}

// Helper function to install js-yaml if not present
function ensureYamlLibrary() {
    try {
        return require('js-yaml');
    } catch (e) {
        // Return a simple implementation for basic YAML generation
        return {
            dump: (obj, options = {}) => {
                const indent = options.indent || 2;
                
                function stringify(value, depth = 0) {
                    const spacing = ' '.repeat(depth * indent);
                    
                    if (value === null || value === undefined) {
                        return 'null';
                    }
                    
                    if (typeof value === 'boolean' || typeof value === 'number') {
                        return String(value);
                    }
                    
                    if (typeof value === 'string') {
                        return value.includes('\n') ? `|\n${spacing}${value}` : value;
                    }
                    
                    if (Array.isArray(value)) {
                        return value.map(item => `${spacing}- ${stringify(item, depth + 1)}`).join('\n');
                    }
                    
                    if (typeof value === 'object') {
                        return Object.entries(value)
                            .map(([key, val]) => {
                                const valueStr = stringify(val, depth + 1);
                                if (typeof val === 'object' && !Array.isArray(val)) {
                                    return `${spacing}${key}:\n${valueStr}`;
                                }
                                return `${spacing}${key}: ${valueStr}`;
                            })
                            .join('\n');
                    }
                    
                    return String(value);
                }
                
                return stringify(obj);
            }
        };
    }
}

// Use the yaml library
const yaml = ensureYamlLibrary();

module.exports = KubernetesDeployment;