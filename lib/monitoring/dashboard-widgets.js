/**
 * Dashboard Widget Components for Otedama
 * Reusable monitoring widgets
 * 
 * Design principles:
 * - Carmack: Fast rendering, minimal DOM updates
 * - Martin: Component-based architecture
 * - Pike: Simple widget API
 */

import { EventEmitter } from 'events';

/**
 * Base widget class
 */
export class Widget extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.id = options.id || Math.random().toString(36).substr(2, 9);
    this.type = options.type || 'base';
    this.title = options.title || 'Widget';
    this.refreshInterval = options.refreshInterval || 1000;
    this.data = [];
    this.config = options.config || {};
    
    this.refreshTimer = null;
    this.element = null;
  }
  
  /**
   * Mount widget to DOM element
   */
  mount(container) {
    this.element = typeof container === 'string' ? 
      document.getElementById(container) : container;
    
    if (!this.element) {
      throw new Error('Container element not found');
    }
    
    this.render();
    this.startRefresh();
    
    this.emit('mounted');
  }
  
  /**
   * Unmount widget
   */
  unmount() {
    this.stopRefresh();
    
    if (this.element) {
      this.element.innerHTML = '';
      this.element = null;
    }
    
    this.emit('unmounted');
  }
  
  /**
   * Start auto-refresh
   */
  startRefresh() {
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => {
        this.refresh();
      }, this.refreshInterval);
    }
  }
  
  /**
   * Stop auto-refresh
   */
  stopRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
  
  /**
   * Refresh widget data
   */
  async refresh() {
    try {
      const data = await this.fetchData();
      this.updateData(data);
      this.render();
    } catch (error) {
      this.handleError(error);
    }
  }
  
  /**
   * Fetch widget data (override in subclasses)
   */
  async fetchData() {
    return [];
  }
  
  /**
   * Update widget data
   */
  updateData(data) {
    this.data = data;
    this.emit('data:updated', data);
  }
  
  /**
   * Render widget (override in subclasses)
   */
  render() {
    if (!this.element) return;
    
    this.element.innerHTML = `
      <div class="widget">
        <h3>${this.title}</h3>
        <div class="widget-content">
          <!-- Override in subclasses -->
        </div>
      </div>
    `;
  }
  
  /**
   * Handle errors
   */
  handleError(error) {
    console.error(`Widget ${this.id} error:`, error);
    this.emit('error', error);
    
    if (this.element) {
      this.element.innerHTML = `
        <div class="widget error">
          <h3>${this.title}</h3>
          <div class="error-message">${error.message}</div>
        </div>
      `;
    }
  }
}

/**
 * Metric widget - displays a single metric value
 */
export class MetricWidget extends Widget {
  constructor(options) {
    super({
      type: 'metric',
      ...options
    });
    
    this.metric = options.metric || 'value';
    this.unit = options.unit || '';
    this.format = options.format || ((v) => v);
    this.threshold = options.threshold || null;
  }
  
  render() {
    if (!this.element) return;
    
    const value = this.format(this.data[this.metric] || 0);
    const status = this._getStatus(value);
    
    this.element.innerHTML = `
      <div class="widget metric-widget ${status}">
        <h3>${this.title}</h3>
        <div class="metric-value">
          <span class="value">${value}</span>
          <span class="unit">${this.unit}</span>
        </div>
      </div>
    `;
  }
  
  _getStatus(value) {
    if (!this.threshold) return 'normal';
    
    if (typeof this.threshold === 'object') {
      if (this.threshold.critical && value >= this.threshold.critical) {
        return 'critical';
      }
      if (this.threshold.warning && value >= this.threshold.warning) {
        return 'warning';
      }
    }
    
    return 'normal';
  }
}

/**
 * Chart widget - displays time series data
 */
export class ChartWidget extends Widget {
  constructor(options) {
    super({
      type: 'chart',
      ...options
    });
    
    this.chartType = options.chartType || 'line';
    this.maxPoints = options.maxPoints || 60;
    this.datasets = options.datasets || [{
      label: 'Value',
      key: 'value',
      color: '#4caf50'
    }];
    
    this.chart = null;
  }
  
