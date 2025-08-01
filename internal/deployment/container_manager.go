package deployment

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ContainerManager manages containerized mining deployments
// Following John Carmack's principle: "Focus is a matter of deciding what things you're not going to do."
type ContainerManager struct {
	logger *zap.Logger
	
	// Container runtime
	runtime        ContainerRuntime
	
	// Container registry
	containers     map[string]*Container
	containersMu   sync.RWMutex
	
	// Image management
	images         map[string]*Image
	imagesMu       sync.RWMutex
	
	// Network management
	networks       map[string]*Network
	networksMu     sync.RWMutex
	
	// Volume management
	volumes        map[string]*Volume
	volumesMu      sync.RWMutex
	
	// Configuration
	config         ContainerConfig
	
	// Metrics
	metrics        struct {
		containersCreated   uint64
		containersDeleted   uint64
		imagesBuilt         uint64
		imagesPulled        uint64
		networkOperations   uint64
		volumeOperations    uint64
	}
}

// ContainerConfig configures the container manager
type ContainerConfig struct {
	// Runtime settings
	Runtime         string // "docker", "podman", "containerd"
	SocketPath      string
	
	// Resource limits
	DefaultCPULimit    float64
	DefaultMemoryLimit int64
	DefaultGPULimit    int
	
	// Networking
	DefaultNetwork     string
	EnableIPv6         bool
	
	// Storage
	DefaultVolumeDriver string
	VolumeBasePath      string
	
	// Security
	EnableSecurityOpts  bool
	AppArmorProfile     string
	SeccompProfile      string
}

// Container represents a mining container
type Container struct {
	ID             string
	Name           string
	Image          string
	Status         ContainerStatus
	Configuration  ContainerSpec
	Created        time.Time
	Started        time.Time
	Stats          ContainerStats
	Labels         map[string]string
}

// ContainerStatus represents container state
type ContainerStatus struct {
	State      string // "created", "running", "paused", "stopped", "removing"
	ExitCode   int
	Error      string
	StartedAt  time.Time
	FinishedAt time.Time
}

// ContainerSpec defines container configuration
type ContainerSpec struct {
	// Image
	Image          string
	Command        []string
	Args           []string
	WorkingDir     string
	
	// Environment
	Env            map[string]string
	
	// Resources
	CPULimit       float64
	CPUReservation float64
	MemoryLimit    int64
	MemoryReserv   int64
	GPUDevices     []string
	
	// Networking
	NetworkMode    string
	Ports          []PortMapping
	DNS            []string
	
	// Storage
	Volumes        []VolumeMount
	Tmpfs          []TmpfsMount
	
	// Security
	Privileged     bool
	ReadOnly       bool
	User           string
	Groups         []string
	Capabilities   []string
	SecurityOpts   []string
	
	// Runtime
	RestartPolicy  RestartPolicy
	HealthCheck    *HealthCheck
}

// ContainerStats contains runtime statistics
type ContainerStats struct {
	CPUUsage       float64
	MemoryUsage    int64
	MemoryLimit    int64
	NetworkRxBytes int64
	NetworkTxBytes int64
	BlockIORead    int64
	BlockIOWrite   int64
	PIDs           int
}

// Image represents a container image
type Image struct {
	ID         string
	Name       string
	Tags       []string
	Size       int64
	Created    time.Time
	Layers     []string
	Config     ImageConfig
}

// ImageConfig contains image configuration
type ImageConfig struct {
	Architecture string
	OS           string
	Env          []string
	Cmd          []string
	WorkingDir   string
	Labels       map[string]string
}

// Network represents a container network
type Network struct {
	ID         string
	Name       string
	Driver     string
	Scope      string
	Internal   bool
	IPv6       bool
	Subnet     string
	Gateway    string
	Created    time.Time
}

// Volume represents a storage volume
type Volume struct {
	ID         string
	Name       string
	Driver     string
	Mountpoint string
	Labels     map[string]string
	Options    map[string]string
	Created    time.Time
}

