/**
 * Theme Manager
 * Dark mode, light mode, and custom theme support
 */

import { DesignTokens } from '../core/design-system.js';
import { logger } from '../../core/logger.js';

/**
 * Theme definitions
 */
export const Themes = {
  light: {
    name: 'Light',
    colors: {
      // Backgrounds
      'background-primary': DesignTokens.colors.neutral[0],
      'background-secondary': DesignTokens.colors.neutral[50],
      'background-tertiary': DesignTokens.colors.neutral[100],
      
      // Surfaces
      'surface-card': DesignTokens.colors.neutral[0],
      'surface-overlay': 'rgba(255, 255, 255, 0.95)',
      
      // Text
      'text-primary': DesignTokens.colors.neutral[900],
      'text-secondary': DesignTokens.colors.neutral[700],
      'text-tertiary': DesignTokens.colors.neutral[500],
      'text-inverse': DesignTokens.colors.neutral[0],
      
      // Borders
      'border-primary': DesignTokens.colors.neutral[200],
      'border-secondary': DesignTokens.colors.neutral[100],
      
      // Shadows
      'shadow-color': 'rgba(0, 0, 0, 0.1)',
      
      // Chart specific
      'chart-grid': DesignTokens.colors.neutral[200],
      'chart-text': DesignTokens.colors.neutral[700],
      
      // Code
      'code-background': DesignTokens.colors.neutral[50],
      'code-text': DesignTokens.colors.neutral[900]
    }
  },
  
  dark: {
    name: 'Dark',
    colors: {
      // Backgrounds
      'background-primary': DesignTokens.colors.neutral[900],
      'background-secondary': DesignTokens.colors.neutral[800],
      'background-tertiary': DesignTokens.colors.neutral[700],
      
      // Surfaces
      'surface-card': DesignTokens.colors.neutral[800],
      'surface-overlay': 'rgba(0, 0, 0, 0.95)',
      
      // Text
      'text-primary': DesignTokens.colors.neutral[50],
      'text-secondary': DesignTokens.colors.neutral[200],
      'text-tertiary': DesignTokens.colors.neutral[400],
      'text-inverse': DesignTokens.colors.neutral[900],
      
      // Borders
      'border-primary': DesignTokens.colors.neutral[700],
      'border-secondary': DesignTokens.colors.neutral[800],
      
      // Shadows
      'shadow-color': 'rgba(0, 0, 0, 0.3)',
      
      // Chart specific
      'chart-grid': DesignTokens.colors.neutral[800],
      'chart-text': DesignTokens.colors.neutral[200],
      
      // Code
      'code-background': DesignTokens.colors.neutral[800],
      'code-text': DesignTokens.colors.neutral[100]
    }
  },
  
  midnight: {
    name: 'Midnight',
    colors: {
      // Backgrounds
      'background-primary': '#0a0a0a',
      'background-secondary': '#141414',
      'background-tertiary': '#1f1f1f',
      
      // Surfaces
      'surface-card': '#141414',
      'surface-overlay': 'rgba(0, 0, 0, 0.98)',
      
      // Text
      'text-primary': '#e5e5e5',
      'text-secondary': '#b3b3b3',
      'text-tertiary': '#808080',
      'text-inverse': '#0a0a0a',
      
      // Borders
      'border-primary': '#2a2a2a',
      'border-secondary': '#1f1f1f',
      
      // Shadows
      'shadow-color': 'rgba(0, 0, 0, 0.5)',
      
      // Chart specific
      'chart-grid': '#2a2a2a',
      'chart-text': '#b3b3b3',
      
      // Code
      'code-background': '#0d0d0d',
      'code-text': '#e5e5e5'
    }
  },
  
  ocean: {
    name: 'Ocean',
    colors: {
      // Backgrounds
      'background-primary': '#001220',
      'background-secondary': '#001830',
      'background-tertiary': '#002040',
      
      // Surfaces
      'surface-card': '#001830',
      'surface-overlay': 'rgba(0, 18, 32, 0.95)',
      
      // Text
      'text-primary': '#e0f2fe',
      'text-secondary': '#7dd3fc',
      'text-tertiary': '#38bdf8',
      'text-inverse': '#001220',
      
      // Borders
      'border-primary': '#003060',
      'border-secondary': '#002850',
      
      // Shadows
      'shadow-color': 'rgba(0, 0, 0, 0.4)',
      
      // Chart specific
      'chart-grid': '#003060',
      'chart-text': '#7dd3fc',
      
      // Code
      'code-background': '#000c16',
      'code-text': '#e0f2fe'
    }
  }
};

