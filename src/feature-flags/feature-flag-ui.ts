// src/feature-flags/feature-flag-ui.ts
import express from 'express';
import { FeatureFlagManager } from './feature-flag-manager';
import { Logger } from '../logging/logger';

export class FeatureFlagUI {
  private router: express.Router;
  private flagManager: FeatureFlagManager;
  private logger: Logger;

  constructor(flagManager: FeatureFlagManager, logger: Logger) {
    this.router = express.Router();
    this.flagManager = flagManager;
    this.logger = logger;
    
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Main dashboard
    this.router.get('/', (req, res) => {
      res.send(this.generateDashboardHTML());
    });

    // Flag detail page
    this.router.get('/flag/:flagId', (req, res) => {
      const { flagId } = req.params;
      const flag = this.flagManager.getFlag(flagId);
      
      if (!flag) {
        return res.status(404).send('<h1>Flag not found</h1>');
      }
      
      res.send(this.generateFlagDetailHTML(flag));
    });

    // Create flag page
    this.router.get('/create', (req, res) => {
      res.send(this.generateCreateFlagHTML());
    });

    // Static assets
    this.router.get('/style.css', (req, res) => {
      res.type('text/css').send(this.getCSS());
    });

    this.router.get('/script.js', (req, res) => {
      res.type('application/javascript').send(this.getJavaScript());
    });
  }

