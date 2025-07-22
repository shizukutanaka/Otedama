/**
 * Advanced Data Visualization Components
 * Interactive, real-time charts with D3.js integration
 */

import { DesignTokens } from '../core/design-system.js';
import { BaseComponent } from '../components/base-components.js';

/**
 * Chart base class
 */
export class ChartBase extends BaseComponent {
  constructor(props) {
    super({
      width: 600,
      height: 400,
      margin: { top: 20, right: 20, bottom: 40, left: 50 },
      responsive: true,
      animated: true,
      theme: 'dark',
      ...props
    });
    
    this.data = props.data || [];
    this.scales = {};
    this.axes = {};
    this.tooltip = null;
  }
  
  /**
   * Get chart dimensions
   */
  getDimensions() {
    const { width, height, margin } = this.props;
    
    return {
      width,
      height,
      innerWidth: width - margin.left - margin.right,
      innerHeight: height - margin.top - margin.bottom,
      margin
    };
  }
  
  /**
   * Get color palette
   */
  getColors() {
    const isDark = this.props.theme === 'dark';
    
    return {
      background: isDark ? DesignTokens.colors.neutral[900] : DesignTokens.colors.neutral[0],
      text: isDark ? DesignTokens.colors.neutral[200] : DesignTokens.colors.neutral[700],
      grid: isDark ? DesignTokens.colors.neutral[800] : DesignTokens.colors.neutral[200],
      series: DesignTokens.colors.chart.series
    };
  }
  
  /**
   * Create SVG container
   */
  createSVG() {
    const { width, height, margin } = this.getDimensions();
    
    return `
      <svg 
        id="${this.id}-svg"
        width="${width}" 
        height="${height}"
        viewBox="0 0 ${width} ${height}"
        class="otedama-chart__svg"
      >
        <g transform="translate(${margin.left}, ${margin.top})">
          ${this.renderContent()}
        </g>
      </svg>
    `;
  }
  
  /**
   * Render chart content (override in subclasses)
   */
  renderContent() {
    return '';
  }
  
  /**
   * Create tooltip
   */
  createTooltip() {
    return `
      <div id="${this.id}-tooltip" class="otedama-chart__tooltip" style="display: none;">
        <div class="otedama-chart__tooltip-content"></div>
      </div>
    `;
  }
  
  /**
   * Update data
   */
  updateData(newData) {
    this.data = newData;
    this.onDataUpdate();
  }
  
  /**
   * Data update handler
   */
  onDataUpdate() {
    // Override in subclasses
  }
}

/**
 * Line Chart Component
 */
export class LineChart extends ChartBase {
  constructor(props) {
    super({
      curve: 'linear', // linear, step, basis, cardinal, monotone
      area: false,
      dots: true,
      grid: true,
      ...props
    });
  }
  
  renderContent() {
    const { innerWidth, innerHeight } = this.getDimensions();
    const colors = this.getColors();
    
    // Create scales
    const xExtent = this.getXExtent();
    const yExtent = this.getYExtent();
    
    const xScale = this.createXScale(xExtent, [0, innerWidth]);
    const yScale = this.createYScale(yExtent, [innerHeight, 0]);
    
    // Generate paths
    const paths = this.data.map((series, i) => {
      const color = colors.series[i % colors.series.length];
      const pathData = this.generatePath(series.values, xScale, yScale);
      
      return `
        <g class="otedama-chart__series" data-series="${series.name}">
          ${this.props.area ? `
            <path
              class="otedama-chart__area"
              d="${this.generateArea(series.values, xScale, yScale)}"
              fill="${color}"
              fill-opacity="0.1"
            />
          ` : ''}
          
          <path
            class="otedama-chart__line"
            d="${pathData}"
            stroke="${color}"
            stroke-width="2"
            fill="none"
          />
          
          ${this.props.dots ? series.values.map(d => `
            <circle
              class="otedama-chart__dot"
              cx="${xScale(d.x)}"
              cy="${yScale(d.y)}"
              r="4"
              fill="${color}"
              data-x="${d.x}"
              data-y="${d.y}"
            />
          `).join('') : ''}
        </g>
      `;
    }).join('');
    
    return `
      ${this.props.grid ? this.renderGrid(xScale, yScale, innerWidth, innerHeight) : ''}
      ${this.renderAxes(xScale, yScale, innerWidth, innerHeight)}
      ${paths}
    `;
  }
  
