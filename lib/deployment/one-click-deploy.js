const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const yaml = require('js-yaml');

class OneClickDeploy extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Deployment targets
      targets: options.targets || ['docker', 'kubernetes', 'aws', 'gcp', 'azure'],
      
      // Docker settings
      docker: {
        imageName: options.dockerImageName || 'otedama/mining-pool',
        imageTag: options.dockerImageTag || 'latest',
        registry: options.dockerRegistry || 'docker.io',
        buildArgs: options.dockerBuildArgs || {}
      },
      
      // Kubernetes settings
      kubernetes: {
        namespace: options.k8sNamespace || 'otedama',
        replicas: options.k8sReplicas || 3,
        resourceLimits: options.k8sResourceLimits || {
          cpu: '4000m',
          memory: '8Gi'
        }
      },
      
      // Cloud settings
      aws: {
        region: options.awsRegion || 'us-east-1',
        instanceType: options.awsInstanceType || 't3.xlarge',
        spotInstance: options.awsSpotInstance !== false
      },
      
      gcp: {
        project: options.gcpProject,
        zone: options.gcpZone || 'us-central1-a',
        machineType: options.gcpMachineType || 'n1-standard-4'
      },
      
      azure: {
        resourceGroup: options.azureResourceGroup || 'otedama-rg',
        location: options.azureLocation || 'eastus',
        vmSize: options.azureVmSize || 'Standard_D4_v3'
      },
      
      // General settings
      autoScale: options.autoScale !== false,
      monitoring: options.monitoring !== false,
      ssl: options.ssl !== false,
      backup: options.backup !== false
    };
    
    this.deploymentStatus = {
      inProgress: false,
      lastDeployment: null,
      deployments: []
    };
  }
  
  async deploy(target, options = {}) {
    if (this.deploymentStatus.inProgress) {
      throw new Error('Deployment already in progress');
    }
    
    this.deploymentStatus.inProgress = true;
    const deploymentId = `deploy-${Date.now()}`;
    
    this.emit('deploymentStarted', { deploymentId, target });
    
    try {
      let result;
      
      switch (target) {
        case 'docker':
          result = await this.deployDocker(options);
          break;
          
        case 'kubernetes':
          result = await this.deployKubernetes(options);
          break;
          
        case 'aws':
          result = await this.deployAWS(options);
          break;
          
        case 'gcp':
          result = await this.deployGCP(options);
          break;
          
        case 'azure':
          result = await this.deployAzure(options);
          break;
          
        case 'all':
          result = await this.deployAll(options);
          break;
          
        default:
          throw new Error(`Unknown deployment target: ${target}`);
      }
      
      const deployment = {
        id: deploymentId,
        target,
        status: 'success',
        timestamp: Date.now(),
        result
      };
      
      this.deploymentStatus.lastDeployment = deployment;
      this.deploymentStatus.deployments.push(deployment);
      
      this.emit('deploymentCompleted', deployment);
      
      return deployment;
      
    } catch (error) {
      const deployment = {
        id: deploymentId,
        target,
        status: 'failed',
        timestamp: Date.now(),
        error: error.message
      };
      
      this.deploymentStatus.deployments.push(deployment);
      
      this.emit('deploymentFailed', deployment);
      
      throw error;
      
    } finally {
      this.deploymentStatus.inProgress = false;
    }
  }
  
  // Docker deployment
  
  async deployDocker(options = {}) {
    this.emit('dockerDeploymentStarted');
    
    // Generate Dockerfile
    await this.generateDockerfile();
    
    // Build image
    const buildResult = await this.buildDockerImage();
    
    // Push to registry
    if (options.push !== false) {
      await this.pushDockerImage();
    }
    
    // Generate docker-compose
    await this.generateDockerCompose();
    
    // Start containers
    if (options.start !== false) {
      await this.startDockerContainers();
    }
    
    return {
      image: `${this.config.docker.registry}/${this.config.docker.imageName}:${this.config.docker.imageTag}`,
      containers: await this.getRunningContainers()
    };
  }
  
  async generateDockerfile() {
    const dockerfile = `# Otedama Mining Pool
FROM node:16-alpine

# Install dependencies
RUN apk add --no-cache \\
    python3 \\
    make \\
    g++ \\
    git \\
    curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install node dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Build native modules
RUN npm run build:native || true

# Expose ports
EXPOSE 3333 8080 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \\
  CMD curl -f http://localhost:8080/health || exit 1

# Start application
CMD ["node", "index.js"]
`;
    
    await fs.writeFile('Dockerfile', dockerfile);
    this.emit('dockerfileGenerated');
  }
  
  async buildDockerImage() {
    const imageName = `${this.config.docker.imageName}:${this.config.docker.imageTag}`;
    
    this.emit('dockerBuildStarted', { imageName });
    
    const buildArgs = Object.entries(this.config.docker.buildArgs)
      .map(([key, value]) => `--build-arg ${key}=${value}`)
      .join(' ');
    
    const { stdout, stderr } = await execAsync(
      `docker build -t ${imageName} ${buildArgs} .`
    );
    
    this.emit('dockerBuildCompleted', { imageName, output: stdout });
    
    return { imageName, output: stdout };
  }
  
  async pushDockerImage() {
    const fullImageName = `${this.config.docker.registry}/${this.config.docker.imageName}:${this.config.docker.imageTag}`;
    
    this.emit('dockerPushStarted', { image: fullImageName });
    
    // Tag image
    await execAsync(
      `docker tag ${this.config.docker.imageName}:${this.config.docker.imageTag} ${fullImageName}`
    );
    
    // Push image
    const { stdout } = await execAsync(`docker push ${fullImageName}`);
    
    this.emit('dockerPushCompleted', { image: fullImageName });
    
    return { image: fullImageName, output: stdout };
  }
  
  async generateDockerCompose() {
    const compose = {
      version: '3.8',
      services: {
        'mining-pool': {
          image: `${this.config.docker.imageName}:${this.config.docker.imageTag}`,
          restart: 'unless-stopped',
          ports: [
            '3333:3333',  // Stratum
            '8080:8080',  // Web UI
            '3001:3001'   // API
          ],
          environment: {
            NODE_ENV: 'production',
            POOL_NAME: 'Otedama Mining Pool',
            ENABLE_CLUSTERING: 'true'
          },
          volumes: [
            './data:/app/data',
            './logs:/app/logs'
          ],
          healthcheck: {
            test: ['CMD', 'curl', '-f', 'http://localhost:8080/health'],
            interval: '30s',
            timeout: '10s',
            retries: 3
          }
        },
        
        redis: {
          image: 'redis:alpine',
          restart: 'unless-stopped',
          volumes: [
            './redis-data:/data'
          ]
        },
        
        nginx: {
          image: 'nginx:alpine',
          restart: 'unless-stopped',
          ports: [
            '80:80',
            '443:443'
          ],
          volumes: [
            './nginx.conf:/etc/nginx/nginx.conf:ro',
            './ssl:/etc/nginx/ssl:ro'
          ],
          depends_on: [
            'mining-pool'
          ]
        }
      },
      
      volumes: {
        data: {},
        logs: {},
        'redis-data': {}
      },
      
      networks: {
        default: {
          name: 'otedama-network'
        }
      }
    };
    
    const composeYaml = yaml.dump(compose);
    await fs.writeFile('docker-compose.yml', composeYaml);
    
    // Generate nginx config
    await this.generateNginxConfig();
    
    this.emit('dockerComposeGenerated');
  }
  
  async generateNginxConfig() {
    const nginxConfig = `
events {
    worker_connections 1024;
}

http {
    upstream mining_pool {
        server mining-pool:8080;
    }
    
    upstream mining_api {
        server mining-pool:3001;
    }
    
    server {
        listen 80;
        server_name _;
        
        ${this.config.ssl ? `
        return 301 https://$server_name$request_uri;
    }
    
    server {
        listen 443 ssl http2;
        server_name _;
        
        ssl_certificate /etc/nginx/ssl/cert.pem;
        ssl_certificate_key /etc/nginx/ssl/key.pem;
        ` : ''}
        
        location / {
            proxy_pass http://mining_pool;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
        
        location /api {
            proxy_pass http://mining_api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
        
        location /ws {
            proxy_pass http://mining_pool;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}
`;
    
    await fs.writeFile('nginx.conf', nginxConfig);
  }
  
  async startDockerContainers() {
    this.emit('dockerStarting');
    
    const { stdout } = await execAsync('docker-compose up -d');
    
    this.emit('dockerStarted', { output: stdout });
    
    return { started: true, output: stdout };
  }
  
  async getRunningContainers() {
    const { stdout } = await execAsync('docker ps --format "table {{.Names}}\\t{{.Status}}"');
    return stdout.trim().split('\n').slice(1); // Skip header
  }
  
  // Kubernetes deployment
  
  async deployKubernetes(options = {}) {
    this.emit('kubernetesDeploymentStarted');
    
    // Generate Kubernetes manifests
    await this.generateKubernetesManifests();
    
    // Create namespace
    await this.createKubernetesNamespace();
    
    // Apply manifests
    await this.applyKubernetesManifests();
    
    // Wait for pods to be ready
    await this.waitForPodsReady();
    
    return {
      namespace: this.config.kubernetes.namespace,
      deployments: await this.getKubernetesDeployments()
    };
  }
  
  async generateKubernetesManifests() {
    // Deployment manifest
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'otedama-mining-pool',
        namespace: this.config.kubernetes.namespace
      },
      spec: {
        replicas: this.config.kubernetes.replicas,
        selector: {
          matchLabels: {
            app: 'otedama-mining-pool'
          }
        },
        template: {
          metadata: {
            labels: {
              app: 'otedama-mining-pool'
            }
          },
          spec: {
            containers: [{
              name: 'mining-pool',
              image: `${this.config.docker.registry}/${this.config.docker.imageName}:${this.config.docker.imageTag}`,
              ports: [
                { containerPort: 3333, name: 'stratum' },
                { containerPort: 8080, name: 'web' },
                { containerPort: 3001, name: 'api' }
              ],
              resources: {
                limits: this.config.kubernetes.resourceLimits,
                requests: {
                  cpu: '1000m',
                  memory: '2Gi'
                }
              },
              livenessProbe: {
                httpGet: {
                  path: '/health',
                  port: 8080
                },
                initialDelaySeconds: 30,
                periodSeconds: 10
              },
              readinessProbe: {
                httpGet: {
                  path: '/ready',
                  port: 8080
                },
                initialDelaySeconds: 5,
                periodSeconds: 5
              }
            }]
          }
        }
      }
    };
    
    // Service manifest
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'otedama-mining-pool',
        namespace: this.config.kubernetes.namespace
      },
      spec: {
        selector: {
          app: 'otedama-mining-pool'
        },
        ports: [
          { port: 3333, targetPort: 3333, name: 'stratum' },
          { port: 80, targetPort: 8080, name: 'web' },
          { port: 3001, targetPort: 3001, name: 'api' }
        ],
        type: 'LoadBalancer'
      }
    };
    
    // HorizontalPodAutoscaler
    const hpa = {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: {
        name: 'otedama-mining-pool',
        namespace: this.config.kubernetes.namespace
      },
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'otedama-mining-pool'
        },
        minReplicas: this.config.kubernetes.replicas,
        maxReplicas: this.config.kubernetes.replicas * 3,
        metrics: [{
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: {
              type: 'Utilization',
              averageUtilization: 70
            }
          }
        }]
      }
    };
    
    // Save manifests
    await fs.mkdir('k8s', { recursive: true });
    await fs.writeFile('k8s/deployment.yaml', yaml.dump(deployment));
    await fs.writeFile('k8s/service.yaml', yaml.dump(service));
    
    if (this.config.autoScale) {
      await fs.writeFile('k8s/hpa.yaml', yaml.dump(hpa));
    }
    
    this.emit('kubernetesManifestsGenerated');
  }
  
  async createKubernetesNamespace() {
    try {
      await execAsync(`kubectl create namespace ${this.config.kubernetes.namespace}`);
    } catch (error) {
      // Namespace might already exist
    }
  }
  
  async applyKubernetesManifests() {
    const { stdout } = await execAsync(`kubectl apply -f k8s/ -n ${this.config.kubernetes.namespace}`);
    
    this.emit('kubernetesManifestsApplied', { output: stdout });
  }
  
  async waitForPodsReady() {
    this.emit('waitingForPods');
    
    const maxWait = 300; // 5 minutes
    const checkInterval = 5;
    let waited = 0;
    
    while (waited < maxWait) {
      const { stdout } = await execAsync(
        `kubectl get pods -n ${this.config.kubernetes.namespace} -l app=otedama-mining-pool -o json`
      );
      
      const pods = JSON.parse(stdout);
      const allReady = pods.items.every(pod => 
        pod.status.conditions.some(c => c.type === 'Ready' && c.status === 'True')
      );
      
      if (allReady) {
        this.emit('podsReady');
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
      waited += checkInterval;
    }
    
    throw new Error('Pods failed to become ready in time');
  }
  
  async getKubernetesDeployments() {
    const { stdout } = await execAsync(
      `kubectl get deployments -n ${this.config.kubernetes.namespace} -o json`
    );
    
    return JSON.parse(stdout).items;
  }
  
  // AWS deployment
  
  async deployAWS(options = {}) {
    this.emit('awsDeploymentStarted');
    
    // Generate CloudFormation template
    const template = await this.generateCloudFormationTemplate();
    
    // Deploy stack
    const stackName = `otedama-mining-pool-${Date.now()}`;
    await this.deployCloudFormationStack(stackName, template);
    
    // Wait for stack completion
    await this.waitForStackComplete(stackName);
    
    return {
      stackName,
      outputs: await this.getStackOutputs(stackName)
    };
  }
  
  async generateCloudFormationTemplate() {
    const template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'Otedama Mining Pool Infrastructure',
      
      Parameters: {
        InstanceType: {
          Type: 'String',
          Default: this.config.aws.instanceType
        },
        KeyName: {
          Type: 'AWS::EC2::KeyPair::KeyName',
          Description: 'EC2 Key Pair for SSH access'
        }
      },
      
      Resources: {
        VPC: {
          Type: 'AWS::EC2::VPC',
          Properties: {
            CidrBlock: '10.0.0.0/16',
            EnableDnsHostnames: true,
            EnableDnsSupport: true
          }
        },
        
        PublicSubnet: {
          Type: 'AWS::EC2::Subnet',
          Properties: {
            VpcId: { Ref: 'VPC' },
            CidrBlock: '10.0.1.0/24',
            AvailabilityZone: { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }
          }
        },
        
        InternetGateway: {
          Type: 'AWS::EC2::InternetGateway'
        },
        
        AttachGateway: {
          Type: 'AWS::EC2::VPCGatewayAttachment',
          Properties: {
            VpcId: { Ref: 'VPC' },
            InternetGatewayId: { Ref: 'InternetGateway' }
          }
        },
        
        SecurityGroup: {
          Type: 'AWS::EC2::SecurityGroup',
          Properties: {
            GroupDescription: 'Otedama Mining Pool Security Group',
            VpcId: { Ref: 'VPC' },
            SecurityGroupIngress: [
              { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
              { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
              { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
              { IpProtocol: 'tcp', FromPort: 3333, ToPort: 3333, CidrIp: '0.0.0.0/0' }
            ]
          }
        },
        
        AutoScalingGroup: {
          Type: 'AWS::AutoScaling::AutoScalingGroup',
          Properties: {
            VPCZoneIdentifier: [{ Ref: 'PublicSubnet' }],
            LaunchConfigurationName: { Ref: 'LaunchConfiguration' },
            MinSize: 1,
            MaxSize: 10,
            DesiredCapacity: 3,
            HealthCheckType: 'ELB',
            HealthCheckGracePeriod: 300
          }
        },
        
        LaunchConfiguration: {
          Type: 'AWS::AutoScaling::LaunchConfiguration',
          Properties: {
            ImageId: this.getAMI(),
            InstanceType: { Ref: 'InstanceType' },
            SecurityGroups: [{ Ref: 'SecurityGroup' }],
            KeyName: { Ref: 'KeyName' },
            UserData: {
              'Fn::Base64': {
                'Fn::Join': ['', [
                  '#!/bin/bash\\n',
                  'yum update -y\\n',
                  'yum install -y docker\\n',
                  'service docker start\\n',
                  'docker run -d -p 3333:3333 -p 8080:8080 ',
                  `${this.config.docker.registry}/${this.config.docker.imageName}:${this.config.docker.imageTag}\\n`
                ]]
              }
            }
          }
        },
        
        LoadBalancer: {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: {
            Type: 'application',
            Subnets: [{ Ref: 'PublicSubnet' }],
            SecurityGroups: [{ Ref: 'SecurityGroup' }]
          }
        }
      },
      
      Outputs: {
        LoadBalancerDNS: {
          Value: { 'Fn::GetAtt': ['LoadBalancer', 'DNSName'] },
          Description: 'Load Balancer DNS Name'
        }
      }
    };
    
    await fs.writeFile('cloudformation.json', JSON.stringify(template, null, 2));
    
    return template;
  }
  
  getAMI() {
    // Get latest Amazon Linux 2 AMI
    // In production, would query AWS for latest AMI
    return 'ami-0c02fb55956c7d316'; // Example AMI ID
  }
  
  async deployCloudFormationStack(stackName, template) {
    const { stdout } = await execAsync(
      `aws cloudformation create-stack --stack-name ${stackName} --template-body file://cloudformation.json --capabilities CAPABILITY_IAM`
    );
    
    this.emit('cloudFormationStackCreated', { stackName });
  }
  
  async waitForStackComplete(stackName) {
    this.emit('waitingForStack', { stackName });
    
    const maxWait = 1800; // 30 minutes
    const checkInterval = 30;
    let waited = 0;
    
    while (waited < maxWait) {
      const { stdout } = await execAsync(
        `aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].StackStatus' --output text`
      );
      
      const status = stdout.trim();
      
      if (status === 'CREATE_COMPLETE') {
        this.emit('stackReady', { stackName });
        return;
      }
      
      if (status.includes('FAILED') || status.includes('ROLLBACK')) {
        throw new Error(`Stack creation failed: ${status}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
      waited += checkInterval;
    }
    
    throw new Error('Stack creation timed out');
  }
  
  async getStackOutputs(stackName) {
    const { stdout } = await execAsync(
      `aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].Outputs' --output json`
    );
    
    return JSON.parse(stdout);
  }
  
  // Simplified GCP and Azure deployments
  
  async deployGCP(options = {}) {
    this.emit('gcpDeploymentStarted');
    
    // Generate deployment script
    const script = `#!/bin/bash
# Create instance template
gcloud compute instance-templates create otedama-template \\
  --machine-type=${this.config.gcp.machineType} \\
  --image-family=ubuntu-2004-lts \\
  --image-project=ubuntu-os-cloud \\
  --boot-disk-size=100GB \\
  --metadata-from-file startup-script=startup.sh

# Create managed instance group
gcloud compute instance-groups managed create otedama-group \\
  --base-instance-name=otedama \\
  --template=otedama-template \\
  --size=3 \\
  --zone=${this.config.gcp.zone}

# Create load balancer
gcloud compute backend-services create otedama-backend \\
  --protocol=TCP \\
  --port-name=stratum \\
  --health-checks=otedama-health
`;
    
    await fs.writeFile('deploy-gcp.sh', script);
    
    return { script: 'deploy-gcp.sh' };
  }
  
  async deployAzure(options = {}) {
    this.emit('azureDeploymentStarted');
    
    // Generate ARM template
    const template = {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      resources: [{
        type: 'Microsoft.Compute/virtualMachineScaleSets',
        apiVersion: '2021-07-01',
        name: 'otedama-vmss',
        location: this.config.azure.location,
        sku: {
          name: this.config.azure.vmSize,
          capacity: 3
        }
      }]
    };
    
    await fs.writeFile('azuredeploy.json', JSON.stringify(template, null, 2));
    
    return { template: 'azuredeploy.json' };
  }
  
  // Deploy to all targets
  
  async deployAll(options = {}) {
    const results = {};
    
    for (const target of this.config.targets) {
      try {
        results[target] = await this.deploy(target, options);
      } catch (error) {
        results[target] = { error: error.message };
      }
    }
    
    return results;
  }
  
  // Utilities
  
  async validatePrerequisites() {
    const checks = {
      docker: await this.checkDocker(),
      kubectl: await this.checkKubectl(),
      aws: await this.checkAWS(),
      gcloud: await this.checkGCloud(),
      az: await this.checkAzure()
    };
    
    return checks;
  }
  
  async checkDocker() {
    try {
      const { stdout } = await execAsync('docker --version');
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false };
    }
  }
  
  async checkKubectl() {
    try {
      const { stdout } = await execAsync('kubectl version --client --short');
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false };
    }
  }
  
  async checkAWS() {
    try {
      const { stdout } = await execAsync('aws --version');
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false };
    }
  }
  
  async checkGCloud() {
    try {
      const { stdout } = await execAsync('gcloud --version | head -n 1');
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false };
    }
  }
  
  async checkAzure() {
    try {
      const { stdout } = await execAsync('az --version | head -n 1');
      return { installed: true, version: stdout.trim() };
    } catch (error) {
      return { installed: false };
    }
  }
  
  // Status and monitoring
  
  getDeploymentHistory() {
    return this.deploymentStatus.deployments;
  }
  
  getLastDeployment() {
    return this.deploymentStatus.lastDeployment;
  }
  
  isDeploying() {
    return this.deploymentStatus.inProgress;
  }
  
  async getDeploymentStatus(deploymentId) {
    const deployment = this.deploymentStatus.deployments.find(d => d.id === deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
    return deployment;
  }
}

module.exports = OneClickDeploy;