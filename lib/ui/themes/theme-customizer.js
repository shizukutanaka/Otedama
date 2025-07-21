/**
 * Theme Customizer
 * UI for creating and customizing themes
 */

import { BaseComponent } from '../components/base-components.js';
import { DesignTokens } from '../core/design-system.js';

/**
 * Color Picker Component
 */
export class ColorPicker extends BaseComponent {
  constructor(props) {
    super({
      value: '#000000',
      label: 'Color',
      onChange: () => {},
      ...props
    });
    
    this.state = {
      isOpen: false,
      tempValue: props.value
    };
  }
  
  render() {
    const { value, label, className = '' } = this.props;
    const { isOpen } = this.state;
    
    const baseClasses = `
      otedama-color-picker
      ${isOpen ? 'otedama-color-picker--open' : ''}
      ${className}
    `.trim();
    
    return `
      <div id="${this.id}" class="${baseClasses}">
        <label class="otedama-color-picker__label">${label}</label>
        
        <div class="otedama-color-picker__control">
          <button 
            class="otedama-color-picker__button"
            onclick="document.getElementById('${this.id}-input').click()"
            style="background-color: ${value}"
          >
            <span class="otedama-color-picker__value">${value}</span>
          </button>
          
          <input
            id="${this.id}-input"
            type="color"
            class="otedama-color-picker__input"
            value="${value}"
            onchange="this.previousElementSibling.style.backgroundColor = this.value; 
                     this.previousElementSibling.querySelector('.otedama-color-picker__value').textContent = this.value;
                     ${this.props.onChange ? `(${this.props.onChange})(this.value)` : ''}"
          />
        </div>
      </div>
    `;
  }
  
  static styles = `
    .otedama-color-picker {
      display: flex;
      flex-direction: column;
      gap: ${DesignTokens.spacing[1]};
    }
    
    .otedama-color-picker__label {
      font-size: ${DesignTokens.typography.fontSize.sm};
      color: var(--text-secondary);
      font-weight: ${DesignTokens.typography.fontWeight.medium};
    }
    
    .otedama-color-picker__control {
      position: relative;
    }
    
    .otedama-color-picker__button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 40px;
      border: 2px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: all 0.2s ease;
    }
    
    .otedama-color-picker__button:hover {
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-color-picker__value {
      background: var(--surface-card);
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[2]};
      border-radius: ${DesignTokens.borderRadius.sm};
      font-family: ${DesignTokens.typography.fontFamily.mono};
      font-size: ${DesignTokens.typography.fontSize.xs};
      color: var(--text-primary);
      text-transform: uppercase;
    }
    
    .otedama-color-picker__input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
  `;
}

/**
 * Theme Customizer Component
 */
export class ThemeCustomizer extends BaseComponent {
  constructor(props) {
    super({
      manager: null,
      onSave: () => {},
      ...props
    });
    
    if (!this.props.manager) {
      throw new Error('ThemeManager instance required');
    }
    
    this.state = {
      isOpen: false,
      customColors: {
        primary: DesignTokens.colors.primary[500],
        secondary: DesignTokens.colors.secondary[500],
        background: '#0a0a0a',
        surface: '#141414',
        text: '#e5e5e5',
        border: '#2a2a2a'
      },
      previewTheme: null
    };
  }
  
