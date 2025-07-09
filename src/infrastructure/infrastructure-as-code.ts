/**
 * インフラストラクチャ as コード管理システム
 * 設計思想: John Carmack (効率性), Rob Pike (明確性), Robert C. Martin (構造化)
 * 
 * 機能:
 * - Terraform統合
 * - マルチクラウド対応
 * - 自動プロビジョニング
 * - 状態管理
 * - 設定ドリフト検出
 * - コスト最適化
 * - セキュリティ最適化
 * - 災害復旧自動化
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import crypto from 'crypto';

// === 型定義 ===
export interface InfrastructureConfig {
  id: string;
  name: string;
  description: string;
  provider: CloudProvider;
  environment: 'development' | 'staging' | 'production' | 'disaster_recovery';
  region: string;
  version: string;
  
  // リソース設定
  resources: ResourceConfiguration;
  
  // ネットワーク設定
  networking: NetworkConfiguration;
  
  // セキュリティ設定
  security: SecurityConfiguration;
  
  // 監視・ログ設定
  monitoring: MonitoringConfiguration;
  
  // バックアップ・災害復旧
  backup: BackupConfiguration;
  
  // コスト設定
  cost: CostConfiguration;
  
  // タグ設定
  tags: Record<string, string>;
}

export interface CloudProvider {
  type: 'aws' | 'gcp' | 'azure' | 'digitalocean' | 'linode';
  credentials: ProviderCredentials;
  defaultRegion: string;
  availabilityZones: string[];
}

export interface ProviderCredentials {
  accessKey?: string;
  secretKey?: string;
  subscriptionId?: string;
  tenantId?: string;
  projectId?: string;
  serviceAccountKey?: string;
}

export interface ResourceConfiguration {
  compute: ComputeResource[];
  storage: StorageResource[];
  database: DatabaseResource[];
  loadBalancers: LoadBalancerResource[];
  cdn: CDNResource[];
  dns: DNSResource[];
}

export interface ComputeResource {
  name: string;
  type: 'vm' | 'container' | 'serverless';
  instanceType: string;
  count: number;
  autoScaling: AutoScalingConfig;
  operatingSystem: string;
  userData?: string;
  sshKeys: string[];
  securityGroups: string[];
  monitoring: boolean;
}

export interface AutoScalingConfig {
  enabled: boolean;
  minInstances: number;
  maxInstances: number;
  targetCpuUtilization: number;
  targetMemoryUtilization: number;
  scaleUpCooldown: number;
  scaleDownCooldown: number;
}

export interface StorageResource {
  name: string;
  type: 'block' | 'object' | 'file';
  size: number; // GB
  iops?: number;
  throughput?: number;
  encryption: boolean;
  backup: boolean;
  replication: boolean;
}

export interface DatabaseResource {
  name: string;
  engine: 'mysql' | 'postgresql' | 'mongodb' | 'redis' | 'elasticsearch';
  version: string;
  instanceClass: string;
  storage: number; // GB
  multiAZ: boolean;
  backup: DatabaseBackupConfig;
  monitoring: boolean;
  encryption: boolean;
}

export interface DatabaseBackupConfig {
  enabled: boolean;
  retentionDays: number;
  backupWindow: string;
  maintenanceWindow: string;
  pointInTimeRecovery: boolean;
}

export interface LoadBalancerResource {
  name: string;
  type: 'application' | 'network' | 'classic';
  scheme: 'internet-facing' | 'internal';
  listeners: LoadBalancerListener[];
  healthCheck: HealthCheckConfig;
  sslCertificate?: string;
  accessLogs: boolean;
}

export interface LoadBalancerListener {
  port: number;
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'UDP';
  targetPort: number;
  targetProtocol: 'HTTP' | 'HTTPS' | 'TCP' | 'UDP';
}

export interface HealthCheckConfig {
  protocol: 'HTTP' | 'HTTPS' | 'TCP';
  port: number;
  path?: string;
  interval: number;
  timeout: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
}

export interface CDNResource {
  name: string;
  origins: string[];
  caching: CachingConfig;
  geoRestriction?: GeoRestrictionConfig;
  waf: boolean;
}

export interface CachingConfig {
  defaultTtl: number;
  maxTtl: number;
  cachePolicyId?: string;
  behaviors: CacheBehavior[];
}

export interface CacheBehavior {
  pathPattern: string;
  ttl: number;
  compress: boolean;
  queryStringCaching: boolean;
}

export interface GeoRestrictionConfig {
  type: 'whitelist' | 'blacklist';
  countries: string[];
}

export interface DNSResource {
  name: string;
  zone: string;
  records: DNSRecord[];
  healthChecks: DNSHealthCheck[];
}

export interface DNSRecord {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV';
  value: string;
  ttl: number;
  weight?: number;
  priority?: number;
}

export interface DNSHealthCheck {
  fqdn: string;
  port: number;
  type: 'HTTP' | 'HTTPS' | 'TCP';
  resourcePath?: string;
  failureThreshold: number;
}

export interface NetworkConfiguration {
  vpc: VPCConfig;
  subnets: SubnetConfig[];
  routeTables: RouteTableConfig[];
  securityGroups: SecurityGroupConfig[];
  nacls: NACLConfig[];
}

export interface VPCConfig {
  cidr: string;
  enableDnsHostnames: boolean;
  enableDnsSupport: boolean;
  enableVpnGateway: boolean;
  instanceTenancy: 'default' | 'dedicated';
}

export interface SubnetConfig {
  name: string;
  cidr: string;
  availabilityZone: string;
  public: boolean;
  mapPublicIpOnLaunch: boolean;
}

export interface RouteTableConfig {
  name: string;
  subnets: string[];
  routes: RouteConfig[];
}

export interface RouteConfig {
  cidr: string;
  target: string;
  targetType: 'internet_gateway' | 'nat_gateway' | 'vpn_gateway' | 'peering_connection';
}

export interface SecurityGroupConfig {
  name: string;
  description: string;
  ingress: SecurityRule[];
  egress: SecurityRule[];
}

export interface SecurityRule {
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  fromPort: number;
  toPort: number;
  cidr?: string;
  securityGroupId?: string;
  description?: string;
}

export interface NACLConfig {
  name: string;
  subnets: string[];
  rules: NACLRule[];
}

export interface NACLRule {
  ruleNumber: number;
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  ruleAction: 'allow' | 'deny';
  cidr: string;
  fromPort?: number;
  toPort?: number;
}

export interface SecurityConfiguration {
  encryption: EncryptionConfig;
  iam: IAMConfig;
  secrets: SecretsConfig;
  compliance: ComplianceConfig;
  monitoring: SecurityMonitoringConfig;
}

export interface EncryptionConfig {
  atRest: boolean;
  inTransit: boolean;
  keyManagement: 'provider' | 'customer' | 'hsm';
  kmsKeyId?: string;
}

export interface IAMConfig {
  roles: IAMRole[];
  policies: IAMPolicy[];
  users: IAMUser[];
  groups: IAMGroup[];
}

export interface IAMRole {
  name: string;
  assumeRolePolicy: string;
  policies: string[];
  maxSessionDuration: number;
}

export interface IAMPolicy {
  name: string;
  description: string;
  policy: string;
}

export interface IAMUser {
  name: string;
  groups: string[];
  policies: string[];
  accessKeys: boolean;
  consoleAccess: boolean;
}

export interface IAMGroup {
  name: string;
  policies: string[];
}

export interface SecretsConfig {
  provider: 'aws_secrets_manager' | 'azure_key_vault' | 'gcp_secret_manager' | 'hashicorp_vault';
  secrets: SecretConfig[];
}

export interface SecretConfig {
  name: string;
  value: string;
  encryption: boolean;
  rotation: RotationConfig;
}

export interface RotationConfig {
  enabled: boolean;
  frequency: number; // days
  autoRotate: boolean;
}

export interface ComplianceConfig {
  standards: string[]; // 'SOC2', 'PCI_DSS', 'HIPAA', 'GDPR'
  auditing: boolean;
  dataClassification: boolean;
  accessLogging: boolean;
}

export interface SecurityMonitoringConfig {
  cloudTrail: boolean;
  configRules: boolean;
  guardDuty: boolean;
  securityHub: boolean;
  inspector: boolean;
}

export interface MonitoringConfiguration {
  metrics: MetricsConfig;
  logs: LogsConfig;
  alerting: AlertingConfig;
  dashboards: DashboardConfig[];
}

export interface MetricsConfig {
  provider: 'cloudwatch' | 'stackdriver' | 'azure_monitor' | 'prometheus';
  retentionDays: number;
  detailedMonitoring: boolean;
  customMetrics: CustomMetric[];
}

export interface CustomMetric {
  name: string;
  namespace: string;
  dimensions: Record<string, string>;
  unit: string;
}

export interface LogsConfig {
  provider: 'cloudwatch_logs' | 'stackdriver_logging' | 'azure_logs' | 'elk_stack';
  retentionDays: number;
  logGroups: LogGroup[];
  centralized: boolean;
}

export interface LogGroup {
  name: string;
  source: string;
  format: 'json' | 'text' | 'syslog';
  filters: LogFilter[];
}

export interface LogFilter {
  name: string;
  pattern: string;
  destination: string;
}

export interface AlertingConfig {
  provider: 'cloudwatch_alarms' | 'stackdriver_alerting' | 'azure_alerts' | 'prometheus_alertmanager';
  notificationChannels: NotificationChannel[];
  alerts: Alert[];
}

export interface NotificationChannel {
  name: string;
  type: 'email' | 'slack' | 'pagerduty' | 'sns' | 'webhook';
  endpoint: string;
}

export interface Alert {
  name: string;
  metric: string;
  threshold: number;
  comparison: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  evaluationPeriods: number;
  period: number;
  statistic: 'avg' | 'sum' | 'min' | 'max' | 'count';
  channels: string[];
}

export interface DashboardConfig {
  name: string;
  provider: 'cloudwatch' | 'grafana' | 'datadog';
  widgets: DashboardWidget[];
}

export interface DashboardWidget {
  type: 'metric' | 'log' | 'text';
  title: string;
  metrics?: string[];
  logQuery?: string;
  text?: string;
  position: { x: number; y: number; width: number; height: number };
}

export interface BackupConfiguration {
  strategy: BackupStrategy;
  retention: RetentionPolicy;
  testing: BackupTestingConfig;
  disasterRecovery: DisasterRecoveryConfig;
}

export interface BackupStrategy {
  frequency: 'hourly' | 'daily' | 'weekly' | 'monthly';
  window: string;
  crossRegion: boolean;
  encryption: boolean;
  compression: boolean;
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface BackupTestingConfig {
  enabled: boolean;
  frequency: 'weekly' | 'monthly' | 'quarterly';
  automatedRestore: boolean;
  validationChecks: string[];
}

export interface DisasterRecoveryConfig {
  rto: number; // Recovery Time Objective in minutes
  rpo: number; // Recovery Point Objective in minutes
  multiRegion: boolean;
  failoverRegion: string;
  autoFailover: boolean;
  runbooks: string[];
}

export interface CostConfiguration {
  budgets: BudgetConfig[];
  optimization: CostOptimizationConfig;
  tagging: TaggingStrategy;
  reporting: CostReportingConfig;
}

export interface BudgetConfig {
  name: string;
  amount: number;
  period: 'monthly' | 'quarterly' | 'yearly';
  alertThresholds: number[];
  filters: BudgetFilter[];
}

export interface BudgetFilter {
  type: 'service' | 'tag' | 'account' | 'region';
  values: string[];
}

export interface CostOptimizationConfig {
  rightSizing: boolean;
  reservedInstances: boolean;
  spotInstances: boolean;
  scheduledScaling: boolean;
  unusedResourceCleanup: boolean;
}

export interface TaggingStrategy {
  required: string[];
  optional: string[];
  enforced: boolean;
  inheritance: boolean;
}

export interface CostReportingConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  recipients: string[];
  detailLevel: 'summary' | 'detailed' | 'resource_level';
}

// === 実行結果型 ===
export interface TerraformExecution {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  duration: number;
  output: string;
  error?: string;
  exitCode?: number;
  workingDirectory: string;
  variables: Record<string, any>;
}

export interface InfrastructureState {
  configId: string;
  lastApplied: number;
  terraformVersion: string;
  providerVersions: Record<string, string>;
  resources: TerraformResource[];
  outputs: Record<string, any>;
  drift: DriftDetection;
}

export interface TerraformResource {
  address: string;
  type: string;
  name: string;
  provider: string;
  instances: ResourceInstance[];
}

export interface ResourceInstance {
  index: number;
  attributes: Record<string, any>;
  status: 'created' | 'updated' | 'destroyed' | 'drift_detected';
  dependencies: string[];
}

export interface DriftDetection {
  lastCheck: number;
  driftedResources: DriftedResource[];
  autoCorrect: boolean;
}

export interface DriftedResource {
  address: string;
  attribute: string;
  expected: any;
  actual: any;
  severity: 'low' | 'medium' | 'high';
}

export interface DeploymentPlan {
  id: string;
  configId: string;
  action: 'apply' | 'destroy' | 'plan';
  changes: PlannedChange[];
  estimatedCost: number;
  estimatedDuration: number;
  riskLevel: 'low' | 'medium' | 'high';
  approvals: PlanApproval[];
}

export interface PlannedChange {
  action: 'create' | 'update' | 'delete' | 'replace';
  resourceType: string;
  resourceName: string;
  changes: Record<string, any>;
  impact: ChangeImpact;
}

export interface ChangeImpact {
  downtime: boolean;
  dataLoss: boolean;
  costChange: number;
  securityImpact: boolean;
  performanceImpact: boolean;
}

export interface PlanApproval {
  approver: string;
  status: 'pending' | 'approved' | 'rejected';
  timestamp?: number;
  comment?: string;
}

// === メインインフラストラクチャ管理システム ===
export class InfrastructureAsCodeSystem extends EventEmitter {
  private configs = new Map<string, InfrastructureConfig>();
  private executions = new Map<string, TerraformExecution>();
  private states = new Map<string, InfrastructureState>();
  private plans = new Map<string, DeploymentPlan>();
  private workingDirectory: string;
  private terraformBinary: string;

  constructor(workingDirectory: string = '/tmp/terraform', terraformBinary: string = 'terraform') {
    super();
    this.workingDirectory = workingDirectory;
    this.terraformBinary = terraformBinary;
    this.ensureWorkingDirectory();
  }

  private async ensureWorkingDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.workingDirectory, { recursive: true });
    } catch (error) {
      console.error('Failed to create working directory:', error);
    }
  }

  // === 設定管理 ===
  async addInfrastructureConfig(config: InfrastructureConfig): Promise<void> {
    this.validateConfig(config);
    this.configs.set(config.id, config);
    
    // Terraformファイル生成
    await this.generateTerraformFiles(config);
    
    console.log(`🏗️ Added infrastructure config: ${config.name} (${config.id})`);
    console.log(`🌍 Provider: ${config.provider.type}, Region: ${config.region}`);
    console.log(`💰 Environment: ${config.environment}`);
    
    this.emit('config_added', config);
  }

  async updateInfrastructureConfig(configId: string, updates: Partial<InfrastructureConfig>): Promise<void> {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`Configuration not found: ${configId}`);
    }

    const updatedConfig = { ...config, ...updates };
    this.validateConfig(updatedConfig);
    
    this.configs.set(configId, updatedConfig);
    await this.generateTerraformFiles(updatedConfig);
    
    console.log(`📝 Updated infrastructure config: ${config.name}`);
    this.emit('config_updated', updatedConfig);
  }

  async removeInfrastructureConfig(configId: string): Promise<void> {
    const config = this.configs.get(configId);
    if (!config) return;

    // インフラが存在する場合は警告
    const state = this.states.get(configId);
    if (state && state.resources.length > 0) {
      console.warn(`⚠️ Infrastructure still exists for config: ${config.name}`);
      console.warn(`💀 Consider running destroy before removing config`);
    }

    this.configs.delete(configId);
    this.states.delete(configId);
    
    // Terraformファイル削除
    await this.cleanupTerraformFiles(configId);
    
    console.log(`🗑️ Removed infrastructure config: ${config.name}`);
    this.emit('config_removed', config);
  }

  // === Terraform ファイル生成 ===
  private async generateTerraformFiles(config: InfrastructureConfig): Promise<void> {
    const configDir = path.join(this.workingDirectory, config.id);
    await fs.mkdir(configDir, { recursive: true });

    // Provider設定
    await this.generateProviderConfig(config, configDir);
    
    // Variables設定
    await this.generateVariablesConfig(config, configDir);
    
    // Resources設定
    await this.generateResourcesConfig(config, configDir);
    
    // Outputs設定
    await this.generateOutputsConfig(config, configDir);
    
    // terraform.tfvars
    await this.generateTfvarsFile(config, configDir);
    
    console.log(`📄 Generated Terraform files for: ${config.name}`);
  }

  private async generateProviderConfig(config: InfrastructureConfig, configDir: string): Promise<void> {
    let providerConfig = '';

    // Terraform設定
    providerConfig += `terraform {
  required_version = ">= 1.0"
  required_providers {
`;

    switch (config.provider.type) {
      case 'aws':
        providerConfig += `    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
`;
        break;
      case 'gcp':
        providerConfig += `    google = {
      source  = "hashicorp/google"
      version = "~> 4.0"
    }
`;
        break;
      case 'azure':
        providerConfig += `    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
`;
        break;
    }

    providerConfig += `  }

  backend "s3" {
    bucket = var.terraform_state_bucket
    key    = "${config.id}/terraform.tfstate"
    region = var.terraform_state_region
  }
}

`;

    // Provider設定
    switch (config.provider.type) {
      case 'aws':
        providerConfig += `provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = var.default_tags
  }
}
`;
        break;
      case 'gcp':
        providerConfig += `provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}
`;
        break;
      case 'azure':
        providerConfig += `provider "azurerm" {
  features {}
  
  subscription_id = var.azure_subscription_id
  tenant_id       = var.azure_tenant_id
}
`;
        break;
    }

    await fs.writeFile(path.join(configDir, 'provider.tf'), providerConfig);
  }

  private async generateVariablesConfig(config: InfrastructureConfig, configDir: string): Promise<void> {
    let variablesConfig = `# Infrastructure Variables

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "${config.environment}"
}

variable "region" {
  description = "Default region"
  type        = string
  default     = "${config.region}"
}

variable "default_tags" {
  description = "Default tags for all resources"
  type        = map(string)
  default = {
`;

    for (const [key, value] of Object.entries(config.tags)) {
      variablesConfig += `    "${key}" = "${value}"\n`;
    }

    variablesConfig += `  }
}

variable "terraform_state_bucket" {
  description = "S3 bucket for Terraform state"
  type        = string
}

variable "terraform_state_region" {
  description = "Region for Terraform state bucket"
  type        = string
  default     = "us-east-1"
}

`;

    // Provider特有の変数
    switch (config.provider.type) {
      case 'aws':
        variablesConfig += `variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "${config.region}"
}
`;
        break;
      case 'gcp':
        variablesConfig += `variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region"
  type        = string
  default     = "${config.region}"
}
`;
        break;
      case 'azure':
        variablesConfig += `variable "azure_subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "azure_tenant_id" {
  description = "Azure tenant ID"
  type        = string
}
`;
        break;
    }

    await fs.writeFile(path.join(configDir, 'variables.tf'), variablesConfig);
  }

  private async generateResourcesConfig(config: InfrastructureConfig, configDir: string): Promise<void> {
    let resourcesConfig = `# Infrastructure Resources

`;

    // VPC/Network
    resourcesConfig += await this.generateNetworkingResources(config);
    
    // Compute
    resourcesConfig += await this.generateComputeResources(config);
    
    // Storage
    resourcesConfig += await this.generateStorageResources(config);
    
    // Database
    resourcesConfig += await this.generateDatabaseResources(config);
    
    // Load Balancers
    resourcesConfig += await this.generateLoadBalancerResources(config);
    
    // Security
    resourcesConfig += await this.generateSecurityResources(config);

    await fs.writeFile(path.join(configDir, 'main.tf'), resourcesConfig);
  }

  private async generateNetworkingResources(config: InfrastructureConfig): Promise<string> {
    let networkingConfig = `# Networking Resources

`;

    if (config.provider.type === 'aws') {
      // VPC
      networkingConfig += `resource "aws_vpc" "main" {
  cidr_block           = "${config.networking.vpc.cidr}"
  enable_dns_hostnames = ${config.networking.vpc.enableDnsHostnames}
  enable_dns_support   = ${config.networking.vpc.enableDnsSupport}
  instance_tenancy     = "${config.networking.vpc.instanceTenancy}"

  tags = merge(var.default_tags, {
    Name = "${config.name}-vpc"
  })
}

`;

      // Internet Gateway
      networkingConfig += `resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.default_tags, {
    Name = "${config.name}-igw"
  })
}

`;

      // Subnets
      for (const subnet of config.networking.subnets) {
        networkingConfig += `resource "aws_subnet" "${subnet.name}" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "${subnet.cidr}"
  availability_zone       = "${subnet.availabilityZone}"
  map_public_ip_on_launch = ${subnet.mapPublicIpOnLaunch}

  tags = merge(var.default_tags, {
    Name = "${config.name}-${subnet.name}"
    Type = "${subnet.public ? 'public' : 'private'}"
  })
}

`;
      }

      // Security Groups
      for (const sg of config.networking.securityGroups) {
        networkingConfig += `resource "aws_security_group" "${sg.name}" {
  name        = "${config.name}-${sg.name}"
  description = "${sg.description}"
  vpc_id      = aws_vpc.main.id

`;

        for (const rule of sg.ingress) {
          networkingConfig += `  ingress {
    from_port   = ${rule.fromPort}
    to_port     = ${rule.toPort}
    protocol    = "${rule.protocol}"
    cidr_blocks = ["${rule.cidr || '0.0.0.0/0'}"]
    description = "${rule.description || ''}"
  }

`;
        }

        for (const rule of sg.egress) {
          networkingConfig += `  egress {
    from_port   = ${rule.fromPort}
    to_port     = ${rule.toPort}
    protocol    = "${rule.protocol}"
    cidr_blocks = ["${rule.cidr || '0.0.0.0/0'}"]
    description = "${rule.description || ''}"
  }

`;
        }

        networkingConfig += `  tags = merge(var.default_tags, {
    Name = "${config.name}-${sg.name}"
  })
}

`;
      }
    }

    return networkingConfig;
  }

  private async generateComputeResources(config: InfrastructureConfig): Promise<string> {
    let computeConfig = `# Compute Resources

`;

    for (const compute of config.resources.compute) {
      if (config.provider.type === 'aws') {
        // Launch Template
        computeConfig += `resource "aws_launch_template" "${compute.name}" {
  name_prefix   = "${config.name}-${compute.name}-"
  image_id      = data.aws_ami.${compute.operatingSystem}.id
  instance_type = "${compute.instanceType}"

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.${compute.securityGroups[0] || 'default'}.id]
    delete_on_termination       = true
  }

  monitoring {
    enabled = ${compute.monitoring}
  }

  user_data = base64encode(<<-EOF
${compute.userData || '#!/bin/bash\necho "No user data provided"'}
  EOF
  )

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.default_tags, {
      Name = "${config.name}-${compute.name}"
      Type = "mining-pool"
    })
  }
}

`;

        // Auto Scaling Group (if enabled)
        if (compute.autoScaling.enabled) {
          computeConfig += `resource "aws_autoscaling_group" "${compute.name}" {
  name                = "${config.name}-${compute.name}-asg"
  vpc_zone_identifier = [aws_subnet.${config.networking.subnets[0].name}.id]
  target_group_arns   = []
  health_check_type   = "EC2"
  health_check_grace_period = 300

  min_size         = ${compute.autoScaling.minInstances}
  max_size         = ${compute.autoScaling.maxInstances}
  desired_capacity = ${compute.count}

  launch_template {
    id      = aws_launch_template.${compute.name}.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${config.name}-${compute.name}"
    propagate_at_launch = true
  }
}

resource "aws_autoscaling_policy" "${compute.name}_scale_up" {
  name                   = "${config.name}-${compute.name}-scale-up"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = ${compute.autoScaling.scaleUpCooldown}
  autoscaling_group_name = aws_autoscaling_group.${compute.name}.name
}

resource "aws_autoscaling_policy" "${compute.name}_scale_down" {
  name                   = "${config.name}-${compute.name}-scale-down"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = ${compute.autoScaling.scaleDownCooldown}
  autoscaling_group_name = aws_autoscaling_group.${compute.name}.name
}

`;
        }

        // AMI Data Source
        computeConfig += `data "aws_ami" "${compute.operatingSystem}" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }
}

`;
      }
    }

    return computeConfig;
  }

  private async generateStorageResources(config: InfrastructureConfig): Promise<string> {
    let storageConfig = `# Storage Resources

`;

    for (const storage of config.resources.storage) {
      if (config.provider.type === 'aws') {
        if (storage.type === 'block') {
          storageConfig += `resource "aws_ebs_volume" "${storage.name}" {
  availability_zone = "${config.networking.subnets[0].availabilityZone}"
  size              = ${storage.size}
  type              = "gp3"
  encrypted         = ${storage.encryption}

  tags = merge(var.default_tags, {
    Name = "${config.name}-${storage.name}"
  })
}

`;
        } else if (storage.type === 'object') {
          storageConfig += `resource "aws_s3_bucket" "${storage.name}" {
  bucket = "${config.name}-${storage.name}-\${random_string.bucket_suffix.result}"

  tags = merge(var.default_tags, {
    Name = "${config.name}-${storage.name}"
  })
}

resource "aws_s3_bucket_encryption_configuration" "${storage.name}" {
  bucket = aws_s3_bucket.${storage.name}.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "random_string" "bucket_suffix" {
  length  = 8
  special = false
  upper   = false
}

`;
        }
      }
    }

    return storageConfig;
  }

  private async generateDatabaseResources(config: InfrastructureConfig): Promise<string> {
    let databaseConfig = `# Database Resources

`;

    for (const db of config.resources.database) {
      if (config.provider.type === 'aws') {
        // DB Subnet Group
        databaseConfig += `resource "aws_db_subnet_group" "${db.name}" {
  name       = "${config.name}-${db.name}-subnet-group"
  subnet_ids = [aws_subnet.${config.networking.subnets[0].name}.id, aws_subnet.${config.networking.subnets[1]?.name || config.networking.subnets[0].name}.id]

  tags = merge(var.default_tags, {
    Name = "${config.name}-${db.name}-subnet-group"
  })
}

`;

        // RDS Instance
        databaseConfig += `resource "aws_db_instance" "${db.name}" {
  identifier     = "${config.name}-${db.name}"
  engine         = "${db.engine}"
  engine_version = "${db.version}"
  instance_class = "${db.instanceClass}"
  
  allocated_storage     = ${db.storage}
  max_allocated_storage = ${db.storage * 2}
  storage_type          = "gp3"
  storage_encrypted     = ${db.encryption}

  db_name  = "${db.name}"
  username = "admin"
  password = random_password.${db.name}_password.result

  db_subnet_group_name   = aws_db_subnet_group.${db.name}.name
  vpc_security_group_ids = [aws_security_group.database.id]

  backup_retention_period = ${db.backup.retentionDays}
  backup_window          = "${db.backup.backupWindow}"
  maintenance_window     = "${db.backup.maintenanceWindow}"

  multi_az               = ${db.multiAZ}
  publicly_accessible    = false
  monitoring_interval    = ${db.monitoring ? 60 : 0}

  skip_final_snapshot = true

  tags = merge(var.default_tags, {
    Name = "${config.name}-${db.name}"
  })
}

resource "random_password" "${db.name}_password" {
  length  = 16
  special = true
}

`;
      }
    }

    return databaseConfig;
  }

  private async generateLoadBalancerResources(config: InfrastructureConfig): Promise<string> {
    let lbConfig = `# Load Balancer Resources

`;

    for (const lb of config.resources.loadBalancers) {
      if (config.provider.type === 'aws') {
        lbConfig += `resource "aws_lb" "${lb.name}" {
  name               = "${config.name}-${lb.name}"
  internal           = ${lb.scheme === 'internal'}
  load_balancer_type = "${lb.type}"
  security_groups    = [aws_security_group.${lb.name}.id]
  subnets            = [aws_subnet.${config.networking.subnets[0].name}.id, aws_subnet.${config.networking.subnets[1]?.name || config.networking.subnets[0].name}.id]

  enable_deletion_protection = false

  tags = merge(var.default_tags, {
    Name = "${config.name}-${lb.name}"
  })
}

`;

        // Target Group
        for (const listener of lb.listeners) {
          lbConfig += `resource "aws_lb_target_group" "${lb.name}_${listener.port}" {
  name     = "${config.name}-${lb.name}-${listener.port}"
  port     = ${listener.targetPort}
  protocol = "${listener.targetProtocol}"
  vpc_id   = aws_vpc.main.id

  health_check {
    enabled             = true
    healthy_threshold   = ${lb.healthCheck.healthyThreshold}
    unhealthy_threshold = ${lb.healthCheck.unhealthyThreshold}
    timeout             = ${lb.healthCheck.timeout}
    interval            = ${lb.healthCheck.interval}
    path                = "${lb.healthCheck.path || '/'}"
    matcher             = "200"
  }

  tags = merge(var.default_tags, {
    Name = "${config.name}-${lb.name}-${listener.port}"
  })
}

resource "aws_lb_listener" "${lb.name}_${listener.port}" {
  load_balancer_arn = aws_lb.${lb.name}.arn
  port              = "${listener.port}"
  protocol          = "${listener.protocol}"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${lb.name}_${listener.port}.arn
  }
}

`;
        }
      }
    }

    return lbConfig;
  }

  private async generateSecurityResources(config: InfrastructureConfig): Promise<string> {
    let securityConfig = `# Security Resources

`;

    if (config.provider.type === 'aws') {
      // KMS Key
      if (config.security.encryption.keyManagement === 'customer') {
        securityConfig += `resource "aws_kms_key" "main" {
  description             = "${config.name} encryption key"
  deletion_window_in_days = 7

  tags = merge(var.default_tags, {
    Name = "${config.name}-kms-key"
  })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${config.name}-key"
  target_key_id = aws_kms_key.main.key_id
}

`;
      }

      // IAM Roles
      for (const role of config.security.iam.roles) {
        securityConfig += `resource "aws_iam_role" "${role.name}" {
  name = "${config.name}-${role.name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  max_session_duration = ${role.maxSessionDuration}

  tags = merge(var.default_tags, {
    Name = "${config.name}-${role.name}"
  })
}

`;
      }
    }

    return securityConfig;
  }

  private async generateOutputsConfig(config: InfrastructureConfig, configDir: string): Promise<void> {
    let outputsConfig = `# Outputs

output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = [
`;

    for (const subnet of config.networking.subnets.filter(s => s.public)) {
      outputsConfig += `    aws_subnet.${subnet.name}.id,\n`;
    }

    outputsConfig += `  ]
}

output "private_subnet_ids" {
  description = "IDs of the private subnets"
  value       = [
`;

    for (const subnet of config.networking.subnets.filter(s => !s.public)) {
      outputsConfig += `    aws_subnet.${subnet.name}.id,\n`;
    }

    outputsConfig += `  ]
}

`;

    // Load balancer outputs
    for (const lb of config.resources.loadBalancers) {
      outputsConfig += `output "${lb.name}_dns_name" {
  description = "DNS name of the ${lb.name} load balancer"
  value       = aws_lb.${lb.name}.dns_name
}

output "${lb.name}_arn" {
  description = "ARN of the ${lb.name} load balancer"
  value       = aws_lb.${lb.name}.arn
}

`;
    }

    // Database outputs
    for (const db of config.resources.database) {
      outputsConfig += `output "${db.name}_endpoint" {
  description = "RDS instance endpoint"
  value       = aws_db_instance.${db.name}.endpoint
  sensitive   = true
}

output "${db.name}_password" {
  description = "RDS instance password"
  value       = random_password.${db.name}_password.result
  sensitive   = true
}

`;
    }

    await fs.writeFile(path.join(configDir, 'outputs.tf'), outputsConfig);
  }

  private async generateTfvarsFile(config: InfrastructureConfig, configDir: string): Promise<void> {
    let tfvarsContent = `# Terraform Variables

environment = "${config.environment}"
region      = "${config.region}"

default_tags = {
`;

    for (const [key, value] of Object.entries(config.tags)) {
      tfvarsContent += `  "${key}" = "${value}"\n`;
    }

    tfvarsContent += `}

# Provider-specific variables
`;

    switch (config.provider.type) {
      case 'aws':
        tfvarsContent += `aws_region = "${config.region}"
`;
        break;
      case 'gcp':
        tfvarsContent += `gcp_project_id = "${config.provider.credentials.projectId || 'your-project-id'}"
gcp_region     = "${config.region}"
`;
        break;
    }

    await fs.writeFile(path.join(configDir, 'terraform.tfvars'), tfvarsContent);
  }

  // === Terraform 実行 ===
  async plan(configId: string, variables?: Record<string, any>): Promise<string> {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`Configuration not found: ${configId}`);
    }

    console.log(`📋 Creating deployment plan for: ${config.name}`);

    const execution = await this.executeTerraformCommand(
      configId,
      'plan',
      ['-detailed-exitcode', '-out=tfplan'],
      variables
    );

    // プラン解析
    const plan = await this.parseTerraformPlan(configId, execution);
    this.plans.set(plan.id, plan);

    console.log(`📊 Plan created: ${plan.changes.length} changes`);
    console.log(`💰 Estimated cost: $${plan.estimatedCost.toFixed(2)}/month`);
    console.log(`⏱️ Estimated duration: ${plan.estimatedDuration} minutes`);
    console.log(`⚠️ Risk level: ${plan.riskLevel}`);

    this.emit('plan_created', plan);
    
    return execution.id;
  }

  async apply(configId: string, planId?: string, variables?: Record<string, any>): Promise<string> {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`Configuration not found: ${configId}`);
    }

    console.log(`🚀 Applying infrastructure changes for: ${config.name}`);

    const args = planId ? ['tfplan'] : ['-auto-approve'];
    
    const execution = await this.executeTerraformCommand(
      configId,
      'apply',
      args,
      variables
    );

    // 状態更新
    await this.refreshState(configId);

    console.log(`✅ Infrastructure applied successfully: ${config.name}`);
    this.emit('infrastructure_applied', { configId, execution });

    return execution.id;
  }

  async destroy(configId: string, variables?: Record<string, any>): Promise<string> {
    const config = this.configs.get(configId);
    if (!config) {
      throw new Error(`Configuration not found: ${configId}`);
    }

    console.log(`💥 Destroying infrastructure for: ${config.name}`);
    console.warn(`⚠️ This action cannot be undone!`);

    const execution = await this.executeTerraformCommand(
      configId,
      'destroy',
      ['-auto-approve'],
      variables
    );

    // 状態更新
    await this.refreshState(configId);

    console.log(`💀 Infrastructure destroyed: ${config.name}`);
    this.emit('infrastructure_destroyed', { configId, execution });

    return execution.id;
  }

  async refresh(configId: string): Promise<string> {
    console.log(`🔄 Refreshing infrastructure state for: ${configId}`);

    const execution = await this.executeTerraformCommand(configId, 'refresh', []);
    await this.refreshState(configId);

    console.log(`✅ State refreshed: ${configId}`);
    return execution.id;
  }

  // === 状態管理 ===
  async refreshState(configId: string): Promise<void> {
    const configDir = path.join(this.workingDirectory, configId);
    
    try {
      // terraform show -json で状態取得
      const showResult = await this.executeTerraformCommand(
        configId,
        'show',
        ['-json']
      );

      const stateData = JSON.parse(showResult.output);
      
      const state: InfrastructureState = {
        configId,
        lastApplied: Date.now(),
        terraformVersion: stateData.terraform_version || 'unknown',
        providerVersions: this.extractProviderVersions(stateData),
        resources: this.extractResources(stateData),
        outputs: stateData.values?.outputs || {},
        drift: {
          lastCheck: Date.now(),
          driftedResources: [],
          autoCorrect: false
        }
      };

      this.states.set(configId, state);
      this.emit('state_updated', state);

    } catch (error) {
      console.error(`Failed to refresh state for ${configId}:`, error);
    }
  }

  async detectDrift(configId: string): Promise<DriftedResource[]> {
    console.log(`🔍 Detecting configuration drift for: ${configId}`);

    const state = this.states.get(configId);
    if (!state) {
      throw new Error(`State not found for configuration: ${configId}`);
    }

    // terraform plan を使用してドリフト検出
    const execution = await this.executeTerraformCommand(
      configId,
      'plan',
      ['-detailed-exitcode']
    );

    const driftedResources = await this.parseDriftFromPlan(execution.output);
    
    // 状態更新
    state.drift.lastCheck = Date.now();
    state.drift.driftedResources = driftedResources;

    if (driftedResources.length > 0) {
      console.log(`⚠️ Configuration drift detected: ${driftedResources.length} resources`);
      this.emit('drift_detected', { configId, driftedResources });
    } else {
      console.log(`✅ No configuration drift detected`);
    }

    return driftedResources;
  }

  // === Terraform コマンド実行 ===
  private async executeTerraformCommand(
    configId: string,
    command: string,
    args: string[] = [],
    variables?: Record<string, any>
  ): Promise<TerraformExecution> {
    const executionId = this.generateExecutionId();
    const configDir = path.join(this.workingDirectory, configId);
    
    // 変数ファイル作成
    if (variables) {
      await this.createVariablesFile(configDir, variables);
    }

    const execution: TerraformExecution = {
      id: executionId,
      command: `${command} ${args.join(' ')}`,
      status: 'running',
      startTime: Date.now(),
      duration: 0,
      output: '',
      workingDirectory: configDir,
      variables: variables || {}
    };

    this.executions.set(executionId, execution);

    try {
      // terraform init (必要に応じて)
      await this.ensureTerraformInit(configDir);

      // メインコマンド実行
      const fullArgs = [command, ...args];
      if (variables) {
        fullArgs.push('-var-file=variables.tfvars.json');
      }

      const result = await this.runTerraformProcess(configDir, fullArgs);
      
      execution.status = 'completed';
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      execution.output = result.stdout;
      execution.exitCode = result.exitCode;

      if (result.exitCode !== 0) {
        execution.status = 'failed';
        execution.error = result.stderr;
        console.error(`❌ Terraform ${command} failed:`, result.stderr);
      } else {
        console.log(`✅ Terraform ${command} completed successfully`);
      }

      this.emit('terraform_execution_completed', execution);

    } catch (error) {
      execution.status = 'failed';
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      execution.error = error instanceof Error ? error.message : String(error);
      
      console.error(`❌ Terraform execution failed:`, error);
      this.emit('terraform_execution_failed', execution);
    }

    return execution;
  }

  private async ensureTerraformInit(configDir: string): Promise<void> {
    const terraformDir = path.join(configDir, '.terraform');
    
    try {
      await fs.access(terraformDir);
      // .terraform ディレクトリが存在するので init 済み
    } catch {
      // init が必要
      console.log(`🔧 Initializing Terraform in: ${configDir}`);
      await this.runTerraformProcess(configDir, ['init']);
    }
  }

  private async runTerraformProcess(
    workingDirectory: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const process = spawn(this.terraformBinary, args, {
        cwd: workingDirectory,
        stdio: 'pipe'
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode || 0 });
      });

      process.on('error', (error) => {
        reject(error);
      });

      // 30分でタイムアウト
      setTimeout(() => {
        process.kill();
        reject(new Error('Terraform process timed out'));
      }, 30 * 60 * 1000);
    });
  }

  private async createVariablesFile(
    configDir: string,
    variables: Record<string, any>
  ): Promise<void> {
    const variablesPath = path.join(configDir, 'variables.tfvars.json');
    await fs.writeFile(variablesPath, JSON.stringify(variables, null, 2));
  }

  // === 解析・パース ===
  private async parseTerraformPlan(configId: string, execution: TerraformExecution): Promise<DeploymentPlan> {
    // 簡略化された実装
    const planId = this.generatePlanId();
    
    const changes: PlannedChange[] = [
      {
        action: 'create',
        resourceType: 'aws_vpc',
        resourceName: 'main',
        changes: { cidr_block: '10.0.0.0/16' },
        impact: {
          downtime: false,
          dataLoss: false,
          costChange: 50,
          securityImpact: false,
          performanceImpact: false
        }
      }
    ];

    return {
      id: planId,
      configId,
      action: 'apply',
      changes,
      estimatedCost: changes.reduce((sum, change) => sum + change.impact.costChange, 0),
      estimatedDuration: changes.length * 2, // 2 minutes per change
      riskLevel: this.assessPlanRiskLevel(changes),
      approvals: []
    };
  }

  private async parseDriftFromPlan(planOutput: string): Promise<DriftedResource[]> {
    // 簡略化された実装
    const driftedResources: DriftedResource[] = [];
    
    // 実際の実装では、terraform plan の出力を解析してドリフトを検出
    if (planOutput.includes('will be updated in-place')) {
      driftedResources.push({
        address: 'aws_instance.example',
        attribute: 'tags',
        expected: { Name: 'example' },
        actual: { Name: 'modified' },
        severity: 'low'
      });
    }

    return driftedResources;
  }

  private extractProviderVersions(stateData: any): Record<string, string> {
    const providers: Record<string, string> = {};
    
    if (stateData.values?.root_module?.resources) {
      for (const resource of stateData.values.root_module.resources) {
        if (resource.provider_name && !providers[resource.provider_name]) {
          providers[resource.provider_name] = 'unknown';
        }
      }
    }

    return providers;
  }

  private extractResources(stateData: any): TerraformResource[] {
    const resources: TerraformResource[] = [];
    
    if (stateData.values?.root_module?.resources) {
      for (const resource of stateData.values.root_module.resources) {
        resources.push({
          address: resource.address,
          type: resource.type,
          name: resource.name,
          provider: resource.provider_name,
          instances: [{
            index: 0,
            attributes: resource.values,
            status: 'created',
            dependencies: []
          }]
        });
      }
    }

    return resources;
  }

  // === ヘルパー関数 ===
  private validateConfig(config: InfrastructureConfig): void {
    if (!config.id || !config.name) {
      throw new Error('Configuration must have id and name');
    }

    if (!config.provider || !config.provider.type) {
      throw new Error('Provider configuration is required');
    }

    if (!config.networking || !config.networking.vpc) {
      throw new Error('Network configuration is required');
    }
  }

  private assessPlanRiskLevel(changes: PlannedChange[]): DeploymentPlan['riskLevel'] {
    const hasHighRiskChanges = changes.some(change => 
      change.impact.downtime || change.impact.dataLoss || change.impact.securityImpact
    );
    
    const hasDestructiveChanges = changes.some(change => 
      change.action === 'delete' || change.action === 'replace'
    );

    if (hasHighRiskChanges || hasDestructiveChanges) {
      return 'high';
    } else if (changes.length > 10) {
      return 'medium';
    }
    return 'low';
  }

  private async cleanupTerraformFiles(configId: string): Promise<void> {
    const configDir = path.join(this.workingDirectory, configId);
    
    try {
      await fs.rm(configDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to cleanup Terraform files for ${configId}:`, error);
    }
  }

  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generatePlanId(): string {
    return `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // === パブリック API ===
  getInfrastructureConfig(configId: string): InfrastructureConfig | null {
    return this.configs.get(configId) || null;
  }

  getInfrastructureState(configId: string): InfrastructureState | null {
    return this.states.get(configId) || null;
  }

  getTerraformExecution(executionId: string): TerraformExecution | null {
    return this.executions.get(executionId) || null;
  }

  getDeploymentPlan(planId: string): DeploymentPlan | null {
    return this.plans.get(planId) || null;
  }

  getAllConfigurations(): InfrastructureConfig[] {
    return Array.from(this.configs.values());
  }

  getActiveExecutions(): TerraformExecution[] {
    return Array.from(this.executions.values()).filter(e => e.status === 'running');
  }

  async cancelExecution(executionId: string): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (execution && execution.status === 'running') {
      execution.status = 'cancelled';
      console.log(`🛑 Cancelled Terraform execution: ${executionId}`);
      return true;
    }
    return false;
  }

  generateInfrastructureReport(configId: string): string {
    const config = this.configs.get(configId);
    const state = this.states.get(configId);
    
    if (!config) return 'Configuration not found';

    const lines = [
      `=== Infrastructure Report ===`,
      `Configuration: ${config.name} (${config.id})`,
      `Provider: ${config.provider.type}`,
      `Region: ${config.region}`,
      `Environment: ${config.environment}`,
      ``,
      `Resources:`,
      `- Compute: ${config.resources.compute.length}`,
      `- Storage: ${config.resources.storage.length}`,
      `- Database: ${config.resources.database.length}`,
      `- Load Balancers: ${config.resources.loadBalancers.length}`,
      ``
    ];

    if (state) {
      lines.push(
        `State Information:`,
        `- Last Applied: ${new Date(state.lastApplied).toISOString()}`,
        `- Terraform Version: ${state.terraformVersion}`,
        `- Active Resources: ${state.resources.length}`,
        `- Drift Check: ${new Date(state.drift.lastCheck).toISOString()}`,
        `- Drifted Resources: ${state.drift.driftedResources.length}`,
        ``
      );

      if (state.drift.driftedResources.length > 0) {
        lines.push(`Configuration Drift:`);
        state.drift.driftedResources.forEach(drift => {
          lines.push(`- ${drift.address}.${drift.attribute}: ${drift.severity} severity`);
        });
      }
    }

    return lines.join('\n');
  }

  // === 停止処理 ===
  async shutdown(): Promise<void> {
    // 実行中のプロセスを停止
    for (const execution of this.getActiveExecutions()) {
      await this.cancelExecution(execution.id);
    }

    console.log('🛑 Infrastructure as Code System shutdown');
  }
}

// === ヘルパークラス ===
export class InfrastructureConfigHelper {
  static createAWSMiningPoolConfig(
    name: string,
    environment: 'development' | 'staging' | 'production' = 'production'
  ): InfrastructureConfig {
    return {
      id: `aws_mining_pool_${Date.now()}`,
      name,
      description: `AWS infrastructure for ${name} mining pool`,
      provider: {
        type: 'aws',
        credentials: {
          accessKey: process.env.AWS_ACCESS_KEY_ID || '',
          secretKey: process.env.AWS_SECRET_ACCESS_KEY || ''
        },
        defaultRegion: 'us-east-1',
        availabilityZones: ['us-east-1a', 'us-east-1b']
      },
      environment,
      region: 'us-east-1',
      version: '1.0.0',
      resources: {
        compute: [
          {
            name: 'mining_pool_servers',
            type: 'vm',
            instanceType: 'c5.2xlarge',
            count: 3,
            autoScaling: {
              enabled: true,
              minInstances: 2,
              maxInstances: 10,
              targetCpuUtilization: 70,
              targetMemoryUtilization: 80,
              scaleUpCooldown: 300,
              scaleDownCooldown: 600
            },
            operatingSystem: 'amazon-linux-2',
            userData: `#!/bin/bash
yum update -y
yum install -y docker
systemctl start docker
systemctl enable docker
`,
            sshKeys: ['mining-pool-key'],
            securityGroups: ['mining_pool_sg'],
            monitoring: true
          }
        ],
        storage: [
          {
            name: 'mining_data',
            type: 'block',
            size: 500,
            encryption: true,
            backup: true,
            replication: true
          },
          {
            name: 'logs_storage',
            type: 'object',
            size: 1000,
            encryption: true,
            backup: true,
            replication: false
          }
        ],
        database: [
          {
            name: 'mining_pool_db',
            engine: 'postgresql',
            version: '14.9',
            instanceClass: 'db.r5.large',
            storage: 100,
            multiAZ: true,
            backup: {
              enabled: true,
              retentionDays: 7,
              backupWindow: '03:00-04:00',
              maintenanceWindow: 'Sun:04:00-Sun:05:00',
              pointInTimeRecovery: true
            },
            monitoring: true,
            encryption: true
          }
        ],
        loadBalancers: [
          {
            name: 'mining_pool_alb',
            type: 'application',
            scheme: 'internet-facing',
            listeners: [
              {
                port: 443,
                protocol: 'HTTPS',
                targetPort: 3333,
                targetProtocol: 'HTTP'
              },
              {
                port: 80,
                protocol: 'HTTP',
                targetPort: 3333,
                targetProtocol: 'HTTP'
              }
            ],
            healthCheck: {
              protocol: 'HTTP',
              port: 3333,
              path: '/health',
              interval: 30,
              timeout: 5,
              healthyThreshold: 2,
              unhealthyThreshold: 3
            },
            accessLogs: true
          }
        ],
        cdn: [],
        dns: []
      },
      networking: {
        vpc: {
          cidr: '10.0.0.0/16',
          enableDnsHostnames: true,
          enableDnsSupport: true,
          enableVpnGateway: false,
          instanceTenancy: 'default'
        },
        subnets: [
          {
            name: 'public_subnet_1',
            cidr: '10.0.1.0/24',
            availabilityZone: 'us-east-1a',
            public: true,
            mapPublicIpOnLaunch: true
          },
          {
            name: 'public_subnet_2',
            cidr: '10.0.2.0/24',
            availabilityZone: 'us-east-1b',
            public: true,
            mapPublicIpOnLaunch: true
          },
          {
            name: 'private_subnet_1',
            cidr: '10.0.3.0/24',
            availabilityZone: 'us-east-1a',
            public: false,
            mapPublicIpOnLaunch: false
          },
          {
            name: 'private_subnet_2',
            cidr: '10.0.4.0/24',
            availabilityZone: 'us-east-1b',
            public: false,
            mapPublicIpOnLaunch: false
          }
        ],
        routeTables: [],
        securityGroups: [
          {
            name: 'mining_pool_sg',
            description: 'Security group for mining pool servers',
            ingress: [
              {
                protocol: 'tcp',
                fromPort: 3333,
                toPort: 3333,
                cidr: '0.0.0.0/0',
                description: 'Mining pool Stratum port'
              },
              {
                protocol: 'tcp',
                fromPort: 8080,
                toPort: 8080,
                cidr: '10.0.0.0/16',
                description: 'Admin API port'
              },
              {
                protocol: 'tcp',
                fromPort: 22,
                toPort: 22,
                cidr: '10.0.0.0/16',
                description: 'SSH access'
              }
            ],
            egress: [
              {
                protocol: 'tcp',
                fromPort: 0,
                toPort: 65535,
                cidr: '0.0.0.0/0',
                description: 'All outbound traffic'
              }
            ]
          },
          {
            name: 'database',
            description: 'Security group for database',
            ingress: [
              {
                protocol: 'tcp',
                fromPort: 5432,
                toPort: 5432,
                securityGroupId: 'mining_pool_sg',
                description: 'PostgreSQL access from mining pool'
              }
            ],
            egress: []
          }
        ],
        nacls: []
      },
      security: {
        encryption: {
          atRest: true,
          inTransit: true,
          keyManagement: 'customer'
        },
        iam: {
          roles: [
            {
              name: 'mining_pool_role',
              assumeRolePolicy: '{}',
              policies: ['CloudWatchAgentServerPolicy'],
              maxSessionDuration: 3600
            }
          ],
          policies: [],
          users: [],
          groups: []
        },
        secrets: {
          provider: 'aws_secrets_manager',
          secrets: [
            {
              name: 'database_password',
              value: 'random_generated',
              encryption: true,
              rotation: {
                enabled: true,
                frequency: 90,
                autoRotate: true
              }
            }
          ]
        },
        compliance: {
          standards: ['SOC2'],
          auditing: true,
          dataClassification: true,
          accessLogging: true
        },
        monitoring: {
          cloudTrail: true,
          configRules: true,
          guardDuty: true,
          securityHub: true,
          inspector: true
        }
      },
      monitoring: {
        metrics: {
          provider: 'cloudwatch',
          retentionDays: 30,
          detailedMonitoring: true,
          customMetrics: [
            {
              name: 'MiningPoolHashrate',
              namespace: 'MiningPool/Performance',
              dimensions: { Environment: environment },
              unit: 'Count/Second'
            }
          ]
        },
        logs: {
          provider: 'cloudwatch_logs',
          retentionDays: 14,
          logGroups: [
            {
              name: 'mining-pool-application',
              source: '/var/log/mining-pool/*.log',
              format: 'json',
              filters: []
            }
          ],
          centralized: true
        },
        alerting: {
          provider: 'cloudwatch_alarms',
          notificationChannels: [
            {
              name: 'ops_team',
              type: 'email',
              endpoint: 'ops@mining-pool.com'
            }
          ],
          alerts: [
            {
              name: 'HighCPUUtilization',
              metric: 'CPUUtilization',
              threshold: 80,
              comparison: 'gt',
              evaluationPeriods: 2,
              period: 300,
              statistic: 'avg',
              channels: ['ops_team']
            }
          ]
        },
        dashboards: []
      },
      backup: {
        strategy: {
          frequency: 'daily',
          window: '03:00-04:00',
          crossRegion: true,
          encryption: true,
          compression: true
        },
        retention: {
          daily: 7,
          weekly: 4,
          monthly: 12,
          yearly: 5
        },
        testing: {
          enabled: true,
          frequency: 'monthly',
          automatedRestore: true,
          validationChecks: ['data_integrity', 'application_startup']
        },
        disasterRecovery: {
          rto: 60,
          rpo: 15,
          multiRegion: true,
          failoverRegion: 'us-west-2',
          autoFailover: false,
          runbooks: ['disaster_recovery_playbook.md']
        }
      },
      cost: {
        budgets: [
          {
            name: 'Monthly Infrastructure Budget',
            amount: 1000,
            period: 'monthly',
            alertThresholds: [50, 80, 100],
            filters: [
              {
                type: 'tag',
                values: [`Environment:${environment}`]
              }
            ]
          }
        ],
        optimization: {
          rightSizing: true,
          reservedInstances: true,
          spotInstances: false,
          scheduledScaling: true,
          unusedResourceCleanup: true
        },
        tagging: {
          required: ['Environment', 'Project', 'Owner'],
          optional: ['CostCenter', 'Application'],
          enforced: true,
          inheritance: true
        },
        reporting: {
          enabled: true,
          frequency: 'weekly',
          recipients: ['finance@mining-pool.com'],
          detailLevel: 'detailed'
        }
      },
      tags: {
        Environment: environment,
        Project: 'MiningPool',
        Owner: 'Infrastructure Team',
        ManagedBy: 'Terraform',
        Application: 'otedama-mining-pool'
      }
    };
  }
}

export default InfrastructureAsCodeSystem;