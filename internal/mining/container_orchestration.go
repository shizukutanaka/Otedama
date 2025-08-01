package mining

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ContainerOrchestrator manages containerized mining deployments
type ContainerOrchestrator struct {
	logger *zap.Logger
	
	// Container runtime
	runtime      ContainerRuntime
	
	// Orchestration components
	scheduler    *ContainerScheduler
	autoscaler   *ContainerAutoscaler
	loadBalancer *ContainerLoadBalancer
	
	// Service mesh
	serviceMesh  *ServiceMesh
	
	// Container registry
	registry     *ContainerRegistry
	
	// Deployments
	deployments  map[string]*Deployment
	deployMu     sync.RWMutex
	
	// Services
	services     map[string]*Service
	servicesMu   sync.RWMutex
	
	// Nodes
	nodes        map[string]*Node
	nodesMu      sync.RWMutex
	
	// Configuration
	config       OrchestratorConfig
	
	// Metrics
	containersRunning atomic.Uint64
	deploymentCount   atomic.Uint64
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// OrchestratorConfig configures container orchestration
type OrchestratorConfig struct {
	// Runtime settings
	Runtime          string // "docker", "kubernetes", "podman"
	Namespace        string
	
	// Scheduling
	MaxContainers    int
	MaxNodesPerPool  int
	
	// Autoscaling
	EnableAutoscale  bool
	MinReplicas      int
	MaxReplicas      int
	TargetCPU        int // Percentage
	
	// Networking
	NetworkMode      string // "bridge", "host", "overlay"
	ServiceMesh      bool
	
	// Storage
	StorageDriver    string
	VolumeDriver     string
	
	// Security
	EnableSecurity   bool
	RuntimeSecurity  string // "selinux", "apparmor", "seccomp"
}

// ContainerRuntime interface for container operations
type ContainerRuntime interface {
	CreateContainer(spec *ContainerSpec) (string, error)
	StartContainer(id string) error
	StopContainer(id string) error
	RemoveContainer(id string) error
	ListContainers() ([]*Container, error)
	GetContainerStats(id string) (*ContainerStats, error)
	ExecuteCommand(id string, cmd []string) (string, error)
}

// ContainerScheduler schedules containers on nodes
type ContainerScheduler struct {
	// Scheduling algorithms
	algorithm    SchedulingAlgorithm
	
	// Pending tasks
	queue        *SchedulingQueue
	
	// Node selector
	nodeSelector *NodeSelector
	
	// Constraints
	constraints  map[string]*SchedulingConstraint
	
	mu           sync.RWMutex
}

// ContainerAutoscaler manages automatic scaling
type ContainerAutoscaler struct {
	// Scaling policies
	policies     map[string]*ScalingPolicy
	
	// Metrics provider
	metrics      MetricsProvider
	
	// Scaling decisions
	decisions    []*ScalingDecision
	decisionsMu  sync.RWMutex
	
	// Cool down periods
	cooldowns    map[string]time.Time
	cooldownMu   sync.RWMutex
}

// ContainerLoadBalancer distributes load across containers
type ContainerLoadBalancer struct {
	// Load balancing algorithms
	algorithms   map[string]LoadBalancingAlgorithm
	
	// Backend pools
	pools        map[string]*BackendPool
	poolsMu      sync.RWMutex
	
	// Health checks
	healthCheck  *HealthChecker
	
	// Session affinity
	sessions     map[string]string
	sessionsMu   sync.RWMutex
}

// ServiceMesh provides service-to-service communication
type ServiceMesh struct {
	// Service registry
	registry     *ServiceRegistry
	
	// Traffic management
	trafficMgr   *TrafficManager
	
	// Circuit breakers
	breakers     map[string]*CircuitBreaker
	breakersMu   sync.RWMutex
	
	// Distributed tracing
	tracer       *DistributedTracer
}

// ContainerRegistry manages container images
type ContainerRegistry struct {
	// Registry URL
	url          string
	
	// Authentication
	auth         RegistryAuth
	
	// Image cache
	imageCache   map[string]*Image
	cacheMu      sync.RWMutex
	
	// Pull policies
	pullPolicy   string // "always", "never", "ifnotpresent"
}

// Core types

type Deployment struct {
	ID           string
	Name         string
	Namespace    string
	
	// Deployment spec
	Spec         DeploymentSpec
	
	// Current state
	Status       DeploymentStatus
	Replicas     int
	ReadyReplicas int
	
	// Containers
	Containers   []*Container
	
	// Metadata
	Labels       map[string]string
	Annotations  map[string]string
	
	// Timestamps
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type DeploymentSpec struct {
	Replicas     int
	Selector     map[string]string
	Template     PodTemplate
	Strategy     DeploymentStrategy
}

type PodTemplate struct {
	Metadata     ObjectMeta
	Spec         PodSpec
}

type PodSpec struct {
	Containers   []ContainerSpec
	Volumes      []Volume
	NodeSelector map[string]string
	Affinity     *Affinity
}

type ContainerSpec struct {
	Name         string
	Image        string
	Command      []string
	Args         []string
	Env          []EnvVar
	Resources    ResourceRequirements
	Ports        []ContainerPort
	VolumeMounts []VolumeMount
	SecurityContext *SecurityContext
}

type Container struct {
	ID           string
	Name         string
	Image        string
	State        ContainerState
	NodeID       string
	
	// Runtime info
	PID          int
	StartedAt    time.Time
	
	// Resources
	CPUShares    int
	MemoryLimit  int64
	
	// Network
	IPAddress    string
	Ports        map[string]string
	
	// Metrics
	Stats        *ContainerStats
}

type Service struct {
	ID           string
	Name         string
	Namespace    string
	
	// Service type
	Type         ServiceType // "ClusterIP", "LoadBalancer", "NodePort"
	
	// Endpoints
	ClusterIP    string
	ExternalIPs  []string
	Ports        []ServicePort
	
	// Selector
	Selector     map[string]string
	
	// Load balancing
	SessionAffinity string
	
	// Health check
	HealthCheck  *ServiceHealthCheck
}

type Node struct {
	ID           string
	Name         string
	
	// Node info
	Hostname     string
	IPAddress    string
	OS           string
	Arch         string
	
	// Capacity
	CPUCores     int
	MemoryGB     int
	StorageGB    int
	GPUs         int
	
	// Allocatable resources
	AllocatableCPU    float64
	AllocatableMemory int64
	AllocatableGPUs   int
	
	// Current usage
	UsedCPU      float64
	UsedMemory   int64
	UsedGPUs     int
	
	// Status
	Status       NodeStatus
	Conditions   []NodeCondition
	
	// Labels
	Labels       map[string]string
	Taints       []Taint
}

// Additional types

type ContainerState string

const (
	ContainerCreated ContainerState = "created"
	ContainerRunning ContainerState = "running"
	ContainerPaused  ContainerState = "paused"
	ContainerStopped ContainerState = "stopped"
	ContainerDead    ContainerState = "dead"
)

type DeploymentStatus string

const (
	DeploymentPending   DeploymentStatus = "pending"
	DeploymentRunning   DeploymentStatus = "running"
	DeploymentSucceeded DeploymentStatus = "succeeded"
	DeploymentFailed    DeploymentStatus = "failed"
)

type ServiceType string

const (
	ServiceTypeClusterIP    ServiceType = "ClusterIP"
	ServiceTypeLoadBalancer ServiceType = "LoadBalancer"
	ServiceTypeNodePort     ServiceType = "NodePort"
)

type NodeStatus string

const (
	NodeReady    NodeStatus = "ready"
	NodeNotReady NodeStatus = "notready"
	NodeUnknown  NodeStatus = "unknown"
)

type ObjectMeta struct {
	Name         string
	Namespace    string
	Labels       map[string]string
	Annotations  map[string]string
}

type ResourceRequirements struct {
	Limits       ResourceList
	Requests     ResourceList
}

type ResourceList struct {
	CPU          string
	Memory       string
	GPU          string
}

type EnvVar struct {
	Name         string
	Value        string
}

type ContainerPort struct {
	Name         string
	ContainerPort int
	Protocol     string
}

type Volume struct {
	Name         string
	Source       VolumeSource
}

type VolumeSource struct {
	HostPath     *string
	EmptyDir     *EmptyDir
	ConfigMap    *string
	Secret       *string
}

type EmptyDir struct {
	Medium       string
	SizeLimit    string
}

type VolumeMount struct {
	Name         string
	MountPath    string
	ReadOnly     bool
}

type SecurityContext struct {
	RunAsUser    *int64
	RunAsGroup   *int64
	Privileged   *bool
	Capabilities *Capabilities
}

type Capabilities struct {
	Add          []string
	Drop         []string
}

type Affinity struct {
	NodeAffinity *NodeAffinity
	PodAffinity  *PodAffinity
}

type NodeAffinity struct {
	RequiredDuringScheduling  *NodeSelector
	PreferredDuringScheduling []PreferredSchedulingTerm
}

type PodAffinity struct {
	RequiredDuringScheduling  []PodAffinityTerm
	PreferredDuringScheduling []WeightedPodAffinityTerm
}

type NodeSelector struct {
	NodeSelectorTerms []NodeSelectorTerm
}

type NodeSelectorTerm struct {
	MatchExpressions []NodeSelectorRequirement
}

type NodeSelectorRequirement struct {
	Key      string
	Operator string
	Values   []string
}

type PreferredSchedulingTerm struct {
	Weight     int32
	Preference NodeSelectorTerm
}

type PodAffinityTerm struct {
	LabelSelector map[string]string
	Namespaces    []string
	TopologyKey   string
}

type WeightedPodAffinityTerm struct {
	Weight          int32
	PodAffinityTerm PodAffinityTerm
}

type ServicePort struct {
	Name         string
	Port         int
	TargetPort   int
	Protocol     string
}

type ServiceHealthCheck struct {
	Path         string
	Port         int
	Interval     time.Duration
	Timeout      time.Duration
	Retries      int
}

type NodeCondition struct {
	Type         string
	Status       string
	LastTransition time.Time
	Reason       string
	Message      string
}

type Taint struct {
	Key          string
	Value        string
	Effect       string // "NoSchedule", "PreferNoSchedule", "NoExecute"
}

type ContainerStats struct {
	CPUUsage     float64
	MemoryUsage  int64
	NetworkRx    int64
	NetworkTx    int64
	DiskRead     int64
	DiskWrite    int64
	Timestamp    time.Time
}

type DeploymentStrategy struct {
	Type         string // "recreate", "rolling"
	RollingUpdate *RollingUpdateStrategy
}

type RollingUpdateStrategy struct {
	MaxUnavailable int
	MaxSurge       int
}

// Scheduling types

type SchedulingAlgorithm interface {
	Schedule(task *SchedulingTask, nodes []*Node) (*Node, error)
	Name() string
}

type SchedulingQueue struct {
	tasks        []*SchedulingTask
	mu           sync.RWMutex
}

type SchedulingTask struct {
	ID           string
	PodSpec      PodSpec
	Priority     int
	Constraints  []SchedulingConstraint
}

type SchedulingConstraint struct {
	Type         string // "node", "pod", "resource"
	Key          string
	Operator     string
	Values       []string
}

// Autoscaling types

type ScalingPolicy struct {
	Name         string
	TargetRef    string
	MinReplicas  int
	MaxReplicas  int
	Metrics      []MetricSpec
}

type MetricSpec struct {
	Type         string // "cpu", "memory", "custom"
	Target       int
}

type ScalingDecision struct {
	Timestamp    time.Time
	Deployment   string
	CurrentReplicas int
	DesiredReplicas int
	Reason       string
}

type MetricsProvider interface {
	GetMetrics(deployment string) (map[string]float64, error)
}

// Load balancing types

type LoadBalancingAlgorithm interface {
	SelectBackend(backends []*Backend) (*Backend, error)
	Name() string
}

type BackendPool struct {
	Name         string
	Backends     []*Backend
	Algorithm    string
	HealthCheck  *HealthCheck
}

type Backend struct {
	ID           string
	Address      string
	Weight       int
	Healthy      bool
	Connections  int
}

type HealthCheck struct {
	Type         string // "tcp", "http", "grpc"
	Interval     time.Duration
	Timeout      time.Duration
	Threshold    int
}

type HealthChecker struct {
	checks       map[string]*HealthCheck
	results      map[string]*HealthCheckResult
	mu           sync.RWMutex
}

type HealthCheckResult struct {
	BackendID    string
	Healthy      bool
	LastCheck    time.Time
	Consecutive  int
}

// Service mesh types

type ServiceRegistry struct {
	services     map[string]*ServiceInstance
	mu           sync.RWMutex
}

type ServiceInstance struct {
	ID           string
	Name         string
	Version      string
	Endpoints    []string
	Metadata     map[string]string
}

type TrafficManager struct {
	rules        map[string]*TrafficRule
	mu           sync.RWMutex
}

type TrafficRule struct {
	Name         string
	Source       string
	Destination  string
	Weight       int
	Retry        *RetryPolicy
	Timeout      time.Duration
}

type RetryPolicy struct {
	Attempts     int
	Backoff      time.Duration
	MaxBackoff   time.Duration
}

type CircuitBreaker struct {
	Name         string
	State        string // "closed", "open", "half-open"
	Failures     int
	Threshold    int
	Timeout      time.Duration
	LastFailure  time.Time
}

type DistributedTracer struct {
	traces       map[string]*Trace
	mu           sync.RWMutex
}

type Trace struct {
	ID           string
	Spans        []*Span
	StartTime    time.Time
	Duration     time.Duration
}

type Span struct {
	ID           string
	TraceID      string
	ParentID     string
	Operation    string
	StartTime    time.Time
	Duration     time.Duration
	Tags         map[string]string
}

// Registry types

type RegistryAuth struct {
	Username     string
	Password     string
	Token        string
}

type Image struct {
	Name         string
	Tag          string
	Digest       string
	Size         int64
	Created      time.Time
	Architecture string
	OS           string
}

// NewContainerOrchestrator creates a new container orchestrator
func NewContainerOrchestrator(logger *zap.Logger, config OrchestratorConfig) (*ContainerOrchestrator, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	co := &ContainerOrchestrator{
		logger:      logger,
		config:      config,
		deployments: make(map[string]*Deployment),
		services:    make(map[string]*Service),
		nodes:       make(map[string]*Node),
		ctx:         ctx,
		cancel:      cancel,
	}
	
	// Initialize runtime
	runtime, err := co.createRuntime(config.Runtime)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create runtime: %w", err)
	}
	co.runtime = runtime
	
	// Initialize components
	co.initializeScheduler()
	co.initializeAutoscaler()
	co.initializeLoadBalancer()
	
	if config.ServiceMesh {
		co.initializeServiceMesh()
	}
	
	co.initializeRegistry()
	
	// Discover nodes
	if err := co.discoverNodes(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to discover nodes: %w", err)
	}
	
	return co, nil
}

// Start begins container orchestration
func (co *ContainerOrchestrator) Start() error {
	co.logger.Info("Starting container orchestrator",
		zap.String("runtime", co.config.Runtime),
		zap.Int("nodes", len(co.nodes)),
	)
	
	// Start scheduler
	co.wg.Add(1)
	go co.schedulerLoop()
	
	// Start autoscaler
	if co.config.EnableAutoscale {
		co.wg.Add(1)
		go co.autoscalerLoop()
	}
	
	// Start health checker
	co.wg.Add(1)
	go co.healthCheckLoop()
	
	// Start metrics collection
	co.wg.Add(1)
	go co.metricsLoop()
	
	// Start reconciliation
	co.wg.Add(1)
	go co.reconciliationLoop()
	
	return nil
}

// Stop stops container orchestration
func (co *ContainerOrchestrator) Stop() error {
	co.logger.Info("Stopping container orchestrator")
	
	co.cancel()
	co.wg.Wait()
	
	// Clean up resources
	co.cleanup()
	
	return nil
}

// CreateDeployment creates a new deployment
func (co *ContainerOrchestrator) CreateDeployment(spec DeploymentSpec) (*Deployment, error) {
	deployment := &Deployment{
		ID:        co.generateID(),
		Name:      spec.Template.Metadata.Name,
		Namespace: spec.Template.Metadata.Namespace,
		Spec:      spec,
		Status:    DeploymentPending,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	
	if deployment.Namespace == "" {
		deployment.Namespace = "default"
	}
	
	co.deployMu.Lock()
	co.deployments[deployment.ID] = deployment
	co.deployMu.Unlock()
	
	co.deploymentCount.Add(1)
	
	// Schedule containers
	if err := co.scheduleDeployment(deployment); err != nil {
		deployment.Status = DeploymentFailed
		return deployment, fmt.Errorf("failed to schedule deployment: %w", err)
	}
	
	co.logger.Info("Created deployment",
		zap.String("id", deployment.ID),
		zap.String("name", deployment.Name),
		zap.Int("replicas", spec.Replicas),
	)
	
	return deployment, nil
}

// ScaleDeployment scales a deployment
func (co *ContainerOrchestrator) ScaleDeployment(deploymentID string, replicas int) error {
	co.deployMu.Lock()
	deployment, exists := co.deployments[deploymentID]
	co.deployMu.Unlock()
	
	if !exists {
		return fmt.Errorf("deployment not found: %s", deploymentID)
	}
	
	oldReplicas := deployment.Spec.Replicas
	deployment.Spec.Replicas = replicas
	deployment.UpdatedAt = time.Now()
	
	// Scale up or down
	if replicas > oldReplicas {
		return co.scaleUp(deployment, replicas-oldReplicas)
	} else if replicas < oldReplicas {
		return co.scaleDown(deployment, oldReplicas-replicas)
	}
	
	return nil
}

// CreateService creates a new service
func (co *ContainerOrchestrator) CreateService(spec ServiceSpec) (*Service, error) {
	service := &Service{
		ID:        co.generateID(),
		Name:      spec.Name,
		Namespace: spec.Namespace,
		Type:      spec.Type,
		Selector:  spec.Selector,
		Ports:     spec.Ports,
	}
	
	if service.Namespace == "" {
		service.Namespace = "default"
	}
	
	// Allocate cluster IP
	service.ClusterIP = co.allocateClusterIP()
	
	// Set up load balancer if needed
	if service.Type == ServiceTypeLoadBalancer {
		externalIP, err := co.setupLoadBalancer(service)
		if err != nil {
			return nil, fmt.Errorf("failed to setup load balancer: %w", err)
		}
		service.ExternalIPs = []string{externalIP}
	}
	
	co.servicesMu.Lock()
	co.services[service.ID] = service
	co.servicesMu.Unlock()
	
	co.logger.Info("Created service",
		zap.String("id", service.ID),
		zap.String("name", service.Name),
		zap.String("type", string(service.Type)),
	)
	
	return service, nil
}

// GetDeployment retrieves a deployment
func (co *ContainerOrchestrator) GetDeployment(deploymentID string) (*Deployment, error) {
	co.deployMu.RLock()
	deployment, exists := co.deployments[deploymentID]
	co.deployMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("deployment not found: %s", deploymentID)
	}
	
	return deployment, nil
}

// ListDeployments lists all deployments
func (co *ContainerOrchestrator) ListDeployments() []*Deployment {
	co.deployMu.RLock()
	defer co.deployMu.RUnlock()
	
	deployments := make([]*Deployment, 0, len(co.deployments))
	for _, d := range co.deployments {
		deployments = append(deployments, d)
	}
	
	return deployments
}

// GetContainerLogs retrieves container logs
func (co *ContainerOrchestrator) GetContainerLogs(containerID string, options LogOptions) (io.ReadCloser, error) {
	// In production, would interface with container runtime
	return nil, fmt.Errorf("not implemented")
}

// ExecuteInContainer executes a command in a container
func (co *ContainerOrchestrator) ExecuteInContainer(containerID string, cmd []string) (string, error) {
	return co.runtime.ExecuteCommand(containerID, cmd)
}

// Internal methods

func (co *ContainerOrchestrator) createRuntime(runtimeType string) (ContainerRuntime, error) {
	switch runtimeType {
	case "docker":
		return NewDockerRuntime()
	case "kubernetes":
		return NewKubernetesRuntime()
	case "podman":
		return NewPodmanRuntime()
	default:
		return nil, fmt.Errorf("unsupported runtime: %s", runtimeType)
	}
}

func (co *ContainerOrchestrator) initializeScheduler() {
	co.scheduler = &ContainerScheduler{
		algorithm:    NewBinPackingScheduler(),
		queue:        &SchedulingQueue{},
		nodeSelector: &NodeSelector{},
		constraints:  make(map[string]*SchedulingConstraint),
	}
}

func (co *ContainerOrchestrator) initializeAutoscaler() {
	co.autoscaler = &ContainerAutoscaler{
		policies:  make(map[string]*ScalingPolicy),
		metrics:   NewMetricsProvider(),
		decisions: make([]*ScalingDecision, 0),
		cooldowns: make(map[string]time.Time),
	}
}

func (co *ContainerOrchestrator) initializeLoadBalancer() {
	co.loadBalancer = &ContainerLoadBalancer{
		algorithms: map[string]LoadBalancingAlgorithm{
			"round-robin": NewRoundRobinLB(),
			"least-conn":  NewLeastConnectionLB(),
			"ip-hash":     NewIPHashLB(),
		},
		pools:       make(map[string]*BackendPool),
		healthCheck: &HealthChecker{
			checks:  make(map[string]*HealthCheck),
			results: make(map[string]*HealthCheckResult),
		},
		sessions: make(map[string]string),
	}
}

func (co *ContainerOrchestrator) initializeServiceMesh() {
	co.serviceMesh = &ServiceMesh{
		registry: &ServiceRegistry{
			services: make(map[string]*ServiceInstance),
		},
		trafficMgr: &TrafficManager{
			rules: make(map[string]*TrafficRule),
		},
		breakers: make(map[string]*CircuitBreaker),
		tracer: &DistributedTracer{
			traces: make(map[string]*Trace),
		},
	}
}

func (co *ContainerOrchestrator) initializeRegistry() {
	co.registry = &ContainerRegistry{
		url:        "registry.local:5000",
		pullPolicy: "ifnotpresent",
		imageCache: make(map[string]*Image),
	}
}

func (co *ContainerOrchestrator) discoverNodes() error {
	// In production, would discover actual nodes
	// For now, create mock nodes
	
	for i := 0; i < 3; i++ {
		node := &Node{
			ID:       fmt.Sprintf("node-%d", i),
			Name:     fmt.Sprintf("worker-%d", i),
			Hostname: fmt.Sprintf("worker-%d.local", i),
			IPAddress: fmt.Sprintf("10.0.0.%d", i+10),
			OS:       "linux",
			Arch:     "amd64",
			CPUCores: 16,
			MemoryGB: 64,
			StorageGB: 500,
			GPUs:     2,
			AllocatableCPU: 15.0,
			AllocatableMemory: 60 * 1024 * 1024 * 1024,
			AllocatableGPUs: 2,
			Status:   NodeReady,
			Labels: map[string]string{
				"type": "worker",
				"zone": fmt.Sprintf("zone-%d", i%2),
			},
		}
		
		co.nodesMu.Lock()
		co.nodes[node.ID] = node
		co.nodesMu.Unlock()
	}
	
	return nil
}

func (co *ContainerOrchestrator) schedulerLoop() {
	defer co.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-co.ctx.Done():
			return
		case <-ticker.C:
			co.processSchedulingQueue()
		}
	}
}