  mount(container) {
    super.mount(container);
    this._initChart();
  }
  
  unmount() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    super.unmount();
  }
  
  render() {
    if (!this.element) return;
    
    this.element.innerHTML = `
      <div class="widget chart-widget">
        <h3>${this.title}</h3>
        <div class="chart-container">
          <canvas id="chart-${this.id}"></canvas>
        </div>
      </div>
    `;
  }
  
  _initChart() {
    const canvas = document.getElementById(`chart-${this.id}`);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    this.chart = new Chart(ctx, {
      type: this.chartType,
      data: {
        labels: [],
        datasets: this.datasets.map(ds => ({
          label: ds.label,
          data: [],
          borderColor: ds.color,
          backgroundColor: ds.backgroundColor || ds.color + '20',
          tension: 0.4,
          fill: ds.fill !== false
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: this.datasets.length > 1
          }
        },
        scales: {
          x: {
            display: true,
            grid: {
              display: false
            }
          },
          y: {
            beginAtZero: true,
            grid: {
              color: '#333'
            }
          }
        }
      }
    });
  }
  
  updateData(data) {
    super.updateData(data);
    
    if (!this.chart) return;
    
    // Add new data point
    const timestamp = new Date().toLocaleTimeString();
    this.chart.data.labels.push(timestamp);
    
    this.datasets.forEach((dataset, index) => {
      const value = data[dataset.key] || 0;
      this.chart.data.datasets[index].data.push(value);
    });
    
    // Trim old data
    while (this.chart.data.labels.length > this.maxPoints) {
      this.chart.data.labels.shift();
      this.chart.data.datasets.forEach(ds => ds.data.shift());
    }
    
    this.chart.update('none');
  }
}

/**
 * List widget - displays a list of items
 */
export class ListWidget extends Widget {
  constructor(options) {
    super({
      type: 'list',
      ...options
    });
    
    this.maxItems = options.maxItems || 10;
    this.itemRenderer = options.itemRenderer || this._defaultItemRenderer;
    this.emptyMessage = options.emptyMessage || 'No items';
  }
  
  render() {
    if (!this.element) return;
    
    const items = Array.isArray(this.data) ? this.data : [];
    const displayItems = items.slice(0, this.maxItems);
    
    this.element.innerHTML = `
      <div class="widget list-widget">
        <h3>${this.title}</h3>
        <div class="list-container">
          ${displayItems.length > 0 ? 
            displayItems.map(item => this.itemRenderer(item)).join('') :
            `<div class="empty-message">${this.emptyMessage}</div>`
          }
        </div>
      </div>
    `;
  }
  
  _defaultItemRenderer(item) {
    return `<div class="list-item">${JSON.stringify(item)}</div>`;
  }
}

/**
 * Alert widget - displays active alerts
 */
export class AlertWidget extends ListWidget {
  constructor(options) {
    super({
      type: 'alert',
      title: 'Active Alerts',
      emptyMessage: 'No active alerts',
      itemRenderer: (alert) => `
        <div class="alert-item ${alert.level}">
          <div class="alert-content">
            <span class="alert-message">${alert.message}</span>
            <span class="alert-time">${new Date(alert.triggeredAt).toLocaleTimeString()}</span>
          </div>
        </div>
      `,
      ...options
    });
  }
}

/**
 * Log widget - displays log entries
 */
export class LogWidget extends ListWidget {
  constructor(options) {
    super({
      type: 'log',
      title: 'Recent Logs',
      maxItems: 50,
      itemRenderer: (log) => `
        <div class="log-entry ${log.level}">
          <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
          <span class="log-level">[${log.level.toUpperCase()}]</span>
          <span class="log-message">${log.message}</span>
        </div>
      `,
      ...options
    });
  }
  
