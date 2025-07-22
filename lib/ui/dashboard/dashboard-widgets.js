/**
 * Dashboard Widget Components
 * Reusable widgets for building interactive dashboards
 */

import { BaseComponent } from '../components/base-components.js';
import { DesignTokens } from '../core/design-system.js';
import { LineChart, BarChart, PieChart, RealTimeChart } from '../visualization/advanced-charts.js';

/**
 * Base Widget Class
 */
export class DashboardWidget extends BaseComponent {
  constructor(props) {
    super({
      title: '',
      subtitle: '',
      icon: null,
      size: 'medium', // small, medium, large, full
      refreshable: true,
      collapsible: true,
      removable: true,
      loading: false,
      error: null,
      ...props
    });
    
    this.state = {
      collapsed: false,
      refreshing: false
    };
  }
  
  /**
   * Get widget size classes
   */
  getSizeClasses() {
    const sizeMap = {
      small: 'otedama-widget--small',
      medium: 'otedama-widget--medium',
      large: 'otedama-widget--large',
      full: 'otedama-widget--full'
    };
    
    return sizeMap[this.props.size] || sizeMap.medium;
  }
  
  /**
   * Render widget header
   */
  renderHeader() {
    const { title, subtitle, icon, refreshable, collapsible, removable } = this.props;
    const { collapsed } = this.state;
    
    return `
      <div class="otedama-widget__header">
        <div class="otedama-widget__header-content">
          ${icon ? `<span class="otedama-widget__icon">${icon}</span>` : ''}
          <div class="otedama-widget__titles">
            <h3 class="otedama-widget__title">${title}</h3>
            ${subtitle ? `<p class="otedama-widget__subtitle">${subtitle}</p>` : ''}
          </div>
        </div>
        
        <div class="otedama-widget__actions">
          ${refreshable ? `
            <button 
              class="otedama-widget__action"
              onclick="document.getElementById('${this.id}').refresh()"
              aria-label="Refresh"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.65 2.35a8 8 0 1 0 1.41 8.83.75.75 0 0 0-1.32-.72 6.5 6.5 0 1 1-1.17-7.17l-1.42.01a.75.75 0 0 0 .01 1.5l3.25-.02a.75.75 0 0 0 .75-.75l-.02-3.25a.75.75 0 0 0-1.5.01l.01 1.56z"/>
              </svg>
            </button>
          ` : ''}
          
          ${collapsible ? `
            <button 
              class="otedama-widget__action"
              onclick="document.getElementById('${this.id}').toggleCollapse()"
              aria-label="${collapsed ? 'Expand' : 'Collapse'}"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 ${collapsed ? '11' : '5'}l-4 4h8l-4-4z" transform="rotate(${collapsed ? '180' : '0'} 8 8)"/>
              </svg>
            </button>
          ` : ''}
          
          ${removable ? `
            <button 
              class="otedama-widget__action otedama-widget__action--danger"
              onclick="document.getElementById('${this.id}').remove()"
              aria-label="Remove"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.78 4.22a.75.75 0 0 1 0 1.06L9.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 0 1-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 0 1 1.06-1.06L8 6.94l2.72-2.72a.75.75 0 0 1 1.06 0z"/>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }
  
  /**
   * Render widget content
   */
  renderContent() {
    // Override in subclasses
    return '<div class="otedama-widget__empty">No content</div>';
  }
  
  /**
   * Render widget
   */
  render() {
    const { loading, error, className = '' } = this.props;
    const { collapsed, refreshing } = this.state;
    
    const baseClasses = `
      otedama-widget
      ${this.getSizeClasses()}
      ${collapsed ? 'otedama-widget--collapsed' : ''}
      ${loading || refreshing ? 'otedama-widget--loading' : ''}
      ${error ? 'otedama-widget--error' : ''}
      ${className}
    `.trim();
    
    return `
      <div id="${this.id}" class="${baseClasses}">
        ${this.renderHeader()}
        
        <div class="otedama-widget__body">
          ${loading || refreshing ? `
            <div class="otedama-widget__loader">
              <div class="otedama-widget__spinner"></div>
              <span>Loading...</span>
            </div>
          ` : error ? `
            <div class="otedama-widget__error">
              <span class="otedama-widget__error-icon">⚠️</span>
              <p>${error}</p>
            </div>
          ` : this.renderContent()}
        </div>
      </div>
    `;
  }
  
  /**
   * Refresh widget
   */
  async refresh() {
    this.setState({ refreshing: true });
    
    try {
      // Call onRefresh prop if provided
      if (this.props.onRefresh) {
        await this.props.onRefresh();
      }
      
      this.emit('refresh');
    } catch (error) {
      console.error('Widget refresh failed:', error);
    } finally {
      this.setState({ refreshing: false });
    }
  }
  
  /**
   * Toggle collapse state
   */
  toggleCollapse() {
    this.setState({ collapsed: !this.state.collapsed });
    this.emit('collapse', { collapsed: !this.state.collapsed });
  }
  
  /**
   * Remove widget
   */
  remove() {
    if (this.props.onRemove) {
      this.props.onRemove();
    }
    
    this.emit('remove');
    
    // Animate removal
    const element = document.getElementById(this.id);
    if (element) {
      element.style.opacity = '0';
      element.style.transform = 'scale(0.9)';
      setTimeout(() => element.remove(), 300);
    }
  }
  
  static styles = `
    .otedama-widget {
      background: var(--surface-card);
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.lg};
      display: flex;
      flex-direction: column;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    
    /* Sizes */
    .otedama-widget--small {
      grid-column: span 1;
      grid-row: span 1;
      min-height: 200px;
    }
    
    .otedama-widget--medium {
      grid-column: span 2;
      grid-row: span 1;
      min-height: 300px;
    }
    
    .otedama-widget--large {
      grid-column: span 2;
      grid-row: span 2;
      min-height: 400px;
    }
    
    .otedama-widget--full {
      grid-column: 1 / -1;
      grid-row: span 2;
      min-height: 400px;
    }
    
    /* Header */
    .otedama-widget__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[4]};
      border-bottom: 1px solid var(--border-primary);
    }
    
    .otedama-widget__header-content {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[3]};
      flex: 1;
      min-width: 0;
    }
    
    .otedama-widget__icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    
    .otedama-widget__titles {
      flex: 1;
      min-width: 0;
    }
    
    .otedama-widget__title {
      margin: 0;
      font-size: ${DesignTokens.typography.fontSize.base};
      font-weight: ${DesignTokens.typography.fontWeight.semibold};
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .otedama-widget__subtitle {
      margin: ${DesignTokens.spacing[0.5]} 0 0 0;
      font-size: ${DesignTokens.typography.fontSize.sm};
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    /* Actions */
    .otedama-widget__actions {
      display: flex;
      gap: ${DesignTokens.spacing[1]};
    }
    
    .otedama-widget__action {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: ${DesignTokens.borderRadius.md};
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-widget__action:hover {
      background: var(--background-secondary);
      color: var(--text-primary);
    }
    
    .otedama-widget__action--danger:hover {
      background: ${DesignTokens.colors.semantic.error}22;
      color: ${DesignTokens.colors.semantic.error};
    }
    
    /* Body */
    .otedama-widget__body {
      flex: 1;
      padding: ${DesignTokens.spacing[4]};
      overflow: auto;
    }
    
    .otedama-widget--collapsed .otedama-widget__body {
      display: none;
    }
    
    /* States */
    .otedama-widget--loading .otedama-widget__body {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .otedama-widget__loader {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${DesignTokens.spacing[3]};
      color: var(--text-secondary);
    }
    
    .otedama-widget__spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-primary);
      border-top-color: ${DesignTokens.colors.primary[500]};
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    .otedama-widget__error {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: ${DesignTokens.spacing[2]};
      text-align: center;
      color: ${DesignTokens.colors.semantic.error};
      height: 100%;
    }
    
    .otedama-widget__error-icon {
      font-size: 48px;
    }
    
    .otedama-widget__empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-tertiary);
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
}

/**
 * Stats Widget
 */
export class StatsWidget extends DashboardWidget {
  constructor(props) {
    super({
      value: 0,
      previousValue: null,
      format: 'number', // number, currency, percentage
      trend: 'up', // up, down, neutral
      sparkline: null,
      ...props
    });
  }
  
  formatValue(value) {
    const { format } = this.props;
    
    switch (format) {
      case 'currency':
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 0,
          maximumFractionDigits: 2
        }).format(value);
        
      case 'percentage':
        return `${value.toFixed(1)}%`;
        
      default:
        return new Intl.NumberFormat('en-US').format(value);
    }
  }
  
  calculateChange() {
    const { value, previousValue } = this.props;
    if (!previousValue) return null;
    
    const change = ((value - previousValue) / previousValue) * 100;
    return change;
  }
  
  renderContent() {
    const { value, trend, sparkline } = this.props;
    const change = this.calculateChange();
    
    return `
      <div class="otedama-stats-widget">
        <div class="otedama-stats-widget__value">
          ${this.formatValue(value)}
        </div>
        
        ${change !== null ? `
          <div class="otedama-stats-widget__change otedama-stats-widget__change--${trend}">
            <span class="otedama-stats-widget__change-icon">
              ${trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
            </span>
            <span class="otedama-stats-widget__change-value">
              ${Math.abs(change).toFixed(1)}%
            </span>
          </div>
        ` : ''}
        
        ${sparkline ? `
          <div class="otedama-stats-widget__sparkline">
            ${new LineChart({
              data: [{ name: 'value', values: sparkline }],
              width: 200,
              height: 60,
              margin: { top: 5, right: 5, bottom: 5, left: 5 },
              dots: false,
              grid: false
            }).render()}
          </div>
        ` : ''}
      </div>
    `;
  }
  
  static styles = `
    .otedama-stats-widget {
      display: flex;
      flex-direction: column;
      gap: ${DesignTokens.spacing[3]};
      height: 100%;
    }
    
    .otedama-stats-widget__value {
      font-size: ${DesignTokens.typography.fontSize['3xl']};
      font-weight: ${DesignTokens.typography.fontWeight.bold};
      color: var(--text-primary);
    }
    
    .otedama-stats-widget__change {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[1]};
      font-size: ${DesignTokens.typography.fontSize.sm};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
    }
    