func (co *ContainerOrchestrator) autoscalerLoop() {
	defer co.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-co.ctx.Done():
			return
		case <-ticker.C:
			co.evaluateAutoscaling()
		}
	}
}

func (co *ContainerOrchestrator) healthCheckLoop() {
	defer co.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-co.ctx.Done():
			return
		case <-ticker.C:
			co.performHealthChecks()
		}
	}
}

func (co *ContainerOrchestrator) metricsLoop() {
	defer co.wg.Done()
	
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-co.ctx.Done():
			return
		case <-ticker.C:
			co.collectMetrics()
		}
	}
}

func (co *ContainerOrchestrator) reconciliationLoop() {
	defer co.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-co.ctx.Done():
			return
		case <-ticker.C:
			co.reconcileState()
		}
	}
}

func (co *ContainerOrchestrator) scheduleDeployment(deployment *Deployment) error {
	// Create containers based on deployment spec
	for i := 0; i < deployment.Spec.Replicas; i++ {
		for _, containerSpec := range deployment.Spec.Template.Spec.Containers {
			task := &SchedulingTask{
				ID:       fmt.Sprintf("%s-%s-%d", deployment.ID, containerSpec.Name, i),
				PodSpec:  deployment.Spec.Template.Spec,
				Priority: 50,
			}
			
			co.scheduler.queue.Add(task)
		}
	}
	
	deployment.Status = DeploymentRunning
	return nil
}

