/**
 * Incident Manager - Comprehensive Incident Management System
 * 
 * Design Philosophy:
 * - Carmack: Fast incident detection and response
 * - Martin: Clear state management and workflows
 * - Pike: Simple status tracking, clear actions
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { UnifiedLogger } from '../logging/unified-logger';
import { AlertRuleEngine, Alert } from '../monitoring/alert-rules';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
  assignee?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  alerts: string[]; // Alert IDs associated with this incident
  timeline: IncidentTimelineEntry[];
  tags: Record<string, string>;
  impactedServices: string[];
  estimatedResolutionTime?: Date;
  postMortemRequired: boolean;
  escalationLevel: number;
}

export interface IncidentTimelineEntry {
  id: string;
  timestamp: Date;
  type: 'created' | 'updated' | 'escalated' | 'assigned' | 'resolved' | 'note';
  message: string;
  author?: string;
  data?: Record<string, any>;
}

export interface IncidentEscalationRule {
  severityLevel: string;
  escalationDelayMinutes: number;
  escalationTo: string[];
  autoActions: string[];
}

export interface IncidentResponse {
  playbook?: string;
  contacts: string[];
  automatedActions: string[];
  estimatedTTR: number; // Time To Recovery in minutes
}

export class IncidentManager extends EventEmitter {
  private incidents: Map<string, Incident> = new Map();
  private escalationRules: Map<string, IncidentEscalationRule> = new Map();
  private escalationTimers: Map<string, NodeJS.Timeout> = new Map();
  private responsePlaybooks: Map<string, IncidentResponse> = new Map();

  constructor(
    private alertEngine: AlertRuleEngine,
    private logger: UnifiedLogger,
    private config = {
      autoCreateIncidents: true,
      maxOpenIncidents: 100,
      defaultEscalationDelayMinutes: 30
    }
  ) {
    super();
    this.initializeEscalationRules();
    this.initializeResponsePlaybooks();
    this.setupAlertHandlers();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Incident Manager...');
    
    // Clean up old resolved incidents
    this.cleanupOldIncidents();
    
    this.logger.info('Incident Manager started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Incident Manager...');
    
    // Clear all escalation timers
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();

    this.logger.info('Incident Manager stopped');
  }

  public createIncident(params: {
    title: string;
    description: string;
    severity: Incident['severity'];
    alertIds?: string[];
    impactedServices?: string[];
    assignee?: string;
    tags?: Record<string, string>;
  }): Incident {
    const incident: Incident = {
      id: uuidv4(),
      title: params.title,
      description: params.description,
      severity: params.severity,
      status: 'open',
      assignee: params.assignee,
      createdAt: new Date(),
      updatedAt: new Date(),
      alerts: params.alertIds || [],
      timeline: [],
      tags: params.tags || {},
      impactedServices: params.impactedServices || [],
      postMortemRequired: params.severity === 'critical' || params.severity === 'high',
      escalationLevel: 0
    };

    this.addTimelineEntry(incident, {
      type: 'created',
      message: `Incident created: ${params.title}`,
      data: { severity: params.severity }
    });

    this.incidents.set(incident.id, incident);
    this.startEscalationTimer(incident);

    this.emit('incidentCreated', incident);
    this.logger.warn(`Incident created: ${incident.id} - ${incident.title}`, {
      severity: incident.severity,
      impactedServices: incident.impactedServices
    });

    return incident;
  }

  public updateIncident(incidentId: string, updates: Partial<Incident>): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    const oldStatus = incident.status;
    const oldSeverity = incident.severity;

    Object.assign(incident, updates, { updatedAt: new Date() });

    // Track status changes
    if (oldStatus !== incident.status) {
      this.addTimelineEntry(incident, {
        type: 'updated',
        message: `Status changed from ${oldStatus} to ${incident.status}`
      });
    }

    // Track severity changes
    if (oldSeverity !== incident.severity) {
      this.addTimelineEntry(incident, {
        type: 'updated',
        message: `Severity changed from ${oldSeverity} to ${incident.severity}`
      });
      
      // Restart escalation timer if severity changed
      this.clearEscalationTimer(incidentId);
      this.startEscalationTimer(incident);
    }

    this.emit('incidentUpdated', incident);
    this.logger.info(`Incident updated: ${incidentId}`, { updates });
  }

  public resolveIncident(incidentId: string, resolution: string, author?: string): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    incident.status = 'resolved';
    incident.resolvedAt = new Date();
    incident.updatedAt = new Date();

    this.addTimelineEntry(incident, {
      type: 'resolved',
      message: resolution,
      author
    });

    this.clearEscalationTimer(incidentId);

    // Auto-resolve associated alerts
    incident.alerts.forEach(alertId => {
      this.alertEngine.resolveAlert(alertId);
    });

    this.emit('incidentResolved', incident);
    this.logger.info(`Incident resolved: ${incidentId} - ${resolution}`);
  }

  public assignIncident(incidentId: string, assignee: string, author?: string): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    const oldAssignee = incident.assignee;
    incident.assignee = assignee;
    incident.updatedAt = new Date();

    this.addTimelineEntry(incident, {
      type: 'assigned',
      message: `Assigned to ${assignee}${oldAssignee ? ` (previously ${oldAssignee})` : ''}`,
      author
    });

    this.emit('incidentAssigned', incident);
    this.logger.info(`Incident assigned: ${incidentId} to ${assignee}`);
  }

  public addIncidentNote(incidentId: string, note: string, author?: string): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }

    this.addTimelineEntry(incident, {
      type: 'note',
      message: note,
      author
    });

    incident.updatedAt = new Date();
    this.emit('incidentNoteAdded', incident);
  }

  public getIncident(incidentId: string): Incident | undefined {
    return this.incidents.get(incidentId);
  }

  public getOpenIncidents(): Incident[] {
    return Array.from(this.incidents.values())
      .filter(incident => incident.status !== 'resolved')
      .sort((a, b) => {
        // Sort by severity (critical first) then by creation time
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const aSeverity = severityOrder[a.severity];
        const bSeverity = severityOrder[b.severity];
        
        if (aSeverity !== bSeverity) {
          return bSeverity - aSeverity;
        }
        
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  public getIncidentsByService(serviceName: string): Incident[] {
    return Array.from(this.incidents.values())
      .filter(incident => incident.impactedServices.includes(serviceName));
  }

  public getIncidentStats(): {
    total: number;
    open: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    averageResolutionTime: number;
  } {
    const incidents = Array.from(this.incidents.values());
    const resolved = incidents.filter(i => i.status === 'resolved' && i.resolvedAt);
    
    const averageResolutionTime = resolved.length > 0
      ? resolved.reduce((sum, incident) => {
          const resolutionTime = incident.resolvedAt!.getTime() - incident.createdAt.getTime();
          return sum + resolutionTime;
        }, 0) / resolved.length / (1000 * 60) // Convert to minutes
      : 0;

    return {
      total: incidents.length,
      open: incidents.filter(i => i.status !== 'resolved').length,
      byStatus: this.groupByField(incidents, 'status'),
      bySeverity: this.groupByField(incidents, 'severity'),
      averageResolutionTime
    };
  }

  private setupAlertHandlers(): void {
    this.alertEngine.on('alertTriggered', (alert: Alert) => {
      if (this.config.autoCreateIncidents) {
        this.handleAlertTriggered(alert);
      }
    });

    this.alertEngine.on('alertResolved', (alert: Alert) => {
      this.handleAlertResolved(alert);
    });
  }

  private handleAlertTriggered(alert: Alert): void {
    // Check if there's already an open incident for this alert type
    const existingIncident = Array.from(this.incidents.values())
      .find(incident => 
        incident.status !== 'resolved' && 
        incident.alerts.includes(alert.id)
      );

    if (!existingIncident) {
      // Create new incident for critical/high severity alerts
      if (alert.severity === 'critical') {
        this.createIncident({
          title: `Critical Alert: ${alert.message}`,
          description: `Automated incident created from critical alert`,
          severity: 'critical',
          alertIds: [alert.id],
          tags: { ...alert.tags, source: 'alert_engine' }
        });
      }
    } else {
      // Add alert to existing incident
      if (!existingIncident.alerts.includes(alert.id)) {
        existingIncident.alerts.push(alert.id);
        this.addTimelineEntry(existingIncident, {
          type: 'updated',
          message: `Associated alert triggered: ${alert.message}`
        });
      }
    }
  }

  private handleAlertResolved(alert: Alert): void {
    // Check if this resolves any incidents
    const incidents = Array.from(this.incidents.values())
      .filter(incident => 
        incident.status !== 'resolved' && 
        incident.alerts.includes(alert.id)
      );

    incidents.forEach(incident => {
      // If all alerts for this incident are resolved, auto-resolve incident
      const allAlertsResolved = incident.alerts.every(alertId => {
        const associatedAlert = this.alertEngine.getActiveAlerts()
          .find(a => a.id === alertId);
        return !associatedAlert || associatedAlert.resolved;
      });

      if (allAlertsResolved) {
        this.resolveIncident(incident.id, 'All associated alerts resolved (automatic)', 'system');
      }
    });
  }

  private startEscalationTimer(incident: Incident): void {
    const rule = this.escalationRules.get(incident.severity);
    if (!rule) return;

    const timer = setTimeout(() => {
      this.escalateIncident(incident);
    }, rule.escalationDelayMinutes * 60 * 1000);

    this.escalationTimers.set(incident.id, timer);
  }

  private clearEscalationTimer(incidentId: string): void {
    const timer = this.escalationTimers.get(incidentId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(incidentId);
    }
  }

  private escalateIncident(incident: Incident): void {
    if (incident.status === 'resolved') return;

    incident.escalationLevel++;
    const rule = this.escalationRules.get(incident.severity);
    
    if (rule) {
      this.addTimelineEntry(incident, {
        type: 'escalated',
        message: `Incident escalated to level ${incident.escalationLevel}`,
        data: { escalationTo: rule.escalationTo }
      });

      // Execute automated actions
      rule.autoActions.forEach(action => {
        this.executeAutomatedAction(incident, action);
      });

      this.emit('incidentEscalated', incident);
      this.logger.warn(`Incident escalated: ${incident.id} to level ${incident.escalationLevel}`);

      // Set next escalation timer
      this.startEscalationTimer(incident);
    }
  }

  private executeAutomatedAction(incident: Incident, action: string): void {
    switch (action) {
      case 'notify_oncall':
        this.logger.info(`Would notify on-call for incident ${incident.id}`);
        break;
      case 'create_support_ticket':
        this.logger.info(`Would create support ticket for incident ${incident.id}`);
        break;
      case 'page_manager':
        this.logger.info(`Would page manager for incident ${incident.id}`);
        break;
      default:
        this.logger.warn(`Unknown automated action: ${action}`);
    }
  }

  private addTimelineEntry(incident: Incident, entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'>): void {
    const timelineEntry: IncidentTimelineEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      ...entry
    };
    
    incident.timeline.push(timelineEntry);
  }

  private groupByField(incidents: Incident[], field: keyof Incident): Record<string, number> {
    return incidents.reduce((acc, incident) => {
      const value = String(incident[field]);
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  private cleanupOldIncidents(): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90); // Keep incidents for 90 days

    const oldIncidents = Array.from(this.incidents.entries())
      .filter(([, incident]) => 
        incident.status === 'resolved' && 
        incident.resolvedAt && 
        incident.resolvedAt < cutoffDate
      );

    oldIncidents.forEach(([id]) => {
      this.incidents.delete(id);
    });

    if (oldIncidents.length > 0) {
      this.logger.info(`Cleaned up ${oldIncidents.length} old incidents`);
    }
  }

  private initializeEscalationRules(): void {
    const rules: [string, IncidentEscalationRule][] = [
      ['low', {
        severityLevel: 'low',
        escalationDelayMinutes: 120,
        escalationTo: ['team_lead'],
        autoActions: []
      }],
      ['medium', {
        severityLevel: 'medium',
        escalationDelayMinutes: 60,
        escalationTo: ['team_lead', 'manager'],
        autoActions: ['notify_oncall']
      }],
      ['high', {
        severityLevel: 'high',
        escalationDelayMinutes: 30,
        escalationTo: ['manager', 'senior_engineer'],
        autoActions: ['notify_oncall', 'create_support_ticket']
      }],
      ['critical', {
        severityLevel: 'critical',
        escalationDelayMinutes: 15,
        escalationTo: ['manager', 'director', 'oncall_engineer'],
        autoActions: ['notify_oncall', 'create_support_ticket', 'page_manager']
      }]
    ];

    rules.forEach(([severity, rule]) => {
      this.escalationRules.set(severity, rule);
    });
  }

  private initializeResponsePlaybooks(): void {
    const playbooks: [string, IncidentResponse][] = [
      ['database_down', {
        playbook: 'database_recovery_runbook.md',
        contacts: ['dba_team', 'infrastructure_team'],
        automatedActions: ['check_db_status', 'restart_replica'],
        estimatedTTR: 30
      }],
      ['high_cpu_usage', {
        playbook: 'cpu_performance_runbook.md',
        contacts: ['performance_team'],
        automatedActions: ['collect_cpu_profile', 'check_processes'],
        estimatedTTR: 15
      }],
      ['mining_pool_down', {
        playbook: 'pool_recovery_runbook.md',
        contacts: ['mining_team', 'network_team'],
        automatedActions: ['check_stratum_servers', 'verify_blockchain_sync'],
        estimatedTTR: 20
      }]
    ];

    playbooks.forEach(([type, response]) => {
      this.responsePlaybooks.set(type, response);
    });
  }
}

// For compatibility, we need to add the UUID dependency to package.json
// This is already included via the uuid package