// PortMapping defines port forwarding
type PortMapping struct {
	ContainerPort int
	HostPort      int
	Protocol      string // "tcp", "udp"
	HostIP        string
}

// VolumeMount defines a volume mount
type VolumeMount struct {
	Source      string
	Destination string
	Type        string // "bind", "volume", "tmpfs"
	ReadOnly    bool
	Options     []string
}

// TmpfsMount defines a tmpfs mount
type TmpfsMount struct {
	Destination string
	Size        int64
	Mode        uint32
}

// RestartPolicy defines container restart behavior
type RestartPolicy struct {
	Name              string // "no", "always", "on-failure", "unless-stopped"
	MaximumRetryCount int
}

// HealthCheck defines container health check
type HealthCheck struct {
	Test        []string
	Interval    time.Duration
	Timeout     time.Duration
	StartPeriod time.Duration
	Retries     int
}

// ContainerRuntime interface for container operations
type ContainerRuntime interface {
	CreateContainer(spec ContainerSpec) (*Container, error)
	StartContainer(id string) error
	StopContainer(id string, timeout time.Duration) error
	RemoveContainer(id string, force bool) error
	GetContainer(id string) (*Container, error)
	ListContainers() ([]*Container, error)
	GetContainerStats(id string) (*ContainerStats, error)
	GetContainerLogs(id string, tail int) ([]byte, error)
	
	BuildImage(dockerfile string, tag string) (*Image, error)
	PullImage(name string) (*Image, error)
	RemoveImage(id string, force bool) error
	ListImages() ([]*Image, error)
	
	CreateNetwork(name string, driver string) (*Network, error)
	RemoveNetwork(id string) error
	ListNetworks() ([]*Network, error)
	
	CreateVolume(name string, driver string) (*Volume, error)
	RemoveVolume(id string, force bool) error
	ListVolumes() ([]*Volume, error)
}

// NewContainerManager creates a new container manager
func NewContainerManager(logger *zap.Logger, config ContainerConfig) (*ContainerManager, error) {
	// Create runtime based on configuration
	var runtime ContainerRuntime
	switch config.Runtime {
	case "docker":
		runtime = NewDockerRuntime(config.SocketPath)
	case "podman":
		runtime = NewPodmanRuntime(config.SocketPath)
	default:
		return nil, fmt.Errorf("unsupported runtime: %s", config.Runtime)
	}
	
	cm := &ContainerManager{
		logger:     logger,
		runtime:    runtime,
		containers: make(map[string]*Container),
		images:     make(map[string]*Image),
		networks:   make(map[string]*Network),
		volumes:    make(map[string]*Volume),
		config:     config,
	}
	
	// Initialize default network
	if config.DefaultNetwork != "" {
		if _, err := cm.CreateNetwork(config.DefaultNetwork, "bridge"); err != nil {
			logger.Warn("Failed to create default network", zap.Error(err))
		}
	}
	
	logger.Info("Initialized container manager",
		zap.String("runtime", config.Runtime),
		zap.String("default_network", config.DefaultNetwork))
	
	return cm, nil
}