func (co *ContainerOrchestrator) processSchedulingQueue() {
	tasks := co.scheduler.queue.GetPending(10)
	
	for _, task := range tasks {
		node, err := co.selectNode(task)
		if err != nil {
			co.logger.Error("Failed to schedule task",
				zap.String("task", task.ID),
				zap.Error(err),
			)
			continue
		}
		
		// Create container on selected node
		if err := co.createContainerOnNode(task, node); err != nil {
			co.logger.Error("Failed to create container",
				zap.String("task", task.ID),
				zap.String("node", node.ID),
				zap.Error(err),
			)
		}
	}
}

func (co *ContainerOrchestrator) selectNode(task *SchedulingTask) (*Node, error) {
	co.nodesMu.RLock()
	nodes := make([]*Node, 0, len(co.nodes))
	for _, node := range co.nodes {
		if node.Status == NodeReady {
			nodes = append(nodes, node)
		}
	}
	co.nodesMu.RUnlock()
	
	if len(nodes) == 0 {
		return nil, fmt.Errorf("no ready nodes available")
	}
	
	return co.scheduler.algorithm.Schedule(task, nodes)
}

func (co *ContainerOrchestrator) createContainerOnNode(task *SchedulingTask, node *Node) error {
	// Create container using runtime
	for _, spec := range task.PodSpec.Containers {
		containerID, err := co.runtime.CreateContainer(&spec)
		if err != nil {
			return fmt.Errorf("failed to create container: %w", err)
		}
		
		if err := co.runtime.StartContainer(containerID); err != nil {
			return fmt.Errorf("failed to start container: %w", err)
		}
		
		// Update node resources
		node.UsedCPU += parseResourceValue(spec.Resources.Requests.CPU)
		node.UsedMemory += parseMemoryValue(spec.Resources.Requests.Memory)
		
		co.containersRunning.Add(1)
		
		co.logger.Info("Started container",
			zap.String("id", containerID),
			zap.String("node", node.ID),
		)
	}
	
	return nil
}

