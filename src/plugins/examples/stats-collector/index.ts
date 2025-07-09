/**
 * Statistics Collector Plugin
 * Advanced statistics collection and analysis
 */

import { BasePlugin, Hook, Cache } from '../../base-plugin';
import { PluginContext } from '../../plugin-manager';

interface StatsData {
    timestamp: number;
    hashrate: number;
    miners: number;
    shares: {
        submitted: number;
        accepted: number;
        rejected: number;
    };
    efficiency: number;
}

interface AggregatedStats {
    period: string;
    startTime: number;
    endTime: number;
    avgHashrate: number;
    peakHashrate: number;
    avgMiners: number;
    totalShares: number;
    efficiency: number;
}

export default class StatsCollectorPlugin extends BasePlugin {
    private stats: StatsData[] = [];
    private aggregated: Map<string, AggregatedStats[]> = new Map();
    private updateTaskId: number | null = null;
    private currentStats: StatsData;

    constructor(context: PluginContext) {
        super(context);
        
        this.currentStats = {
            timestamp: Date.now(),
            hashrate: 0,
            miners: 0,
            shares: {
                submitted: 0,
                accepted: 0,
                rejected: 0
            },
            efficiency: 100
        };

        // Initialize aggregation levels
        for (const level of this.config.aggregationLevels) {
            this.aggregated.set(level, []);
        }
    }

    async onEnable(): Promise<void> {
        await super.onEnable();
        
        // Schedule periodic updates
        this.updateTaskId = this.scheduleTask(
            () => this.collectStats(),
            this.config.updateInterval
        );

        // Load historical data
        await this.loadHistoricalData();
    }

    async onDisable(): Promise<void> {
        await super.onDisable();
        
        // Cancel update task
        if (this.updateTaskId !== null) {
            this.cancelTask(this.updateTaskId);
            this.updateTaskId = null;
        }

        // Save current data
        await this.saveData();
    }

    /**
     * Hook: Pool stats update
     */
    @Hook('poolStatsUpdate', 5)
    async onPoolStatsUpdate(stats: any): Promise<void> {
        this.currentStats.hashrate = stats.hashrate;
        this.currentStats.miners = stats.miners;
        this.currentStats.timestamp = Date.now();
    }

    /**
     * Hook: Share submitted
     */
    @Hook('shareSubmitted', 5)
    async onShareSubmitted(share: any): Promise<void> {
        this.currentStats.shares.submitted++;
    }

    /**
     * Hook: Share accepted
     */
    @Hook('shareAccepted', 5)
    async onShareAccepted(share: any): Promise<void> {
        this.currentStats.shares.accepted++;
        this.updateEfficiency();
    }

    /**
     * Hook: Share rejected
     */
    @Hook('shareRejected', 5)
    async onShareRejected(share: any): Promise<void> {
        this.currentStats.shares.rejected++;
        this.updateEfficiency();
    }

    /**
     * Hook: Miner connected
     */
    @Hook('minerConnected', 5)
    async onMinerConnected(miner: any): Promise<void> {
        this.logger.debug(`Miner connected: ${miner.address}`);
        
        // Emit custom event
        this.emit('minerActivity', {
            type: 'connected',
            miner: miner.address,
            timestamp: Date.now()
        });
    }

    /**
     * Hook: Miner disconnected
     */
    @Hook('minerDisconnected', 5)
    async onMinerDisconnected(miner: any): Promise<void> {
        this.logger.debug(`Miner disconnected: ${miner.address}`);
        
        // Emit custom event
        this.emit('minerActivity', {
            type: 'disconnected',
            miner: miner.address,
            timestamp: Date.now()
        });
    }

    /**
     * Get current statistics
     */
    @Cache(5000)
    public async getCurrentStats(): Promise<StatsData> {
        return { ...this.currentStats };
    }

    /**
     * Get historical statistics
     */
    @Cache(30000)
    public async getHistoricalStats(
        period: string = '1h',
        limit: number = 100
    ): Promise<AggregatedStats[]> {
        const stats = this.aggregated.get(period) || [];
        return stats.slice(-limit);
    }

    /**
     * Get statistics summary
     */
    public async getStatsSummary(): Promise<any> {
        const now = Date.now();
        const oneDayAgo = now - 86400000;
        
        // Filter stats from last 24 hours
        const recentStats = this.stats.filter(s => s.timestamp > oneDayAgo);
        
        if (recentStats.length === 0) {
            return null;
        }

        const avgHashrate = recentStats.reduce((sum, s) => sum + s.hashrate, 0) / recentStats.length;
        const peakHashrate = Math.max(...recentStats.map(s => s.hashrate));
        const totalShares = recentStats.reduce((sum, s) => sum + s.shares.accepted, 0);
        const avgEfficiency = recentStats.reduce((sum, s) => sum + s.efficiency, 0) / recentStats.length;

        return {
            period: '24h',
            avgHashrate,
            peakHashrate,
            totalShares,
            avgEfficiency,
            dataPoints: recentStats.length
        };
    }

