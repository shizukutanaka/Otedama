package optimization

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// CPUSet represents a set of CPUs
type CPUSet struct {
	mask uint64
}

// NewCPUSet creates a new CPU set
func NewCPUSet() *CPUSet {
	return &CPUSet{}
}

// Add adds a CPU to the set
func (c *CPUSet) Add(cpu int) {
	if cpu >= 0 && cpu < 64 {
		c.mask |= 1 << uint(cpu)
	}
}

// Remove removes a CPU from the set
func (c *CPUSet) Remove(cpu int) {
	if cpu >= 0 && cpu < 64 {
		c.mask &^= 1 << uint(cpu)
	}
}

// Contains checks if CPU is in the set
func (c *CPUSet) Contains(cpu int) bool {
	if cpu < 0 || cpu >= 64 {
		return false
	}
	return c.mask&(1<<uint(cpu)) != 0
}

// Count returns the number of CPUs in the set
func (c *CPUSet) Count() int {
	count := 0
	mask := c.mask
	for mask != 0 {
		count += int(mask & 1)
		mask >>= 1
	}
	return count
}

// Clear removes all CPUs from the set
func (c *CPUSet) Clear() {
	c.mask = 0
}

// CPUAffinity manages CPU affinity for threads
type CPUAffinity struct {
	numCPU int
}

// NewCPUAffinity creates a new CPU affinity manager
func NewCPUAffinity() *CPUAffinity {
	return &CPUAffinity{
		numCPU: runtime.NumCPU(),
	}
}

// SetThreadAffinity pins current thread to specific CPUs
func (a *CPUAffinity) SetThreadAffinity(cpus *CPUSet) error {
	runtime.LockOSThread()
	
	// Platform-specific implementation
	return a.setAffinity(cpus)
}

// GetThreadAffinity gets current thread's CPU affinity
func (a *CPUAffinity) GetThreadAffinity() (*CPUSet, error) {
	return a.getAffinity()
}

// ReleaseThread releases the current thread from CPU pinning
func (a *CPUAffinity) ReleaseThread() {
	runtime.UnlockOSThread()
}

// Linux implementation
func (a *CPUAffinity) setAffinity(cpus *CPUSet) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("CPU affinity not supported on %s", runtime.GOOS)
	}
	
	// Create CPU set for syscall
	var set syscall.CPUSet
	for i := 0; i < a.numCPU; i++ {
		if cpus.Contains(i) {
			set.Set(i)
		}
	}
	
	// Set affinity for current thread
	return syscall.SchedSetaffinity(0, &set)
}

func (a *CPUAffinity) getAffinity() (*CPUSet, error) {
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("CPU affinity not supported on %s", runtime.GOOS)
	}
	
	var set syscall.CPUSet
	if err := syscall.SchedGetaffinity(0, &set); err != nil {
		return nil, err
	}
	
	cpus := NewCPUSet()
	for i := 0; i < a.numCPU; i++ {
		if set.IsSet(i) {
			cpus.Add(i)
		}
	}
	
	return cpus, nil
}

// NUMANode represents a NUMA node
type NUMANode struct {
	ID       int
	CPUs     *CPUSet
	Memory   uint64 // Available memory in bytes
	Distance map[int]int // Distance to other nodes
}

// NUMATopology represents the system's NUMA topology
type NUMATopology struct {
	nodes    []*NUMANode
	cpuToNode map[int]int
}

// NewNUMATopology discovers the system's NUMA topology
func NewNUMATopology() (*NUMATopology, error) {
	topology := &NUMATopology{
		cpuToNode: make(map[int]int),
	}
	
	// Platform-specific discovery
	if err := topology.discover(); err != nil {
		// Fallback to single node
		topology.createSingleNode()
	}
	
	return topology, nil
}

func (t *NUMATopology) discover() error {
	// This would read /sys/devices/system/node/ on Linux
	// For now, return error to use fallback
	return fmt.Errorf("NUMA discovery not implemented")
}

