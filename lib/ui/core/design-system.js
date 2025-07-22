/**
 * Otedama Design System
 * Unified design language and component system
 */

export const DesignTokens = {
  // Color Palette
  colors: {
    // Primary colors
    primary: {
      50: '#e3f2fd',
      100: '#bbdefb',
      200: '#90caf9',
      300: '#64b5f6',
      400: '#42a5f5',
      500: '#2196f3', // Main
      600: '#1e88e5',
      700: '#1976d2',
      800: '#1565c0',
      900: '#0d47a1'
    },
    
    // Secondary colors
    secondary: {
      50: '#fce4ec',
      100: '#f8bbd0',
      200: '#f48fb1',
      300: '#f06292',
      400: '#ec407a',
      500: '#e91e63', // Main
      600: '#d81b60',
      700: '#c2185b',
      800: '#ad1457',
      900: '#880e4f'
    },
    
    // Neutral colors
    neutral: {
      0: '#ffffff',
      50: '#fafafa',
      100: '#f5f5f5',
      200: '#eeeeee',
      300: '#e0e0e0',
      400: '#bdbdbd',
      500: '#9e9e9e',
      600: '#757575',
      700: '#616161',
      800: '#424242',
      900: '#212121',
      1000: '#000000'
    },
    
    // Semantic colors
    semantic: {
      success: '#4caf50',
      warning: '#ff9800',
      error: '#f44336',
      info: '#2196f3'
    },
    
    // Chart colors
    chart: {
      series: [
        '#2196f3', '#4caf50', '#ff9800', '#f44336', '#9c27b0',
        '#00bcd4', '#ffeb3b', '#795548', '#607d8b', '#e91e63'
      ]
    }
  },
  
  // Typography
  typography: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace',
      display: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
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
      '5xl': '3rem',    // 48px
      '6xl': '3.75rem', // 60px
      '7xl': '4.5rem',  // 72px
      '8xl': '6rem',    // 96px
      '9xl': '8rem'     // 128px
    },
    
    fontWeight: {
      thin: 100,
      extralight: 200,
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
      black: 900
    },
    
    lineHeight: {
      none: 1,
      tight: 1.25,
      snug: 1.375,
      normal: 1.5,
      relaxed: 1.625,
      loose: 2
    }
  },
  
  // Spacing
  spacing: {
    0: '0px',
    1: '0.25rem',   // 4px
    2: '0.5rem',    // 8px
    3: '0.75rem',   // 12px
    4: '1rem',      // 16px
    5: '1.25rem',   // 20px
    6: '1.5rem',    // 24px
    7: '1.75rem',   // 28px
    8: '2rem',      // 32px
    9: '2.25rem',   // 36px
    10: '2.5rem',   // 40px
    12: '3rem',     // 48px
    14: '3.5rem',   // 56px
    16: '4rem',     // 64px
    20: '5rem',     // 80px
    24: '6rem',     // 96px
    28: '7rem',     // 112px
    32: '8rem',     // 128px
    36: '9rem',     // 144px
    40: '10rem',    // 160px
    44: '11rem',    // 176px
    48: '12rem',    // 192px
    52: '13rem',    // 208px
    56: '14rem',    // 224px
    60: '15rem',    // 240px
    64: '16rem',    // 256px
    72: '18rem',    // 288px
    80: '20rem',    // 320px
    96: '24rem'     // 384px
  },
  
  // Border radius
  borderRadius: {
    none: '0px',
    sm: '0.125rem',  // 2px
    base: '0.25rem', // 4px
    md: '0.375rem',  // 6px
    lg: '0.5rem',    // 8px
    xl: '0.75rem',   // 12px
    '2xl': '1rem',   // 16px
    '3xl': '1.5rem', // 24px
    full: '9999px'
  },
  
  // Shadows
  shadows: {
    xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    sm: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    base: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    md: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    lg: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
    xl: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
    '2xl': '0 35px 60px -15px rgba(0, 0, 0, 0.3)',
    inner: 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.06)',
    none: 'none'
  },
  
  // Transitions
  transitions: {
    duration: {
      75: '75ms',
      100: '100ms',
      150: '150ms',
      200: '200ms',
      300: '300ms',
      500: '500ms',
      700: '700ms',
      1000: '1000ms'
    },
    
    timing: {
      linear: 'linear',
      in: 'cubic-bezier(0.4, 0, 1, 1)',
      out: 'cubic-bezier(0, 0, 0.2, 1)',
      inOut: 'cubic-bezier(0.4, 0, 0.2, 1)'
    }
  },
  
  // Z-index
  zIndex: {
    0: 0,
    10: 10,
    20: 20,
    30: 30,
    40: 40,
    50: 50,
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modalBackdrop: 1040,
    modal: 1050,
    popover: 1060,
    tooltip: 1070
  },
  
  // Breakpoints
  breakpoints: {
    xs: '0px',
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px'
  },
  
  // Animation
  animation: {
    spin: 'spin 1s linear infinite',
    ping: 'ping 1s cubic-bezier(0, 0, 0.2, 1) infinite',
    pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
    bounce: 'bounce 1s infinite',
    fadeIn: 'fadeIn 0.3s ease-in-out',
    fadeOut: 'fadeOut 0.3s ease-in-out',
    slideInLeft: 'slideInLeft 0.3s ease-out',
    slideInRight: 'slideInRight 0.3s ease-out',
    slideInUp: 'slideInUp 0.3s ease-out',
    slideInDown: 'slideInDown 0.3s ease-out'
  }
};

