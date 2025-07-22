/**
 * Dashboard Layout System
 * Grid-based layout for dashboard widgets with drag-and-drop support
 */

import { BaseComponent } from '../components/base-components.js';
import { DesignTokens } from '../core/design-system.js';
import { DashboardWidget } from './dashboard-widgets.js';

/**
 * Dashboard Grid Layout
 */
export class DashboardGrid extends BaseComponent {
  constructor(props) {
    super({
      columns: 4,
      gap: 'md',
      widgets: [],
      editable: true,
      autoSave: true,
      storageKey: 'otedama-dashboard-layout',
      ...props
    });
    
    this.state = {
      widgets: props.widgets || [],
      draggedWidget: null,
      dropTarget: null,
      isEditing: false
    };
    
    this.loadLayout();
  }
  
  /**
   * Load saved layout
   */
  loadLayout() {
    if (!this.props.autoSave) return;
    
    const saved = localStorage.getItem(this.props.storageKey);
    if (saved) {
      try {
        const layout = JSON.parse(saved);
        this.state.widgets = layout.widgets || this.state.widgets;
      } catch (error) {
        console.error('Failed to load dashboard layout:', error);
      }
    }
  }
  
  /**
   * Save layout
   */
  saveLayout() {
    if (!this.props.autoSave) return;
    
    const layout = {
      widgets: this.state.widgets,
      timestamp: Date.now()
    };
    
    localStorage.setItem(this.props.storageKey, JSON.stringify(layout));
  }
  
  /**
   * Render grid
   */
  render() {
    const { columns, gap, editable, className = '' } = this.props;
    const { widgets, isEditing } = this.state;
    
    const gapMap = {
      sm: DesignTokens.spacing[2],
      md: DesignTokens.spacing[4],
      lg: DesignTokens.spacing[6]
    };
    
    const baseClasses = `
      otedama-dashboard-grid
      ${isEditing ? 'otedama-dashboard-grid--editing' : ''}
      ${className}
    `.trim();
    
    const gridStyle = `
      grid-template-columns: repeat(${columns}, 1fr);
      gap: ${gapMap[gap] || gapMap.md};
    `;
    
    return `
      <div id="${this.id}" class="${baseClasses}">
        ${editable ? this.renderToolbar() : ''}
        
        <div class="otedama-dashboard-grid__container" style="${gridStyle}">
          ${widgets.map(widget => this.renderWidget(widget)).join('')}
          
          ${isEditing ? this.renderAddWidget() : ''}
        </div>
      </div>
    `;
  }
  
  /**
   * Render toolbar
   */
  renderToolbar() {
    const { isEditing } = this.state;
    
    return `
      <div class="otedama-dashboard-grid__toolbar">
        <div class="otedama-dashboard-grid__toolbar-left">
          <h2 class="otedama-dashboard-grid__title">Dashboard</h2>
        </div>
        
        <div class="otedama-dashboard-grid__toolbar-right">
          <button
            class="otedama-button otedama-button--sm otedama-button--${isEditing ? 'primary' : 'ghost'}"
            onclick="document.getElementById('${this.id}').toggleEdit()"
          >
            ${isEditing ? 'Done' : 'Edit'}
          </button>
          
          ${isEditing ? `
            <button
              class="otedama-button otedama-button--sm otedama-button--ghost"
              onclick="document.getElementById('${this.id}').resetLayout()"
            >
              Reset
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }
  