func (co *ContainerOrchestrator) evaluateAutoscaling() {
	co.deployMu.RLock()
	deployments := make([]*Deployment, 0, len(co.deployments))
	for _, d := range co.deployments {
		deployments = append(deployments, d)
	}
	co.deployMu.RUnlock()
	
	for _, deployment := range deployments {
		// Check if policy exists
		policy := co.autoscaler.policies[deployment.ID]
		if policy == nil {
			continue
		}
		
		// Check cooldown
		if co.isInCooldown(deployment.ID) {
			continue
		}
		
		// Get metrics
		metrics, err := co.autoscaler.metrics.GetMetrics(deployment.ID)
		if err != nil {
			continue
		}
		
		// Make scaling decision
		decision := co.makeScalingDecision(deployment, policy, metrics)
		if decision != nil {
			co.applyScalingDecision(deployment, decision)
		}
	}
}

func (co *ContainerOrchestrator) makeScalingDecision(deployment *Deployment, policy *ScalingPolicy, metrics map[string]float64) *ScalingDecision {
	currentReplicas := deployment.Replicas
	desiredReplicas := currentReplicas
	
	// Check CPU metric
	if cpuUsage, exists := metrics["cpu"]; exists {
		if cpuUsage > float64(co.config.TargetCPU) {
			// Scale up
			desiredReplicas = int(float64(currentReplicas) * (cpuUsage / float64(co.config.TargetCPU)))
		} else if cpuUsage < float64(co.config.TargetCPU)*0.5 {
			// Scale down
			desiredReplicas = int(float64(currentReplicas) * (cpuUsage / float64(co.config.TargetCPU)))
		}
	}
	
	// Apply limits
	if desiredReplicas < policy.MinReplicas {
		desiredReplicas = policy.MinReplicas
	} else if desiredReplicas > policy.MaxReplicas {
		desiredReplicas = policy.MaxReplicas
	}
	
	if desiredReplicas != currentReplicas {
		return &ScalingDecision{
			Timestamp:       time.Now(),
			Deployment:      deployment.ID,
			CurrentReplicas: currentReplicas,
			DesiredReplicas: desiredReplicas,
			Reason:          fmt.Sprintf("CPU usage: %.1f%%", cpuUsage),
		}
	}
	
	return nil
}