// CreateMiningContainer creates a new mining container
func (cm *ContainerManager) CreateMiningContainer(name string, config MiningContainerConfig) (*Container, error) {
	// Build container specification
	spec := ContainerSpec{
		Image:       config.Image,
		Command:     []string{"otedama"},
		Args:        cm.buildMiningArgs(config),
		WorkingDir:  "/app",
		Env:         cm.buildMiningEnv(config),
		
		// Resources
		CPULimit:    config.CPULimit,
		MemoryLimit: config.MemoryLimit,
		GPUDevices:  config.GPUDevices,
		
		// Networking
		NetworkMode: cm.config.DefaultNetwork,
		Ports: []PortMapping{
			{ContainerPort: 8080, HostPort: 0, Protocol: "tcp"}, // API
			{ContainerPort: 3333, HostPort: 0, Protocol: "tcp"}, // Stratum
		},
		
		// Volumes
		Volumes: []VolumeMount{
			{
				Source:      name + "-data",
				Destination: "/data",
				Type:        "volume",
				ReadOnly:    false,
			},
		},
		
		// Security
		ReadOnly:     false,
		User:         "1000:1000",
		Capabilities: []string{"NET_ADMIN", "SYS_NICE"},
		
		// Runtime
		RestartPolicy: RestartPolicy{
			Name:              "unless-stopped",
			MaximumRetryCount: 3,
		},
		HealthCheck: &HealthCheck{
			Test:     []string{"CMD", "otedama", "health"},
			Interval: 30 * time.Second,
			Timeout:  10 * time.Second,
			Retries:  3,
		},
		
		Labels: map[string]string{
			"app":        "otedama",
			"component":  "miner",
			"managed-by": "container-manager",
		},
	}
	
	// Apply security options if enabled
	if cm.config.EnableSecurityOpts {
		spec.SecurityOpts = cm.buildSecurityOpts()
	}
	
	// Create volume
	if _, err := cm.CreateVolume(name+"-data", cm.config.DefaultVolumeDriver); err != nil {
		return nil, fmt.Errorf("failed to create volume: %w", err)
	}
	
	// Create container
	container, err := cm.runtime.CreateContainer(spec)
	if err != nil {
		return nil, fmt.Errorf("failed to create container: %w", err)
	}
	
	// Store in registry
	cm.containersMu.Lock()
	cm.containers[container.ID] = container
	cm.containersMu.Unlock()
	
	cm.metrics.containersCreated++
	
	cm.logger.Info("Created mining container",
		zap.String("id", container.ID),
		zap.String("name", name),
		zap.String("image", config.Image))
	
	return container, nil
}

// StartContainer starts a container
func (cm *ContainerManager) StartContainer(id string) error {
	if err := cm.runtime.StartContainer(id); err != nil {
		return err
	}
	
	cm.containersMu.Lock()
	if container, exists := cm.containers[id]; exists {
		container.Status.State = "running"
		container.Started = time.Now()
	}
	cm.containersMu.Unlock()
	
	return nil
}

// StopContainer stops a container
func (cm *ContainerManager) StopContainer(id string, timeout time.Duration) error {
	if err := cm.runtime.StopContainer(id, timeout); err != nil {
		return err
	}
	
	cm.containersMu.Lock()
	if container, exists := cm.containers[id]; exists {
		container.Status.State = "stopped"
		container.Status.FinishedAt = time.Now()
	}
	cm.containersMu.Unlock()
	
	return nil
}

// RemoveContainer removes a container
func (cm *ContainerManager) RemoveContainer(id string, force bool) error {
	if err := cm.runtime.RemoveContainer(id, force); err != nil {
		return err
	}
	
	cm.containersMu.Lock()
	delete(cm.containers, id)
	cm.containersMu.Unlock()
	
	cm.metrics.containersDeleted++
	
	return nil
}

// GetContainerStats returns container statistics
func (cm *ContainerManager) GetContainerStats(id string) (*ContainerStats, error) {
	return cm.runtime.GetContainerStats(id)
}

// GetContainerLogs returns container logs
func (cm *ContainerManager) GetContainerLogs(id string, tail int) ([]byte, error) {
	return cm.runtime.GetContainerLogs(id, tail)
}

// BuildImage builds a container image
func (cm *ContainerManager) BuildImage(dockerfile string, tag string) (*Image, error) {
	image, err := cm.runtime.BuildImage(dockerfile, tag)
	if err != nil {
		return nil, err
	}
	
	cm.imagesMu.Lock()
	cm.images[image.ID] = image
	cm.imagesMu.Unlock()
	
	cm.metrics.imagesBuilt++
	
	return image, nil
}

// PullImage pulls an image from registry
func (cm *ContainerManager) PullImage(name string) (*Image, error) {
	image, err := cm.runtime.PullImage(name)
	if err != nil {
		return nil, err
	}
	
	cm.imagesMu.Lock()
	cm.images[image.ID] = image
	cm.imagesMu.Unlock()
	
	cm.metrics.imagesPulled++
	
	return image, nil
}

