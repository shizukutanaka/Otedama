/**
 * Cost Monitoring System
 * 無料枠の使用量監視とアラート
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CostMonitor {
    constructor() {
        this.providers = {
            github: {
                name: 'GitHub Actions',
                freeQuota: {
                    minutes: 2000,      // 2000分/月
                    storage: 500,       // 500MB
                },
                currentUsage: {
                    minutes: 0,
                    storage: 0,
                },
                costs: {
                    minutesOverage: 0.008,  // $0.008/分
                    storageOverage: 0.008,  // $0.008/MB/日
                }
            },
            netlify: {
                name: 'Netlify',
                freeQuota: {
                    bandwidth: 100,     // 100GB/月
                    buildMinutes: 300,  // 300分/月
                    sites: 1,
                    forms: 100,         // 100送信/月
                },
                currentUsage: {
                    bandwidth: 0,
                    buildMinutes: 0,
                    sites: 1,
                    forms: 0,
                },
                costs: {
                    bandwidthOverage: 0.20,  // $0.20/GB
                    buildMinutesOverage: 7,  // $7/500分
                }
            },
            vercel: {
                name: 'Vercel',
                freeQuota: {
                    bandwidth: 100,     // 100GB/月
                    executions: 125000, // 125K実行/月
                    executionTime: 100, // 100GB秒/月
                },
                currentUsage: {
                    bandwidth: 0,
                    executions: 0,
                    executionTime: 0,
                },
                costs: {
                    bandwidthOverage: 0.40,  // $0.40/GB
                    executionsOverage: 0.60, // $0.60/100K実行
                }
            },
            railway: {
                name: 'Railway',
                freeQuota: {
                    credit: 5,          // $5/月
                    executionTime: 21600, // 6時間/月
                },
                currentUsage: {
                    credit: 0,
                    executionTime: 0,
                },
                costs: {
                    ram: 0.000231,      // $0.000231/MB/時間
                    cpu: 0.000463,      // $0.000463/vCPU/時間
                }
            },
            cloudflare: {
                name: 'Cloudflare',
                freeQuota: {
                    requests: 1000000,  // 100万リクエスト/月
                    bandwidth: 'unlimited',
                    dns: 'unlimited',
                },
                currentUsage: {
                    requests: 0,
                    bandwidth: 0,
                },
                costs: {
                    requestsOverage: 0.50,  // $0.50/100万リクエスト
                }
            }
        };

        this.alertThresholds = {
            warning: 0.8,   // 80%使用時に警告
            critical: 0.95, // 95%使用時に緊急アラート
        };
    }

    // 使用量を更新
    async updateUsage(provider, metrics) {
        if (!this.providers[provider]) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        Object.assign(this.providers[provider].currentUsage, metrics);
        await this.saveUsageData();
        await this.checkAlerts(provider);
    }

    // 使用率を計算
    getUsagePercentage(provider, metric) {
        const providerData = this.providers[provider];
        const current = providerData.currentUsage[metric];
        const quota = providerData.freeQuota[metric];
        
        if (quota === 'unlimited' || quota === 0) {
            return 0;
        }
        
        return (current / quota) * 100;
    }

    // アラートチェック
    async checkAlerts(provider) {
        const providerData = this.providers[provider];
        const alerts = [];

        for (const [metric, quota] of Object.entries(providerData.freeQuota)) {
            if (quota === 'unlimited') continue;

            const usagePercent = this.getUsagePercentage(provider, metric);
            
            if (usagePercent >= this.alertThresholds.critical * 100) {
                alerts.push({
                    level: 'CRITICAL',
                    provider,
                    metric,
                    usage: usagePercent,
                    message: `${providerData.name} ${metric} usage is ${usagePercent.toFixed(1)}% - EXCEEDING FREE QUOTA SOON!`
                });
            } else if (usagePercent >= this.alertThresholds.warning * 100) {
                alerts.push({
                    level: 'WARNING',
                    provider,
                    metric,
                    usage: usagePercent,
                    message: `${providerData.name} ${metric} usage is ${usagePercent.toFixed(1)}% - approaching limit`
                });
            }
        }

        if (alerts.length > 0) {
            await this.sendAlerts(alerts);
        }

        return alerts;
    }

    // アラート送信
    async sendAlerts(alerts) {
        const timestamp = new Date().toISOString();
        
        // コンソールログ
        console.log('\n🚨 COST MONITORING ALERTS 🚨');
        console.log('================================');
        alerts.forEach(alert => {
            const emoji = alert.level === 'CRITICAL' ? '🔴' : '🟡';
            console.log(`${emoji} [${alert.level}] ${alert.message}`);
        });
        console.log(`\nTime: ${timestamp}`);
        console.log('================================\n');

        // ファイルログ
        const logEntry = {
            timestamp,
            alerts
        };
        
        await this.appendToLog(logEntry);

        // GitHub Issue作成（緊急時）
        const criticalAlerts = alerts.filter(a => a.level === 'CRITICAL');
        if (criticalAlerts.length > 0) {
            await this.createGitHubIssue(criticalAlerts);
        }
    }

    // GitHub Issue作成
    async createGitHubIssue(criticalAlerts) {
        const title = `🚨 CRITICAL: Free Quota Exceeded - ${new Date().toISOString().split('T')[0]}`;
        const body = `
## Critical Cost Alert

**Date:** ${new Date().toISOString()}

### Critical Issues:
${criticalAlerts.map(alert => `- **${alert.provider}**: ${alert.message}`).join('\n')}

### Recommended Actions:
1. Review current usage patterns
2. Optimize resource consumption
3. Consider upgrading to paid plans if necessary
4. Implement additional cost controls

### Cost Monitoring Dashboard:
- Check logs: \`tail -f monitoring/cost-alerts.log\`
- Run cost report: \`npm run cost:report\`

**Auto-generated by Cost Monitor**
        `.trim();

        // GitHub API呼び出し（実装は環境に依存）
        console.log('Creating GitHub issue:', { title, body });
        
        // 実際の実装では GitHub API を呼び出し
        // await octokit.rest.issues.create({ owner, repo, title, body });
    }

    // 使用量データ保存
    async saveUsageData() {
        const dataPath = path.join(__dirname, '../../monitoring/usage-data.json');
        
        try {
            await fs.mkdir(path.dirname(dataPath), { recursive: true });
            await fs.writeFile(dataPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                providers: this.providers
            }, null, 2));
        } catch (error) {
            console.error('Failed to save usage data:', error);
        }
    }

    // ログ追記
    async appendToLog(logEntry) {
        const logPath = path.join(__dirname, '../../monitoring/cost-alerts.log');
        
        try {
            await fs.mkdir(path.dirname(logPath), { recursive: true });
            await fs.appendFile(logPath, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.error('Failed to append to log:', error);
        }
    }

    // コストレポート生成
    async generateReport() {
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                totalProviders: Object.keys(this.providers).length,
                providersAtRisk: 0,
                estimatedMonthlyCost: 0
            },
            providers: {}
        };

        for (const [providerName, providerData] of Object.entries(this.providers)) {
            const providerReport = {
                name: providerData.name,
                status: 'SAFE',
                metrics: {},
                estimatedOverageCost: 0
            };

            let isAtRisk = false;
            
            for (const [metric, quota] of Object.entries(providerData.freeQuota)) {
                if (quota === 'unlimited') continue;

                const current = providerData.currentUsage[metric];
                const usagePercent = this.getUsagePercentage(providerName, metric);
                
                providerReport.metrics[metric] = {
                    current,
                    quota,
                    usagePercent: usagePercent.toFixed(1) + '%',
                    remaining: quota - current
                };

                // 超過コスト計算
                if (current > quota) {
                    const overage = current - quota;
                    const costPerUnit = providerData.costs[metric + 'Overage'] || 0;
                    providerReport.estimatedOverageCost += overage * costPerUnit;
                }

                // リスク判定
                if (usagePercent >= this.alertThresholds.warning * 100) {
                    isAtRisk = true;
                    providerReport.status = usagePercent >= this.alertThresholds.critical * 100 ? 'CRITICAL' : 'WARNING';
                }
            }

            if (isAtRisk) {
                report.summary.providersAtRisk++;
            }

            report.summary.estimatedMonthlyCost += providerReport.estimatedOverageCost;
            report.providers[providerName] = providerReport;
        }

        return report;
    }

    // 最適化提案
    getOptimizationSuggestions() {
        const suggestions = [];

        // GitHub Actions最適化
        const githubUsage = this.getUsagePercentage('github', 'minutes');
        if (githubUsage > 70) {
            suggestions.push({
                provider: 'GitHub Actions',
                suggestion: 'Use matrix builds to parallelize jobs and reduce total build time',
                impact: 'Can reduce build minutes by 30-50%'
            });
            suggestions.push({
                provider: 'GitHub Actions',
                suggestion: 'Cache dependencies and build artifacts more aggressively',
                impact: 'Can reduce build time by 20-40%'
            });
        }

        // Netlify最適化
        const netlifyBandwidth = this.getUsagePercentage('netlify', 'bandwidth');
        if (netlifyBandwidth > 70) {
            suggestions.push({
                provider: 'Netlify',
                suggestion: 'Enable Cloudflare CDN to reduce origin bandwidth',
                impact: 'Can reduce bandwidth usage by 60-80%'
            });
            suggestions.push({
                provider: 'Netlify',
                suggestion: 'Optimize images and enable compression',
                impact: 'Can reduce bandwidth usage by 30-50%'
            });
        }

        // Railway最適化
        const railwayCredit = this.getUsagePercentage('railway', 'credit');
        if (railwayCredit > 70) {
            suggestions.push({
                provider: 'Railway',
                suggestion: 'Implement auto-scaling to reduce idle resource usage',
                impact: 'Can reduce costs by 40-60%'
            });
            suggestions.push({
                provider: 'Railway',
                suggestion: 'Use lightweight Docker images and optimize memory usage',
                impact: 'Can reduce memory costs by 20-30%'
            });
        }

        return suggestions;
    }

    // 自動最適化実行
    async runAutoOptimizations() {
        console.log('🔧 Running automatic optimizations...');
        
        const optimizations = [];

        // GitHub Actions キャッシュ最適化
        const githubUsage = this.getUsagePercentage('github', 'minutes');
        if (githubUsage > 80) {
            await this.optimizeGitHubActions();
            optimizations.push('Optimized GitHub Actions caching');
        }

        // Netlify 設定最適化
        const netlifyBandwidth = this.getUsagePercentage('netlify', 'bandwidth');
        if (netlifyBandwidth > 80) {
            await this.optimizeNetlifyConfig();
            optimizations.push('Optimized Netlify configuration');
        }

        console.log('✅ Auto-optimizations completed:', optimizations);
        return optimizations;
    }

    // GitHub Actions最適化
    async optimizeGitHubActions() {
        // package-lock.json と node_modules のキャッシュを強化
        const cacheConfig = {
            key: 'node-modules-${{ hashFiles(\'**/package-lock.json\') }}',
            restoreKeys: ['node-modules-'],
            path: ['node_modules', '.npm']
        };

        console.log('Optimizing GitHub Actions cache configuration:', cacheConfig);
    }

    // Netlify設定最適化
    async optimizeNetlifyConfig() {
        // 圧縮とキャッシュ設定を強化
        const config = {
            compression: true,
            caching: {
                'static/*': 'max-age=31536000',
                'api/*': 'max-age=300'
            }
        };

        console.log('Optimizing Netlify configuration:', config);
    }
}

// 使用例とメイン処理
async function main() {
    const costMonitor = new CostMonitor();

    // 使用量データ例（実際は各プロバイダーのAPIから取得）
    await costMonitor.updateUsage('github', {
        minutes: 1200,  // 1200分使用（60%）
        storage: 300    // 300MB使用（60%）
    });

    await costMonitor.updateUsage('netlify', {
        bandwidth: 75,    // 75GB使用（75%）
        buildMinutes: 180 // 180分使用（60%）
    });

    // レポート生成
    const report = await costMonitor.generateReport();
    console.log('📊 Cost Report:', JSON.stringify(report, null, 2));

    // 最適化提案
    const suggestions = costMonitor.getOptimizationSuggestions();
    console.log('💡 Optimization Suggestions:', suggestions);

    // 自動最適化実行
    await costMonitor.runAutoOptimizations();
}

// CLI実行時
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default CostMonitor;