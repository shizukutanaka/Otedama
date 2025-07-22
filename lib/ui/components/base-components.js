/**
 * Base UI Components Library
 * Reusable, accessible, and customizable components
 */

import { DesignTokens, StyleUtils, A11yUtils } from '../core/design-system.js';

/**
 * Base Component class
 */
export class BaseComponent {
  constructor(props = {}) {
    this.props = props;
    this.state = {};
    this.listeners = new Map();
    this.id = props.id || this.generateId();
  }
  
  /**
   * Generate unique ID
   */
  generateId() {
    return `otedama-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Set state and trigger update
   */
  setState(newState) {
    const prevState = { ...this.state };
    this.state = { ...this.state, ...newState };
    this.onStateChange(prevState, this.state);
  }
  
  /**
   * State change handler
   */
  onStateChange(prevState, newState) {
    // Override in subclasses
  }
  
  /**
   * Add event listener
   */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
  }
  
  /**
   * Emit event
   */
  emit(event, data) {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach(handler => handler(data));
  }
  
  /**
   * Render component
   */
  render() {
    throw new Error('render() must be implemented by subclass');
  }
}

/**
 * Button Component
 */
export class Button extends BaseComponent {
  constructor(props) {
    super({
      variant: 'primary',
      size: 'md',
      disabled: false,
      loading: false,
      fullWidth: false,
      icon: null,
      iconPosition: 'left',
      ...props
    });
  }
  
  render() {
    const { 
      variant, size, disabled, loading, fullWidth, 
      icon, iconPosition, children, className = '', 
      onClick, ...rest 
    } = this.props;
    
    const baseClasses = `
      otedama-button
      otedama-button--${variant}
      otedama-button--${size}
      ${fullWidth ? 'otedama-button--full-width' : ''}
      ${disabled ? 'otedama-button--disabled' : ''}
      ${loading ? 'otedama-button--loading' : ''}
      ${className}
    `.trim();
    
    const iconElement = icon ? `<span class="otedama-button__icon otedama-button__icon--${iconPosition}">${icon}</span>` : '';
    const loadingElement = loading ? '<span class="otedama-button__spinner"></span>' : '';
    
    return `
      <button 
        id="${this.id}"
        class="${baseClasses}"
        ${disabled ? 'disabled' : ''}
        ${onClick ? `onclick="${onClick}"` : ''}
        ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
      >
        ${loading ? loadingElement : ''}
        ${iconPosition === 'left' ? iconElement : ''}
        <span class="otedama-button__content">${children || ''}</span>
        ${iconPosition === 'right' ? iconElement : ''}
      </button>
    `;
  }
  
  static styles = `
    .otedama-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: ${DesignTokens.typography.fontFamily.sans};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      border-radius: ${DesignTokens.borderRadius.md};
      cursor: pointer;
      transition: all ${DesignTokens.transitions.duration[200]} ${DesignTokens.transitions.timing.inOut};
      position: relative;
      overflow: hidden;
      border: 2px solid transparent;
      ${A11yUtils.focusVisible}
    }
    