func (co *ContainerOrchestrator) applyScalingDecision(deployment *Deployment, decision *ScalingDecision) {
	co.logger.Info("Applying scaling decision",
		zap.String("deployment", deployment.Name),
		zap.Int("from", decision.CurrentReplicas),
		zap.Int("to", decision.DesiredReplicas),
		zap.String("reason", decision.Reason),
	)
	
	if err := co.ScaleDeployment(deployment.ID, decision.DesiredReplicas); err != nil {
		co.logger.Error("Failed to scale deployment",
			zap.String("deployment", deployment.Name),
			zap.Error(err),
		)
		return
	}
	
	// Record decision
	co.autoscaler.decisionsMu.Lock()
	co.autoscaler.decisions = append(co.autoscaler.decisions, decision)
	if len(co.autoscaler.decisions) > 1000 {
		co.autoscaler.decisions = co.autoscaler.decisions[100:]
	}
	co.autoscaler.decisionsMu.Unlock()
	
	// Set cooldown
	co.autoscaler.cooldownMu.Lock()
	co.autoscaler.cooldowns[deployment.ID] = time.Now().Add(2 * time.Minute)
	co.autoscaler.cooldownMu.Unlock()
}

func (co *ContainerOrchestrator) performHealthChecks() {
	containers, err := co.runtime.ListContainers()
	if err != nil {
		co.logger.Error("Failed to list containers", zap.Error(err))
		return
	}
	
	for _, container := range containers {
		// Get container stats
		stats, err := co.runtime.GetContainerStats(container.ID)
		if err != nil {
			continue
		}
		
		container.Stats = stats
		
		// Check health
		// In production, would perform actual health checks
	}
}