  render() {
    super.render();
    
    // Auto-scroll to bottom
    const container = this.element.querySelector('.list-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }
}

/**
 * Progress widget - displays progress bars
 */
export class ProgressWidget extends Widget {
  constructor(options) {
    super({
      type: 'progress',
      ...options
    });
    
    this.items = options.items || [];
  }
  
  render() {
    if (!this.element) return;
    
    this.element.innerHTML = `
      <div class="widget progress-widget">
        <h3>${this.title}</h3>
        <div class="progress-container">
          ${this.items.map(item => this._renderProgressBar(item)).join('')}
        </div>
      </div>
    `;
  }
  
  _renderProgressBar(item) {
    const value = this.data[item.key] || 0;
    const max = item.max || 100;
    const percentage = Math.min((value / max) * 100, 100);
    const status = this._getProgressStatus(percentage, item.thresholds);
    
    return `
      <div class="progress-item">
        <div class="progress-header">
          <span class="progress-label">${item.label}</span>
          <span class="progress-value">${value}${item.unit || ''}</span>
        </div>
        <div class="progress-bar ${status}">
          <div class="progress-fill" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
  }
  
  _getProgressStatus(percentage, thresholds) {
    if (!thresholds) return 'normal';
    
    if (percentage >= (thresholds.critical || 90)) {
      return 'critical';
    }
    if (percentage >= (thresholds.warning || 70)) {
      return 'warning';
    }
    
    return 'normal';
  }
}

/**
 * Table widget - displays tabular data
 */
export class TableWidget extends Widget {
  constructor(options) {
    super({
      type: 'table',
      ...options
    });
    
    this.columns = options.columns || [];
    this.maxRows = options.maxRows || 20;
    this.sortable = options.sortable !== false;
    this.sortColumn = null;
    this.sortDirection = 'asc';
  }
  
  render() {
    if (!this.element) return;
    
    const rows = Array.isArray(this.data) ? this.data : [];
    const sortedRows = this._sortRows(rows);
    const displayRows = sortedRows.slice(0, this.maxRows);
    
    this.element.innerHTML = `
      <div class="widget table-widget">
        <h3>${this.title}</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                ${this.columns.map(col => `
                  <th ${this.sortable ? `onclick="window.widgetSort('${this.id}', '${col.key}')"` : ''}>
                    ${col.label}
                    ${this.sortColumn === col.key ? 
                      `<span class="sort-indicator">${this.sortDirection === 'asc' ? '▲' : '▼'}</span>` : 
                      ''
                    }
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${displayRows.map(row => `
                <tr>
                  ${this.columns.map(col => `
                    <td>${this._formatCellValue(row[col.key], col)}</td>
                  `).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    
    // Add sort handler
    if (this.sortable && !window.widgetSort) {
      window.widgetSort = (widgetId, column) => {
        if (widgetId === this.id) {
          this.sort(column);
        }
      };
    }
  }
  
  sort(column) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
    
    this.render();
  }
  
  _sortRows(rows) {
    if (!this.sortColumn) return rows;
    
    return [...rows].sort((a, b) => {
      const aVal = a[this.sortColumn];
      const bVal = b[this.sortColumn];
      
      if (aVal < bVal) return this.sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return this.sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }
  
  _formatCellValue(value, column) {
    if (column.formatter) {
      return column.formatter(value);
    }
    
    if (value === null || value === undefined) {
      return '-';
    }
    
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    
    if (value instanceof Date) {
      return value.toLocaleString();
    }
    
    return String(value);
  }
}

/**
 * Create widget factory
 */
export function createWidget(type, options) {
  switch (type) {
    case 'metric':
      return new MetricWidget(options);
      
    case 'chart':
      return new ChartWidget(options);
      
    case 'list':
      return new ListWidget(options);
      
    case 'alert':
      return new AlertWidget(options);
      
    case 'log':
      return new LogWidget(options);
      
    case 'progress':
      return new ProgressWidget(options);
      
    case 'table':
      return new TableWidget(options);
      
    default:
      return new Widget(options);
  }
}

export default {
  Widget,
  MetricWidget,
  ChartWidget,
  ListWidget,
  AlertWidget,
  LogWidget,
  ProgressWidget,
  TableWidget,
  createWidget
};