/**
 * Theme Manager Class
 */
export class ThemeManager {
  constructor(options = {}) {
    this.options = {
      defaultTheme: 'dark',
      enableSystemTheme: true,
      customThemes: {},
      transitions: true,
      persistTheme: true,
      storageKey: 'otedama-theme',
      ...options
    };
    
    this.themes = { ...Themes, ...this.options.customThemes };
    this.currentTheme = null;
    this.listeners = new Map();
    this.systemThemeQuery = null;
  }
  
  /**
   * Initialize theme manager
   */
  initialize() {
    // Load persisted theme
    if (this.options.persistTheme) {
      const savedTheme = localStorage.getItem(this.options.storageKey);
      if (savedTheme && this.themes[savedTheme]) {
        this.setTheme(savedTheme, false);
      }
    }
    
    // Set up system theme detection
    if (this.options.enableSystemTheme && !this.currentTheme) {
      this.detectSystemTheme();
    }
    
    // Apply default theme if none set
    if (!this.currentTheme) {
      this.setTheme(this.options.defaultTheme, false);
    }
    
    // Inject base styles
    this.injectStyles();
    
    logger.info('Theme manager initialized with theme:', this.currentTheme);
  }
  
  /**
   * Detect system theme preference
   */
  detectSystemTheme() {
    if (!window.matchMedia) return;
    
    this.systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    // Set initial theme based on system preference
    const systemTheme = this.systemThemeQuery.matches ? 'dark' : 'light';
    this.setTheme(systemTheme, false);
    
    // Listen for changes
    this.systemThemeQuery.addEventListener('change', (e) => {
      if (this.options.enableSystemTheme) {
        const newTheme = e.matches ? 'dark' : 'light';
        this.setTheme(newTheme);
      }
    });
  }
  
  /**
   * Set active theme
   */
  setTheme(themeName, transition = true) {
    if (!this.themes[themeName]) {
      logger.error(`Theme "${themeName}" not found`);
      return false;
    }
    
    const previousTheme = this.currentTheme;
    this.currentTheme = themeName;
    
    // Apply theme
    this.applyTheme(this.themes[themeName], transition);
    
    // Persist theme
    if (this.options.persistTheme) {
      localStorage.setItem(this.options.storageKey, themeName);
    }
    
    // Emit change event
    this.emitChange({
      theme: themeName,
      previousTheme,
      themeData: this.themes[themeName]
    });
    
    logger.info(`Theme changed to: ${themeName}`);
    return true;
  }
  