// CreateNetwork creates a container network
func (cm *ContainerManager) CreateNetwork(name string, driver string) (*Network, error) {
	network, err := cm.runtime.CreateNetwork(name, driver)
	if err != nil {
		return nil, err
	}
	
	cm.networksMu.Lock()
	cm.networks[network.ID] = network
	cm.networksMu.Unlock()
	
	cm.metrics.networkOperations++
	
	return network, nil
}

// CreateVolume creates a storage volume
func (cm *ContainerManager) CreateVolume(name string, driver string) (*Volume, error) {
	volume, err := cm.runtime.CreateVolume(name, driver)
	if err != nil {
		return nil, err
	}
	
	cm.volumesMu.Lock()
	cm.volumes[volume.ID] = volume
	cm.volumesMu.Unlock()
	
	cm.metrics.volumeOperations++
	
	return volume, nil
}

// GenerateDockerfile generates a Dockerfile for mining
func (cm *ContainerManager) GenerateDockerfile(config MiningImageConfig) string {
	var dockerfile strings.Builder
	
	// Base image
	dockerfile.WriteString(fmt.Sprintf("FROM %s\n\n", config.BaseImage))
	
	// Labels
	dockerfile.WriteString("LABEL maintainer=\"Otedama Team\"\n")
	dockerfile.WriteString("LABEL app=\"otedama\"\n")
	dockerfile.WriteString("LABEL version=\"latest\"\n\n")
	
	// Install dependencies
	dockerfile.WriteString("RUN apt-get update && apt-get install -y \\\n")
	dockerfile.WriteString("    curl \\\n")
	dockerfile.WriteString("    ca-certificates \\\n")
	dockerfile.WriteString("    libssl-dev \\\n")
	dockerfile.WriteString("    libgomp1 \\\n")
	
	if config.EnableGPU {
		dockerfile.WriteString("    nvidia-cuda-toolkit \\\n")
		dockerfile.WriteString("    opencl-headers \\\n")
	}
	
	dockerfile.WriteString("    && rm -rf /var/lib/apt/lists/*\n\n")
	
	// Create user
	dockerfile.WriteString("RUN useradd -m -u 1000 -s /bin/bash miner\n\n")
	
	// Copy binary
	dockerfile.WriteString("COPY --chown=miner:miner otedama /usr/local/bin/\n")
	dockerfile.WriteString("RUN chmod +x /usr/local/bin/otedama\n\n")
	
	// Set working directory
	dockerfile.WriteString("WORKDIR /home/miner\n\n")
	
	// Switch to non-root user
	dockerfile.WriteString("USER miner\n\n")
	
	// Expose ports
	dockerfile.WriteString("EXPOSE 8080 3333\n\n")
	
	// Volume for data
	dockerfile.WriteString("VOLUME [\"/data\"]\n\n")
	
	// Entrypoint
	dockerfile.WriteString("ENTRYPOINT [\"otedama\"]\n")
	dockerfile.WriteString("CMD [\"start\", \"--config\", \"/data/config.yaml\"]\n")
	
	return dockerfile.String()
}

// GenerateCompose generates docker-compose.yml
func (cm *ContainerManager) GenerateCompose(services []ComposeService) ([]byte, error) {
	compose := map[string]interface{}{
		"version": "3.8",
		"services": make(map[string]interface{}),
		"networks": map[string]interface{}{
			"mining": map[string]interface{}{
				"driver": "bridge",
			},
		},
		"volumes": map[string]interface{}{},
	}
	
	for _, service := range services {
		serviceConfig := map[string]interface{}{
			"image":   service.Image,
			"command": service.Command,
			"environment": service.Environment,
			"networks": []string{"mining"},
			"restart": "unless-stopped",
			"volumes": service.Volumes,
		}
		
		if service.CPULimit > 0 {
			serviceConfig["deploy"] = map[string]interface{}{
				"resources": map[string]interface{}{
					"limits": map[string]interface{}{
						"cpus":   fmt.Sprintf("%.2f", service.CPULimit),
						"memory": fmt.Sprintf("%dM", service.MemoryLimit/1024/1024),
					},
				},
			}
		}
		
		if len(service.GPUDevices) > 0 {
			serviceConfig["runtime"] = "nvidia"
			serviceConfig["environment"].(map[string]string)["NVIDIA_VISIBLE_DEVICES"] = strings.Join(service.GPUDevices, ",")
		}
		
		compose["services"].(map[string]interface{})[service.Name] = serviceConfig
		
		// Add volume
		compose["volumes"].(map[string]interface{})[service.Name+"-data"] = map[string]interface{}{
			"driver": "local",
		}
	}
	
	return json.MarshalIndent(compose, "", "  ")
}