  /**
   * Generate line path
   */
  generatePath(data, xScale, yScale) {
    const curve = this.getCurveFunction();
    
    return data.map((d, i) => {
      const x = xScale(d.x);
      const y = yScale(d.y);
      
      if (i === 0) return `M ${x},${y}`;
      
      if (curve === 'step') {
        const prevX = xScale(data[i - 1].x);
        return `L ${prevX},${y} L ${x},${y}`;
      }
      
      return `L ${x},${y}`;
    }).join(' ');
  }
  
  /**
   * Generate area path
   */
  generateArea(data, xScale, yScale) {
    const linePath = this.generatePath(data, xScale, yScale);
    const { innerHeight } = this.getDimensions();
    
    const firstX = xScale(data[0].x);
    const lastX = xScale(data[data.length - 1].x);
    
    return `${linePath} L ${lastX},${innerHeight} L ${firstX},${innerHeight} Z`;
  }
  
  /**
   * Get curve function
   */
  getCurveFunction() {
    return this.props.curve;
  }
  
  /**
   * Get X extent
   */
  getXExtent() {
    const allValues = this.data.flatMap(series => series.values.map(d => d.x));
    return [Math.min(...allValues), Math.max(...allValues)];
  }
  
  /**
   * Get Y extent
   */
  getYExtent() {
    const allValues = this.data.flatMap(series => series.values.map(d => d.y));
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const padding = (max - min) * 0.1;
    return [min - padding, max + padding];
  }
  
  /**
   * Create X scale
   */
  createXScale(domain, range) {
    // Linear scale for numeric data
    const scale = (value) => {
      const t = (value - domain[0]) / (domain[1] - domain[0]);
      return range[0] + t * (range[1] - range[0]);
    };
    
    scale.domain = () => domain;
    scale.range = () => range;
    
    return scale;
  }
  
  /**
   * Create Y scale
   */
  createYScale(domain, range) {
    // Linear scale
    const scale = (value) => {
      const t = (value - domain[0]) / (domain[1] - domain[0]);
      return range[0] + t * (range[1] - range[0]);
    };
    
    scale.domain = () => domain;
    scale.range = () => range;
    
    return scale;
  }
  
  /**
   * Render grid
   */
  renderGrid(xScale, yScale, width, height) {
    const colors = this.getColors();
    const xTicks = this.generateTicks(xScale.domain(), 10);
    const yTicks = this.generateTicks(yScale.domain(), 8);
    
    return `
      <g class="otedama-chart__grid">
        ${xTicks.map(tick => `
          <line
            x1="${xScale(tick)}"
            y1="0"
            x2="${xScale(tick)}"
            y2="${height}"
            stroke="${colors.grid}"
            stroke-dasharray="2,2"
          />
        `).join('')}
        
        ${yTicks.map(tick => `
          <line
            x1="0"
            y1="${yScale(tick)}"
            x2="${width}"
            y2="${yScale(tick)}"
            stroke="${colors.grid}"
            stroke-dasharray="2,2"
          />
        `).join('')}
      </g>
    `;
  }
  
  /**
   * Render axes
   */
  renderAxes(xScale, yScale, width, height) {
    const colors = this.getColors();
    const xTicks = this.generateTicks(xScale.domain(), 10);
    const yTicks = this.generateTicks(yScale.domain(), 8);
    
    return `
      <g class="otedama-chart__axes">
        <!-- X Axis -->
        <g class="otedama-chart__axis otedama-chart__axis--x" transform="translate(0, ${height})">
          <line x1="0" y1="0" x2="${width}" y2="0" stroke="${colors.text}" />
          
          ${xTicks.map(tick => `
            <g transform="translate(${xScale(tick)}, 0)">
              <line y1="0" y2="6" stroke="${colors.text}" />
              <text y="20" text-anchor="middle" fill="${colors.text}" font-size="12">
                ${this.formatValue(tick)}
              </text>
            </g>
          `).join('')}
        </g>
        
        <!-- Y Axis -->
        <g class="otedama-chart__axis otedama-chart__axis--y">
          <line x1="0" y1="0" x2="0" y2="${height}" stroke="${colors.text}" />
          
          ${yTicks.map(tick => `
            <g transform="translate(0, ${yScale(tick)})">
              <line x1="-6" x2="0" stroke="${colors.text}" />
              <text x="-10" y="5" text-anchor="end" fill="${colors.text}" font-size="12">
                ${this.formatValue(tick)}
              </text>
            </g>
          `).join('')}
        </g>
      </g>
    `;
  }
  
