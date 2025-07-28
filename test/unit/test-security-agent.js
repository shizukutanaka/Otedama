/**
 * Unit Tests for Security Agent
 */

import { SecurityAgent } from '../../lib/agents/security-agent.js';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

describe('SecurityAgent', () => {
  let agent;
  
  beforeEach(() => {
    agent = new SecurityAgent({
      name: 'TestSecurityAgent',
      interval: 1000
    });
  });
  
  afterEach(async () => {
    if (agent.state === 'running') {
      await agent.stop();
    }
  });
  
  describe('Initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(agent.name).toBe('TestSecurityAgent');
      expect(agent.type).toBe('security');
      expect(agent.interval).toBe(1000);
    });
    
    it('should start with low threat level', () => {
      expect(agent.threatLevel).toBe('low');
      expect(agent.blockedIPs.size).toBe(0);
    });
  });
  
  describe('Threat Detection', () => {
    it('should detect brute force attempts', async () => {
      const events = [
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'auth', subtype: 'failed_login', source: '192.168.1.1', timestamp: Date.now() }
      ];
      
      const threats = await agent.analyzeThreats(events);
      
      expect(threats).toHaveLength(1);
      expect(threats[0].type).toBe('brute_force');
      expect(threats[0].source).toBe('192.168.1.1');
      expect(threats[0].severity).toBe('high');
    });
    
    it('should detect DDoS patterns', async () => {
      const events = [];
      for (let i = 0; i < 150; i++) {
        events.push({
          type: 'network',
          subtype: 'connection',
          source: `192.168.1.${i % 10}`,
          timestamp: Date.now()
        });
      }
      
      const threats = await agent.analyzeThreats(events);
      
      const ddosThreat = threats.find(t => t.type === 'ddos');
      expect(ddosThreat).toBeDefined();
      expect(ddosThreat.severity).toBe('critical');
    });
    
    it('should not flag normal activity as threats', async () => {
      const events = [
        { type: 'auth', subtype: 'successful_login', source: '192.168.1.1', timestamp: Date.now() },
        { type: 'network', subtype: 'connection', source: '192.168.1.2', timestamp: Date.now() },
        { type: 'mining', subtype: 'share_submitted', source: '192.168.1.3', timestamp: Date.now() }
      ];
      
      const threats = await agent.analyzeThreats(events);
      
      expect(threats).toHaveLength(0);
    });
  });
  
  describe('Defensive Actions', () => {
    it('should block IPs for brute force attacks', async () => {
      const threat = {
        type: 'brute_force',
        source: '192.168.1.100',
        severity: 'high'
      };
      
      const actions = await agent.executeDefensiveActions([threat]);
      
      expect(agent.blockedIPs.has('192.168.1.100')).toBe(true);
      expect(actions).toContainEqual({
        action: 'block_ip',
        target: '192.168.1.100',
        duration: 3600000,
        reason: 'brute_force'
      });
    });
    
    it('should enable DDoS protection for critical threats', async () => {
      const threat = {
        type: 'ddos',
        severity: 'critical',
        confidence: 0.9
      };
      
      const actions = await agent.executeDefensiveActions([threat]);
      
      expect(actions).toContainEqual({
        action: 'enable_ddos_protection',
        level: 'maximum'
      });
    });
    
    it('should update threat level based on threats', () => {
      const highThreats = [
        { severity: 'high' },
        { severity: 'high' }
      ];
      
      agent.updateThreatLevel(highThreats);
      expect(agent.threatLevel).toBe('medium');
      
      const criticalThreats = [
        { severity: 'critical' },
        { severity: 'high' }
      ];
      
      agent.updateThreatLevel(criticalThreats);
      expect(agent.threatLevel).toBe('high');
    });
  });
  
  describe('Message Handling', () => {
    it('should respond to security check requests', async () => {
      const response = await agent.receiveMessage({
        from: 'TestAgent',
        action: 'checkSecurity',
        data: { target: '192.168.1.1' }
      });
      
      expect(response.status).toBe('security_checked');
      expect(response.data).toHaveProperty('isBlocked');
      expect(response.data).toHaveProperty('threatLevel');
    });
    
    it('should handle reportThreat messages', async () => {
      const response = await agent.receiveMessage({
        from: 'MonitoringAgent',
        action: 'reportThreat',
        data: {
          type: 'suspicious_activity',
          source: '192.168.1.50',
          details: 'Unusual pattern detected'
        }
      });
      
      expect(response.status).toBe('threat_reported');
      expect(agent.securityEvents).toHaveLength(1);
      expect(agent.securityEvents[0].reporter).toBe('MonitoringAgent');
    });
  });
  
  describe('Error Handling', () => {
    it('should handle analyzeThreats errors gracefully', async () => {
      // Pass invalid events
      const threats = await agent.analyzeThreats(null);
      expect(threats).toEqual([]);
    });
    
    it('should continue running after errors', async () => {
      agent.collectSecurityEvents = jest.fn().mockRejectedValue(new Error('Collection failed'));
      
      await agent.start();
      
      // Wait for one execution
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      expect(agent.state).toBe('running');
      expect(agent.stats.errors).toBeGreaterThan(0);
    });
  });
});