func (co *ContainerOrchestrator) collectMetrics() {
	// Collect node metrics
	co.nodesMu.RLock()
	for _, node := range co.nodes {
		// In production, would collect actual metrics
		node.UsedCPU = float64(co.containersRunning.Load()) * 0.5
		node.UsedMemory = int64(co.containersRunning.Load()) * 1024 * 1024 * 100
	}
	co.nodesMu.RUnlock()
}

func (co *ContainerOrchestrator) reconcileState() {
	// Ensure desired state matches actual state
	co.deployMu.RLock()
	for _, deployment := range co.deployments {
		actualReplicas := co.countRunningContainers(deployment)
		if actualReplicas != deployment.Spec.Replicas {
			co.logger.Warn("Deployment replica mismatch",
				zap.String("deployment", deployment.Name),
				zap.Int("desired", deployment.Spec.Replicas),
				zap.Int("actual", actualReplicas),
			)
			
			// Fix mismatch
			if actualReplicas < deployment.Spec.Replicas {
				co.scaleUp(deployment, deployment.Spec.Replicas-actualReplicas)
			} else {
				co.scaleDown(deployment, actualReplicas-deployment.Spec.Replicas)
			}
		}
	}
	co.deployMu.RUnlock()
}

func (co *ContainerOrchestrator) scaleUp(deployment *Deployment, count int) error {
	for i := 0; i < count; i++ {
		for _, containerSpec := range deployment.Spec.Template.Spec.Containers {
			task := &SchedulingTask{
				ID:       fmt.Sprintf("%s-%s-scale-%d", deployment.ID, containerSpec.Name, i),
				PodSpec:  deployment.Spec.Template.Spec,
				Priority: 60, // Higher priority for scaling
			}
			
			co.scheduler.queue.Add(task)
		}
	}
	
	deployment.Replicas += count
	return nil
}

func (co *ContainerOrchestrator) scaleDown(deployment *Deployment, count int) error {
	// Select containers to remove
	containers := co.getDeploymentContainers(deployment)
	
	toRemove := count
	if toRemove > len(containers) {
		toRemove = len(containers)
	}
	
	for i := 0; i < toRemove; i++ {
		if err := co.runtime.StopContainer(containers[i].ID); err != nil {
			co.logger.Error("Failed to stop container",
				zap.String("container", containers[i].ID),
				zap.Error(err),
			)
			continue
		}
		
		if err := co.runtime.RemoveContainer(containers[i].ID); err != nil {
			co.logger.Error("Failed to remove container",
				zap.String("container", containers[i].ID),
				zap.Error(err),
			)
		}
		
		co.containersRunning.Add(^uint64(0)) // Decrement
	}
	
	deployment.Replicas -= toRemove
	return nil
}