  /**
   * Render widget
   */
  renderWidget(widget) {
    const { isEditing } = this.state;
    
    const widgetClasses = `
      otedama-dashboard-grid__widget
      ${isEditing ? 'otedama-dashboard-grid__widget--editable' : ''}
    `.trim();
    
    return `
      <div 
        class="${widgetClasses}"
        data-widget-id="${widget.id}"
        ${isEditing ? `
          draggable="true"
          ondragstart="document.getElementById('${this.id}').handleDragStart(event, '${widget.id}')"
          ondragend="document.getElementById('${this.id}').handleDragEnd(event)"
          ondragover="document.getElementById('${this.id}').handleDragOver(event)"
          ondrop="document.getElementById('${this.id}').handleDrop(event, '${widget.id}')"
        ` : ''}
      >
        ${this.createWidgetComponent(widget).render()}
        
        ${isEditing ? `
          <div class="otedama-dashboard-grid__widget-overlay">
            <div class="otedama-dashboard-grid__widget-handle">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM17 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM17 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM17 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>
              </svg>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  /**
   * Render add widget button
   */
  renderAddWidget() {
    return `
      <div class="otedama-dashboard-grid__add-widget">
        <button
          class="otedama-dashboard-grid__add-button"
          onclick="document.getElementById('${this.id}').showWidgetPicker()"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z"/>
          </svg>
          <span>Add Widget</span>
        </button>
      </div>
    `;
  }
  
  /**
   * Create widget component
   */
  createWidgetComponent(widget) {
    // This would create the appropriate widget component based on type
    // For now, return a basic widget
    return new DashboardWidget({
      ...widget,
      onRemove: () => this.removeWidget(widget.id),
      onRefresh: widget.onRefresh
    });
  }
  
  /**
   * Toggle edit mode
   */
  toggleEdit() {
    this.setState({ isEditing: !this.state.isEditing });
    
    if (!this.state.isEditing) {
      this.saveLayout();
    }
  }
  
  /**
   * Add widget
   */
  addWidget(widget) {
    const newWidget = {
      id: `widget-${Date.now()}`,
      ...widget
    };
    
    this.setState({
      widgets: [...this.state.widgets, newWidget]
    });
    
    this.saveLayout();
  }
  
  /**
   * Remove widget
   */
  removeWidget(widgetId) {
    this.setState({
      widgets: this.state.widgets.filter(w => w.id !== widgetId)
    });
    
    this.saveLayout();
  }
  
  /**
   * Reset layout
   */
  resetLayout() {
    if (confirm('Are you sure you want to reset the dashboard layout?')) {
      this.setState({ widgets: this.props.widgets || [] });
      localStorage.removeItem(this.props.storageKey);
    }
  }
  
  /**
   * Drag and drop handlers
   */
  handleDragStart(event, widgetId) {
    this.state.draggedWidget = widgetId;
    event.dataTransfer.effectAllowed = 'move';
    event.target.classList.add('otedama-dashboard-grid__widget--dragging');
  }
  
  handleDragEnd(event) {
    event.target.classList.remove('otedama-dashboard-grid__widget--dragging');
    
    // Clean up any drop indicators
    const dropTargets = this.element.querySelectorAll('.otedama-dashboard-grid__widget--drop-target');
    dropTargets.forEach(el => el.classList.remove('otedama-dashboard-grid__widget--drop-target'));
  }
  
  handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    
    const widget = event.target.closest('.otedama-dashboard-grid__widget');
    if (widget && widget.dataset.widgetId !== this.state.draggedWidget) {
      widget.classList.add('otedama-dashboard-grid__widget--drop-target');
    }
  }
  
  handleDrop(event, targetWidgetId) {
    event.preventDefault();
    
    const draggedId = this.state.draggedWidget;
    if (!draggedId || draggedId === targetWidgetId) return;
    
    const widgets = [...this.state.widgets];
    const draggedIndex = widgets.findIndex(w => w.id === draggedId);
    const targetIndex = widgets.findIndex(w => w.id === targetWidgetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    // Reorder widgets
    const [draggedWidget] = widgets.splice(draggedIndex, 1);
    widgets.splice(targetIndex, 0, draggedWidget);
    
    this.setState({ widgets });
    this.saveLayout();
  }
  
  /**
   * Show widget picker
   */
  showWidgetPicker() {
    // This would show a modal with available widgets
    // For now, we'll add a sample widget
    this.addWidget({
      type: 'stats',
      title: 'New Widget',
      subtitle: 'Configure this widget',
      size: 'medium',
      value: 0
    });
  }
  
  /**
   * Get element
   */
  get element() {
    return document.getElementById(this.id);
  }
  
  static styles = `
    .otedama-dashboard-grid {
      display: flex;
      flex-direction: column;
      gap: ${DesignTokens.spacing[4]};
    }
    
    /* Toolbar */
    .otedama-dashboard-grid__toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${DesignTokens.spacing[2]} 0;
    }
    
    .otedama-dashboard-grid__toolbar-left,
    .otedama-dashboard-grid__toolbar-right {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
    }
    
    .otedama-dashboard-grid__title {
      margin: 0;
      font-size: ${DesignTokens.typography.fontSize['2xl']};
      font-weight: ${DesignTokens.typography.fontWeight.semibold};
    }
    
    /* Container */
    .otedama-dashboard-grid__container {
      display: grid;
      position: relative;
    }
    
    /* Widget wrapper */
    .otedama-dashboard-grid__widget {
      position: relative;
      transition: all 0.3s ease;
    }
    
    .otedama-dashboard-grid__widget--editable {
      cursor: move;
    }
    
    .otedama-dashboard-grid__widget--dragging {
      opacity: 0.5;
    }
    
    .otedama-dashboard-grid__widget--drop-target {
      transform: scale(0.95);
      opacity: 0.7;
    }
    
    /* Widget overlay for editing */
    .otedama-dashboard-grid__widget-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      border: 2px dashed ${DesignTokens.colors.primary[500]};
      border-radius: ${DesignTokens.borderRadius.lg};
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }
    
    .otedama-dashboard-grid__widget--editable:hover .otedama-dashboard-grid__widget-overlay {
      opacity: 1;
    }
    
    .otedama-dashboard-grid__widget-handle {
      color: white;
      background: ${DesignTokens.colors.primary[500]};
      padding: ${DesignTokens.spacing[2]};
      border-radius: ${DesignTokens.borderRadius.md};
    }
    
    /* Add widget button */
    .otedama-dashboard-grid__add-widget {
      grid-column: span 1;
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .otedama-dashboard-grid__add-button {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
      padding: ${DesignTokens.spacing[4]};
      background: var(--surface-card);
      border: 2px dashed var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.lg};
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
      width: 100%;
      height: 100%;
    }
    
    .otedama-dashboard-grid__add-button:hover {
      border-color: ${DesignTokens.colors.primary[500]};
      color: ${DesignTokens.colors.primary[500]};
      background: var(--background-secondary);
    }
    
    /* Responsive */
    @media (max-width: ${DesignTokens.breakpoints.lg}) {
      .otedama-dashboard-grid__container {
        grid-template-columns: repeat(2, 1fr) !important;
      }
    }
    
    @media (max-width: ${DesignTokens.breakpoints.sm}) {
      .otedama-dashboard-grid__container {
        grid-template-columns: 1fr !important;
      }
      
      .otedama-dashboard-grid__toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: ${DesignTokens.spacing[2]};
      }
      
      .otedama-dashboard-grid__toolbar-right {
        justify-content: flex-end;
      }
    }
  `;
}

/**
 * Dashboard Template
 */
export class DashboardTemplate {
  static Trading = {
    name: 'Trading Dashboard',
    widgets: [
      {
        type: 'stats',
        title: 'Portfolio Value',
        icon: '💰',
        size: 'medium',
        format: 'currency',
        value: 125000,
        previousValue: 120000,
        trend: 'up'
      },
      {
        type: 'stats',
        title: 'Today\'s Profit',
        icon: '📈',
        size: 'medium',
        format: 'currency',
        value: 5000,
        previousValue: 3500,
        trend: 'up'
      },
      {
        type: 'chart',
        title: 'Price Chart',
        icon: '📊',
        size: 'large',
        chartType: 'line',
        chartData: []
      },
      {
        type: 'table',
        title: 'Open Orders',
        icon: '📋',
        size: 'large',
        columns: [
          { key: 'pair', label: 'Pair' },
          { key: 'type', label: 'Type' },
          { key: 'amount', label: 'Amount' },
          { key: 'price', label: 'Price' },
          { key: 'status', label: 'Status' }
        ],
        data: []
      },
      {
        type: 'activity',
        title: 'Recent Trades',
        icon: '🔄',
        size: 'medium',
        activities: []
      }
    ]
  };
  