// Helper methods

func (cm *ContainerManager) buildMiningArgs(config MiningContainerConfig) []string {
	args := []string{
		"start",
		"--algorithm", config.Algorithm,
		"--pool", config.PoolURL,
		"--wallet", config.WalletAddress,
		"--worker", config.WorkerName,
	}
	
	if config.Intensity > 0 {
		args = append(args, "--intensity", fmt.Sprintf("%d", config.Intensity))
	}
	
	if config.EnableZKP {
		args = append(args, "--zkp")
	}
	
	
	return args
}

func (cm *ContainerManager) buildMiningEnv(config MiningContainerConfig) map[string]string {
	env := map[string]string{
		"OTEDAMA_LOG_LEVEL": "info",
		"OTEDAMA_DATA_DIR":  "/data",
	}
	
	if config.EnableGPU && len(config.GPUDevices) > 0 {
		env["CUDA_VISIBLE_DEVICES"] = strings.Join(config.GPUDevices, ",")
	}
	
	// Merge with custom environment
	for k, v := range config.Environment {
		env[k] = v
	}
	
	return env
}

func (cm *ContainerManager) buildSecurityOpts() []string {
	opts := []string{}
	
	if cm.config.AppArmorProfile != "" {
		opts = append(opts, fmt.Sprintf("apparmor=%s", cm.config.AppArmorProfile))
	}
	
	if cm.config.SeccompProfile != "" {
		opts = append(opts, fmt.Sprintf("seccomp=%s", cm.config.SeccompProfile))
	}
	
	opts = append(opts, "no-new-privileges")
	
	return opts
}

// GetMetrics returns container manager metrics
func (cm *ContainerManager) GetMetrics() map[string]interface{} {
	cm.containersMu.RLock()
	containerCount := len(cm.containers)
	cm.containersMu.RUnlock()
	
	cm.imagesMu.RLock()
	imageCount := len(cm.images)
	cm.imagesMu.RUnlock()
	
	cm.networksMu.RLock()
	networkCount := len(cm.networks)
	cm.networksMu.RUnlock()
	
	cm.volumesMu.RLock()
	volumeCount := len(cm.volumes)
	cm.volumesMu.RUnlock()
	
	return map[string]interface{}{
		"runtime":             cm.config.Runtime,
		"containers_created":  cm.metrics.containersCreated,
		"containers_deleted":  cm.metrics.containersDeleted,
		"containers_active":   containerCount,
		"images_built":        cm.metrics.imagesBuilt,
		"images_pulled":       cm.metrics.imagesPulled,
		"images_total":        imageCount,
		"networks_total":      networkCount,
		"volumes_total":       volumeCount,
		"network_operations":  cm.metrics.networkOperations,
		"volume_operations":   cm.metrics.volumeOperations,
	}
}

// Configuration types

type MiningContainerConfig struct {
	Image                  string
	Algorithm              string
	PoolURL                string
	WalletAddress          string
	WorkerName             string
	Intensity              int
	CPULimit               float64
	MemoryLimit            int64
	GPUDevices             []string
	EnableGPU              bool
	EnableZKP              bool
	Environment            map[string]string
}

type MiningImageConfig struct {
	BaseImage  string
	EnableGPU  bool
	EnableCUDA bool
	EnableOpenCL bool
}