  /**
   * Apply theme to DOM
   */
  applyTheme(theme, transition = true) {
    const root = document.documentElement;
    
    // Add transition class if enabled
    if (transition && this.options.transitions) {
      root.classList.add('theme-transitioning');
    }
    
    // Set theme attribute
    root.setAttribute('data-theme', this.currentTheme);
    
    // Apply CSS variables
    Object.entries(theme.colors).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value);
    });
    
    // Update meta theme color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.content = theme.colors['background-primary'];
    }
    
    // Remove transition class after animation
    if (transition && this.options.transitions) {
      setTimeout(() => {
        root.classList.remove('theme-transitioning');
      }, 300);
    }
  }
  
  /**
   * Get current theme
   */
  getCurrentTheme() {
    return {
      name: this.currentTheme,
      data: this.themes[this.currentTheme]
    };
  }
  
  /**
   * Get all available themes
   */
  getAvailableThemes() {
    return Object.keys(this.themes).map(key => ({
      id: key,
      name: this.themes[key].name,
      preview: this.themes[key].colors
    }));
  }
  
  /**
   * Add custom theme
   */
  addCustomTheme(id, theme) {
    this.themes[id] = theme;
    logger.info(`Custom theme "${id}" added`);
  }
  
  /**
   * Remove custom theme
   */
  removeCustomTheme(id) {
    if (Themes[id]) {
      logger.error('Cannot remove built-in theme');
      return false;
    }
    
    if (this.currentTheme === id) {
      this.setTheme(this.options.defaultTheme);
    }
    
    delete this.themes[id];
    logger.info(`Custom theme "${id}" removed`);
    return true;
  }
  
  /**
   * Toggle between light and dark
   */
  toggleTheme() {
    const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }
  
  /**
   * Create theme from colors
   */
  createThemeFromColors(baseColors) {
    // Generate a complete theme from base colors
    const theme = {
      name: 'Custom',
      colors: {}
    };
    
    // Calculate derived colors
    // This is a simplified version - in production, you'd want more sophisticated color generation
    const isDark = this.isColorDark(baseColors.primary);
    
    if (isDark) {
      // Dark theme variant
      theme.colors = {
        'background-primary': baseColors.background || '#0a0a0a',
        'background-secondary': this.lighten(baseColors.background || '#0a0a0a', 0.05),
        'background-tertiary': this.lighten(baseColors.background || '#0a0a0a', 0.1),
        'surface-card': this.lighten(baseColors.background || '#0a0a0a', 0.05),
        'surface-overlay': `${baseColors.background || '#0a0a0a'}f2`,
        'text-primary': baseColors.text || '#e5e5e5',
        'text-secondary': this.darken(baseColors.text || '#e5e5e5', 0.2),
        'text-tertiary': this.darken(baseColors.text || '#e5e5e5', 0.4),
        'text-inverse': '#0a0a0a',
        'border-primary': this.lighten(baseColors.background || '#0a0a0a', 0.15),
        'border-secondary': this.lighten(baseColors.background || '#0a0a0a', 0.1),
        'shadow-color': 'rgba(0, 0, 0, 0.5)',
        'chart-grid': this.lighten(baseColors.background || '#0a0a0a', 0.15),
        'chart-text': this.darken(baseColors.text || '#e5e5e5', 0.2),
        'code-background': this.darken(baseColors.background || '#0a0a0a', 0.05),
        'code-text': baseColors.text || '#e5e5e5'
      };
    } else {
      // Light theme variant
      theme.colors = {
        'background-primary': baseColors.background || '#ffffff',
        'background-secondary': this.darken(baseColors.background || '#ffffff', 0.02),
        'background-tertiary': this.darken(baseColors.background || '#ffffff', 0.05),
        'surface-card': baseColors.background || '#ffffff',
        'surface-overlay': `${baseColors.background || '#ffffff'}f2`,
        'text-primary': baseColors.text || '#1a1a1a',
        'text-secondary': this.lighten(baseColors.text || '#1a1a1a', 0.2),
        'text-tertiary': this.lighten(baseColors.text || '#1a1a1a', 0.4),
        'text-inverse': '#ffffff',
        'border-primary': this.darken(baseColors.background || '#ffffff', 0.1),
        'border-secondary': this.darken(baseColors.background || '#ffffff', 0.05),
        'shadow-color': 'rgba(0, 0, 0, 0.1)',
        'chart-grid': this.darken(baseColors.background || '#ffffff', 0.1),
        'chart-text': this.lighten(baseColors.text || '#1a1a1a', 0.2),
        'code-background': this.darken(baseColors.background || '#ffffff', 0.02),
        'code-text': baseColors.text || '#1a1a1a'
      };
    }
    
    return theme;
  }
  
  /**
   * Color utilities
   */
  isColorDark(color) {
    const rgb = this.hexToRgb(color);
    if (!rgb) return false;
    
    // Calculate relative luminance
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance < 0.5;
  }
  
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }
  
  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }
  
  lighten(color, amount) {
    const rgb = this.hexToRgb(color);
    if (!rgb) return color;
    
    const factor = 1 + amount;
    const r = Math.min(255, Math.round(rgb.r * factor));
    const g = Math.min(255, Math.round(rgb.g * factor));
    const b = Math.min(255, Math.round(rgb.b * factor));
    
    return this.rgbToHex(r, g, b);
  }
  
  darken(color, amount) {
    const rgb = this.hexToRgb(color);
    if (!rgb) return color;
    
    const factor = 1 - amount;
    const r = Math.round(rgb.r * factor);
    const g = Math.round(rgb.g * factor);
    const b = Math.round(rgb.b * factor);
    
    return this.rgbToHex(r, g, b);
  }
  
  /**
   * Add change listener
   */
  onChange(callback) {
    const id = Math.random().toString(36).substr(2, 9);
    this.listeners.set(id, callback);
    
    return () => {
      this.listeners.delete(id);
    };
  }
  
  /**
   * Emit change event
   */
  emitChange(data) {
    this.listeners.forEach(callback => {
      callback(data);
    });
  }
  
  /**
   * Inject theme styles
   */
  injectStyles() {
    const style = document.createElement('style');
    style.id = 'otedama-theme-styles';
    style.textContent = `
      /* Theme transition */
      .theme-transitioning,
      .theme-transitioning *,
      .theme-transitioning *::before,
      .theme-transitioning *::after {
        transition: background-color 300ms ease, 
                    color 300ms ease, 
                    border-color 300ms ease,
                    box-shadow 300ms ease !important;
      }
      
      /* Theme-aware scrollbar */
      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      
      ::-webkit-scrollbar-track {
        background: var(--background-secondary);
      }
      
      ::-webkit-scrollbar-thumb {
        background: var(--border-primary);
        border-radius: 4px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: var(--text-tertiary);
      }
      
      /* Selection colors */
      ::selection {
        background: ${DesignTokens.colors.primary[500]}33;
        color: var(--text-primary);
      }
      
      /* Focus outlines */
      *:focus-visible {
        outline: 2px solid ${DesignTokens.colors.primary[500]};
        outline-offset: 2px;
      }
      
      /* Theme-specific component adjustments */
      [data-theme="dark"] .otedama-button--ghost:hover:not(:disabled) {
        background-color: ${DesignTokens.colors.neutral[800]};
      }
      
      [data-theme="light"] .otedama-button--secondary:hover:not(:disabled) {
        background-color: ${DesignTokens.colors.primary[50]};
      }
      
      [data-theme="dark"] .otedama-button--secondary:hover:not(:disabled) {
        background-color: ${DesignTokens.colors.primary[900]}33;
      }
    `;
    
    document.head.appendChild(style);
  }
}

