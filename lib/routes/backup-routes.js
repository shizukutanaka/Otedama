/**
 * Backup Management API Routes
 * 
 * Provides REST API for backup operations
 * Following clean code principles
 */

import express from 'express';
import { UnifiedBackupManager, BackupType } from '../backup/unified-backup-manager.js';
import { AdminMiddleware } from '../auth/admin-middleware.js';

export function createBackupRoutes(options = {}) {
    const router = express.Router();
    const { backupManager, adminMiddleware } = options;
    
    // Apply admin middleware to all backup routes
    if (adminMiddleware) {
        router.use(adminMiddleware.middleware());
    } else {
        // Create default admin middleware with IP-based access
        const defaultAdminMiddleware = new AdminMiddleware({
            requireIPWhitelist: true,
            allowedAdminIPs: process.env.ADMIN_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1']
        });
        router.use(defaultAdminMiddleware.middleware());
    }
    
    /**
     * Get backup status and statistics
     */
    router.get('/status', (req, res) => {
        const stats = backupManager.getStats();
        const state = {
            status: backupManager.state.status,
            lastBackup: backupManager.state.lastBackup,
            lastFullBackup: backupManager.state.lastFullBackup,
            activeBackups: backupManager.state.activeBackups.size,
            operationsSinceBackup: backupManager.state.operationsSinceBackup,
            strategy: backupManager.config.strategy,
            encryption: backupManager.config.encryption.enabled,
            cloud: !!backupManager.config.cloud
        };
        
        res.json({
            state,
            stats,
            timestamp: Date.now()
        });
    });
    
    /**
     * List backups with filtering
     */
    router.get('/list', (req, res) => {
        const { 
            type, 
            startDate, 
            endDate, 
            limit = 50,
            offset = 0,
            sortBy = 'timestamp',
            sortOrder = 'desc'
        } = req.query;
        
        let backups = [...backupManager.history];
        
        // Filter by type
        if (type) {
            backups = backups.filter(b => b.type === type);
        }
        
        // Filter by date range
        if (startDate) {
            const start = new Date(startDate).getTime();
            backups = backups.filter(b => b.startTime >= start);
        }
        
        if (endDate) {
            const end = new Date(endDate).getTime();
            backups = backups.filter(b => b.startTime <= end);
        }
        
        // Sort
        backups.sort((a, b) => {
            const aVal = a[sortBy] || 0;
            const bVal = b[sortBy] || 0;
            return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
        });
        
        // Paginate
        const total = backups.length;
        backups = backups.slice(offset, offset + limit);
        
        res.json({
            backups,
            total,
            limit,
            offset,
            timestamp: Date.now()
        });
    });
    
    /**
     * Create manual backup
     */
    router.post('/create', async (req, res) => {
        try {
            const { 
                type = BackupType.MANUAL,
                metadata = {}
            } = req.body;
            
            // Add user info to metadata
            metadata.triggeredBy = 'api';
            metadata.user = req.user?.username || 'admin';
            metadata.ip = req.ip;
            
            const backup = await backupManager.createBackup(type, metadata);
            
            res.json({
                success: true,
                backup,
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Restore from backup
     */
    router.post('/restore/:backupId', async (req, res) => {
        try {
            const { backupId } = req.params;
            const { 
                targetPath,
                verify = true
            } = req.body;
            
            const result = await backupManager.restoreBackup(backupId, {
                targetPath,
                verify
            });
            
            res.json({
                success: true,
                result,
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Delete backup
     */
    router.delete('/:backupId', async (req, res) => {
        try {
            const { backupId } = req.params;
            
            // Find backup in history
            const backup = backupManager.history.find(b => b.id === backupId);
            if (!backup) {
                return res.status(404).json({
                    error: 'Backup not found',
                    timestamp: Date.now()
                });
            }
            
            // Delete file
            const fs = await import('fs');
            if (backup.path && fs.existsSync(backup.path)) {
                fs.unlinkSync(backup.path);
            }
            
            // Delete from cloud if exists
            if (backupManager.cloudProvider && backup.metadata?.cloudPath) {
                await backupManager.cloudProvider.delete(backup.metadata.cloudPath).catch(() => {});
            }
            
            // Remove from history
            backupManager.history = backupManager.history.filter(b => b.id !== backupId);
            await backupManager.saveHistory();
            
            res.json({
                success: true,
                message: 'Backup deleted',
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Update backup schedule
     */
    router.put('/schedule/:name', (req, res) => {
        try {
            const { name } = req.params;
            const { schedule } = req.body;
            
            if (!schedule) {
                return res.status(400).json({
                    error: 'Schedule cron expression required',
                    timestamp: Date.now()
                });
            }
            
            // Validate cron expression
            const cron = require('node-cron');
            if (!cron.validate(schedule)) {
                return res.status(400).json({
                    error: 'Invalid cron expression',
                    timestamp: Date.now()
                });
            }
            
            // Update schedule
            backupManager.updateSchedule(name, schedule);
            
            res.json({
                success: true,
                name,
                schedule,
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Download backup file
     */
    router.get('/download/:backupId', async (req, res) => {
        try {
            const { backupId } = req.params;
            
            // Find backup
            const backup = backupManager.history.find(b => b.id === backupId);
            if (!backup || !backup.path) {
                return res.status(404).json({
                    error: 'Backup not found',
                    timestamp: Date.now()
                });
            }
            
            // Check if file exists
            const fs = await import('fs');
            if (!fs.existsSync(backup.path)) {
                return res.status(404).json({
                    error: 'Backup file not found',
                    timestamp: Date.now()
                });
            }
            
            // Set headers
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${backup.id}.backup"`);
            
            // Stream file
            const stream = fs.createReadStream(backup.path);
            stream.pipe(res);
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Verify backup integrity
     */
    router.post('/verify/:backupId', async (req, res) => {
        try {
            const { backupId } = req.params;
            
            // Find backup
            const backup = backupManager.history.find(b => b.id === backupId);
            if (!backup || !backup.path) {
                return res.status(404).json({
                    error: 'Backup not found',
                    timestamp: Date.now()
                });
            }
            
            // Verify backup
            const result = await backupManager.verifyBackup(backup.path);
            
            res.json({
                success: true,
                backupId,
                verification: result,
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    /**
     * Get cloud backup status
     */
    router.get('/cloud/status', async (req, res) => {
        if (!backupManager.cloudProvider) {
            return res.json({
                enabled: false,
                provider: null,
                timestamp: Date.now()
            });
        }
        
        try {
            const backups = await backupManager.cloudProvider.list();
            
            res.json({
                enabled: true,
                provider: backupManager.config.cloud.provider,
                backupCount: backups.length,
                totalSize: backups.reduce((sum, b) => sum + b.size, 0),
                lastUpload: backups[0]?.lastModified,
                timestamp: Date.now()
            });
            
        } catch (error) {
            res.status(500).json({
                error: error.message,
                timestamp: Date.now()
            });
        }
    });
    
    return router;
}

/**
 * Add updateSchedule method to backup manager
 */
UnifiedBackupManager.prototype.updateSchedule = function(name, schedule) {
    // Stop existing schedule
    const existingTask = this.state.scheduledTasks.get(name);
    if (existingTask && existingTask.stop) {
        existingTask.stop();
    }
    
    // Update config
    this.config.schedules[name] = schedule;
    
    // Create new schedule
    const cron = require('node-cron');
    const task = cron.schedule(schedule, async () => {
        try {
            await this.createBackup(BackupType.SCHEDULED, {
                schedule: name,
                cron: schedule
            });
        } catch (error) {
            this.emit('schedule:error', { schedule: name, error });
        }
    });
    
    this.state.scheduledTasks.set(name, task);
};

export default createBackupRoutes;