type ComposeService struct {
	Name        string
	Image       string
	Command     []string
	Environment map[string]string
	Volumes     []string
	CPULimit    float64
	MemoryLimit int64
	GPUDevices  []string
}

// Runtime implementations (simplified)

type DockerRuntime struct {
	socketPath string
}

func NewDockerRuntime(socketPath string) *DockerRuntime {
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	return &DockerRuntime{socketPath: socketPath}
}

func (dr *DockerRuntime) CreateContainer(spec ContainerSpec) (*Container, error) {
	// Simplified implementation
	return &Container{
		ID:     generateContainerID(),
		Name:   spec.Labels["name"],
		Image:  spec.Image,
		Status: ContainerStatus{State: "created"},
		Configuration: spec,
		Created: time.Now(),
		Labels: spec.Labels,
	}, nil
}

func (dr *DockerRuntime) StartContainer(id string) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) StopContainer(id string, timeout time.Duration) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) RemoveContainer(id string, force bool) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) GetContainer(id string) (*Container, error) {
	// Implementation would use Docker API
	return nil, errors.New("not implemented")
}

func (dr *DockerRuntime) ListContainers() ([]*Container, error) {
	// Implementation would use Docker API
	return []*Container{}, nil
}

func (dr *DockerRuntime) GetContainerStats(id string) (*ContainerStats, error) {
	// Implementation would use Docker API
	return &ContainerStats{}, nil
}

func (dr *DockerRuntime) GetContainerLogs(id string, tail int) ([]byte, error) {
	// Implementation would use Docker API
	return []byte{}, nil
}

func (dr *DockerRuntime) BuildImage(dockerfile string, tag string) (*Image, error) {
	// Implementation would use Docker API
	return &Image{
		ID:   generateImageID(),
		Name: tag,
		Tags: []string{tag},
		Created: time.Now(),
	}, nil
}

func (dr *DockerRuntime) PullImage(name string) (*Image, error) {
	// Implementation would use Docker API
	return &Image{
		ID:   generateImageID(),
		Name: name,
		Tags: []string{name},
		Created: time.Now(),
	}, nil
}

func (dr *DockerRuntime) RemoveImage(id string, force bool) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) ListImages() ([]*Image, error) {
	// Implementation would use Docker API
	return []*Image{}, nil
}

func (dr *DockerRuntime) CreateNetwork(name string, driver string) (*Network, error) {
	// Implementation would use Docker API
	return &Network{
		ID:      generateNetworkID(),
		Name:    name,
		Driver:  driver,
		Created: time.Now(),
	}, nil
}

func (dr *DockerRuntime) RemoveNetwork(id string) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) ListNetworks() ([]*Network, error) {
	// Implementation would use Docker API
	return []*Network{}, nil
}

func (dr *DockerRuntime) CreateVolume(name string, driver string) (*Volume, error) {
	// Implementation would use Docker API
	return &Volume{
		ID:      generateVolumeID(),
		Name:    name,
		Driver:  driver,
		Created: time.Now(),
	}, nil
}

func (dr *DockerRuntime) RemoveVolume(id string, force bool) error {
	// Implementation would use Docker API
	return nil
}

func (dr *DockerRuntime) ListVolumes() ([]*Volume, error) {
	// Implementation would use Docker API
	return []*Volume{}, nil
}

type PodmanRuntime struct {
	socketPath string
}

func NewPodmanRuntime(socketPath string) *PodmanRuntime {
	if socketPath == "" {
		socketPath = "/run/podman/podman.sock"
	}
	return &PodmanRuntime{socketPath: socketPath}
}

// Implement ContainerRuntime interface for Podman
// (Similar to DockerRuntime, but using Podman API)

// Helper functions

func generateContainerID() string {
	return fmt.Sprintf("cnt-%d", time.Now().UnixNano())
}

func generateImageID() string {
	return fmt.Sprintf("img-%d", time.Now().UnixNano())
}

func generateNetworkID() string {
	return fmt.Sprintf("net-%d", time.Now().UnixNano())
}

func generateVolumeID() string {
	return fmt.Sprintf("vol-%d", time.Now().UnixNano())
}