  /**
   * Generate tick values
   */
  generateTicks(domain, count) {
    const ticks = [];
    const step = (domain[1] - domain[0]) / (count - 1);
    
    for (let i = 0; i < count; i++) {
      ticks.push(domain[0] + step * i);
    }
    
    return ticks;
  }
  
  /**
   * Format value for display
   */
  formatValue(value) {
    if (typeof value === 'number') {
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return value.toFixed(1);
    }
    return value;
  }
  
  render() {
    return `
      <div id="${this.id}" class="otedama-chart otedama-chart--line">
        ${this.createSVG()}
        ${this.createTooltip()}
      </div>
    `;
  }
}

/**
 * Bar Chart Component
 */
export class BarChart extends ChartBase {
  constructor(props) {
    super({
      orientation: 'vertical', // vertical, horizontal
      grouped: false,
      stacked: false,
      ...props
    });
  }
  
  renderContent() {
    const { innerWidth, innerHeight } = this.getDimensions();
    const colors = this.getColors();
    
    if (this.props.grouped) {
      return this.renderGroupedBars(innerWidth, innerHeight, colors);
    } else if (this.props.stacked) {
      return this.renderStackedBars(innerWidth, innerHeight, colors);
    } else {
      return this.renderSimpleBars(innerWidth, innerHeight, colors);
    }
  }
  
  /**
   * Render simple bars
   */
  renderSimpleBars(width, height, colors) {
    const data = this.data[0]?.values || [];
    const barWidth = width / data.length * 0.8;
    const barSpacing = width / data.length * 0.2;
    
    const yMax = Math.max(...data.map(d => d.value));
    const yScale = this.createYScale([0, yMax], [height, 0]);
    
    const bars = data.map((d, i) => {
      const x = i * (barWidth + barSpacing) + barSpacing / 2;
      const barHeight = height - yScale(d.value);
      const y = yScale(d.value);
      
      return `
        <rect
          class="otedama-chart__bar"
          x="${x}"
          y="${y}"
          width="${barWidth}"
          height="${barHeight}"
          fill="${colors.series[0]}"
          data-value="${d.value}"
          data-label="${d.label}"
        />
      `;
    }).join('');
    
    return `
      ${this.renderAxes(null, yScale, width, height)}
      ${bars}
    `;
  }
  
  /**
   * Render grouped bars
   */
  renderGroupedBars(width, height, colors) {
    const categories = this.data[0]?.values.map(d => d.label) || [];
    const groupWidth = width / categories.length;
    const barWidth = groupWidth / this.data.length * 0.8;
    
    const yMax = Math.max(...this.data.flatMap(series => 
      series.values.map(d => d.value)
    ));
    const yScale = this.createYScale([0, yMax], [height, 0]);
    
    const bars = this.data.map((series, seriesIndex) => {
      const color = colors.series[seriesIndex % colors.series.length];
      
      return series.values.map((d, i) => {
        const x = i * groupWidth + seriesIndex * barWidth + groupWidth * 0.1;
        const barHeight = height - yScale(d.value);
        const y = yScale(d.value);
        
        return `
          <rect
            class="otedama-chart__bar"
            x="${x}"
            y="${y}"
            width="${barWidth}"
            height="${barHeight}"
            fill="${color}"
            data-series="${series.name}"
            data-value="${d.value}"
            data-label="${d.label}"
          />
        `;
      }).join('');
    }).join('');
    
    return `
      ${this.renderAxes(null, yScale, width, height)}
      ${bars}
    `;
  }
  