  private generateDashboardHTML(): string {
    const flags = this.flagManager.getAllFlags();
    const summary = this.flagManager.getFlagSummary();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Feature Flags Dashboard</title>
    <link rel="stylesheet" href="/feature-flags/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>🚩 Feature Flags Dashboard</h1>
            <div class="actions">
                <button onclick="window.location.href='/feature-flags/create'" class="btn btn-primary">
                    + Create Flag
                </button>
                <button onclick="refreshPage()" class="btn btn-secondary">
                    🔄 Refresh
                </button>
            </div>
        </header>

        <div class="summary-cards">
            <div class="card">
                <h3>Total Flags</h3>
                <div class="number">${summary.total}</div>
            </div>
            <div class="card">
                <h3>Enabled</h3>
                <div class="number enabled">${summary.enabled}</div>
            </div>
            <div class="card">
                <h3>Disabled</h3>
                <div class="number disabled">${summary.disabled}</div>
            </div>
            <div class="card">
                <h3>Scheduled</h3>
                <div class="number">${summary.scheduled}</div>
            </div>
        </div>

        <div class="flags-section">
            <div class="section-header">
                <h2>Feature Flags</h2>
                <div class="filters">
                    <select id="statusFilter" onchange="filterFlags()">
                        <option value="">All Status</option>
                        <option value="enabled">Enabled</option>
                        <option value="disabled">Disabled</option>
                    </select>
                    <select id="typeFilter" onchange="filterFlags()">
                        <option value="">All Types</option>
                        <option value="boolean">Boolean</option>
                        <option value="percentage">Percentage</option>
                        <option value="variant">Variant</option>
                        <option value="kill_switch">Kill Switch</option>
                    </select>
                </div>
            </div>

            <div class="flags-grid">
                ${flags.map(flag => this.generateFlagCard(flag)).join('')}
            </div>
        </div>
    </div>

    <script src="/feature-flags/script.js"></script>
</body>
</html>`;
  }

  private generateFlagCard(flag: any): string {
    const metrics = this.flagManager.getMetrics(flag.id);
    const enabledClass = flag.enabled ? 'enabled' : 'disabled';
    
    return `
        <div class="flag-card ${enabledClass}" data-status="${flag.enabled ? 'enabled' : 'disabled'}" data-type="${flag.type}">
            <div class="flag-header">
                <h3><a href="/feature-flags/flag/${flag.id}">${flag.name}</a></h3>
                <div class="flag-status ${enabledClass}">
                    ${flag.enabled ? '✅' : '❌'}
                </div>
            </div>
            
            <div class="flag-info">
                <p class="description">${flag.description || 'No description'}</p>
                <div class="flag-meta">
                    <span class="type-badge type-${flag.type}">${flag.type}</span>
                    ${flag.rollout?.enabled ? `<span class="rollout-badge">${flag.rollout.percentage}%</span>` : ''}
                </div>
            </div>

            ${metrics ? `
                <div class="flag-metrics">
                    <div class="metric">
                        <span class="metric-label">Evaluations</span>
                        <span class="metric-value">${metrics.totalEvaluations}</span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Success Rate</span>
                        <span class="metric-value">${((metrics.enabledEvaluations / metrics.totalEvaluations) * 100).toFixed(1)}%</span>
                    </div>
                </div>
            ` : ''}

            <div class="flag-actions">
                <button onclick="toggleFlag('${flag.id}', ${!flag.enabled})" 
                        class="btn btn-sm ${flag.enabled ? 'btn-danger' : 'btn-success'}">
                    ${flag.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onclick="editFlag('${flag.id}')" class="btn btn-sm btn-secondary">
                    Edit
                </button>
                <button onclick="viewMetrics('${flag.id}')" class="btn btn-sm btn-info">
                    Metrics
                </button>
            </div>
        </div>`;
  }

  private generateFlagDetailHTML(flag: any): string {
    const metrics = this.flagManager.getMetrics(flag.id);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flag: ${flag.name}</title>
    <link rel="stylesheet" href="/feature-flags/style.css">
</head>
<body>
    <div class="container">
        <header>
            <nav>
                <a href="/feature-flags">&larr; Back to Dashboard</a>
            </nav>
            <h1>🚩 ${flag.name}</h1>
            <div class="actions">
                <button onclick="toggleFlag('${flag.id}', ${!flag.enabled})" 
                        class="btn ${flag.enabled ? 'btn-danger' : 'btn-success'}">
                    ${flag.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onclick="editFlag('${flag.id}')" class="btn btn-primary">
                    Edit Flag
                </button>
            </div>
        </header>

        <div class="flag-detail">
            <div class="detail-section">
                <h2>Configuration</h2>
                <div class="config-grid">
                    <div class="config-item">
                        <label>Status</label>
                        <span class="flag-status ${flag.enabled ? 'enabled' : 'disabled'}">
                            ${flag.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                    </div>
                    <div class="config-item">
                        <label>Type</label>
                        <span class="type-badge type-${flag.type}">${flag.type}</span>
                    </div>
                    <div class="config-item">
                        <label>Description</label>
                        <span>${flag.description || 'No description'}</span>
                    </div>
                    <div class="config-item">
                        <label>Environment</label>
                        <span>${flag.metadata.environment}</span>
                    </div>
                    <div class="config-item">
                        <label>Created</label>
                        <span>${new Date(flag.metadata.createdAt).toLocaleString()}</span>
                    </div>
                    <div class="config-item">
                        <label>Updated</label>
                        <span>${new Date(flag.metadata.updatedAt).toLocaleString()}</span>
                    </div>
                </div>
            </div>

            ${flag.rollout?.enabled ? `
                <div class="detail-section">
                    <h2>Rollout Configuration</h2>
                    <div class="rollout-config">
                        <div class="rollout-percentage">
                            <label>Rollout Percentage</label>
                            <div class="percentage-display">
                                <div class="percentage-bar">
                                    <div class="percentage-fill" style="width: ${flag.rollout.percentage}%"></div>
                                </div>
                                <span class="percentage-text">${flag.rollout.percentage}%</span>
                            </div>
                        </div>
                        <div class="rollout-strategy">
                            <label>Strategy</label>
                            <span>${flag.rollout.strategy}</span>
                        </div>
                    </div>
                </div>
            ` : ''}

            ${flag.rules && flag.rules.length > 0 ? `
                <div class="detail-section">
                    <h2>Rules</h2>
                    <div class="rules-list">
                        ${flag.rules.map((rule: any) => `
                            <div class="rule-card">
                                <div class="rule-header">
                                    <h4>${rule.name}</h4>
                                    <span class="rule-status ${rule.enabled ? 'enabled' : 'disabled'}">
                                        ${rule.enabled ? 'Active' : 'Inactive'}
                                    </span>
                                </div>
                                <div class="rule-details">
                                    <div>Priority: ${rule.priority}</div>
                                    <div>Rollout: ${rule.rolloutPercentage}%</div>
                                    ${rule.variant ? `<div>Variant: ${rule.variant}</div>` : ''}
                                </div>
                                ${rule.conditions.length > 0 ? `
                                    <div class="conditions">
                                        <h5>Conditions:</h5>
                                        ${rule.conditions.map((condition: any) => `
                                            <div class="condition">
                                                ${condition.attribute} ${condition.operator} ${JSON.stringify(condition.value)}
                                            </div>
                                        `).join('')}
                                    </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}

            ${flag.variants && flag.variants.length > 0 ? `
                <div class="detail-section">
                    <h2>Variants</h2>
                    <div class="variants-list">
                        ${flag.variants.map((variant: any) => `
                            <div class="variant-card">
                                <h4>${variant.name}</h4>
                                <div class="variant-details">
                                    <div>Weight: ${variant.weight}%</div>
                                    <div>Value: ${JSON.stringify(variant.value)}</div>
                                    ${variant.description ? `<div>Description: ${variant.description}</div>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}

            ${metrics ? `
                <div class="detail-section">
                    <h2>Metrics</h2>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <h4>Total Evaluations</h4>
                            <div class="metric-number">${metrics.totalEvaluations}</div>
                        </div>
                        <div class="metric-card">
                            <h4>Enabled Evaluations</h4>
                            <div class="metric-number">${metrics.enabledEvaluations}</div>
                        </div>
                        <div class="metric-card">
                            <h4>Success Rate</h4>
                            <div class="metric-number">${((metrics.enabledEvaluations / metrics.totalEvaluations) * 100).toFixed(1)}%</div>
                        </div>
                        <div class="metric-card">
                            <h4>Last Evaluated</h4>
                            <div class="metric-text">${new Date(metrics.lastEvaluated).toLocaleString()}</div>
                        </div>
                    </div>
                    
                    ${Object.keys(metrics.variantDistribution).length > 0 ? `
                        <div class="variant-distribution">
                            <h4>Variant Distribution</h4>
                            ${Object.entries(metrics.variantDistribution).map(([variant, count]) => `
                                <div class="variant-stat">
                                    <span>${variant}</span>
                                    <span>${count} evaluations</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            ` : ''}
        </div>
    </div>

    <script src="/feature-flags/script.js"></script>
</body>
</html>`;
  }

  private generateCreateFlagHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Feature Flag</title>
    <link rel="stylesheet" href="/feature-flags/style.css">
</head>
<body>
    <div class="container">
        <header>
            <nav>
                <a href="/feature-flags">&larr; Back to Dashboard</a>
            </nav>
            <h1>Create Feature Flag</h1>
        </header>

        <form id="createFlagForm" class="flag-form">
            <div class="form-section">
                <h2>Basic Information</h2>
                
                <div class="form-group">
                    <label for="name">Name *</label>
                    <input type="text" id="name" name="name" required>
                    <small>Unique identifier for the flag (letters, numbers, underscores)</small>
                </div>

                <div class="form-group">
                    <label for="description">Description</label>
                    <textarea id="description" name="description" rows="3"></textarea>
                </div>

                <div class="form-group">
                    <label for="type">Type *</label>
                    <select id="type" name="type" required onchange="handleTypeChange()">
                        <option value="boolean">Boolean</option>
                        <option value="percentage">Percentage</option>
                        <option value="variant">Variant</option>
                        <option value="kill_switch">Kill Switch</option>
                    </select>
                </div>

                <div class="form-group">
                    <label>
                        <input type="checkbox" id="enabled" name="enabled">
                        Enable flag immediately
                    </label>
                </div>
            </div>

            <div class="form-section">
                <h2>Rollout Configuration</h2>
                
                <div class="form-group">
                    <label>
                        <input type="checkbox" id="rolloutEnabled" name="rolloutEnabled" onchange="toggleRolloutConfig()">
                        Enable rollout
                    </label>
                </div>

                <div id="rolloutConfig" class="rollout-config hidden">
                    <div class="form-group">
                        <label for="rolloutPercentage">Rollout Percentage</label>
                        <input type="range" id="rolloutPercentage" name="rolloutPercentage" min="0" max="100" value="0" oninput="updatePercentageDisplay()">
                        <span id="percentageDisplay">0%</span>
                    </div>

                    <div class="form-group">
                        <label for="rolloutStrategy">Strategy</label>
                        <select id="rolloutStrategy" name="rolloutStrategy">
                            <option value="user_id">User ID</option>
                            <option value="session_id">Session ID</option>
                            <option value="random">Random</option>
                        </select>
                    </div>
                </div>
            </div>

            <div id="variantSection" class="form-section hidden">
                <h2>Variants</h2>
                <div id="variantsList">
                    <!-- Variants will be added here -->
                </div>
                <button type="button" onclick="addVariant()" class="btn btn-secondary">Add Variant</button>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary">Create Flag</button>
                <button type="button" onclick="window.location.href='/feature-flags'" class="btn btn-secondary">Cancel</button>
            </div>
        </form>
    </div>

    <script src="/feature-flags/script.js"></script>
    <script>
        let variantCount = 0;

        function handleTypeChange() {
            const type = document.getElementById('type').value;
            const variantSection = document.getElementById('variantSection');
            
            if (type === 'variant') {
                variantSection.classList.remove('hidden');
                if (variantCount === 0) {
                    addVariant();
                    addVariant();
                }
            } else {
                variantSection.classList.add('hidden');
            }
        }

        function toggleRolloutConfig() {
            const enabled = document.getElementById('rolloutEnabled').checked;
            const config = document.getElementById('rolloutConfig');
            
            if (enabled) {
                config.classList.remove('hidden');
            } else {
                config.classList.add('hidden');
            }
        }

        function updatePercentageDisplay() {
            const percentage = document.getElementById('rolloutPercentage').value;
            document.getElementById('percentageDisplay').textContent = percentage + '%';
        }

        function addVariant() {
            variantCount++;
            const variantsList = document.getElementById('variantsList');
            
            const variantDiv = document.createElement('div');
            variantDiv.className = 'variant-form';
            variantDiv.innerHTML = \`
                <div class="variant-header">
                    <h4>Variant \${variantCount}</h4>
                    <button type="button" onclick="removeVariant(this)" class="btn btn-sm btn-danger">Remove</button>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Name</label>
                        <input type="text" name="variant_name_\${variantCount}" required>
                    </div>
                    <div class="form-group">
                        <label>Weight (%)</label>
                        <input type="number" name="variant_weight_\${variantCount}" min="0" max="100" required>
                    </div>
                </div>
                <div class="form-group">
                    <label>Value</label>
                    <input type="text" name="variant_value_\${variantCount}" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <input type="text" name="variant_description_\${variantCount}">
                </div>
            \`;
            
            variantsList.appendChild(variantDiv);
        }

        function removeVariant(button) {
            button.closest('.variant-form').remove();
        }

        document.getElementById('createFlagForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const flagData = {
                name: formData.get('name'),
                description: formData.get('description'),
                type: formData.get('type'),
                enabled: formData.has('enabled'),
                rollout: {
                    enabled: formData.has('rolloutEnabled'),
                    percentage: parseInt(formData.get('rolloutPercentage')) || 0,
                    strategy: formData.get('rolloutStrategy') || 'user_id'
                },
                rules: [],
                variants: []
            };

            // Process variants
            if (flagData.type === 'variant') {
                for (let i = 1; i <= variantCount; i++) {
                    const name = formData.get(\`variant_name_\${i}\`);
                    if (name) {
                        flagData.variants.push({
                            id: name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                            name: name,
                            value: formData.get(\`variant_value_\${i}\`),
                            weight: parseInt(formData.get(\`variant_weight_\${i}\`)) || 0,
                            description: formData.get(\`variant_description_\${i}\`)
                        });
                    }
                }
            }

            try {
                const response = await fetch('/feature-flags/api/admin/flags', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(flagData)
                });

                const result = await response.json();

                if (result.success) {
                    alert('Feature flag created successfully!');
                    window.location.href = '/feature-flags';
                } else {
                    alert('Error creating flag: ' + result.error);
                }
            } catch (error) {
                alert('Error creating flag: ' + error.message);
            }
        });
    </script>
</body>
</html>`;
  }

  private getCSS(): string {
    return `
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background-color: #f5f5f5;
    color: #333;
    line-height: 1.6;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
}

header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 30px;
    padding-bottom: 20px;
    border-bottom: 2px solid #e0e0e0;
}

header h1 {
    color: #2c3e50;
    font-size: 2rem;
}

nav a {
    color: #3498db;
    text-decoration: none;
    font-weight: 500;
}

nav a:hover {
    text-decoration: underline;
}

.actions {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
    font-size: 14px;
    font-weight: 500;
    transition: background-color 0.2s;
}

.btn-primary {
    background-color: #3498db;
    color: white;
}

.btn-primary:hover {
    background-color: #2980b9;
}

.btn-secondary {
    background-color: #95a5a6;
    color: white;
}

.btn-secondary:hover {
    background-color: #7f8c8d;
}

.btn-success {
    background-color: #27ae60;
    color: white;
}

.btn-success:hover {
    background-color: #229954;
}

.btn-danger {
    background-color: #e74c3c;
    color: white;
}

.btn-danger:hover {
    background-color: #c0392b;
}

.btn-info {
    background-color: #17a2b8;
    color: white;
}

.btn-info:hover {
    background-color: #138496;
}

.btn-sm {
    padding: 4px 8px;
    font-size: 12px;
}

.summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.card {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    text-align: center;
}

.card h3 {
    color: #7f8c8d;
    font-size: 14px;
    margin-bottom: 10px;
}

.card .number {
    font-size: 2rem;
    font-weight: bold;
    color: #2c3e50;
}

.card .number.enabled {
    color: #27ae60;
}

.card .number.disabled {
    color: #e74c3c;
}

.section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.section-header h2 {
    color: #2c3e50;
}

.filters {
    display: flex;
    gap: 10px;
}

.filters select {
    padding: 6px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: white;
}

.flags-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 20px;
}

.flag-card {
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    transition: transform 0.2s, box-shadow 0.2s;
}

.flag-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0,0,0,0.15);
}

.flag-card.disabled {
    opacity: 0.7;
}

.flag-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 15px;
}

.flag-header h3 {
    margin: 0;
    color: #2c3e50;
}

.flag-header h3 a {
    color: inherit;
    text-decoration: none;
}

.flag-header h3 a:hover {
    text-decoration: underline;
}

.flag-status {
    font-size: 1.2rem;
}

.flag-status.enabled {
    color: #27ae60;
}

.flag-status.disabled {
    color: #e74c3c;
}

.description {
    color: #7f8c8d;
    font-size: 14px;
    margin-bottom: 10px;
}

.flag-meta {
    display: flex;
    gap: 8px;
    margin-bottom: 15px;
}

.type-badge {
    background: #ecf0f1;
    color: #2c3e50;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}

.type-boolean { background: #e8f5e8; color: #27ae60; }
.type-percentage { background: #fff3cd; color: #856404; }
.type-variant { background: #d1ecf1; color: #0c5460; }
.type-kill_switch { background: #f8d7da; color: #721c24; }

.rollout-badge {
    background: #d4edda;
    color: #155724;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}

.flag-metrics {
    display: flex;
    justify-content: space-between;
    margin: 15px 0;
    padding: 10px;
    background: #f8f9fa;
    border-radius: 4px;
}

.metric {
    text-align: center;
}

.metric-label {
    display: block;
    font-size: 12px;
    color: #7f8c8d;
}

.metric-value {
    display: block;
    font-weight: bold;
    color: #2c3e50;
}

.flag-actions {
    display: flex;
    gap: 8px;
    margin-top: 15px;
}

.hidden {
    display: none !important;
}

/* Detail page styles */
.flag-detail {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.detail-section {
    padding: 20px;
    border-bottom: 1px solid #e0e0e0;
}

.detail-section:last-child {
    border-bottom: none;
}

.detail-section h2 {
    color: #2c3e50;
    margin-bottom: 15px;
    font-size: 1.3rem;
}

.config-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 15px;
}

.config-item {
    display: flex;
    flex-direction: column;
}

.config-item label {
    font-weight: 500;
    color: #7f8c8d;
    font-size: 12px;
    text-transform: uppercase;
    margin-bottom: 5px;
}

.rollout-config {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 20px;
    align-items: center;
}

.percentage-display {
    display: flex;
    align-items: center;
    gap: 10px;
}

.percentage-bar {
    flex: 1;
    height: 8px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
}

.percentage-fill {
    height: 100%;
    background: #3498db;
    transition: width 0.3s;
}

.percentage-text {
    font-weight: bold;
    min-width: 40px;
}

.rules-list, .variants-list {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.rule-card, .variant-card {
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 15px;
    background: #f8f9fa;
}

.rule-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.rule-header h4 {
    margin: 0;
    color: #2c3e50;
}

.rule-details {
    display: flex;
    gap: 15px;
    margin-bottom: 10px;
    font-size: 14px;
    color: #7f8c8d;
}

.conditions {
    margin-top: 10px;
}

.conditions h5 {
    margin-bottom: 5px;
    color: #2c3e50;
    font-size: 14px;
}

.condition {
    background: white;
    padding: 5px 10px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 12px;
    margin-bottom: 5px;
}

.metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
    margin-bottom: 20px;
}

.metric-card {
    text-align: center;
    padding: 15px;
    background: #f8f9fa;
    border-radius: 6px;
}

.metric-card h4 {
    color: #7f8c8d;
    font-size: 12px;
    text-transform: uppercase;
    margin-bottom: 8px;
}

.metric-number {
    font-size: 1.8rem;
    font-weight: bold;
    color: #2c3e50;
}

.metric-text {
    font-size: 14px;
    color: #2c3e50;
}

.variant-distribution {
    padding: 15px;
    background: #f8f9fa;
    border-radius: 6px;
}

.variant-distribution h4 {
    margin-bottom: 10px;
    color: #2c3e50;
}

.variant-stat {
    display: flex;
    justify-content: space-between;
    padding: 5px 0;
    border-bottom: 1px solid #e0e0e0;
}

/* Form styles */
.flag-form {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.form-section {
    padding: 20px;
    border-bottom: 1px solid #e0e0e0;
}

.form-section:last-child {
    border-bottom: none;
}

.form-section h2 {
    color: #2c3e50;
    margin-bottom: 15px;
    font-size: 1.3rem;
}

.form-group {
    margin-bottom: 15px;
}

.form-group label {
    display: block;
    font-weight: 500;
    color: #2c3e50;
    margin-bottom: 5px;
}

.form-group input,
.form-group select,
.form-group textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
}

.form-group input[type="checkbox"] {
    width: auto;
    margin-right: 8px;
}

.form-group input[type="range"] {
    width: calc(100% - 60px);
    margin-right: 10px;
}

.form-group small {
    display: block;
    color: #7f8c8d;
    font-size: 12px;
    margin-top: 5px;
}

.form-row {
    display: grid;
    grid-template-columns: 1fr 100px;
    gap: 15px;
}

.form-actions {
    padding: 20px;
    background: #f8f9fa;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}

.variant-form {
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 15px;
    margin-bottom: 15px;
    background: #f8f9fa;
}

.variant-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
}

.variant-header h4 {
    margin: 0;
    color: #2c3e50;
}

@media (max-width: 768px) {
    .flags-grid {
        grid-template-columns: 1fr;
    }
    
    .summary-cards {
        grid-template-columns: repeat(2, 1fr);
    }
    
    .config-grid {
        grid-template-columns: 1fr;
    }
    
    .rollout-config {
        grid-template-columns: 1fr;
    }
    
    .form-row {
        grid-template-columns: 1fr;
    }
}`;
  }

  private getJavaScript(): string {
    return `
function refreshPage() {
    window.location.reload();
}

function filterFlags() {
    const statusFilter = document.getElementById('statusFilter').value;
    const typeFilter = document.getElementById('typeFilter').value;
    const flagCards = document.querySelectorAll('.flag-card');

    flagCards.forEach(card => {
        const status = card.dataset.status;
        const type = card.dataset.type;
        
        const statusMatch = !statusFilter || status === statusFilter;
        const typeMatch = !typeFilter || type === typeFilter;
        
        if (statusMatch && typeMatch) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

async function toggleFlag(flagId, enable) {
    try {
        const endpoint = enable ? 'enable' : 'disable';
        const response = await fetch(\`/feature-flags/api/admin/flags/\${flagId}/\${endpoint}\`, {
            method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
            window.location.reload();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

function editFlag(flagId) {
    // For now, just show an alert. In a real implementation, 
    // this would open an edit form or redirect to an edit page
    alert('Edit functionality would be implemented here for flag: ' + flagId);
}

function viewMetrics(flagId) {
    // Open metrics in a new tab or modal
    window.open(\`/feature-flags/api/admin/metrics/\${flagId}\`, '_blank');
}

// Evaluation testing function
async function testEvaluation() {
    const flagId = prompt('Enter flag ID to test:');
    if (!flagId) return;

    const userId = prompt('Enter user ID (optional):') || 'test-user';
    
    try {
        const response = await fetch(\`/feature-flags/api/evaluate/\${flagId}?userId=\${userId}\`);
        const result = await response.json();

        if (result.success) {
            alert(\`Evaluation result:\\nEnabled: \${result.data.enabled}\\nVariant: \${result.data.variant || 'none'}\\nValue: \${JSON.stringify(result.data.value)}\`);
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Add test evaluation button to dashboard
document.addEventListener('DOMContentLoaded', function() {
    const actions = document.querySelector('.actions');
    if (actions && window.location.pathname === '/feature-flags/') {
        const testButton = document.createElement('button');
        testButton.className = 'btn btn-info';
        testButton.textContent = '🧪 Test Evaluation';
        testButton.onclick = testEvaluation;
        actions.appendChild(testButton);
    }
});`;
  }

  public getRouter(): express.Router {
    return this.router;
  }
}
