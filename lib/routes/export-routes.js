/**
 * Export API Routes
 * 
 * Handles data export requests
 */

import express from 'express';
import { ExportManager } from '../utils/export-manager.js';
import { createAuthMiddleware } from '../auth/auth-controller.js';
import path from 'path';
import fs from 'fs';

export function createExportRoutes(options = {}) {
    const router = express.Router();
    const exportManager = new ExportManager(options);
    const authMiddleware = createAuthMiddleware(options);
    
    // Apply auth to all routes
    router.use(authMiddleware);
    
    /**
     * Export transactions to Excel
     */
    router.post('/transactions/excel', async (req, res) => {
        try {
            const { startDate, endDate, type, currency } = req.body;
            
            const result = await exportManager.exportTransactionsExcel(req.user.id, {
                startDate,
                endDate,
                type,
                currency
            });
            
            res.json({
                success: true,
                filename: result.filename,
                downloadUrl: `/api/export/download/${result.filename}`
            });
            
        } catch (error) {
            console.error('Export error:', error);
            res.status(500).json({ error: 'Export failed' });
        }
    });
    
    /**
     * Export transactions to PDF
     */
    router.post('/transactions/pdf', async (req, res) => {
        try {
            const { startDate, endDate, type, currency } = req.body;
            
            const result = await exportManager.exportTransactionsPDF(req.user.id, {
                startDate,
                endDate,
                type,
                currency
            });
            
            res.json({
                success: true,
                filename: result.filename,
                downloadUrl: `/api/export/download/${result.filename}`
            });
            
        } catch (error) {
            console.error('Export error:', error);
            res.status(500).json({ error: 'Export failed' });
        }
    });
    
    /**
     * Export mining statistics to Excel
     */
    router.post('/mining-stats/excel', async (req, res) => {
        try {
            const { days = 30 } = req.body;
            
            const result = await exportManager.exportMiningStatsExcel(req.user.id, {
                days: parseInt(days)
            });
            
            res.json({
                success: true,
                filename: result.filename,
                downloadUrl: `/api/export/download/${result.filename}`
            });
            
        } catch (error) {
            console.error('Export error:', error);
            res.status(500).json({ error: 'Export failed' });
        }
    });
    
    /**
     * Export portfolio summary to PDF
     */
    router.post('/portfolio/pdf', async (req, res) => {
        try {
            const result = await exportManager.exportPortfolioPDF(req.user.id);
            
            res.json({
                success: true,
                filename: result.filename,
                downloadUrl: `/api/export/download/${result.filename}`
            });
            
        } catch (error) {
            console.error('Export error:', error);
            res.status(500).json({ error: 'Export failed' });
        }
    });
    
    /**
     * Download exported file
     */
    router.get('/download/:filename', async (req, res) => {
        try {
            const { filename } = req.params;
            
            // Security: ensure filename is safe
            if (!/^[a-zA-Z0-9_-]+\.(xlsx|pdf)$/.test(filename)) {
                return res.status(400).json({ error: 'Invalid filename' });
            }
            
            // Check if file belongs to user
            if (!filename.includes(req.user.id)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            
            const filepath = path.join(exportManager.exportPath, filename);
            
            // Check if file exists
            if (!fs.existsSync(filepath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            
            // Set headers
            const ext = path.extname(filename).toLowerCase();
            if (ext === '.xlsx') {
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            } else if (ext === '.pdf') {
                res.setHeader('Content-Type', 'application/pdf');
            }
            
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            
            // Stream file
            const stream = fs.createReadStream(filepath);
            stream.pipe(res);
            
            // Delete file after download (optional)
            stream.on('end', () => {
                setTimeout(() => {
                    fs.unlink(filepath, (err) => {
                        if (err) console.error('Failed to delete export file:', err);
                    });
                }, 60000); // Delete after 1 minute
            });
            
        } catch (error) {
            console.error('Download error:', error);
            res.status(500).json({ error: 'Download failed' });
        }
    });
    
    /**
     * Get export history
     */
    router.get('/history', async (req, res) => {
        try {
            const files = fs.readdirSync(exportManager.exportPath);
            const userFiles = files
                .filter(f => f.includes(req.user.id))
                .map(f => {
                    const stats = fs.statSync(path.join(exportManager.exportPath, f));
                    return {
                        filename: f,
                        size: stats.size,
                        created: stats.ctime,
                        type: path.extname(f).substring(1).toUpperCase()
                    };
                })
                .sort((a, b) => b.created - a.created)
                .slice(0, 20); // Last 20 exports
            
            res.json(userFiles);
            
        } catch (error) {
            console.error('History error:', error);
            res.status(500).json({ error: 'Failed to get export history' });
        }
    });
    
    return router;
}

/**
 * Export formats info endpoint
 */
export function getExportFormats() {
    return {
        transactions: {
            excel: {
                name: 'Excel Spreadsheet',
                extension: 'xlsx',
                features: ['Filtering', 'Sorting', 'Charts', 'Multiple sheets'],
                maxRecords: 1000000
            },
            pdf: {
                name: 'PDF Document',
                extension: 'pdf',
                features: ['Printable', 'Summary', 'Portable'],
                maxRecords: 10000
            }
        },
        miningStats: {
            excel: {
                name: 'Excel Spreadsheet',
                extension: 'xlsx',
                features: ['Daily stats', 'Worker details', 'Charts', 'Summary'],
                maxDays: 365
            }
        },
        portfolio: {
            pdf: {
                name: 'PDF Report',
                extension: 'pdf',
                features: ['Asset breakdown', 'Performance metrics', 'Charts'],
                includesHistory: true
            }
        }
    };
}

export default createExportRoutes;