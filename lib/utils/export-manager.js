/**
 * Export Manager
 * 
 * Handles data export to PDF and Excel formats
 * Following clean code principles
 */

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { DatabaseManager } from '../core/database-manager.js';

export class ExportManager {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        this.exportPath = options.exportPath || path.join(process.cwd(), 'exports');
        this.locale = options.locale || 'en';
        
        // Ensure export directory exists
        if (!fs.existsSync(this.exportPath)) {
            fs.mkdirSync(this.exportPath, { recursive: true });
        }
    }
    
    /**
     * Export user transactions to Excel
     */
    async exportTransactionsExcel(userId, options = {}) {
        const {
            startDate = null,
            endDate = null,
            type = null,
            currency = null
        } = options;
        
        // Get transactions
        const transactions = await this.getTransactions(userId, {
            startDate,
            endDate,
            type,
            currency
        });
        
        // Create workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Otedama';
        workbook.created = new Date();
        
        // Add worksheet
        const worksheet = workbook.addWorksheet('Transactions');
        
        // Define columns
        worksheet.columns = [
            { header: 'Date', key: 'date', width: 20 },
            { header: 'Type', key: 'type', width: 15 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Amount', key: 'amount', width: 15 },
            { header: 'Fee', key: 'fee', width: 10 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'TX Hash', key: 'tx_hash', width: 50 },
            { header: 'Description', key: 'description', width: 30 }
        ];
        
        // Style header row
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        
        // Add data
        transactions.forEach(tx => {
            worksheet.addRow({
                date: new Date(tx.created_at).toLocaleString(),
                type: tx.type,
                currency: tx.currency,
                amount: parseFloat(tx.amount),
                fee: parseFloat(tx.fee || 0),
                status: tx.status,
                tx_hash: tx.tx_hash || '-',
                description: tx.description || ''
            });
        });
        
        // Add totals
        const lastRow = worksheet.lastRow.number + 2;
        worksheet.getCell(`A${lastRow}`).value = 'TOTALS:';
        worksheet.getCell(`A${lastRow}`).font = { bold: true };
        
        // Calculate totals by currency
        const totals = {};
        transactions.forEach(tx => {
            if (!totals[tx.currency]) {
                totals[tx.currency] = { amount: 0, fee: 0 };
            }
            totals[tx.currency].amount += parseFloat(tx.amount);
            totals[tx.currency].fee += parseFloat(tx.fee || 0);
        });
        
        let row = lastRow + 1;
        for (const [currency, total] of Object.entries(totals)) {
            worksheet.getCell(`B${row}`).value = currency;
            worksheet.getCell(`D${row}`).value = total.amount;
            worksheet.getCell(`E${row}`).value = total.fee;
            row++;
        }
        
        // Auto-filter
        worksheet.autoFilter = {
            from: 'A1',
            to: `H${worksheet.lastRow.number}`
        };
        
        // Save file
        const filename = `transactions_${userId}_${Date.now()}.xlsx`;
        const filepath = path.join(this.exportPath, filename);
        await workbook.xlsx.writeFile(filepath);
        
        return { filename, filepath };
    }
    
    /**
     * Export user transactions to PDF
     */
    async exportTransactionsPDF(userId, options = {}) {
        const {
            startDate = null,
            endDate = null,
            type = null,
            currency = null
        } = options;
        
        // Get transactions
        const transactions = await this.getTransactions(userId, {
            startDate,
            endDate,
            type,
            currency
        });
        
        // Get user info
        const user = await this.getUserInfo(userId);
        
        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        const filename = `transactions_${userId}_${Date.now()}.pdf`;
        const filepath = path.join(this.exportPath, filename);
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);
        
        // Header
        doc.fontSize(20).text('Transaction Report', { align: 'center' });
        doc.moveDown();
        
        // User info
        doc.fontSize(12);
        doc.text(`User: ${user.username} (${user.email})`);
        doc.text(`Generated: ${new Date().toLocaleString()}`);
        
        if (startDate || endDate) {
            doc.text(`Period: ${startDate || 'Beginning'} to ${endDate || 'Present'}`);
        }
        
        doc.moveDown();
        
        // Table header
        const tableTop = doc.y;
        const columnWidths = [100, 60, 60, 80, 60, 80];
        const columns = ['Date', 'Type', 'Currency', 'Amount', 'Fee', 'Status'];
        
        // Draw header
        doc.font('Helvetica-Bold');
        let x = doc.x;
        columns.forEach((col, i) => {
            doc.text(col, x, tableTop, { width: columnWidths[i], align: 'left' });
            x += columnWidths[i];
        });
        
        // Draw line
        doc.moveTo(50, doc.y + 5)
           .lineTo(550, doc.y + 5)
           .stroke();
        
        doc.y += 10;
        doc.font('Helvetica');
        
        // Table data
        transactions.forEach(tx => {
            // Check if need new page
            if (doc.y > 700) {
                doc.addPage();
                doc.y = 50;
            }
            
            const y = doc.y;
            x = 50;
            
            const rowData = [
                new Date(tx.created_at).toLocaleDateString(),
                tx.type,
                tx.currency,
                parseFloat(tx.amount).toFixed(8),
                parseFloat(tx.fee || 0).toFixed(8),
                tx.status
            ];
            
            rowData.forEach((data, i) => {
                doc.text(data, x, y, { width: columnWidths[i], align: 'left' });
                x += columnWidths[i];
            });
            
            doc.y = y + 15;
        });
        
        // Summary
        doc.moveDown(2);
        doc.font('Helvetica-Bold');
        doc.text('Summary by Currency:', 50);
        doc.font('Helvetica');
        
        const totals = {};
        transactions.forEach(tx => {
            if (!totals[tx.currency]) {
                totals[tx.currency] = { 
                    count: 0, 
                    amount: 0, 
                    fee: 0,
                    deposits: 0,
                    withdrawals: 0
                };
            }
            totals[tx.currency].count++;
            totals[tx.currency].amount += parseFloat(tx.amount);
            totals[tx.currency].fee += parseFloat(tx.fee || 0);
            
            if (tx.type === 'deposit') {
                totals[tx.currency].deposits += parseFloat(tx.amount);
            } else if (tx.type === 'withdrawal') {
                totals[tx.currency].withdrawals += parseFloat(tx.amount);
            }
        });
        
        for (const [currency, total] of Object.entries(totals)) {
            doc.moveDown();
            doc.text(`${currency}:`);
            doc.text(`  Transactions: ${total.count}`);
            doc.text(`  Total Amount: ${total.amount.toFixed(8)}`);
            doc.text(`  Total Fees: ${total.fee.toFixed(8)}`);
            doc.text(`  Deposits: ${total.deposits.toFixed(8)}`);
            doc.text(`  Withdrawals: ${total.withdrawals.toFixed(8)}`);
        }
        
        // Footer
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
            doc.switchToPage(i);
            doc.fontSize(10);
            doc.text(
                `Page ${i + 1} of ${pages.count}`,
                50,
                doc.page.height - 50,
                { align: 'center' }
            );
        }
        
        doc.end();
        
        // Wait for file to be written
        await new Promise(resolve => stream.on('finish', resolve));
        
        return { filename, filepath };
    }
    
    /**
     * Export mining statistics to Excel
     */
    async exportMiningStatsExcel(userId, options = {}) {
        const { days = 30 } = options;
        
        // Get mining stats
        const stats = await this.getMiningStats(userId, days);
        
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Otedama';
        
        // Daily stats worksheet
        const dailySheet = workbook.addWorksheet('Daily Stats');
        dailySheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Hashrate (avg)', key: 'hashrate', width: 15 },
            { header: 'Shares', key: 'shares', width: 10 },
            { header: 'Valid Shares', key: 'valid_shares', width: 12 },
            { header: 'Invalid %', key: 'invalid_percent', width: 10 },
            { header: 'Earnings (BTC)', key: 'earnings', width: 15 },
            { header: 'Workers', key: 'workers', width: 10 }
        ];
        
        // Style header
        dailySheet.getRow(1).font = { bold: true };
        dailySheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        
        // Add daily data
        stats.daily.forEach(day => {
            dailySheet.addRow({
                date: new Date(day.date).toLocaleDateString(),
                hashrate: this.formatHashrate(day.avg_hashrate),
                shares: day.total_shares,
                valid_shares: day.valid_shares,
                invalid_percent: ((1 - day.valid_shares / day.total_shares) * 100).toFixed(2) + '%',
                earnings: parseFloat(day.earnings).toFixed(8),
                workers: day.worker_count
            });
        });
        
        // Workers worksheet
        const workersSheet = workbook.addWorksheet('Workers');
        workersSheet.columns = [
            { header: 'Worker Name', key: 'name', width: 20 },
            { header: 'Status', key: 'status', width: 10 },
            { header: 'Hashrate', key: 'hashrate', width: 15 },
            { header: 'Shares (24h)', key: 'shares', width: 12 },
            { header: 'Efficiency', key: 'efficiency', width: 12 },
            { header: 'Last Seen', key: 'last_seen', width: 20 }
        ];
        
        workersSheet.getRow(1).font = { bold: true };
        workersSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF2196F3' }
        };
        
        // Add worker data
        stats.workers.forEach(worker => {
            workersSheet.addRow({
                name: worker.name,
                status: worker.active ? 'Active' : 'Offline',
                hashrate: this.formatHashrate(worker.hashrate),
                shares: worker.shares_24h,
                efficiency: (worker.efficiency * 100).toFixed(2) + '%',
                last_seen: new Date(worker.last_seen).toLocaleString()
            });
        });
        
        // Summary worksheet
        const summarySheet = workbook.addWorksheet('Summary');
        summarySheet.columns = [
            { header: 'Metric', key: 'metric', width: 30 },
            { header: 'Value', key: 'value', width: 30 }
        ];
        
        const summaryData = [
            { metric: 'Period', value: `Last ${days} days` },
            { metric: 'Total Hashrate (current)', value: this.formatHashrate(stats.summary.current_hashrate) },
            { metric: 'Average Hashrate', value: this.formatHashrate(stats.summary.avg_hashrate) },
            { metric: 'Peak Hashrate', value: this.formatHashrate(stats.summary.peak_hashrate) },
            { metric: 'Total Shares', value: stats.summary.total_shares.toLocaleString() },
            { metric: 'Valid Share Rate', value: (stats.summary.valid_share_rate * 100).toFixed(2) + '%' },
            { metric: 'Total Earnings (BTC)', value: stats.summary.total_earnings.toFixed(8) },
            { metric: 'Active Workers', value: stats.summary.active_workers },
            { metric: 'Total Workers', value: stats.summary.total_workers }
        ];
        
        summaryData.forEach(row => summarySheet.addRow(row));
        
        // Charts data worksheet
        const chartsSheet = workbook.addWorksheet('Charts Data');
        
        // Prepare chart data
        const chartData = stats.daily.map(day => ({
            date: new Date(day.date).toLocaleDateString(),
            hashrate: day.avg_hashrate / 1e9, // Convert to GH/s
            earnings: parseFloat(day.earnings)
        }));
        
        chartsSheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Hashrate (GH/s)', key: 'hashrate', width: 15 },
            { header: 'Earnings (BTC)', key: 'earnings', width: 15 }
        ];
        
        chartData.forEach(row => chartsSheet.addRow(row));
        
        // Add chart
        const hashrateChart = workbook.addChart('line', {
            title: { name: 'Hashrate Over Time' },
            data: [
                {
                    name: 'Hashrate',
                    color: 'FF0000',
                    values: `'Charts Data'!B2:B${chartData.length + 1}`,
                    categories: `'Charts Data'!A2:A${chartData.length + 1}`
                }
            ]
        });
        
        // Save file
        const filename = `mining_stats_${userId}_${Date.now()}.xlsx`;
        const filepath = path.join(this.exportPath, filename);
        await workbook.xlsx.writeFile(filepath);
        
        return { filename, filepath };
    }
    
    /**
     * Export portfolio summary to PDF
     */
    async exportPortfolioPDF(userId) {
        const user = await this.getUserInfo(userId);
        const balances = await this.getUserBalances(userId);
        const portfolio = await this.getPortfolioValue(userId);
        
        const doc = new PDFDocument({ margin: 50 });
        const filename = `portfolio_${userId}_${Date.now()}.pdf`;
        const filepath = path.join(this.exportPath, filename);
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);
        
        // Header
        doc.fontSize(24).text('Portfolio Summary', { align: 'center' });
        doc.moveDown();
        
        // User info
        doc.fontSize(14);
        doc.text(`Account: ${user.username}`);
        doc.text(`Date: ${new Date().toLocaleDateString()}`);
        doc.moveDown(2);
        
        // Total value
        doc.fontSize(16).font('Helvetica-Bold');
        doc.text(`Total Portfolio Value: ${portfolio.total_btc.toFixed(8)} BTC`);
        doc.fontSize(12).font('Helvetica');
        doc.text(`(≈ $${portfolio.total_usd.toFixed(2)} USD)`);
        doc.moveDown(2);
        
        // Asset breakdown
        doc.fontSize(14).font('Helvetica-Bold');
        doc.text('Asset Breakdown:');
        doc.font('Helvetica');
        doc.moveDown();
        
        // Table
        const tableTop = doc.y;
        const cols = ['Asset', 'Balance', 'BTC Value', 'USD Value', '% of Portfolio'];
        const colWidths = [80, 100, 100, 100, 100];
        
        // Header
        doc.fontSize(11).font('Helvetica-Bold');
        let x = 50;
        cols.forEach((col, i) => {
            doc.text(col, x, tableTop, { width: colWidths[i] });
            x += colWidths[i];
        });
        
        doc.moveTo(50, doc.y + 5).lineTo(530, doc.y + 5).stroke();
        doc.y += 10;
        doc.font('Helvetica');
        
        // Data
        balances.forEach(balance => {
            const y = doc.y;
            x = 50;
            
            const percentage = (balance.btc_value / portfolio.total_btc * 100).toFixed(2);
            const rowData = [
                balance.currency,
                balance.total.toFixed(8),
                balance.btc_value.toFixed(8),
                `$${balance.usd_value.toFixed(2)}`,
                `${percentage}%`
            ];
            
            rowData.forEach((data, i) => {
                doc.text(data, x, y, { width: colWidths[i] });
                x += colWidths[i];
            });
            
            doc.y = y + 20;
        });
        
        // Performance metrics
        if (portfolio.performance) {
            doc.addPage();
            doc.fontSize(16).font('Helvetica-Bold');
            doc.text('Performance Metrics:');
            doc.font('Helvetica').fontSize(12);
            doc.moveDown();
            
            doc.text(`24h Change: ${portfolio.performance.change_24h.toFixed(2)}%`);
            doc.text(`7d Change: ${portfolio.performance.change_7d.toFixed(2)}%`);
            doc.text(`30d Change: ${portfolio.performance.change_30d.toFixed(2)}%`);
            doc.moveDown();
            
            doc.text(`Total Deposits: ${portfolio.performance.total_deposits.toFixed(8)} BTC`);
            doc.text(`Total Withdrawals: ${portfolio.performance.total_withdrawals.toFixed(8)} BTC`);
            doc.text(`Net P&L: ${portfolio.performance.net_pnl.toFixed(8)} BTC`);
        }
        
        // Disclaimer
        doc.moveDown(3);
        doc.fontSize(10).fillColor('gray');
        doc.text('This report is for informational purposes only. Cryptocurrency values are volatile and subject to market conditions.', {
            align: 'center'
        });
        
        doc.end();
        await new Promise(resolve => stream.on('finish', resolve));
        
        return { filename, filepath };
    }
    
    /**
     * Helper: Get transactions
     */
    async getTransactions(userId, filters) {
        let query = 'SELECT * FROM transactions WHERE user_id = ?';
        const params = [userId];
        
        if (filters.startDate) {
            query += ' AND created_at >= ?';
            params.push(filters.startDate);
        }
        
        if (filters.endDate) {
            query += ' AND created_at <= ?';
            params.push(filters.endDate);
        }
        
        if (filters.type) {
            query += ' AND type = ?';
            params.push(filters.type);
        }
        
        if (filters.currency) {
            query += ' AND currency = ?';
            params.push(filters.currency);
        }
        
        query += ' ORDER BY created_at DESC';
        
        return await this.db.query(query, params);
    }
    
    /**
     * Helper: Get user info
     */
    async getUserInfo(userId) {
        const users = await this.db.query(
            'SELECT id, username, email FROM users WHERE id = ?',
            [userId]
        );
        return users[0] || { username: 'Unknown', email: 'unknown@example.com' };
    }
    
    /**
     * Helper: Get user balances
     */
    async getUserBalances(userId) {
        return await this.db.query(
            `SELECT currency, available_balance + locked_balance as total,
                    available_balance, locked_balance
             FROM user_balances 
             WHERE user_id = ?`,
            [userId]
        );
    }
    
    /**
     * Helper: Get mining stats
     */
    async getMiningStats(userId, days) {
        // This would be implemented based on your mining stats schema
        return {
            daily: [],
            workers: [],
            summary: {
                current_hashrate: 0,
                avg_hashrate: 0,
                peak_hashrate: 0,
                total_shares: 0,
                valid_share_rate: 1,
                total_earnings: 0,
                active_workers: 0,
                total_workers: 0
            }
        };
    }
    
    /**
     * Helper: Get portfolio value
     */
    async getPortfolioValue(userId) {
        // This would calculate portfolio value based on current prices
        return {
            total_btc: 0,
            total_usd: 0,
            performance: {
                change_24h: 0,
                change_7d: 0,
                change_30d: 0,
                total_deposits: 0,
                total_withdrawals: 0,
                net_pnl: 0
            }
        };
    }
    
    /**
     * Helper: Format hashrate
     */
    formatHashrate(hashrate) {
        if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
        if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
        if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
        if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
        return hashrate.toFixed(2) + ' H/s';
    }
}

export default ExportManager;