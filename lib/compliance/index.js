/**
 * Compliance Module Entry Point
 * Integrates compliance and ESG monitoring with the main application
 */

import ComplianceESGFramework from './compliance-esg-framework.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('Index');

/**
 * Initialize and configure compliance monitoring
 */
export async function initializeCompliance(config = {}) {
  try {
    const complianceFramework = new ComplianceESGFramework({
      // Enable frameworks based on industry/requirements
      frameworks: {
        gdpr: true,
        sox: config.financial || false,
        iso27001: true,
        pci: config.payments || false,
        hipaa: config.healthcare || false,
        fips: config.government || false,
        nist: true
      },
      
      // ESG monitoring configuration
      esg: {
        environmental: {
          carbonFootprint: true,
          energyEfficiency: true,
          renewableEnergy: config.sustainability || false,
          wasteReduction: true
        },
        social: {
          dataPrivacy: true,
          cybersecurity: true,
          employeeSafety: true,
          communityImpact: config.socialImpact || false
        },
        governance: {
          ethicalAI: true,
          transparency: true,
          riskManagement: true,
          auditTrails: true
        }
      },
      
      // Monitoring settings
      monitoring: {
        realTimeAlerts: true,
        continuousAssessment: true,
        automaticRemediation: config.autoRemediation !== false,
        complianceScoring: true
      },
      
      // Reporting configuration
      reporting: {
        frequency: config.reportFrequency || 'monthly',
        formats: ['json', 'pdf'],
        stakeholders: config.stakeholders || [],
        auditTrail: true
      },
      
      dataDirectory: config.dataDirectory || './data/compliance',
      retentionPeriod: config.retentionPeriod || 7 * 365 * 24 * 60 * 60 * 1000,
      
      ...config
    });

    // Set up event handlers
    complianceFramework.on('critical-compliance-issues', (event) => {
      logger.error('Critical compliance issues detected:', event);
      // Notify administrators, create tickets, etc.
    });

    complianceFramework.on('violation-detected', (violation) => {
      logger.warn('Compliance violation detected:', violation);
      // Log to security systems, create alerts
    });

    complianceFramework.on('assessment-completed', (assessment) => {
      logger.info('Compliance assessment completed:', {
        id: assessment.assessmentId,
        score: assessment.score
      });
    });

    complianceFramework.on('esg-metrics-collected', (metrics) => {
      logger.debug('ESG metrics collected:', {
        timestamp: metrics.timestamp,
        overallScore: metrics.scores.overall
      });
    });

    await complianceFramework.initialize();
    logger.info('Compliance and ESG framework initialized successfully');
    
    return complianceFramework;

  } catch (error) {
    logger.error('Failed to initialize compliance framework:', error);
    throw error;
  }
}

/**
 * Compliance middleware for Express applications
 */
export function complianceMiddleware(complianceFramework) {
  return (req, res, next) => {
    // Add compliance context to requests
    req.compliance = {
      framework: complianceFramework,
      logAccess: (resource, action) => {
        complianceFramework.logAuditEvent('resource-access', {
          resource,
          action,
          user: req.user?.id || 'anonymous',
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          timestamp: Date.now()
        });
      },
      checkDataAccess: (dataType, purpose) => {
        // Implement data access compliance checks
        return complianceFramework.checkDataAccess(dataType, purpose, req.user);
      }
    };
    
    next();
  };
}

/**
 * Get compliance dashboard data
 */
export async function getComplianceDashboard(complianceFramework) {
  return complianceFramework.getComplianceDashboard();
}

/**
 * Generate compliance report
 */
export async function generateComplianceReport(complianceFramework, options = {}) {
  const {
    timeframe = '30d',
    format = 'json',
    frameworks = [],
    includeESG = true
  } = options;

  return complianceFramework.generateComplianceReport(timeframe, format);
}

/**
 * Perform on-demand compliance assessment
 */
export async function performComplianceAssessment(complianceFramework, frameworks = []) {
  return complianceFramework.performComplianceAssessment(frameworks);
}

/**
 * Get audit trail
 */
export function getAuditTrail(complianceFramework, filters = {}) {
  return complianceFramework.getAuditTrail(filters);
}

export { ComplianceESGFramework };
export default { 
  initializeCompliance,
  complianceMiddleware,
  getComplianceDashboard,
  generateComplianceReport,
  performComplianceAssessment,
  getAuditTrail
};