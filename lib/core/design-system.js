/**
 * Design System - Otedama
 * Consistent design tokens and utilities
 * 
 * Design principles:
 * - Consistency across all interfaces
 * - Accessibility first
 * - Performance optimized
 * - Mobile responsive
 */

export const DesignSystem = {
  // Color palette
  colors: {
    // Primary colors
    primary: {
      50: '#EFF6FF',
      100: '#DBEAFE',
      200: '#BFDBFE',
      300: '#93BBFD',
      400: '#60A5FA',
      500: '#3B82F6',
      600: '#2563EB',
      700: '#1D4ED8',
      800: '#1E40AF',
      900: '#1E3A8A'
    },
    
    // Neutral colors
    neutral: {
      50: '#F9FAFB',
      100: '#F3F4F6',
      200: '#E5E7EB',
      300: '#D1D5DB',
      400: '#9CA3AF',
      500: '#6B7280',
      600: '#4B5563',
      700: '#374151',
      800: '#1F2937',
      900: '#111827'
    },
    
    // Semantic colors
    success: {
      light: '#D1FAE5',
      default: '#10B981',
      dark: '#065F46'
    },
    
    warning: {
      light: '#FEF3C7',
      default: '#F59E0B',
      dark: '#92400E'
    },
    
    danger: {
      light: '#FEE2E2',
      default: '#EF4444',
      dark: '#991B1B'
    },
    
    info: {
      light: '#DBEAFE',
      default: '#3B82F6',
      dark: '#1E40AF'
    }
  },
  
  // Typography
  typography: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
    },
    
    fontSize: {
      xs: '0.75rem',    // 12px
      sm: '0.875rem',   // 14px
      base: '1rem',     // 16px
      lg: '1.125rem',   // 18px
      xl: '1.25rem',    // 20px
      '2xl': '1.5rem',  // 24px
      '3xl': '1.875rem', // 30px
      '4xl': '2.25rem', // 36px
      '5xl': '3rem'     // 48px
    },
    
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700
    },
    
    lineHeight: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75
    }
  },
  
  // Spacing
  spacing: {
    0: '0',
    1: '0.25rem',   // 4px
    2: '0.5rem',    // 8px
    3: '0.75rem',   // 12px
    4: '1rem',      // 16px
    5: '1.25rem',   // 20px
    6: '1.5rem',    // 24px
    8: '2rem',      // 32px
    10: '2.5rem',   // 40px
    12: '3rem',     // 48px
    16: '4rem',     // 64px
    20: '5rem',     // 80px
    24: '6rem'      // 96px
  },
  
  // Borders
  borders: {
    radius: {
      none: '0',
      sm: '0.125rem',  // 2px
      default: '0.25rem', // 4px
      md: '0.375rem',  // 6px
      lg: '0.5rem',    // 8px
      xl: '0.75rem',   // 12px
      '2xl': '1rem',   // 16px
      full: '9999px'
    },
    
    width: {
      none: '0',
      thin: '1px',
      default: '2px',
      thick: '4px'
    }
  },
  
  // Shadows
  shadows: {
    sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    default: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
    inner: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.06)',
    none: 'none'
  },
  
  // Breakpoints
  breakpoints: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px'
  },
  
  // Z-index
  zIndex: {
    0: 0,
    10: 10,
    20: 20,
    30: 30,
    40: 40,
    50: 50,
    modal: 1000,
    popover: 1050,
    tooltip: 1100
  },
  
  // Animations
  animations: {
    duration: {
      fast: '150ms',
      default: '300ms',
      slow: '500ms'
    },
    
    easing: {
      linear: 'linear',
      ease: 'ease',
      easeIn: 'ease-in',
      easeOut: 'ease-out',
      easeInOut: 'ease-in-out',
      bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)'
    }
  }
};

/**
 * CSS-in-JS utilities
 */
export const css = {
  // Generate CSS variables from design tokens
  generateCSSVariables(theme = 'light') {
    const isDark = theme === 'dark';
    
    return `
      :root {
        /* Colors */
        --color-primary: ${DesignSystem.colors.primary[500]};
        --color-primary-hover: ${DesignSystem.colors.primary[600]};
        --color-success: ${DesignSystem.colors.success.default};
        --color-warning: ${DesignSystem.colors.warning.default};
        --color-danger: ${DesignSystem.colors.danger.default};
        --color-info: ${DesignSystem.colors.info.default};
        
        /* Theme specific */
        --color-background: ${isDark ? DesignSystem.colors.neutral[900] : DesignSystem.colors.neutral[50]};
        --color-surface: ${isDark ? DesignSystem.colors.neutral[800] : '#FFFFFF'};
        --color-text-primary: ${isDark ? DesignSystem.colors.neutral[50] : DesignSystem.colors.neutral[900]};
        --color-text-secondary: ${isDark ? DesignSystem.colors.neutral[400] : DesignSystem.colors.neutral[600]};
        --color-border: ${isDark ? DesignSystem.colors.neutral[700] : DesignSystem.colors.neutral[200]};
        
        /* Typography */
        --font-sans: ${DesignSystem.typography.fontFamily.sans};
        --font-mono: ${DesignSystem.typography.fontFamily.mono};
        
        /* Shadows */
        --shadow-sm: ${DesignSystem.shadows.sm};
        --shadow-default: ${DesignSystem.shadows.default};
        --shadow-lg: ${DesignSystem.shadows.lg};
        
        /* Animations */
        --animation-duration: ${DesignSystem.animations.duration.default};
        --animation-easing: ${DesignSystem.animations.easing.easeInOut};
      }
    `;
  },
  
  // Media query helper
  media(breakpoint) {
    return `@media (min-width: ${DesignSystem.breakpoints[breakpoint]})`;
  },
  
  // Focus styles
  focusRing(color = DesignSystem.colors.primary[500]) {
    return `
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow: 0 0 0 2px ${color};
    `;
  }
};

