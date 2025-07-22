/**
 * Automation API Routes
 * API endpoints for automation system management and monitoring
 */

import express from 'express';
import { getLogger } from '../core/logger.js';

const logger = getLogger('AutomationRoutes');

const router = express.Router();

/**
 * GET /api/automation/dashboard
 * Get comprehensive automation dashboard
 */
router.get('/dashboard', async (req, res) => {
  try {
    const app = req.app.locals.otedamaApp;
    if (!app?.automationOrchestrator) {
      return res.status(503).json({
        success: false,
        error: 'Automation system not available'
      });
    }

    const dashboard = app.automationOrchestrator.getAutomationDashboard();
    
    res.json({
      success: true,
      data: dashboard,
      message: 'Automation dashboard retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving automation dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve automation dashboard'
    });
  }
});

/**
 * GET /api/automation/systems/:systemName/status
 * Get status of specific automation system
 */
router.get('/systems/:systemName/status', async (req, res) => {
  try {
    const { systemName } = req.params;
    const app = req.app.locals.otedamaApp;
    
    if (!app?.automationOrchestrator) {
      return res.status(503).json({
        success: false,
        error: 'Automation system not available'
      });
    }

    const systemStatus = app.automationOrchestrator.getSystemStatus(systemName);
    
    if (!systemStatus) {
      return res.status(404).json({
        success: false,
        error: `System ${systemName} not found`
      });
    }

    res.json({
      success: true,
      data: systemStatus,
      message: `${systemName} system status retrieved successfully`
    });

  } catch (error) {
    logger.error('Error retrieving system status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve system status'
    });
  }
});

/**
 * POST /api/automation/systems/:systemName/control
 * Control specific automation system (admin only)
 */
router.post('/systems/:systemName/control', async (req, res) => {
  try {
    // Check admin privileges (simplified check)
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Administrator access required'
      });
    }

    const { systemName } = req.params;
    const { action, params = {} } = req.body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action parameter is required'
      });
    }

    const app = req.app.locals.otedamaApp;
    if (!app?.automationOrchestrator) {
      return res.status(503).json({
        success: false,
        error: 'Automation system not available'
      });
    }

    const result = await app.automationOrchestrator.controlSystem(systemName, action, params);
    
    res.json({
      success: true,
      data: result,
      message: `System control action '${action}' executed successfully`
    });

  } catch (error) {
    logger.error('Error controlling automation system:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to control automation system'
    });
  }
});

/**
 * GET /api/automation/user/:userId/status
 * Get user automation status
 */
router.get('/user/:userId/status', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Check if user can access this data
    if (!req.user || (req.user.id !== userId && !req.user.isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const app = req.app.locals.otedamaApp;
    const userSystem = app?.automationOrchestrator?.automationSystems?.get('user');
    
    if (!userSystem) {
      return res.status(503).json({
        success: false,
        error: 'User automation system not available'
      });
    }

    const userStatus = userSystem.getUserAutomationStatus(userId);
    
    if (!userStatus) {
      return res.status(404).json({
        success: false,
        error: 'User not found or not registered for automation'
      });
    }

    res.json({
      success: true,
      data: userStatus,
      message: 'User automation status retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving user automation status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve user automation status'
    });
  }
});

/**
 * POST /api/automation/user/:userId/register
 * Register user for automation
 */
router.post('/user/:userId/register', async (req, res) => {
  try {
    const { userId } = req.params;
    const { preferences = {} } = req.body;
    
    // Check if user can register
    if (!req.user || (req.user.id !== userId && !req.user.isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const app = req.app.locals.otedamaApp;
    const userSystem = app?.automationOrchestrator?.automationSystems?.get('user');
    
    if (!userSystem) {
      return res.status(503).json({
        success: false,
        error: 'User automation system not available'
      });
    }

    const userProfile = await userSystem.registerUser(userId, preferences);
    
    res.json({
      success: true,
      data: userProfile,
      message: 'User registered for automation successfully'
    });

  } catch (error) {
    logger.error('Error registering user for automation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register user for automation'
    });
  }
});

/**
 * PUT /api/automation/user/:userId/preferences
 * Update user automation preferences
 */
router.put('/user/:userId/preferences', async (req, res) => {
  try {
    const { userId } = req.params;
    const { preferences } = req.body;
    
    if (!preferences) {
      return res.status(400).json({
        success: false,
        error: 'Preferences parameter is required'
      });
    }

    // Check if user can update preferences
    if (!req.user || (req.user.id !== userId && !req.user.isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const app = req.app.locals.otedamaApp;
    const userSystem = app?.automationOrchestrator?.automationSystems?.get('user');
    
    if (!userSystem) {
      return res.status(503).json({
        success: false,
        error: 'User automation system not available'
      });
    }

    const success = await userSystem.updateUserPreferences(userId, preferences);
    
    if (!success) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User automation preferences updated successfully'
    });

  } catch (error) {
    logger.error('Error updating user automation preferences:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user automation preferences'
    });
  }
});

/**
 * GET /api/automation/security/dashboard
 * Get security automation dashboard (admin only)
 */
router.get('/security/dashboard', async (req, res) => {
  try {
    // Check admin privileges
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Administrator access required'
      });
    }

    const app = req.app.locals.otedamaApp;
    const securitySystem = app?.automationOrchestrator?.automationSystems?.get('security');
    
    if (!securitySystem) {
      return res.status(503).json({
        success: false,
        error: 'Security automation system not available'
      });
    }

    const dashboard = securitySystem.getSecurityDashboard();
    
    res.json({
      success: true,
      data: dashboard,
      message: 'Security automation dashboard retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving security automation dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security automation dashboard'
    });
  }
});

/**
 * GET /api/automation/maintenance/dashboard
 * Get maintenance automation dashboard (admin only)
 */
router.get('/maintenance/dashboard', async (req, res) => {
  try {
    // Check admin privileges
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Administrator access required'
      });
    }

    const app = req.app.locals.otedamaApp;
    const maintenanceSystem = app?.automationOrchestrator?.automationSystems?.get('maintenance');
    
    if (!maintenanceSystem) {
      return res.status(503).json({
        success: false,
        error: 'Maintenance automation system not available'
      });
    }

    const dashboard = maintenanceSystem.getMaintenanceDashboard();
    
    res.json({
      success: true,
      data: dashboard,
      message: 'Maintenance automation dashboard retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving maintenance automation dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve maintenance automation dashboard'
    });
  }
});

/**
 * GET /api/automation/admin/dashboard
 * Get admin automation dashboard (admin only)
 */
router.get('/admin/dashboard', async (req, res) => {
  try {
    // Check admin privileges
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Administrator access required'
      });
    }

    const app = req.app.locals.otedamaApp;
    const adminSystem = app?.automationOrchestrator?.automationSystems?.get('admin');
    
    if (!adminSystem) {
      return res.status(503).json({
        success: false,
        error: 'Admin automation system not available'
      });
    }

    const dashboard = adminSystem.getAdminDashboard();
    
    res.json({
      success: true,
      data: dashboard,
      message: 'Admin automation dashboard retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving admin automation dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve admin automation dashboard'
    });
  }
});

/**
 * GET /api/automation/status
 * Get overall automation system status
 */
router.get('/status', async (req, res) => {
  try {
    const app = req.app.locals.otedamaApp;
    
    if (!app?.automationOrchestrator) {
      return res.status(503).json({
        success: false,
        error: 'Automation system not available'
      });
    }

    const status = app.automationOrchestrator.getStatus();
    
    res.json({
      success: true,
      data: status,
      message: 'Automation system status retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving automation status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve automation status'
    });
  }
});

export default router;