    .otedama-stats-widget__change--up {
      color: ${DesignTokens.colors.semantic.success};
    }
    
    .otedama-stats-widget__change--down {
      color: ${DesignTokens.colors.semantic.error};
    }
    
    .otedama-stats-widget__change--neutral {
      color: var(--text-secondary);
    }
    
    .otedama-stats-widget__sparkline {
      flex: 1;
      min-height: 60px;
    }
  `;
}

/**
 * Chart Widget
 */
export class ChartWidget extends DashboardWidget {
  constructor(props) {
    super({
      chartType: 'line', // line, bar, pie, realtime
      chartData: [],
      chartOptions: {},
      ...props
    });
  }
  
  renderContent() {
    const { chartType, chartData, chartOptions } = this.props;
    
    let ChartComponent;
    switch (chartType) {
      case 'bar':
        ChartComponent = BarChart;
        break;
      case 'pie':
        ChartComponent = PieChart;
        break;
      case 'realtime':
        ChartComponent = RealTimeChart;
        break;
      case 'line':
      default:
        ChartComponent = LineChart;
        break;
    }
    
    const chart = new ChartComponent({
      data: chartData,
      ...chartOptions
    });
    
    return `
      <div class="otedama-chart-widget">
        ${chart.render()}
      </div>
    `;
  }
  
  static styles = `
    .otedama-chart-widget {
      height: 100%;
      min-height: 200px;
    }
  `;
}

/**
 * Table Widget
 */
export class TableWidget extends DashboardWidget {
  constructor(props) {
    super({
      columns: [],
      data: [],
      sortable: true,
      filterable: true,
      paginated: true,
      pageSize: 10,
      ...props
    });
    
    this.state = {
      ...this.state,
      currentPage: 0,
      sortColumn: null,
      sortDirection: 'asc',
      filterValue: ''
    };
  }
  
  renderContent() {
    const { columns, data, sortable, filterable, paginated, pageSize } = this.props;
    const { currentPage, sortColumn, sortDirection, filterValue } = this.state;
    
    // Filter data
    let filteredData = data;
    if (filterValue) {
      filteredData = data.filter(row =>
        Object.values(row).some(value =>
          String(value).toLowerCase().includes(filterValue.toLowerCase())
        )
      );
    }
    
    // Sort data
    if (sortColumn) {
      filteredData = [...filteredData].sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        const modifier = sortDirection === 'asc' ? 1 : -1;
        
        if (aVal < bVal) return -1 * modifier;
        if (aVal > bVal) return 1 * modifier;
        return 0;
      });
    }
    
    // Paginate data
    const totalPages = Math.ceil(filteredData.length / pageSize);
    const paginatedData = paginated
      ? filteredData.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
      : filteredData;
    
    return `
      <div class="otedama-table-widget">
        ${filterable ? `
          <div class="otedama-table-widget__filter">
            <input
              type="text"
              class="otedama-table-widget__filter-input"
              placeholder="Filter..."
              value="${filterValue}"
              oninput="document.getElementById('${this.id}').filter(this.value)"
            />
          </div>
        ` : ''}
        