func (t *NUMATopology) createSingleNode() {
	cpus := NewCPUSet()
	for i := 0; i < runtime.NumCPU(); i++ {
		cpus.Add(i)
		t.cpuToNode[i] = 0
	}
	
	node := &NUMANode{
		ID:       0,
		CPUs:     cpus,
		Memory:   getSystemMemory(),
		Distance: map[int]int{0: 10}, // Local distance
	}
	
	t.nodes = []*NUMANode{node}
}

// GetNode returns the NUMA node for a CPU
func (t *NUMATopology) GetNode(cpu int) *NUMANode {
	if nodeID, ok := t.cpuToNode[cpu]; ok && nodeID < len(t.nodes) {
		return t.nodes[nodeID]
	}
	return nil
}

// GetNodeCount returns the number of NUMA nodes
func (t *NUMATopology) GetNodeCount() int {
	return len(t.nodes)
}

// GetNodes returns all NUMA nodes
func (t *NUMATopology) GetNodes() []*NUMANode {
	return t.nodes
}

// ThreadPool provides NUMA-aware thread pooling
type ThreadPool struct {
	topology  *NUMATopology
	affinity  *CPUAffinity
	workers   []Worker
	workQueue chan func()
	done      chan struct{}
}

// Worker represents a worker thread
type Worker struct {
	id       int
	cpu      int
	node     int
	pool     *ThreadPool
}

// NewThreadPool creates a NUMA-aware thread pool
func NewThreadPool(workersPerNode int) (*ThreadPool, error) {
	topology, err := NewNUMATopology()
	if err != nil {
		return nil, err
	}
	
	pool := &ThreadPool{
		topology:  topology,
		affinity:  NewCPUAffinity(),
		workQueue: make(chan func(), workersPerNode*topology.GetNodeCount()*2),
		done:      make(chan struct{}),
	}
	
	// Create workers for each NUMA node
	workerID := 0
	for _, node := range topology.GetNodes() {
		cpuList := make([]int, 0)
		for cpu := 0; cpu < runtime.NumCPU(); cpu++ {
			if node.CPUs.Contains(cpu) {
				cpuList = append(cpuList, cpu)
			}
		}
		
		// Distribute workers across CPUs in the node
		for i := 0; i < workersPerNode && i < len(cpuList); i++ {
			worker := Worker{
				id:   workerID,
				cpu:  cpuList[i%len(cpuList)],
				node: node.ID,
				pool: pool,
			}
			pool.workers = append(pool.workers, worker)
			workerID++
		}
	}
	
	// Start workers
	for i := range pool.workers {
		go pool.workers[i].run()
	}
	
	return pool, nil
}

func (w *Worker) run() {
	// Pin to CPU
	cpus := NewCPUSet()
	cpus.Add(w.cpu)
	w.pool.affinity.SetThreadAffinity(cpus)
	defer w.pool.affinity.ReleaseThread()
	
	// Process work
	for {
		select {
		case work := <-w.pool.workQueue:
			if work == nil {
				return
			}
			work()
		case <-w.pool.done:
			return
		}
	}
}

// Submit submits work to the pool
func (p *ThreadPool) Submit(work func()) {
	select {
	case p.workQueue <- work:
	case <-p.done:
	}
}

// SubmitToNode submits work to a specific NUMA node
func (p *ThreadPool) SubmitToNode(nodeID int, work func()) error {
	// This would require per-node queues for optimal performance
	// For now, just submit to general queue
	p.Submit(work)
	return nil
}

// Stop stops the thread pool
func (p *ThreadPool) Stop() {
	close(p.done)
	close(p.workQueue)
}

// MemoryAllocator provides NUMA-aware memory allocation
type MemoryAllocator struct {
	topology *NUMATopology
}

// NewMemoryAllocator creates a NUMA-aware memory allocator
func NewMemoryAllocator() (*MemoryAllocator, error) {
	topology, err := NewNUMATopology()
	if err != nil {
		return nil, err
	}
	
	return &MemoryAllocator{
		topology: topology,
	}, nil
}