    /* Sizes */
    .otedama-button--xs {
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[2]};
      font-size: ${DesignTokens.typography.fontSize.xs};
      height: 24px;
    }
    
    .otedama-button--sm {
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[3]};
      font-size: ${DesignTokens.typography.fontSize.sm};
      height: 32px;
    }
    
    .otedama-button--md {
      padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[4]};
      font-size: ${DesignTokens.typography.fontSize.base};
      height: 40px;
    }
    
    .otedama-button--lg {
      padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[6]};
      font-size: ${DesignTokens.typography.fontSize.lg};
      height: 48px;
    }
    
    /* Variants */
    .otedama-button--primary {
      background-color: ${DesignTokens.colors.primary[500]};
      color: white;
    }
    
    .otedama-button--primary:hover:not(:disabled) {
      background-color: ${DesignTokens.colors.primary[600]};
    }
    
    .otedama-button--secondary {
      background-color: transparent;
      color: ${DesignTokens.colors.primary[500]};
      border-color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-button--secondary:hover:not(:disabled) {
      background-color: ${DesignTokens.colors.primary[50]};
    }
    
    .otedama-button--ghost {
      background-color: transparent;
      color: inherit;
    }
    
    .otedama-button--ghost:hover:not(:disabled) {
      background-color: ${DesignTokens.colors.neutral[100]};
    }
    
    /* States */
    .otedama-button--disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .otedama-button--loading {
      color: transparent;
    }
    
    .otedama-button--full-width {
      width: 100%;
    }
    
    /* Icon */
    .otedama-button__icon {
      display: inline-flex;
      align-items: center;
    }
    
    .otedama-button__icon--left {
      margin-right: ${DesignTokens.spacing[2]};
    }
    
    .otedama-button__icon--right {
      margin-left: ${DesignTokens.spacing[2]};
    }
    
    /* Spinner */
    .otedama-button__spinner {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 16px;
      height: 16px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: ${DesignTokens.animation.spin};
    }
    
    @keyframes spin {
      to { transform: translate(-50%, -50%) rotate(360deg); }
    }
  `;
}

/**
 * Card Component
 */
export class Card extends BaseComponent {
  constructor(props) {
    super({
      variant: 'elevated',
      padding: 'md',
      ...props
    });
  }
  
  render() {
    const { variant, padding, className = '', children, ...rest } = this.props;
    
    const baseClasses = `
      otedama-card
      otedama-card--${variant}
      otedama-card--padding-${padding}
      ${className}
    `.trim();
    
    return `
      <div 
        id="${this.id}"
        class="${baseClasses}"
        ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
      >
        ${children || ''}
      </div>
    `;
  }
  
  static styles = `
    .otedama-card {
      background-color: var(--surface-card);
      border-radius: ${DesignTokens.borderRadius.lg};
      transition: all ${DesignTokens.transitions.duration[200]} ${DesignTokens.transitions.timing.inOut};
    }
    
    /* Variants */
    .otedama-card--elevated {
      box-shadow: ${DesignTokens.shadows.md};
    }
    
    .otedama-card--outlined {
      border: 1px solid var(--border-primary);
      box-shadow: none;
    }
    
    .otedama-card--filled {
      background-color: var(--background-secondary);
      box-shadow: none;
    }
    
    /* Padding */
    .otedama-card--padding-none { padding: 0; }
    .otedama-card--padding-sm { padding: ${DesignTokens.spacing[3]}; }
    .otedama-card--padding-md { padding: ${DesignTokens.spacing[4]}; }
    .otedama-card--padding-lg { padding: ${DesignTokens.spacing[6]}; }
    .otedama-card--padding-xl { padding: ${DesignTokens.spacing[8]}; }
  `;
}

/**
 * Input Component
 */
export class Input extends BaseComponent {
  constructor(props) {
    super({
      type: 'text',
      size: 'md',
      variant: 'outlined',
      disabled: false,
      error: false,
      fullWidth: false,
      ...props
    });
    
    this.state = {
      focused: false,
      value: props.value || ''
    };
  }
  
  render() {
    const { 
      type, size, variant, disabled, error, fullWidth,
      label, placeholder, helperText, errorText,
      prefix, suffix, className = '', ...rest 
    } = this.props;
    
    const { focused, value } = this.state;
    
    const wrapperClasses = `
      otedama-input-wrapper
      otedama-input-wrapper--${size}
      otedama-input-wrapper--${variant}
      ${fullWidth ? 'otedama-input-wrapper--full-width' : ''}
      ${disabled ? 'otedama-input-wrapper--disabled' : ''}
      ${error ? 'otedama-input-wrapper--error' : ''}
      ${focused ? 'otedama-input-wrapper--focused' : ''}
      ${value ? 'otedama-input-wrapper--filled' : ''}
      ${className}
    `.trim();
    
    return `
      <div class="${wrapperClasses}">
        ${label ? `
          <label for="${this.id}" class="otedama-input__label">
            ${label}
          </label>
        ` : ''}
        
        <div class="otedama-input__container">
          ${prefix ? `<span class="otedama-input__prefix">${prefix}</span>` : ''}
          
          <input
            id="${this.id}"
            type="${type}"
            class="otedama-input"
            placeholder="${placeholder || ''}"
            value="${value}"
            ${disabled ? 'disabled' : ''}
            onfocus="this.parentElement.parentElement.classList.add('otedama-input-wrapper--focused')"
            onblur="this.parentElement.parentElement.classList.remove('otedama-input-wrapper--focused')"
            oninput="this.parentElement.parentElement.classList.toggle('otedama-input-wrapper--filled', this.value.length > 0)"
            ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
          />
          
          ${suffix ? `<span class="otedama-input__suffix">${suffix}</span>` : ''}
        </div>
        
        ${helperText || errorText ? `
          <div class="otedama-input__helper-text">
            ${error && errorText ? errorText : helperText}
          </div>
        ` : ''}
      </div>
    `;
  }
  
  static styles = `
    .otedama-input-wrapper {
      display: inline-flex;
      flex-direction: column;
      position: relative;
    }
    
    .otedama-input-wrapper--full-width {
      width: 100%;
    }
    
    .otedama-input__label {
      font-size: ${DesignTokens.typography.fontSize.sm};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      color: var(--text-secondary);
      margin-bottom: ${DesignTokens.spacing[1]};
      transition: color ${DesignTokens.transitions.duration[200]} ${DesignTokens.transitions.timing.inOut};
    }
    
    .otedama-input__container {
      display: flex;
      align-items: center;
      position: relative;
      background-color: var(--background-secondary);
      border: 2px solid var(--border-primary);
      border-radius: ${DesignTokens.borderRadius.md};
      transition: all ${DesignTokens.transitions.duration[200]} ${DesignTokens.transitions.timing.inOut};
    }
    
    .otedama-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      font-family: ${DesignTokens.typography.fontFamily.sans};
      color: var(--text-primary);
      width: 100%;
    }
    
    /* Sizes */
    .otedama-input-wrapper--sm .otedama-input__container {
      height: 32px;
      padding: 0 ${DesignTokens.spacing[2]};
    }
    
    .otedama-input-wrapper--sm .otedama-input {
      font-size: ${DesignTokens.typography.fontSize.sm};
    }
    
    .otedama-input-wrapper--md .otedama-input__container {
      height: 40px;
      padding: 0 ${DesignTokens.spacing[3]};
    }
    
    .otedama-input-wrapper--md .otedama-input {
      font-size: ${DesignTokens.typography.fontSize.base};
    }
    
    .otedama-input-wrapper--lg .otedama-input__container {
      height: 48px;
      padding: 0 ${DesignTokens.spacing[4]};
    }
    
    .otedama-input-wrapper--lg .otedama-input {
      font-size: ${DesignTokens.typography.fontSize.lg};
    }
    
    /* States */
    .otedama-input-wrapper--focused .otedama-input__container {
      border-color: ${DesignTokens.colors.primary[500]};
      box-shadow: 0 0 0 3px ${DesignTokens.colors.primary[500]}33;
    }
    
    .otedama-input-wrapper--focused .otedama-input__label {
      color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-input-wrapper--error .otedama-input__container {
      border-color: ${DesignTokens.colors.semantic.error};
    }
    
    .otedama-input-wrapper--error .otedama-input__label {
      color: ${DesignTokens.colors.semantic.error};
    }
    
    .otedama-input-wrapper--disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .otedama-input-wrapper--disabled .otedama-input {
      cursor: not-allowed;
    }
    
    /* Prefix & Suffix */
    .otedama-input__prefix,
    .otedama-input__suffix {
      color: var(--text-tertiary);
      flex-shrink: 0;
    }
    
    .otedama-input__prefix {
      margin-right: ${DesignTokens.spacing[2]};
    }
    
    .otedama-input__suffix {
      margin-left: ${DesignTokens.spacing[2]};
    }
    
    /* Helper text */
    .otedama-input__helper-text {
      font-size: ${DesignTokens.typography.fontSize.xs};
      margin-top: ${DesignTokens.spacing[1]};
      color: var(--text-tertiary);
    }
    
    .otedama-input-wrapper--error .otedama-input__helper-text {
      color: ${DesignTokens.colors.semantic.error};
    }
  `;
}

/**
 * Badge Component
 */
export class Badge extends BaseComponent {
  constructor(props) {
    super({
      variant: 'primary',
      size: 'md',
      dot: false,
      ...props
    });
  }
  
  render() {
    const { variant, size, dot, children, className = '', ...rest } = this.props;
    
    const baseClasses = `
      otedama-badge
      otedama-badge--${variant}
      otedama-badge--${size}
      ${dot ? 'otedama-badge--dot' : ''}
      ${className}
    `.trim();
    
    return `
      <span 
        id="${this.id}"
        class="${baseClasses}"
        ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
      >
        ${dot ? '' : children || ''}
      </span>
    `;
  }
  
  static styles = `
    .otedama-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: ${DesignTokens.typography.fontWeight.semibold};
      border-radius: ${DesignTokens.borderRadius.full};
      line-height: 1;
    }
    
    /* Sizes */
    .otedama-badge--sm {
      font-size: ${DesignTokens.typography.fontSize.xs};
      padding: ${DesignTokens.spacing[0.5]} ${DesignTokens.spacing[2]};
      min-height: 18px;
    }
    
    .otedama-badge--md {
      font-size: ${DesignTokens.typography.fontSize.sm};
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[2]};
      min-height: 22px;
    }
    
    .otedama-badge--lg {
      font-size: ${DesignTokens.typography.fontSize.base};
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[3]};
      min-height: 28px;
    }
    
    /* Dot variant */
    .otedama-badge--dot {
      padding: 0;
      min-height: 0;
    }
    
    .otedama-badge--dot.otedama-badge--sm {
      width: 6px;
      height: 6px;
    }
    
    .otedama-badge--dot.otedama-badge--md {
      width: 8px;
      height: 8px;
    }
    
    .otedama-badge--dot.otedama-badge--lg {
      width: 10px;
      height: 10px;
    }
    
    /* Variants */
    .otedama-badge--primary {
      background-color: ${DesignTokens.colors.primary[500]};
      color: white;
    }
    
    .otedama-badge--secondary {
      background-color: ${DesignTokens.colors.secondary[500]};
      color: white;
    }
    
    .otedama-badge--success {
      background-color: ${DesignTokens.colors.semantic.success};
      color: white;
    }
    
    .otedama-badge--warning {
      background-color: ${DesignTokens.colors.semantic.warning};
      color: white;
    }
    
    .otedama-badge--error {
      background-color: ${DesignTokens.colors.semantic.error};
      color: white;
    }
    
    .otedama-badge--info {
      background-color: ${DesignTokens.colors.semantic.info};
      color: white;
    }
    
    .otedama-badge--neutral {
      background-color: var(--background-tertiary);
      color: var(--text-primary);
    }
  `;
}

/**
 * Progress Component
 */
export class Progress extends BaseComponent {
  constructor(props) {
    super({
      value: 0,
      max: 100,
      size: 'md',
      variant: 'primary',
      showValue: false,
      indeterminate: false,
      ...props
    });
  }
  
  render() {
    const { 
      value, max, size, variant, showValue, indeterminate,
      label, className = '', ...rest 
    } = this.props;
    
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    
    const baseClasses = `
      otedama-progress
      otedama-progress--${size}
      otedama-progress--${variant}
      ${indeterminate ? 'otedama-progress--indeterminate' : ''}
      ${className}
    `.trim();
    
    return `
      <div 
        id="${this.id}"
        class="${baseClasses}"
        role="progressbar"
        aria-valuenow="${value}"
        aria-valuemin="0"
        aria-valuemax="${max}"
        ${label ? `aria-label="${label}"` : ''}
        ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
      >
        <div class="otedama-progress__track">
          <div 
            class="otedama-progress__bar" 
            style="width: ${indeterminate ? '40%' : `${percentage}%`}"
          ></div>
        </div>
        ${showValue && !indeterminate ? `
          <span class="otedama-progress__value">${Math.round(percentage)}%</span>
        ` : ''}
      </div>
    `;
  }
  
  static styles = `
    .otedama-progress {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
    }
    
    .otedama-progress__track {
      flex: 1;
      background-color: var(--background-tertiary);
      border-radius: ${DesignTokens.borderRadius.full};
      overflow: hidden;
      position: relative;
    }
    
    .otedama-progress__bar {
      height: 100%;
      background-color: currentColor;
      transition: width ${DesignTokens.transitions.duration[300]} ${DesignTokens.transitions.timing.inOut};
      border-radius: ${DesignTokens.borderRadius.full};
    }
    
    /* Sizes */
    .otedama-progress--sm .otedama-progress__track {
      height: 4px;
    }
    
    .otedama-progress--md .otedama-progress__track {
      height: 8px;
    }
    
    .otedama-progress--lg .otedama-progress__track {
      height: 12px;
    }
    
    /* Variants */
    .otedama-progress--primary {
      color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-progress--secondary {
      color: ${DesignTokens.colors.secondary[500]};
    }
    
    .otedama-progress--success {
      color: ${DesignTokens.colors.semantic.success};
    }
    
    .otedama-progress--warning {
      color: ${DesignTokens.colors.semantic.warning};
    }
    
    .otedama-progress--error {
      color: ${DesignTokens.colors.semantic.error};
    }
    
    /* Indeterminate animation */
    .otedama-progress--indeterminate .otedama-progress__bar {
      animation: indeterminate 1.5s linear infinite;
    }
    
    @keyframes indeterminate {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(250%);
      }
    }
    
    /* Value text */
    .otedama-progress__value {
      font-size: ${DesignTokens.typography.fontSize.sm};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      color: var(--text-secondary);
      flex-shrink: 0;
    }
  `;
}

/**
 * Skeleton Component
 */
export class Skeleton extends BaseComponent {
  constructor(props) {
    super({
      variant: 'text',
      width: '100%',
      height: 'auto',
      animation: 'pulse',
      ...props
    });
  }
  
  render() {
    const { variant, width, height, animation, className = '', ...rest } = this.props;
    
    const baseClasses = `
      otedama-skeleton
      otedama-skeleton--${variant}
      otedama-skeleton--${animation}
      ${className}
    `.trim();
    
    const style = `
      ${width ? `width: ${width};` : ''}
      ${height !== 'auto' ? `height: ${height};` : ''}
    `;
    
    return `
      <div 
        id="${this.id}"
        class="${baseClasses}"
        style="${style}"
        aria-busy="true"
        aria-live="polite"
        ${Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(' ')}
      ></div>
    `;
  }
  
  static styles = `
    .otedama-skeleton {
      background-color: var(--background-tertiary);
      position: relative;
      overflow: hidden;
    }
    
    /* Variants */
    .otedama-skeleton--text {
      height: 1em;
      border-radius: ${DesignTokens.borderRadius.sm};
      margin: ${DesignTokens.spacing[1]} 0;
    }
    
    .otedama-skeleton--circular {
      border-radius: ${DesignTokens.borderRadius.full};
      width: 40px;
      height: 40px;
    }
    
    .otedama-skeleton--rectangular {
      border-radius: ${DesignTokens.borderRadius.md};
    }
    
    /* Animations */
    .otedama-skeleton--pulse {
      animation: skeleton-pulse 2s ease-in-out infinite;
    }
    
    .otedama-skeleton--wave::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.1),
        transparent
      );
      animation: skeleton-wave 1.6s linear infinite;
    }
    
    @keyframes skeleton-pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
    
    @keyframes skeleton-wave {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(100%);
      }
    }
  `;
}

/**
 * Export all component styles
 */
export const getAllComponentStyles = () => {
  const components = [Button, Card, Input, Badge, Progress, Skeleton];
  
  return components
    .map(Component => Component.styles)
    .join('\n\n');
};

export default {
  BaseComponent,
  Button,
  Card,
  Input,
  Badge,
  Progress,
  Skeleton,
  getAllComponentStyles
};