  render() {
    const { className = '' } = this.props;
    const { isOpen, customColors } = this.state;
    
    const baseClasses = `
      otedama-theme-customizer
      ${isOpen ? 'otedama-theme-customizer--open' : ''}
      ${className}
    `.trim();
    
    return `
      <div id="${this.id}" class="${baseClasses}">
        <button 
          class="otedama-theme-customizer__trigger"
          onclick="this.parentElement.classList.toggle('otedama-theme-customizer--open')"
        >
          <span class="otedama-theme-customizer__trigger-icon">🎨</span>
          <span>Customize Theme</span>
        </button>
        
        <div class="otedama-theme-customizer__panel">
          <div class="otedama-theme-customizer__header">
            <h3 class="otedama-theme-customizer__title">Theme Customizer</h3>
            <button 
              class="otedama-theme-customizer__close"
              onclick="this.closest('.otedama-theme-customizer').classList.remove('otedama-theme-customizer--open')"
            >
              ×
            </button>
          </div>
          
          <div class="otedama-theme-customizer__content">
            <div class="otedama-theme-customizer__section">
              <h4 class="otedama-theme-customizer__section-title">Base Colors</h4>
              
              <div class="otedama-theme-customizer__colors">
                ${Object.entries(customColors).map(([key, value]) => `
                  <div class="otedama-theme-customizer__color-item">
                    ${new ColorPicker({
                      label: this.formatLabel(key),
                      value: value,
                      onChange: `(value) => {
                        const customizer = document.getElementById('${this.id}');
                        customizer.updateColor('${key}', value);
                      }`
                    }).render()}
                  </div>
                `).join('')}
              </div>
            </div>
            
            <div class="otedama-theme-customizer__section">
              <h4 class="otedama-theme-customizer__section-title">Preview</h4>
              
              <div class="otedama-theme-customizer__preview">
                <div class="otedama-theme-customizer__preview-content" style="
                  background: ${customColors.background};
                  color: ${customColors.text};
                ">
                  <div class="otedama-theme-customizer__preview-card" style="
                    background: ${customColors.surface};
                    border: 1px solid ${customColors.border};
                  ">
                    <h5 style="color: ${customColors.primary}">Card Title</h5>
                    <p>This is how your theme will look.</p>
                    <button style="
                      background: ${customColors.primary};
                      color: white;
                      border: none;
                      padding: 8px 16px;
                      border-radius: 4px;
                    ">
                      Primary Button
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="otedama-theme-customizer__actions">
              <button 
                class="otedama-button otedama-button--secondary"
                onclick="document.getElementById('${this.id}').applyPreview()"
              >
                Preview
              </button>
              
              <button 
                class="otedama-button otedama-button--primary"
                onclick="document.getElementById('${this.id}').saveTheme()"
              >
                Save Theme
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Format label from key
   */
  formatLabel(key) {
    return key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
  }
  
  /**
   * Update color
   */
  updateColor(key, value) {
    this.state.customColors[key] = value;
    
    // Update preview
    const preview = this.element.querySelector('.otedama-theme-customizer__preview-content');
    if (preview) {
      if (key === 'background') preview.style.background = value;
      if (key === 'text') preview.style.color = value;
      
      const card = preview.querySelector('.otedama-theme-customizer__preview-card');
      if (card) {
        if (key === 'surface') card.style.background = value;
        if (key === 'border') card.style.borderColor = value;
      }
      
      const title = preview.querySelector('h5');
      if (title && key === 'primary') title.style.color = value;
      
      const button = preview.querySelector('button');
      if (button && key === 'primary') button.style.background = value;
    }
  }
  
  /**
   * Apply preview
   */
  applyPreview() {
    const theme = this.props.manager.createThemeFromColors(this.state.customColors);
    theme.name = 'Custom Preview';
    
    // Add as temporary theme
    this.props.manager.addCustomTheme('custom-preview', theme);
    this.props.manager.setTheme('custom-preview');
    
    this.state.previewTheme = 'custom-preview';
  }
  
  /**
   * Save theme
   */
  saveTheme() {
    const name = prompt('Enter a name for your theme:');
    if (!name) return;
    
    const theme = this.props.manager.createThemeFromColors(this.state.customColors);
    theme.name = name;
    
    const id = name.toLowerCase().replace(/\s+/g, '-');
    
    // Remove preview if exists
    if (this.state.previewTheme) {
      this.props.manager.removeCustomTheme(this.state.previewTheme);
    }
    
    // Add and apply new theme
    this.props.manager.addCustomTheme(id, theme);
    this.props.manager.setTheme(id);
    
    // Save to localStorage
    const savedThemes = JSON.parse(localStorage.getItem('otedama-custom-themes') || '{}');
    savedThemes[id] = theme;
    localStorage.setItem('otedama-custom-themes', JSON.stringify(savedThemes));
    
    // Call onSave callback
    this.props.onSave({ id, theme });
    
    // Close customizer
    this.element.classList.remove('otedama-theme-customizer--open');
  }
  
  /**
   * Get element reference
   */
  get element() {
    return document.getElementById(this.id);
  }
  
  static styles = `
    .otedama-theme-customizer {
      position: relative;
    }
    
    .otedama-theme-customizer__trigger {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
      background: var(--surface-card);
      border: 2px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-theme-customizer__trigger:hover {
      background: var(--background-secondary);
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-theme-customizer__trigger-icon {
      font-size: 20px;
    }
    
    .otedama-theme-customizer__panel {
      position: fixed;
      top: 0;
      right: -400px;
      width: 400px;
      height: 100vh;
      background: var(--surface-card);
      border-left: 1px solid var(--border-primary);
      box-shadow: ${DesignTokens.shadows.xl};
      transition: right 0.3s ease;
      z-index: ${DesignTokens.zIndex.modal};
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    
    .otedama-theme-customizer--open .otedama-theme-customizer__panel {
      right: 0;
    }
    
    .otedama-theme-customizer__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${DesignTokens.spacing[4]};
      border-bottom: 1px solid var(--border-primary);
    }
    
    .otedama-theme-customizer__title {
      font-size: ${DesignTokens.typography.fontSize.lg};
      font-weight: ${DesignTokens.typography.fontWeight.semibold};
      margin: 0;
    }
    
    .otedama-theme-customizer__close {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s ease;
    }
    
    .otedama-theme-customizer__close:hover {
      color: var(--text-primary);
      background: var(--background-secondary);
    }
    
    .otedama-theme-customizer__content {
      flex: 1;
      overflow-y: auto;
      padding: ${DesignTokens.spacing[4]};
    }
    
    .otedama-theme-customizer__section {
      margin-bottom: ${DesignTokens.spacing[6]};
    }
    
    .otedama-theme-customizer__section-title {
      font-size: ${DesignTokens.typography.fontSize.base};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      color: var(--text-secondary);
      margin: 0 0 ${DesignTokens.spacing[3]} 0;
    }
    
    .otedama-theme-customizer__colors {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: ${DesignTokens.spacing[3]};
    }
    
    .otedama-theme-customizer__preview {
      border: 1px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      overflow: hidden;
    }
    
    .otedama-theme-customizer__preview-content {
      padding: ${DesignTokens.spacing[4]};
      min-height: 200px;
    }
    
    .otedama-theme-customizer__preview-card {
      padding: ${DesignTokens.spacing[3]};
      border-radius: ${DesignTokens.borderRadius.md};
    }
    
    .otedama-theme-customizer__preview-card h5 {
      margin: 0 0 ${DesignTokens.spacing[2]} 0;
      font-size: ${DesignTokens.typography.fontSize.base};
    }
    
    .otedama-theme-customizer__preview-card p {
      margin: 0 0 ${DesignTokens.spacing[3]} 0;
      opacity: 0.8;
    }
    
    .otedama-theme-customizer__actions {
      display: flex;
      gap: ${DesignTokens.spacing[2]};
      margin-top: ${DesignTokens.spacing[4]};
      padding-top: ${DesignTokens.spacing[4]};
      border-top: 1px solid var(--border-primary);
    }
    
    .otedama-theme-customizer__actions button {
      flex: 1;
    }
    
    @media (max-width: ${DesignTokens.breakpoints.sm}) {
      .otedama-theme-customizer__panel {
        width: 100%;
        right: -100%;
      }
    }
  `;
}

/**
 * Theme persistence utilities
 */
export const ThemePersistence = {
  /**
   * Load custom themes from storage
   */
  loadCustomThemes(manager) {
    const saved = localStorage.getItem('otedama-custom-themes');
    if (!saved) return;
    
    try {
      const themes = JSON.parse(saved);
      Object.entries(themes).forEach(([id, theme]) => {
        manager.addCustomTheme(id, theme);
      });
    } catch (error) {
      console.error('Failed to load custom themes:', error);
    }
  },
  
  /**
   * Export themes
   */
  exportThemes() {
    const themes = JSON.parse(localStorage.getItem('otedama-custom-themes') || '{}');
    const data = JSON.stringify(themes, null, 2);
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'otedama-themes.json';
    a.click();
    
    URL.revokeObjectURL(url);
  },
  
  /**
   * Import themes
   */
  async importThemes(file, manager) {
    try {
      const text = await file.text();
      const themes = JSON.parse(text);
      
      Object.entries(themes).forEach(([id, theme]) => {
        manager.addCustomTheme(id, theme);
      });
      
      // Save to storage
      const existing = JSON.parse(localStorage.getItem('otedama-custom-themes') || '{}');
      const merged = { ...existing, ...themes };
      localStorage.setItem('otedama-custom-themes', JSON.stringify(merged));
      
      return Object.keys(themes).length;
    } catch (error) {
      console.error('Failed to import themes:', error);
      throw error;
    }
  }
};

export default {
  ColorPicker,
  ThemeCustomizer,
  ThemePersistence
};