  /**
   * Render stacked bars
   */
  renderStackedBars(width, height, colors) {
    const categories = this.data[0]?.values.map(d => d.label) || [];
    const barWidth = width / categories.length * 0.8;
    const barSpacing = width / categories.length * 0.2;
    
    // Calculate stacked values
    const stackedData = categories.map((category, i) => {
      let y0 = 0;
      return this.data.map(series => {
        const value = series.values[i].value;
        const result = { y0, y1: y0 + value, series: series.name, value };
        y0 += value;
        return result;
      });
    });
    
    const yMax = Math.max(...stackedData.map(stack => 
      stack[stack.length - 1].y1
    ));
    const yScale = this.createYScale([0, yMax], [height, 0]);
    
    const bars = stackedData.map((stack, i) => {
      const x = i * (barWidth + barSpacing) + barSpacing / 2;
      
      return stack.map((d, j) => {
        const color = colors.series[j % colors.series.length];
        const y = yScale(d.y1);
        const barHeight = yScale(d.y0) - yScale(d.y1);
        
        return `
          <rect
            class="otedama-chart__bar"
            x="${x}"
            y="${y}"
            width="${barWidth}"
            height="${barHeight}"
            fill="${color}"
            data-series="${d.series}"
            data-value="${d.value}"
          />
        `;
      }).join('');
    }).join('');
    
    return `
      ${this.renderAxes(null, yScale, width, height)}
      ${bars}
    `;
  }
}

/**
 * Pie Chart Component
 */
export class PieChart extends ChartBase {
  constructor(props) {
    super({
      donut: false,
      donutWidth: 60,
      showLabels: true,
      showValues: true,
      ...props
    });
  }
  
  renderContent() {
    const { innerWidth, innerHeight } = this.getDimensions();
    const colors = this.getColors();
    
    const centerX = innerWidth / 2;
    const centerY = innerHeight / 2;
    const radius = Math.min(innerWidth, innerHeight) / 2 * 0.8;
    const innerRadius = this.props.donut ? radius - this.props.donutWidth : 0;
    
    // Calculate angles
    const total = this.data.reduce((sum, d) => sum + d.value, 0);
    let currentAngle = -Math.PI / 2; // Start at top
    
    const slices = this.data.map((d, i) => {
      const startAngle = currentAngle;
      const endAngle = currentAngle + (d.value / total) * 2 * Math.PI;
      currentAngle = endAngle;
      
      const color = colors.series[i % colors.series.length];
      const midAngle = (startAngle + endAngle) / 2;
      
      // Calculate label position
      const labelRadius = radius + 20;
      const labelX = centerX + Math.cos(midAngle) * labelRadius;
      const labelY = centerY + Math.sin(midAngle) * labelRadius;
      
      return {
        ...d,
        startAngle,
        endAngle,
        midAngle,
        color,
        labelX,
        labelY,
        percentage: (d.value / total * 100).toFixed(1)
      };
    });
    
    return `
      <g transform="translate(${centerX}, ${centerY})">
        ${slices.map(slice => `
          <path
            class="otedama-chart__slice"
            d="${this.createArcPath(slice.startAngle, slice.endAngle, radius, innerRadius)}"
            fill="${slice.color}"
            data-label="${slice.label}"
            data-value="${slice.value}"
            data-percentage="${slice.percentage}"
          />
        `).join('')}
        
        ${this.props.showLabels ? slices.map(slice => `
          <g class="otedama-chart__label" transform="translate(${slice.labelX - centerX}, ${slice.labelY - centerY})">
            <text 
              text-anchor="${slice.midAngle > Math.PI / 2 && slice.midAngle < 3 * Math.PI / 2 ? 'end' : 'start'}"
              fill="${colors.text}"
              font-size="12"
            >
              <tspan x="0" dy="0">${slice.label}</tspan>
              ${this.props.showValues ? `
                <tspan x="0" dy="16" font-size="10" fill-opacity="0.7">
                  ${slice.value} (${slice.percentage}%)
                </tspan>
              ` : ''}
            </text>
          </g>
        `).join('') : ''}
      </g>
    `;
  }
  
