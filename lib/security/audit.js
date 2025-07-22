/**
 * Security Audit Module
 * 
 * This is now a facade that uses the UnifiedSecurityAuditManager
 * Maintains backward compatibility while using the consolidated system
 */

import UnifiedSecurityAuditManager from './unified-audit-manager.js';

// Re-export the unified manager as the default
export { UnifiedSecurityAuditManager as SecurityAuditManager };
export default UnifiedSecurityAuditManager;

// Backward compatibility exports
export const createSecurityAuditManager = (dbManager, config) => {
    return new UnifiedSecurityAuditManager(dbManager, config);
};