/**
 * Theme Switcher Component
 */
export class ThemeSwitcher extends BaseComponent {
  constructor(props) {
    super({
      variant: 'dropdown', // dropdown, toggle, palette
      showPreview: true,
      manager: null,
      ...props
    });
    
    if (!this.props.manager) {
      throw new Error('ThemeManager instance required');
    }
  }
  
  render() {
    const { variant, showPreview, className = '' } = this.props;
    const manager = this.props.manager;
    
    const baseClasses = `
      otedama-theme-switcher
      otedama-theme-switcher--${variant}
      ${className}
    `.trim();
    
    switch (variant) {
      case 'toggle':
        return this.renderToggle(baseClasses, manager);
      
      case 'palette':
        return this.renderPalette(baseClasses, manager);
      
      case 'dropdown':
      default:
        return this.renderDropdown(baseClasses, manager);
    }
  }
  
  renderToggle(classes, manager) {
    const isDark = manager.currentTheme === 'dark' || manager.currentTheme === 'midnight';
    
    return `
      <button 
        id="${this.id}"
        class="${classes}"
        onclick="window.themeManager.toggleTheme()"
        aria-label="Toggle theme"
      >
        <span class="otedama-theme-switcher__icon">
          ${isDark ? '☀️' : '🌙'}
        </span>
      </button>
    `;
  }
  