/**
 * Theme creator
 */
export class Theme {
  constructor(mode = 'light', customTokens = {}) {
    this.mode = mode;
    this.tokens = { ...DesignTokens, ...customTokens };
    this.computed = this.computeTheme();
  }
  
  /**
   * Compute theme values based on mode
   */
  computeTheme() {
    const isDark = this.mode === 'dark';
    
    return {
      // Background colors
      background: {
        primary: isDark ? this.tokens.colors.neutral[900] : this.tokens.colors.neutral[0],
        secondary: isDark ? this.tokens.colors.neutral[800] : this.tokens.colors.neutral[50],
        tertiary: isDark ? this.tokens.colors.neutral[700] : this.tokens.colors.neutral[100],
        inverse: isDark ? this.tokens.colors.neutral[0] : this.tokens.colors.neutral[900]
      },
      
      // Text colors
      text: {
        primary: isDark ? this.tokens.colors.neutral[50] : this.tokens.colors.neutral[900],
        secondary: isDark ? this.tokens.colors.neutral[300] : this.tokens.colors.neutral[600],
        tertiary: isDark ? this.tokens.colors.neutral[400] : this.tokens.colors.neutral[500],
        inverse: isDark ? this.tokens.colors.neutral[900] : this.tokens.colors.neutral[50]
      },
      
      // Border colors
      border: {
        primary: isDark ? this.tokens.colors.neutral[700] : this.tokens.colors.neutral[200],
        secondary: isDark ? this.tokens.colors.neutral[600] : this.tokens.colors.neutral[300],
        focus: this.tokens.colors.primary[500]
      },
      
      // Surface colors
      surface: {
        card: isDark ? this.tokens.colors.neutral[800] : this.tokens.colors.neutral[0],
        overlay: isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(0, 0, 0, 0.5)'
      },
      
      // All tokens
      ...this.tokens
    };
  }
  
  /**
   * Get CSS variables
   */
  getCSSVariables() {
    const vars = {};
    
    // Flatten and convert to CSS variables
    const flatten = (obj, prefix = '') => {
      Object.entries(obj).forEach(([key, value]) => {
        const varName = prefix ? `${prefix}-${key}` : key;
        
        if (typeof value === 'object' && !Array.isArray(value)) {
          flatten(value, varName);
        } else {
          vars[`--${varName}`] = value;
        }
      });
    };
    
    flatten(this.computed);
    
    return vars;
  }
  