        <div class="otedama-table-widget__scroll">
          <table class="otedama-table-widget__table">
            <thead>
              <tr>
                ${columns.map(column => `
                  <th 
                    class="otedama-table-widget__th ${sortable ? 'otedama-table-widget__th--sortable' : ''}"
                    ${sortable ? `onclick="document.getElementById('${this.id}').sort('${column.key}')"` : ''}
                  >
                    <span>${column.label}</span>
                    ${sortable && sortColumn === column.key ? `
                      <span class="otedama-table-widget__sort-icon">
                        ${sortDirection === 'asc' ? '↑' : '↓'}
                      </span>
                    ` : ''}
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${paginatedData.map(row => `
                <tr class="otedama-table-widget__tr">
                  ${columns.map(column => `
                    <td class="otedama-table-widget__td">
                      ${column.render ? column.render(row[column.key], row) : row[column.key]}
                    </td>
                  `).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        
        ${paginated && totalPages > 1 ? `
          <div class="otedama-table-widget__pagination">
            <button
              class="otedama-table-widget__page-button"
              onclick="document.getElementById('${this.id}').previousPage()"
              ${currentPage === 0 ? 'disabled' : ''}
            >
              Previous
            </button>
            
            <span class="otedama-table-widget__page-info">
              Page ${currentPage + 1} of ${totalPages}
            </span>
            
            <button
              class="otedama-table-widget__page-button"
              onclick="document.getElementById('${this.id}').nextPage()"
              ${currentPage === totalPages - 1 ? 'disabled' : ''}
            >
              Next
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  filter(value) {
    this.setState({ filterValue: value, currentPage: 0 });
  }
  
  sort(column) {
    const { sortColumn, sortDirection } = this.state;
    
    if (sortColumn === column) {
      this.setState({
        sortDirection: sortDirection === 'asc' ? 'desc' : 'asc'
      });
    } else {
      this.setState({
        sortColumn: column,
        sortDirection: 'asc'
      });
    }
  }
  
  previousPage() {
    this.setState({ currentPage: Math.max(0, this.state.currentPage - 1) });
  }
  
  nextPage() {
    const totalPages = Math.ceil(this.props.data.length / this.props.pageSize);
    this.setState({ currentPage: Math.min(totalPages - 1, this.state.currentPage + 1) });
  }
  
  static styles = `
    .otedama-table-widget {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: ${DesignTokens.spacing[3]};
    }
    
    .otedama-table-widget__filter {
      flex-shrink: 0;
    }
    
    .otedama-table-widget__filter-input {
      width: 100%;
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
      background: var(--background-secondary);
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      color: var(--text-primary);
      font-size: ${DesignTokens.typography.fontSize.sm};
    }
    
    .otedama-table-widget__scroll {
      flex: 1;
      overflow: auto;
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
    }
    
    .otedama-table-widget__table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .otedama-table-widget__th {
      background: var(--background-secondary);
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
      text-align: left;
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      font-size: ${DesignTokens.typography.fontSize.sm};
      color: var(--text-secondary);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    
    .otedama-table-widget__th--sortable {
      cursor: pointer;
      user-select: none;
    }
    
    .otedama-table-widget__th--sortable:hover {
      background: var(--background-tertiary);
    }
    
    .otedama-table-widget__sort-icon {
      margin-left: ${DesignTokens.spacing[1]};
      color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-table-widget__td {
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
      border-top: 1px solid var(--border-primary);
      font-size: ${DesignTokens.typography.fontSize.sm};
    }
    
    .otedama-table-widget__tr:hover {
      background: var(--background-secondary);
    }
    
    .otedama-table-widget__pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${DesignTokens.spacing[3]};
      flex-shrink: 0;
    }
    
    .otedama-table-widget__page-button {
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[3]};
      background: var(--surface-card);
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      color: var(--text-primary);
      font-size: ${DesignTokens.typography.fontSize.sm};
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-table-widget__page-button:hover:not(:disabled) {
      background: var(--background-secondary);
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-table-widget__page-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .otedama-table-widget__page-info {
      font-size: ${DesignTokens.typography.fontSize.sm};
      color: var(--text-secondary);
    }
  `;
}

/**
 * Activity Feed Widget
 */
export class ActivityFeedWidget extends DashboardWidget {
  constructor(props) {
    super({
      activities: [],
      maxItems: 10,
      showTimestamp: true,
      ...props
    });
  }
  
  getRelativeTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
  
  renderContent() {
    const { activities, maxItems, showTimestamp } = this.props;
    const displayActivities = activities.slice(0, maxItems);
    
    if (displayActivities.length === 0) {
      return '<div class="otedama-widget__empty">No recent activity</div>';
    }
    
    return `
      <div class="otedama-activity-feed">
        ${displayActivities.map(activity => `
          <div class="otedama-activity-feed__item">
            <div class="otedama-activity-feed__icon otedama-activity-feed__icon--${activity.type}">
              ${this.getActivityIcon(activity.type)}
            </div>
            
            <div class="otedama-activity-feed__content">
              <div class="otedama-activity-feed__title">
                ${activity.title}
              </div>
              ${activity.description ? `
                <div class="otedama-activity-feed__description">
                  ${activity.description}
                </div>
              ` : ''}
              ${showTimestamp ? `
                <div class="otedama-activity-feed__time">
                  ${this.getRelativeTime(activity.timestamp)}
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  getActivityIcon(type) {
    const icons = {
      success: '✓',
      error: '✗',
      warning: '⚠',
      info: 'ℹ',
      trade: '📈',
      mining: '⛏',
      transaction: '💸',
      user: '👤'
    };
    
    return icons[type] || '•';
  }
  
  static styles = `
    .otedama-activity-feed {
      display: flex;
      flex-direction: column;
      gap: ${DesignTokens.spacing[3]};
    }
    
    .otedama-activity-feed__item {
      display: flex;
      gap: ${DesignTokens.spacing[3]};
      padding: ${DesignTokens.spacing[2]} 0;
      border-bottom: 1px solid var(--border-primary);
    }
    
    .otedama-activity-feed__item:last-child {
      border-bottom: none;
    }
    
    .otedama-activity-feed__icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: ${DesignTokens.borderRadius.full};
      flex-shrink: 0;
      font-size: 16px;
    }
    
    .otedama-activity-feed__icon--success {
      background: ${DesignTokens.colors.semantic.success}22;
      color: ${DesignTokens.colors.semantic.success};
    }
    
    .otedama-activity-feed__icon--error {
      background: ${DesignTokens.colors.semantic.error}22;
      color: ${DesignTokens.colors.semantic.error};
    }
    
    .otedama-activity-feed__icon--warning {
      background: ${DesignTokens.colors.semantic.warning}22;
      color: ${DesignTokens.colors.semantic.warning};
    }
    
    .otedama-activity-feed__icon--info {
      background: ${DesignTokens.colors.semantic.info}22;
      color: ${DesignTokens.colors.semantic.info};
    }
    
    .otedama-activity-feed__content {
      flex: 1;
      min-width: 0;
    }
    
    .otedama-activity-feed__title {
      font-size: ${DesignTokens.typography.fontSize.sm};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      color: var(--text-primary);
      margin-bottom: ${DesignTokens.spacing[0.5]};
    }
    
    .otedama-activity-feed__description {
      font-size: ${DesignTokens.typography.fontSize.xs};
      color: var(--text-secondary);
      margin-bottom: ${DesignTokens.spacing[1]};
    }
    
    .otedama-activity-feed__time {
      font-size: ${DesignTokens.typography.fontSize.xs};
      color: var(--text-tertiary);
    }
  `;
}

/**
 * Export all widget styles
 */
export const getAllWidgetStyles = () => {
  const widgets = [
    DashboardWidget,
    StatsWidget,
    ChartWidget,
    TableWidget,
    ActivityFeedWidget
  ];
  
  return widgets
    .map(Widget => Widget.styles)
    .join('\n\n');
};

export default {
  DashboardWidget,
  StatsWidget,
  ChartWidget,
  TableWidget,
  ActivityFeedWidget,
  getAllWidgetStyles
};