  renderDropdown(classes, manager) {
    const themes = manager.getAvailableThemes();
    const current = manager.getCurrentTheme();
    
    return `
      <div id="${this.id}" class="${classes}">
        <select 
          class="otedama-theme-switcher__select"
          onchange="window.themeManager.setTheme(this.value)"
          aria-label="Select theme"
        >
          ${themes.map(theme => `
            <option value="${theme.id}" ${theme.id === current.name ? 'selected' : ''}>
              ${theme.name}
            </option>
          `).join('')}
        </select>
        
        ${this.props.showPreview ? `
          <div class="otedama-theme-switcher__preview">
            ${themes.map(theme => `
              <div 
                class="otedama-theme-switcher__preview-item ${theme.id === current.name ? 'active' : ''}"
                data-theme="${theme.id}"
                onclick="window.themeManager.setTheme('${theme.id}')"
                style="
                  background: ${theme.preview['background-primary']};
                  color: ${theme.preview['text-primary']};
                  border-color: ${theme.preview['border-primary']};
                "
              >
                <span class="otedama-theme-switcher__preview-name">${theme.name}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }
  
  renderPalette(classes, manager) {
    const themes = manager.getAvailableThemes();
    const current = manager.getCurrentTheme();
    
    return `
      <div id="${this.id}" class="${classes}">
        <div class="otedama-theme-switcher__palette">
          ${themes.map(theme => `
            <button
              class="otedama-theme-switcher__palette-item ${theme.id === current.name ? 'active' : ''}"
              onclick="window.themeManager.setTheme('${theme.id}')"
              aria-label="${theme.name} theme"
              data-theme="${theme.id}"
            >
              <span 
                class="otedama-theme-switcher__palette-color"
                style="background: linear-gradient(135deg, 
                  ${theme.preview['background-primary']} 0%, 
                  ${theme.preview['background-secondary']} 50%, 
                  ${theme.preview['background-tertiary']} 100%
                )"
              ></span>
              <span class="otedama-theme-switcher__palette-name">${theme.name}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  static styles = `
    /* Base */
    .otedama-theme-switcher {
      display: inline-block;
      position: relative;
    }
    
    /* Toggle variant */
    .otedama-theme-switcher--toggle {
      background: var(--surface-card);
      border: 2px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.full};
      padding: ${DesignTokens.spacing[2]};
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-theme-switcher--toggle:hover {
      background: var(--background-secondary);
    }
    
    .otedama-theme-switcher__icon {
      display: block;
      font-size: 20px;
      line-height: 1;
    }
    
    /* Dropdown variant */
    .otedama-theme-switcher__select {
      background: var(--surface-card);
      color: var(--text-primary);
      border: 2px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
      font-size: ${DesignTokens.typography.fontSize.sm};
      cursor: pointer;
    }
    
    .otedama-theme-switcher__preview {
      position: absolute;
      top: calc(100% + ${DesignTokens.spacing[2]});
      left: 0;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: ${DesignTokens.spacing[2]};
      background: var(--surface-card);
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      padding: ${DesignTokens.spacing[2]};
      box-shadow: ${DesignTokens.shadows.lg};
      opacity: 0;
      visibility: hidden;
      transition: all 0.2s ease;
    }
    
    .otedama-theme-switcher--dropdown:hover .otedama-theme-switcher__preview {
      opacity: 1;
      visibility: visible;
    }
    
    .otedama-theme-switcher__preview-item {
      padding: ${DesignTokens.spacing[2]};
      border: 2px solid transparent;
      border-radius: ${DesignTokens.borderRadius.sm};
      text-align: center;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-theme-switcher__preview-item:hover,
    .otedama-theme-switcher__preview-item.active {
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    /* Palette variant */
    .otedama-theme-switcher__palette {
      display: flex;
      gap: ${DesignTokens.spacing[2]};
      padding: ${DesignTokens.spacing[2]};
      background: var(--surface-card);
      border-radius: ${DesignTokens.borderRadius.lg};
    }
    
    .otedama-theme-switcher__palette-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${DesignTokens.spacing[1]};
      padding: ${DesignTokens.spacing[2]};
      background: transparent;
      border: 2px solid transparent;
      border-radius: ${DesignTokens.borderRadius.md};
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-theme-switcher__palette-item:hover {
      background: var(--background-secondary);
    }
    
    .otedama-theme-switcher__palette-item.active {
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-theme-switcher__palette-color {
      display: block;
      width: 40px;
      height: 40px;
      border-radius: ${DesignTokens.borderRadius.full};
      box-shadow: ${DesignTokens.shadows.md};
    }
    
    .otedama-theme-switcher__palette-name {
      font-size: ${DesignTokens.typography.fontSize.xs};
      color: var(--text-secondary);
    }
  `;
}

// Create global instance
if (typeof window !== 'undefined') {
  window.themeManager = new ThemeManager();
}

export default {
  ThemeManager,
  ThemeSwitcher,
  Themes
};