  static Mining = {
    name: 'Mining Dashboard',
    widgets: [
      {
        type: 'stats',
        title: 'Hashrate',
        icon: '⚡',
        size: 'small',
        value: 125.5,
        format: 'number',
        suffix: 'MH/s',
        trend: 'neutral'
      },
      {
        type: 'stats',
        title: 'Shares',
        icon: '✓',
        size: 'small',
        value: 1250,
        format: 'number',
        trend: 'up'
      },
      {
        type: 'stats',
        title: 'Efficiency',
        icon: '📊',
        size: 'small',
        value: 98.5,
        format: 'percentage',
        trend: 'up'
      },
      {
        type: 'stats',
        title: 'Daily Revenue',
        icon: '💵',
        size: 'small',
        value: 45.67,
        format: 'currency',
        trend: 'down'
      },
      {
        type: 'chart',
        title: 'Hashrate History',
        icon: '📈',
        size: 'full',
        chartType: 'realtime',
        chartData: []
      },
      {
        type: 'table',
        title: 'Worker Status',
        icon: '🖥️',
        size: 'large',
        columns: [
          { key: 'name', label: 'Worker' },
          { key: 'hashrate', label: 'Hashrate' },
          { key: 'temp', label: 'Temp' },
          { key: 'shares', label: 'Shares' },
          { key: 'status', label: 'Status' }
        ],
        data: []
      }
    ]
  };
  
  static Analytics = {
    name: 'Analytics Dashboard',
    widgets: [
      {
        type: 'chart',
        title: 'Revenue Overview',
        icon: '💰',
        size: 'large',
        chartType: 'bar',
        chartData: []
      },
      {
        type: 'chart',
        title: 'Asset Distribution',
        icon: '🥧',
        size: 'medium',
        chartType: 'pie',
        chartData: []
      },
      {
        type: 'stats',
        title: 'Total Users',
        icon: '👥',
        size: 'small',
        value: 15234,
        format: 'number',
        trend: 'up'
      },
      {
        type: 'stats',
        title: 'Active Sessions',
        icon: '🟢',
        size: 'small',
        value: 342,
        format: 'number',
        trend: 'up'
      },
      {
        type: 'activity',
        title: 'System Events',
        icon: '📡',
        size: 'medium',
        activities: []
      }
    ]
  };
}

export default {
  DashboardGrid,
  DashboardTemplate
};