func (co *ContainerOrchestrator) setupLoadBalancer(service *Service) (string, error) {
	// Create backend pool
	pool := &BackendPool{
		Name:      service.Name,
		Algorithm: "round-robin",
		Backends:  make([]*Backend, 0),
		HealthCheck: &HealthCheck{
			Type:      "http",
			Interval:  10 * time.Second,
			Timeout:   5 * time.Second,
			Threshold: 3,
		},
	}
	
	co.loadBalancer.poolsMu.Lock()
	co.loadBalancer.pools[service.ID] = pool
	co.loadBalancer.poolsMu.Unlock()
	
	// In production, would allocate real external IP
	return "203.0.113.1", nil
}

func (co *ContainerOrchestrator) allocateClusterIP() string {
	// In production, would allocate from IP pool
	return fmt.Sprintf("10.96.%d.%d", 
		time.Now().Unix()%256, 
		time.Now().UnixNano()%256)
}

func (co *ContainerOrchestrator) countRunningContainers(deployment *Deployment) int {
	// In production, would count actual containers
	return deployment.Replicas
}

func (co *ContainerOrchestrator) getDeploymentContainers(deployment *Deployment) []*Container {
	// In production, would return actual containers
	containers := make([]*Container, 0)
	for i := 0; i < deployment.Replicas; i++ {
		containers = append(containers, &Container{
			ID:    fmt.Sprintf("%s-container-%d", deployment.ID, i),
			Name:  fmt.Sprintf("%s-%d", deployment.Name, i),
			State: ContainerRunning,
		})
	}
	return containers
}

func (co *ContainerOrchestrator) isInCooldown(deploymentID string) bool {
	co.autoscaler.cooldownMu.RLock()
	cooldownTime, exists := co.autoscaler.cooldowns[deploymentID]
	co.autoscaler.cooldownMu.RUnlock()
	
	if !exists {
		return false
	}
	
	return time.Now().Before(cooldownTime)
}

func (co *ContainerOrchestrator) cleanup() {
	// Clean up all containers
	containers, err := co.runtime.ListContainers()
	if err == nil {
		for _, container := range containers {
			co.runtime.StopContainer(container.ID)
			co.runtime.RemoveContainer(container.ID)
		}
	}
}

func (co *ContainerOrchestrator) generateID() string {
	return fmt.Sprintf("%x", time.Now().UnixNano())
}

// Helper functions

func parseResourceValue(value string) float64 {
	// Parse CPU values like "100m", "2"
	// In production, would handle all formats
	return 1.0
}

func parseMemoryValue(value string) int64 {
	// Parse memory values like "1Gi", "512Mi"
	// In production, would handle all formats
	return 1024 * 1024 * 1024 // 1GB default
}

// Runtime implementations (placeholders)

func NewDockerRuntime() (ContainerRuntime, error) {
	return &dockerRuntime{}, nil
}

func NewKubernetesRuntime() (ContainerRuntime, error) {
	return &kubernetesRuntime{}, nil
}

func NewPodmanRuntime() (ContainerRuntime, error) {
	return &podmanRuntime{}, nil
}

type dockerRuntime struct{}

func (r *dockerRuntime) CreateContainer(spec *ContainerSpec) (string, error) {
	return fmt.Sprintf("docker-%x", time.Now().UnixNano()), nil
}

func (r *dockerRuntime) StartContainer(id string) error {
	return nil
}

func (r *dockerRuntime) StopContainer(id string) error {
	return nil
}

func (r *dockerRuntime) RemoveContainer(id string) error {
	return nil
}

func (r *dockerRuntime) ListContainers() ([]*Container, error) {
	return []*Container{}, nil
}

func (r *dockerRuntime) GetContainerStats(id string) (*ContainerStats, error) {
	return &ContainerStats{
		CPUUsage:    50.0,
		MemoryUsage: 1024 * 1024 * 512,
		Timestamp:   time.Now(),
	}, nil
}

func (r *dockerRuntime) ExecuteCommand(id string, cmd []string) (string, error) {
	return "command output", nil
}

type kubernetesRuntime struct{}

func (r *kubernetesRuntime) CreateContainer(spec *ContainerSpec) (string, error) {
	return fmt.Sprintf("k8s-%x", time.Now().UnixNano()), nil
}

func (r *kubernetesRuntime) StartContainer(id string) error {
	return nil
}

func (r *kubernetesRuntime) StopContainer(id string) error {
	return nil
}

func (r *kubernetesRuntime) RemoveContainer(id string) error {
	return nil
}

func (r *kubernetesRuntime) ListContainers() ([]*Container, error) {
	return []*Container{}, nil
}

func (r *kubernetesRuntime) GetContainerStats(id string) (*ContainerStats, error) {
	return &ContainerStats{}, nil
}

func (r *kubernetesRuntime) ExecuteCommand(id string, cmd []string) (string, error) {
	return "", nil
}

type podmanRuntime struct{}

func (r *podmanRuntime) CreateContainer(spec *ContainerSpec) (string, error) {
	return fmt.Sprintf("podman-%x", time.Now().UnixNano()), nil
}

func (r *podmanRuntime) StartContainer(id string) error {
	return nil
}

func (r *podmanRuntime) StopContainer(id string) error {
	return nil
}

func (r *podmanRuntime) RemoveContainer(id string) error {
	return nil
}

func (r *podmanRuntime) ListContainers() ([]*Container, error) {
	return []*Container{}, nil
}

func (r *podmanRuntime) GetContainerStats(id string) (*ContainerStats, error) {
	return &ContainerStats{}, nil
}

func (r *podmanRuntime) ExecuteCommand(id string, cmd []string) (string, error) {
	return "", nil
}

// Scheduling algorithms

func NewBinPackingScheduler() SchedulingAlgorithm {
	return &binPackingScheduler{}
}