  /**
   * Switch theme mode
   */
  setMode(mode) {
    this.mode = mode;
    this.computed = this.computeTheme();
  }
}

/**
 * Component style utilities
 */
export const StyleUtils = {
  /**
   * Create responsive styles
   */
  responsive(styles) {
    const breakpoints = DesignTokens.breakpoints;
    let css = '';
    
    Object.entries(styles).forEach(([breakpoint, style]) => {
      if (breakpoint === 'base') {
        css += this.objectToCSS(style);
      } else if (breakpoints[breakpoint]) {
        css += `@media (min-width: ${breakpoints[breakpoint]}) {
          ${this.objectToCSS(style)}
        }`;
      }
    });
    
    return css;
  },
  
  /**
   * Convert object to CSS
   */
  objectToCSS(obj) {
    return Object.entries(obj)
      .map(([key, value]) => `${this.camelToKebab(key)}: ${value};`)
      .join('\n');
  },
  
  /**
   * Convert camelCase to kebab-case
   */
  camelToKebab(str) {
    return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();
  },
  
  /**
   * Create transition
   */
  transition(properties = ['all'], duration = '200ms', timing = 'ease-in-out') {
    return `transition: ${properties.join(', ')} ${duration} ${timing};`;
  },
  
  /**
   * Create focus styles
   */
  focusRing(color = DesignTokens.colors.primary[500]) {
    return `
      outline: none;
      box-shadow: 0 0 0 3px ${color}33;
      border-color: ${color};
    `;
  }
};

/**
 * Accessibility utilities
 */
export const A11yUtils = {
  /**
   * Screen reader only styles
   */
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
  
  /**
   * Focus visible styles
   */
  focusVisible: `
    &:focus {
      outline: none;
    }
    
    &:focus-visible {
      ${StyleUtils.focusRing()}
    }
  `,
  
  /**
   * High contrast mode support
   */
  highContrast(styles) {
    return `
      @media (prefers-contrast: high) {
        ${StyleUtils.objectToCSS(styles)}
      }
    `;
  },
  
  /**
   * Reduced motion support
   */
  reducedMotion(styles) {
    return `
      @media (prefers-reduced-motion: reduce) {
        ${StyleUtils.objectToCSS(styles)}
      }
    `;
  }
};

/**
 * Icon system
 */
export const IconSystem = {
  sizes: {
    xs: 12,
    sm: 16,
    md: 20,
    lg: 24,
    xl: 32,
    '2xl': 48,
    '3xl': 64
  },
  
  /**
   * Create icon component
   */
  createIcon(path, viewBox = '0 0 24 24') {
    return (size = 'md', color = 'currentColor', className = '') => `
      <svg 
        width="${this.sizes[size]}" 
        height="${this.sizes[size]}" 
        viewBox="${viewBox}"
        fill="${color}"
        class="${className}"
        aria-hidden="true"
      >
        ${path}
      </svg>
    `;
  }
};

/**
 * Motion presets
 */
export const MotionPresets = {
  // Fade animations
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 }
  },
  
  // Slide animations
  slideInLeft: {
    initial: { x: -20, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: -20, opacity: 0 }
  },
  
  slideInRight: {
    initial: { x: 20, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: 20, opacity: 0 }
  },
  
  slideInUp: {
    initial: { y: 20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: 20, opacity: 0 }
  },
  
  slideInDown: {
    initial: { y: -20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -20, opacity: 0 }
  },
  
  // Scale animations
  scaleIn: {
    initial: { scale: 0.9, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0.9, opacity: 0 }
  },
  
  // Spring animations
  springIn: {
    initial: { scale: 0, opacity: 0 },
    animate: { 
      scale: 1, 
      opacity: 1,
      transition: {
        type: 'spring',
        stiffness: 260,
        damping: 20
      }
    },
    exit: { scale: 0, opacity: 0 }
  }
};

// Export singleton instance
export const defaultTheme = new Theme('dark');

export default {
  DesignTokens,
  Theme,
  StyleUtils,
  A11yUtils,
  IconSystem,
  MotionPresets,
  defaultTheme
};