  /**
   * Create arc path
   */
  createArcPath(startAngle, endAngle, outerRadius, innerRadius) {
    const x1 = Math.cos(startAngle) * outerRadius;
    const y1 = Math.sin(startAngle) * outerRadius;
    const x2 = Math.cos(endAngle) * outerRadius;
    const y2 = Math.sin(endAngle) * outerRadius;
    
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    
    if (innerRadius === 0) {
      return `
        M 0,0
        L ${x1},${y1}
        A ${outerRadius},${outerRadius} 0 ${largeArc} 1 ${x2},${y2}
        Z
      `;
    } else {
      const ix1 = Math.cos(startAngle) * innerRadius;
      const iy1 = Math.sin(startAngle) * innerRadius;
      const ix2 = Math.cos(endAngle) * innerRadius;
      const iy2 = Math.sin(endAngle) * innerRadius;
      
      return `
        M ${ix1},${iy1}
        L ${x1},${y1}
        A ${outerRadius},${outerRadius} 0 ${largeArc} 1 ${x2},${y2}
        L ${ix2},${iy2}
        A ${innerRadius},${innerRadius} 0 ${largeArc} 0 ${ix1},${iy1}
        Z
      `;
    }
  }
}

/**
 * Real-time Chart Wrapper
 */
export class RealTimeChart extends LineChart {
  constructor(props) {
    super({
      maxDataPoints: 50,
      updateInterval: 1000,
      ...props
    });
    
    this.updateTimer = null;
    this.dataBuffer = [];
  }
  
  /**
   * Start real-time updates
   */
  start() {
    if (this.updateTimer) return;
    
    this.updateTimer = setInterval(() => {
      this.onRealtimeUpdate();
    }, this.props.updateInterval);
  }
  
  /**
   * Stop real-time updates
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }
  
  /**
   * Add data point
   */
  addDataPoint(seriesName, value) {
    const timestamp = Date.now();
    
    // Find or create series
    let series = this.data.find(s => s.name === seriesName);
    if (!series) {
      series = { name: seriesName, values: [] };
      this.data.push(series);
    }
    
    // Add point
    series.values.push({ x: timestamp, y: value });
    
    // Maintain max points
    if (series.values.length > this.props.maxDataPoints) {
      series.values.shift();
    }
    
    this.onDataUpdate();
  }
  
  /**
   * Real-time update handler
   */
  onRealtimeUpdate() {
    // Override in subclasses or emit event
    this.emit('update');
  }
}

/**
 * Chart styles
 */
export const chartStyles = `
  .otedama-chart {
    position: relative;
    width: 100%;
    height: 100%;
  }
  
  .otedama-chart__svg {
    width: 100%;
    height: 100%;
  }
  
  /* Animations */
  .otedama-chart__line {
    stroke-dasharray: 1000;
    stroke-dashoffset: 1000;
    animation: draw-line 2s ease-out forwards;
  }
  
  .otedama-chart__bar {
    transform-origin: bottom;
    animation: grow-bar 0.8s ease-out;
  }
  
  .otedama-chart__slice {
    transform-origin: center;
    animation: grow-slice 0.8s ease-out;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .otedama-chart__slice:hover {
    filter: brightness(1.1);
    transform: scale(1.05);
  }
  
  .otedama-chart__dot {
    opacity: 0;
    animation: fade-in 0.3s ease-out 0.8s forwards;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .otedama-chart__dot:hover {
    r: 6;
  }
  
  /* Tooltip */
  .otedama-chart__tooltip {
    position: absolute;
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: ${DesignTokens.borderRadius.md};
    padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
    box-shadow: ${DesignTokens.shadows.lg};
    pointer-events: none;
    z-index: ${DesignTokens.zIndex.tooltip};
  }
  
  .otedama-chart__tooltip-content {
    font-size: ${DesignTokens.typography.fontSize.sm};
    color: var(--text-primary);
  }
  
  /* Animations */
  @keyframes draw-line {
    to {
      stroke-dashoffset: 0;
    }
  }
  
  @keyframes grow-bar {
    from {
      transform: scaleY(0);
    }
    to {
      transform: scaleY(1);
    }
  }
  
  @keyframes grow-slice {
    from {
      transform: scale(0) rotate(-90deg);
    }
    to {
      transform: scale(1) rotate(0deg);
    }
  }
  
  @keyframes fade-in {
    to {
      opacity: 1;
    }
  }
  
  /* Responsive */
  @media (max-width: ${DesignTokens.breakpoints.sm}) {
    .otedama-chart {
      font-size: ${DesignTokens.typography.fontSize.xs};
    }
  }
`;

export default {
  ChartBase,
  LineChart,
  BarChart,
  PieChart,
  RealTimeChart,
  chartStyles
};