type binPackingScheduler struct{}

func (s *binPackingScheduler) Schedule(task *SchedulingTask, nodes []*Node) (*Node, error) {
	// Find node with most resources already in use (bin packing)
	var bestNode *Node
	maxUsage := 0.0
	
	for _, node := range nodes {
		cpuUsage := node.UsedCPU / node.AllocatableCPU
		memUsage := float64(node.UsedMemory) / float64(node.AllocatableMemory)
		usage := (cpuUsage + memUsage) / 2
		
		if usage > maxUsage && s.canFit(task, node) {
			bestNode = node
			maxUsage = usage
		}
	}
	
	if bestNode == nil {
		return nil, fmt.Errorf("no suitable node found")
	}
	
	return bestNode, nil
}

func (s *binPackingScheduler) canFit(task *SchedulingTask, node *Node) bool {
	// Check if task fits on node
	// In production, would check actual resource requirements
	return true
}

func (s *binPackingScheduler) Name() string {
	return "bin-packing"
}

// Load balancing algorithms

func NewRoundRobinLB() LoadBalancingAlgorithm {
	return &roundRobinLB{current: 0}
}

type roundRobinLB struct {
	current uint64
}

func (lb *roundRobinLB) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, fmt.Errorf("no backends available")
	}
	
	healthy := make([]*Backend, 0)
	for _, b := range backends {
		if b.Healthy {
			healthy = append(healthy, b)
		}
	}
	
	if len(healthy) == 0 {
		return nil, fmt.Errorf("no healthy backends")
	}
	
	idx := atomic.AddUint64(&lb.current, 1) % uint64(len(healthy))
	return healthy[idx], nil
}

func (lb *roundRobinLB) Name() string {
	return "round-robin"
}

func NewLeastConnectionLB() LoadBalancingAlgorithm {
	return &leastConnectionLB{}
}

type leastConnectionLB struct{}

func (lb *leastConnectionLB) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, fmt.Errorf("no backends available")
	}
	
	var selected *Backend
	minConnections := int(^uint(0) >> 1) // Max int
	
	for _, b := range backends {
		if b.Healthy && b.Connections < minConnections {
			selected = b
			minConnections = b.Connections
		}
	}
	
	if selected == nil {
		return nil, fmt.Errorf("no healthy backends")
	}
	
	return selected, nil
}

func (lb *leastConnectionLB) Name() string {
	return "least-connections"
}

func NewIPHashLB() LoadBalancingAlgorithm {
	return &ipHashLB{}
}

type ipHashLB struct{}

func (lb *ipHashLB) SelectBackend(backends []*Backend) (*Backend, error) {
	// In production, would hash based on client IP
	return NewRoundRobinLB().SelectBackend(backends)
}

func (lb *ipHashLB) Name() string {
	return "ip-hash"
}

// Metrics provider

func NewMetricsProvider() MetricsProvider {
	return &defaultMetricsProvider{}
}

type defaultMetricsProvider struct{}

func (p *defaultMetricsProvider) GetMetrics(deployment string) (map[string]float64, error) {
	// In production, would collect actual metrics
	return map[string]float64{
		"cpu":    60.0 + float64(time.Now().Unix()%40),
		"memory": 70.0,
	}, nil
}

// Queue methods

func (q *SchedulingQueue) Add(task *SchedulingTask) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = append(q.tasks, task)
}

func (q *SchedulingQueue) GetPending(limit int) []*SchedulingTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	
	if len(q.tasks) == 0 {
		return nil
	}
	
	count := limit
	if count > len(q.tasks) {
		count = len(q.tasks)
	}
	
	tasks := make([]*SchedulingTask, count)
	copy(tasks, q.tasks[:count])
	q.tasks = q.tasks[count:]
	
	return tasks
}

// Request types

type ServiceSpec struct {
	Name         string
	Namespace    string
	Type         ServiceType
	Selector     map[string]string
	Ports        []ServicePort
}

type LogOptions struct {
	Follow       bool
	Timestamps   bool
	Tail         int
	Since        time.Time
}

// GetOrchestratorStats returns orchestrator statistics
func (co *ContainerOrchestrator) GetOrchestratorStats() map[string]interface{} {
	co.nodesMu.RLock()
	nodeCount := len(co.nodes)
	readyNodes := 0
	totalCPU := 0.0
	totalMemory := int64(0)
	usedCPU := 0.0
	usedMemory := int64(0)
	
	for _, node := range co.nodes {
		if node.Status == NodeReady {
			readyNodes++
		}
		totalCPU += node.AllocatableCPU
		totalMemory += node.AllocatableMemory
		usedCPU += node.UsedCPU
		usedMemory += node.UsedMemory
	}
	co.nodesMu.RUnlock()
	
	co.deployMu.RLock()
	deploymentCount := len(co.deployments)
	co.deployMu.RUnlock()
	
	co.servicesMu.RLock()
	serviceCount := len(co.services)
	co.servicesMu.RUnlock()
	
	return map[string]interface{}{
		"nodes": map[string]interface{}{
			"total":  nodeCount,
			"ready":  readyNodes,
			"cpu": map[string]interface{}{
				"total": totalCPU,
				"used":  usedCPU,
				"free":  totalCPU - usedCPU,
			},
			"memory": map[string]interface{}{
				"total": totalMemory,
				"used":  usedMemory,
				"free":  totalMemory - usedMemory,
			},
		},
		"deployments": map[string]interface{}{
			"total":   deploymentCount,
			"created": co.deploymentCount.Load(),
		},
		"containers": map[string]interface{}{
			"running": co.containersRunning.Load(),
		},
		"services": map[string]interface{}{
			"total": serviceCount,
		},
	}
}