/**
 * Component style generators
 */
export const components = {
  // Button styles
  button(variant = 'primary', size = 'md') {
    const baseStyles = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: ${DesignSystem.typography.fontWeight.medium};
      border-radius: ${DesignSystem.borders.radius.md};
      transition: all ${DesignSystem.animations.duration.default} ${DesignSystem.animations.easing.easeInOut};
      cursor: pointer;
      border: none;
      outline: none;
      text-decoration: none;
      
      &:focus-visible {
        ${css.focusRing()}
      }
      
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `;
    
    const sizeStyles = {
      sm: `
        padding: ${DesignSystem.spacing[2]} ${DesignSystem.spacing[3]};
        font-size: ${DesignSystem.typography.fontSize.sm};
      `,
      md: `
        padding: ${DesignSystem.spacing[2]} ${DesignSystem.spacing[4]};
        font-size: ${DesignSystem.typography.fontSize.base};
      `,
      lg: `
        padding: ${DesignSystem.spacing[3]} ${DesignSystem.spacing[6]};
        font-size: ${DesignSystem.typography.fontSize.lg};
      `
    };
    
    const variantStyles = {
      primary: `
        background-color: ${DesignSystem.colors.primary[500]};
        color: white;
        
        &:hover:not(:disabled) {
          background-color: ${DesignSystem.colors.primary[600]};
        }
      `,
      secondary: `
        background-color: ${DesignSystem.colors.neutral[100]};
        color: ${DesignSystem.colors.neutral[900]};
        
        &:hover:not(:disabled) {
          background-color: ${DesignSystem.colors.neutral[200]};
        }
      `,
      danger: `
        background-color: ${DesignSystem.colors.danger.default};
        color: white;
        
        &:hover:not(:disabled) {
          background-color: ${DesignSystem.colors.danger.dark};
        }
      `
    };
    
    return `
      ${baseStyles}
      ${sizeStyles[size]}
      ${variantStyles[variant]}
    `;
  },
  
  // Card styles
  card(elevated = true) {
    return `
      background-color: var(--color-surface);
      border-radius: ${DesignSystem.borders.radius.lg};
      padding: ${DesignSystem.spacing[6]};
      border: 1px solid var(--color-border);
      ${elevated ? `box-shadow: ${DesignSystem.shadows.default};` : ''}
      transition: box-shadow ${DesignSystem.animations.duration.default} ${DesignSystem.animations.easing.easeInOut};
      
      &:hover {
        ${elevated ? `box-shadow: ${DesignSystem.shadows.lg};` : ''}
      }
    `;
  },
  
  // Input styles
  input() {
    return `
      width: 100%;
      padding: ${DesignSystem.spacing[2]} ${DesignSystem.spacing[3]};
      font-size: ${DesignSystem.typography.fontSize.base};
      line-height: ${DesignSystem.typography.lineHeight.normal};
      color: var(--color-text-primary);
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: ${DesignSystem.borders.radius.md};
      transition: border-color ${DesignSystem.animations.duration.fast} ${DesignSystem.animations.easing.easeInOut};
      
      &:focus {
        ${css.focusRing()}
        border-color: ${DesignSystem.colors.primary[500]};
      }
      
      &::placeholder {
        color: var(--color-text-secondary);
      }
      
      &:disabled {
        background-color: ${DesignSystem.colors.neutral[100]};
        cursor: not-allowed;
      }
    `;
  }
};

/**
 * Accessibility utilities
 */
export const a11y = {
  // Screen reader only
  srOnly: `
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  `,
  
  // Focus visible only
  focusVisible: `
    &:focus {
      outline: none;
    }
    
    &:focus-visible {
      ${css.focusRing()}
    }
  `,
  
  // Reduced motion
  reducedMotion: `
    @media (prefers-reduced-motion: reduce) {
      animation: none;
      transition: none;
    }
  `
};

/**
 * Utility functions
 */
export const utils = {
  // Convert hex to rgba
  hexToRgba(hex, alpha = 1) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
      : null;
  },
  
  // Generate color shades
  generateShades(baseColor) {
    // This would generate a full color palette from a base color
    // For now, return the base color
    return {
      50: baseColor,
      100: baseColor,
      200: baseColor,
      300: baseColor,
      400: baseColor,
      500: baseColor,
      600: baseColor,
      700: baseColor,
      800: baseColor,
      900: baseColor
    };
  },
  
  // Responsive value helper
  responsive(values) {
    const { sm, md, lg, xl } = values;
    let css = '';
    
    if (sm) css += `${values.base || sm}`;
    if (md) css += ` ${this.media('md')} { ${md} }`;
    if (lg) css += ` ${this.media('lg')} { ${lg} }`;
    if (xl) css += ` ${this.media('xl')} { ${xl} }`;
    
    return css;
  }
};

export default DesignSystem;