// AllocateOnNode allocates memory on a specific NUMA node
func (a *MemoryAllocator) AllocateOnNode(size int, nodeID int) ([]byte, error) {
	// Platform-specific NUMA allocation
	// For now, use regular allocation
	return make([]byte, size), nil
}

// AllocateInterleaved allocates memory interleaved across nodes
func (a *MemoryAllocator) AllocateInterleaved(size int) ([]byte, error) {
	// Platform-specific interleaved allocation
	// For now, use regular allocation
	return make([]byte, size), nil
}

// HugePage provides huge page memory allocation
type HugePage struct {
	size int
}

// NewHugePage creates a huge page allocator
func NewHugePage(sizeMB int) *HugePage {
	return &HugePage{
		size: sizeMB * 1024 * 1024,
	}
}

// Allocate allocates huge page memory
func (h *HugePage) Allocate() ([]byte, error) {
	// Platform-specific huge page allocation
	// This would use mmap with MAP_HUGETLB on Linux
	return make([]byte, h.size), nil
}

// CPUFeatures detects CPU features
type CPUFeatures struct {
	HasSSE     bool
	HasSSE2    bool
	HasSSE3    bool
	HasSSSE3   bool
	HasSSE41   bool
	HasSSE42   bool
	HasAVX     bool
	HasAVX2    bool
	HasAVX512  bool
	HasAES     bool
	HasSHA     bool
}

// DetectCPUFeatures detects available CPU features
func DetectCPUFeatures() *CPUFeatures {
	features := &CPUFeatures{}
	
	// Use CPUID instruction to detect features
	// This is platform and architecture specific
	// For now, assume basic features
	features.HasSSE = true
	features.HasSSE2 = true
	
	return features
}

// Prefetcher provides data prefetching hints
type Prefetcher struct{}

// NewPrefetcher creates a new prefetcher
func NewPrefetcher() *Prefetcher {
	return &Prefetcher{}
}

// PrefetchT0 prefetches data into all cache levels
func (p *Prefetcher) PrefetchT0(addr unsafe.Pointer) {
	// This would use PREFETCHT0 instruction on x86
	_ = *(*byte)(addr)
}

// PrefetchT1 prefetches data into L2 and L3 cache
func (p *Prefetcher) PrefetchT1(addr unsafe.Pointer) {
	// This would use PREFETCHT1 instruction on x86
	_ = *(*byte)(addr)
}

// PrefetchT2 prefetches data into L3 cache
func (p *Prefetcher) PrefetchT2(addr unsafe.Pointer) {
	// This would use PREFETCHT2 instruction on x86
	_ = *(*byte)(addr)
}

// PrefetchNTA prefetches data with non-temporal hint
func (p *Prefetcher) PrefetchNTA(addr unsafe.Pointer) {
	// This would use PREFETCHNTA instruction on x86
	_ = *(*byte)(addr)
}

// Helper functions

func getSystemMemory() uint64 {
	// This would read /proc/meminfo on Linux
	// For now, return a default value
	return 8 * 1024 * 1024 * 1024 // 8GB
}

// SetProcessPriority sets the process priority
func SetProcessPriority(priority int) error {
	// Platform-specific implementation
	if runtime.GOOS == "linux" {
		return syscall.Setpriority(syscall.PRIO_PROCESS, 0, priority)
	}
	return fmt.Errorf("process priority not supported on %s", runtime.GOOS)
}

// EnableHighPerformanceMode configures system for high performance
func EnableHighPerformanceMode() error {
	// Set process priority
	if err := SetProcessPriority(-10); err != nil {
		// Non-fatal, continue
	}
	
	// Increase file descriptor limits
	var rLimit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rLimit); err == nil {
		rLimit.Cur = rLimit.Max
		syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rLimit)
	}
	
	// Other platform-specific optimizations would go here
	
	return nil
}