    /**
     * Export statistics data
     */
    public async exportStats(format: 'json' | 'csv' = 'json'): Promise<string> {
        if (format === 'json') {
            return JSON.stringify({
                current: this.currentStats,
                historical: Object.fromEntries(this.aggregated),
                summary: await this.getStatsSummary()
            }, null, 2);
        } else {
            // CSV export
            const headers = ['timestamp', 'hashrate', 'miners', 'submitted', 'accepted', 'rejected', 'efficiency'];
            const rows = this.stats.map(s => [
                s.timestamp,
                s.hashrate,
                s.miners,
                s.shares.submitted,
                s.shares.accepted,
                s.shares.rejected,
                s.efficiency
            ]);

            return [
                headers.join(','),
                ...rows.map(r => r.join(','))
            ].join('\n');
        }
    }

    // Private methods

    private async collectStats(): Promise<void> {
        // Clone current stats
        const snapshot: StatsData = {
            ...this.currentStats,
            shares: { ...this.currentStats.shares }
        };

        // Add to stats array
        this.stats.push(snapshot);

        // Clean old data
        this.cleanOldData();

        // Aggregate data
        await this.aggregateData();

        // Save periodically
        if (this.stats.length % 10 === 0) {
            await this.saveData();
        }

        this.logger.debug('Stats collected', snapshot);
    }

    private updateEfficiency(): void {
        const total = this.currentStats.shares.submitted;
        const accepted = this.currentStats.shares.accepted;
        
        if (total > 0) {
            this.currentStats.efficiency = (accepted / total) * 100;
        }
    }

    private cleanOldData(): void {
        const cutoff = Date.now() - this.config.retentionPeriod;
        
        // Remove old raw stats
        this.stats = this.stats.filter(s => s.timestamp > cutoff);
        
        // Remove old aggregated stats
        for (const [period, stats] of this.aggregated.entries()) {
            this.aggregated.set(
                period,
                stats.filter(s => s.endTime > cutoff)
            );
        }
    }

    private async aggregateData(): Promise<void> {
        for (const period of this.config.aggregationLevels) {
            const intervalMs = this.parseInterval(period);
            const aggregated = this.aggregatePeriod(intervalMs);
            
            if (aggregated) {
                const stats = this.aggregated.get(period)!;
                stats.push(aggregated);
                
                // Keep only recent aggregations
                if (stats.length > 1000) {
                    stats.shift();
                }
            }
        }
    }

    private aggregatePeriod(intervalMs: number): AggregatedStats | null {
        const now = Date.now();
        const startTime = Math.floor(now / intervalMs) * intervalMs;
        const endTime = startTime + intervalMs;
        
        // Get stats within this period
        const periodStats = this.stats.filter(
            s => s.timestamp >= startTime && s.timestamp < endTime
        );
        
        if (periodStats.length === 0) {
            return null;
        }

        const avgHashrate = periodStats.reduce((sum, s) => sum + s.hashrate, 0) / periodStats.length;
        const peakHashrate = Math.max(...periodStats.map(s => s.hashrate));
        const avgMiners = periodStats.reduce((sum, s) => sum + s.miners, 0) / periodStats.length;
        const totalShares = periodStats.reduce((sum, s) => sum + s.shares.accepted, 0);
        const avgEfficiency = periodStats.reduce((sum, s) => sum + s.efficiency, 0) / periodStats.length;

        return {
            period: `${intervalMs}ms`,
            startTime,
            endTime,
            avgHashrate,
            peakHashrate,
            avgMiners,
            totalShares,
            efficiency: avgEfficiency
        };
    }

    private parseInterval(period: string): number {
        const match = period.match(/^(\d+)([mhd])$/);
        if (!match) {
            throw new Error(`Invalid period: ${period}`);
        }

        const value = parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: throw new Error(`Invalid unit: ${unit}`);
        }
    }

    private async loadHistoricalData(): Promise<void> {
        try {
            const data = await this.retrieveData('stats');
            if (data) {
                this.stats = data.stats || [];
                this.aggregated = new Map(data.aggregated || []);
                this.logger.info(`Loaded ${this.stats.length} historical data points`);
            }
        } catch (error) {
            this.logger.error('Failed to load historical data:', error);
        }
    }

    private async saveData(): Promise<void> {
        try {
            await this.storeData('stats', {
                stats: this.stats.slice(-1000), // Keep last 1000 raw stats
                aggregated: Array.from(this.aggregated.entries())
            });
            
            this.logger.debug('Stats data saved');
        } catch (error) {
            this.logger.error('Failed to save stats data:', error);
        }
    }
}
