package agents

import (
	"fmt"
	"sync"
	"time"
)

type AgentType string

const (
	TestSpecialist AgentType = "test-specialist"
	CodeReviewer   AgentType = "code-reviewer"
	Performance    AgentType = "performance"
	Security       AgentType = "security"
)

type AgentStatus string

const (
	StatusActive   AgentStatus = "active"
	StatusInactive AgentStatus = "inactive"
	StatusRunning  AgentStatus = "running"
)

type Agent struct {
	ID          string
	Type        AgentType
	Name        string
	Description string
	ConfigPath  string
	Status      AgentStatus
	CreatedAt   time.Time
	LastRun     time.Time
}

type AgentRegistry struct {
	mu     sync.RWMutex
	agents map[string]*Agent
}

func NewAgentRegistry() *AgentRegistry {
	return &AgentRegistry{
		agents: make(map[string]*Agent),
	}
}

func (r *AgentRegistry) Register(agent *Agent) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.agents[agent.ID]; exists {
		return fmt.Errorf("agent with ID %s already exists", agent.ID)
	}

	agent.CreatedAt = time.Now()
	agent.Status = StatusActive
	r.agents[agent.ID] = agent

	return nil
}

func (r *AgentRegistry) GetAgent(id string) (*Agent, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	agent, exists := r.agents[id]
	if !exists {
		return nil, fmt.Errorf("agent with ID %s not found", id)
	}

	return agent, nil
}

func (r *AgentRegistry) ListAgents() []*Agent {
	r.mu.RLock()
	defer r.mu.RUnlock()

	agents := make([]*Agent, 0, len(r.agents))
	for _, agent := range r.agents {
		agents = append(agents, agent)
	}

	return agents
}

func (r *AgentRegistry) UpdateStatus(id string, status AgentStatus) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	agent, exists := r.agents[id]
	if !exists {
		return fmt.Errorf("agent with ID %s not found", id)
	}

	agent.Status = status
	if status == StatusRunning {
		agent.LastRun = time.Now()
	}

	return nil
}