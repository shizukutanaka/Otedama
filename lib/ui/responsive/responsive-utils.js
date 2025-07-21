/**
 * Responsive Design Utilities
 * Mobile-first responsive helpers and utilities
 */

import { DesignTokens } from '../core/design-system.js';

/**
 * Responsive breakpoint system
 */
export const ResponsiveBreakpoints = {
  xs: 0,      // Extra small devices (phones)
  sm: 640,    // Small devices (large phones)
  md: 768,    // Medium devices (tablets)
  lg: 1024,   // Large devices (desktops)
  xl: 1280,   // Extra large devices (large desktops)
  '2xl': 1536 // 2X large devices (larger desktops)
};

/**
 * Media query generator
 */
export class MediaQuery {
  static min(breakpoint) {
    const value = ResponsiveBreakpoints[breakpoint] || breakpoint;
    return `@media (min-width: ${value}px)`;
  }
  
  static max(breakpoint) {
    const value = ResponsiveBreakpoints[breakpoint] || breakpoint;
    return `@media (max-width: ${value - 1}px)`;
  }
  
  static between(min, max) {
    const minValue = ResponsiveBreakpoints[min] || min;
    const maxValue = ResponsiveBreakpoints[max] || max;
    return `@media (min-width: ${minValue}px) and (max-width: ${maxValue - 1}px)`;
  }
  
  static portrait() {
    return '@media (orientation: portrait)';
  }
  
  static landscape() {
    return '@media (orientation: landscape)';
  }
  
  static retina() {
    return '@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi)';
  }
  
  static hover() {
    return '@media (hover: hover)';
  }
  
  static touch() {
    return '@media (hover: none) and (pointer: coarse)';
  }
  
  static prefersReducedMotion() {
    return '@media (prefers-reduced-motion: reduce)';
  }
  
  static prefersDark() {
    return '@media (prefers-color-scheme: dark)';
  }
  
  static prefersLight() {
    return '@media (prefers-color-scheme: light)';
  }
}

/**
 * Viewport utilities
 */
export class ViewportUtils {
  static getViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
    };
  }
  
  static getCurrentBreakpoint() {
    const width = window.innerWidth;
    const breakpoints = Object.entries(ResponsiveBreakpoints).sort((a, b) => b[1] - a[1]);
    
    for (const [name, value] of breakpoints) {
      if (width >= value) {
        return name;
      }
    }
    
    return 'xs';
  }
  
  static isBreakpoint(breakpoint) {
    const width = window.innerWidth;
    const value = ResponsiveBreakpoints[breakpoint];
    
    if (!value) return false;
    
    const nextBreakpoint = Object.values(ResponsiveBreakpoints)
      .sort((a, b) => a - b)
      .find(bp => bp > value);
    
    return width >= value && (!nextBreakpoint || width < nextBreakpoint);
  }
  
  static isAbove(breakpoint) {
    const width = window.innerWidth;
    const value = ResponsiveBreakpoints[breakpoint];
    return width >= value;
  }
  
  static isBelow(breakpoint) {
    const width = window.innerWidth;
    const value = ResponsiveBreakpoints[breakpoint];
    return width < value;
  }
  
  static isMobile() {
    return this.isBelow('md');
  }
  
  static isTablet() {
    return this.isBreakpoint('md') || this.isBreakpoint('lg');
  }
  
  static isDesktop() {
    return this.isAbove('lg');
  }
  
  static isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }
  
  static isRetina() {
    return window.devicePixelRatio > 1;
  }
}

/**
 * Responsive grid system
 */
export class ResponsiveGrid {
  static generate() {
    const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    const columns = 12;
    let styles = '';
    
    // Base grid styles
    styles += `
      .otedama-grid {
        display: grid;
        gap: ${DesignTokens.spacing[4]};
      }
      
      .otedama-grid--no-gap {
        gap: 0;
      }
      
      .otedama-grid--gap-sm {
        gap: ${DesignTokens.spacing[2]};
      }
      
      .otedama-grid--gap-lg {
        gap: ${DesignTokens.spacing[6]};
      }
      
      /* Base column classes */
      @for $i from 1 through ${columns} {
        .otedama-col-#{$i} {
          grid-column: span #{$i};
        }
      }
      
      .otedama-col-auto {
        grid-column: auto;
      }
      
      .otedama-col-full {
        grid-column: 1 / -1;
      }
    `;
    
    // Generate responsive column classes
    breakpoints.forEach(bp => {
      if (bp !== 'xs') {
        styles += `\n${MediaQuery.min(bp)} {\n`;
      }
      
      for (let i = 1; i <= columns; i++) {
        styles += `  .otedama-${bp}-col-${i} { grid-column: span ${i}; }\n`;
      }
      
      styles += `  .otedama-${bp}-col-auto { grid-column: auto; }\n`;
      styles += `  .otedama-${bp}-col-full { grid-column: 1 / -1; }\n`;
      
      if (bp !== 'xs') {
        styles += '}\n';
      }
    });
    
    return styles;
  }
}

/**
 * Responsive spacing utilities
 */
export class ResponsiveSpacing {
  static generate() {
    const properties = ['margin', 'padding'];
    const sides = ['top', 'right', 'bottom', 'left'];
    const values = Object.entries(DesignTokens.spacing);
    const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    
    let styles = '';
    
    // Generate spacing utilities
    properties.forEach(property => {
      const prefix = property === 'margin' ? 'm' : 'p';
      
      // All sides
      values.forEach(([key, value]) => {
        styles += `.otedama-${prefix}-${key} { ${property}: ${value}; }\n`;
      });
      
      // Individual sides
      sides.forEach(side => {
        const sidePrefix = side.charAt(0);
        values.forEach(([key, value]) => {
          styles += `.otedama-${prefix}${sidePrefix}-${key} { ${property}-${side}: ${value}; }\n`;
        });
      });
      
      // Horizontal and vertical
      values.forEach(([key, value]) => {
        styles += `.otedama-${prefix}x-${key} { ${property}-left: ${value}; ${property}-right: ${value}; }\n`;
        styles += `.otedama-${prefix}y-${key} { ${property}-top: ${value}; ${property}-bottom: ${value}; }\n`;
      });
    });
    
    // Generate responsive spacing utilities
    breakpoints.forEach(bp => {
      if (bp === 'xs') return;
      
      styles += `\n${MediaQuery.min(bp)} {\n`;
      
      properties.forEach(property => {
        const prefix = property === 'margin' ? 'm' : 'p';
        
        values.forEach(([key, value]) => {
          styles += `  .otedama-${bp}-${prefix}-${key} { ${property}: ${value}; }\n`;
        });
      });
      
      styles += '}\n';
    });
    
    return styles;
  }
}

/**
 * Responsive visibility utilities
 */
export class ResponsiveVisibility {
  static generate() {
    const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    let styles = '';
    
    // Hidden utilities
    styles += '.otedama-hidden { display: none !important; }\n';
    
    breakpoints.forEach(bp => {
      if (bp === 'xs') {
        styles += `.otedama-hidden-${bp} { display: none !important; }\n`;
      } else {
        styles += `${MediaQuery.min(bp)} { .otedama-hidden-${bp} { display: none !important; } }\n`;
      }
    });
    
    // Visible utilities
    styles += '.otedama-visible { display: block !important; }\n';
    
    breakpoints.forEach(bp => {
      if (bp === 'xs') {
        styles += `.otedama-visible-${bp} { display: block !important; }\n`;
      } else {
        styles += `${MediaQuery.min(bp)} { .otedama-visible-${bp} { display: block !important; } }\n`;
      }
    });
    
    // Screen reader only
    styles += `
      .otedama-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }
      
      .otedama-not-sr-only {
        position: static;
        width: auto;
        height: auto;
        padding: 0;
        margin: 0;
        overflow: visible;
        clip: auto;
        white-space: normal;
      }
    `;
    
    return styles;
  }
}

/**
 * Responsive typography utilities
 */
export class ResponsiveTypography {
  static generate() {
    const sizes = Object.entries(DesignTokens.typography.fontSize);
    const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
    let styles = '';
    
    // Base text sizes
    sizes.forEach(([key, value]) => {
      styles += `.otedama-text-${key} { font-size: ${value}; }\n`;
    });
    
    // Responsive text sizes
    breakpoints.forEach(bp => {
      if (bp === 'xs') return;
      
      styles += `\n${MediaQuery.min(bp)} {\n`;
      
      sizes.forEach(([key, value]) => {
        styles += `  .otedama-${bp}-text-${key} { font-size: ${value}; }\n`;
      });
      
      styles += '}\n';
    });
    
    // Text alignment
    const alignments = ['left', 'center', 'right', 'justify'];
    
    alignments.forEach(align => {
      styles += `.otedama-text-${align} { text-align: ${align}; }\n`;
    });
    
    // Responsive text alignment
    breakpoints.forEach(bp => {
      if (bp === 'xs') return;
      
      styles += `\n${MediaQuery.min(bp)} {\n`;
      
      alignments.forEach(align => {
        styles += `  .otedama-${bp}-text-${align} { text-align: ${align}; }\n`;
      });
      
      styles += '}\n';
    });
    
    return styles;
  }
}

/**
 * Container system
 */
export class ResponsiveContainer {
  static generate() {
    return `
      .otedama-container {
        width: 100%;
        margin-left: auto;
        margin-right: auto;
        padding-left: ${DesignTokens.spacing[4]};
        padding-right: ${DesignTokens.spacing[4]};
      }
      
      ${MediaQuery.min('sm')} {
        .otedama-container {
          max-width: ${ResponsiveBreakpoints.sm}px;
        }
      }
      
      ${MediaQuery.min('md')} {
        .otedama-container {
          max-width: ${ResponsiveBreakpoints.md}px;
          padding-left: ${DesignTokens.spacing[6]};
          padding-right: ${DesignTokens.spacing[6]};
        }
      }
      
      ${MediaQuery.min('lg')} {
        .otedama-container {
          max-width: ${ResponsiveBreakpoints.lg}px;
        }
      }
      
      ${MediaQuery.min('xl')} {
        .otedama-container {
          max-width: ${ResponsiveBreakpoints.xl}px;
          padding-left: ${DesignTokens.spacing[8]};
          padding-right: ${DesignTokens.spacing[8]};
        }
      }
      
      ${MediaQuery.min('2xl')} {
        .otedama-container {
          max-width: ${ResponsiveBreakpoints['2xl']}px;
        }
      }
      
      .otedama-container--fluid {
        max-width: 100%;
      }
    `;
  }
}

/**
 * Touch-friendly utilities
 */
export const TouchUtilities = `
  /* Increase touch targets on mobile */
  ${MediaQuery.touch()} {
    button,
    a,
    input,
    select,
    textarea,
    [role="button"],
    [role="link"],
    [tabindex]:not([tabindex="-1"]) {
      min-height: 44px;
      min-width: 44px;
    }
    
    /* Disable hover effects on touch devices */
    *:hover {
      transition: none !important;
    }
  }
  
  /* Smooth scrolling on iOS */
  .otedama-scroll-touch {
    -webkit-overflow-scrolling: touch;
  }
  
  /* Prevent text selection on UI elements */
  .otedama-no-select {
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  
  /* Tap highlight color */
  .otedama-no-tap-highlight {
    -webkit-tap-highlight-color: transparent;
  }
  
  /* Safe area padding */
  .otedama-safe-top {
    padding-top: env(safe-area-inset-top);
  }
  
  .otedama-safe-right {
    padding-right: env(safe-area-inset-right);
  }
  
  .otedama-safe-bottom {
    padding-bottom: env(safe-area-inset-bottom);
  }
  
  .otedama-safe-left {
    padding-left: env(safe-area-inset-left);
  }
  
  .otedama-safe-x {
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
  
  .otedama-safe-y {
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
`;

/**
 * Generate all responsive utilities
 */
export function generateResponsiveStyles() {
  return `
    /* Responsive Grid System */
    ${ResponsiveGrid.generate()}
    
    /* Responsive Spacing Utilities */
    ${ResponsiveSpacing.generate()}
    
    /* Responsive Visibility Utilities */
    ${ResponsiveVisibility.generate()}
    
    /* Responsive Typography Utilities */
    ${ResponsiveTypography.generate()}
    
    /* Container System */
    ${ResponsiveContainer.generate()}
    
    /* Touch-friendly Utilities */
    ${TouchUtilities}
    
    /* Responsive Display Utilities */
    .otedama-block { display: block; }
    .otedama-inline-block { display: inline-block; }
    .otedama-inline { display: inline; }
    .otedama-flex { display: flex; }
    .otedama-inline-flex { display: inline-flex; }
    .otedama-grid { display: grid; }
    .otedama-inline-grid { display: inline-grid; }
    .otedama-none { display: none; }
    
    /* Flexbox Utilities */
    .otedama-flex-row { flex-direction: row; }
    .otedama-flex-col { flex-direction: column; }
    .otedama-flex-wrap { flex-wrap: wrap; }
    .otedama-flex-nowrap { flex-wrap: nowrap; }
    .otedama-justify-start { justify-content: flex-start; }
    .otedama-justify-center { justify-content: center; }
    .otedama-justify-end { justify-content: flex-end; }
    .otedama-justify-between { justify-content: space-between; }
    .otedama-justify-around { justify-content: space-around; }
    .otedama-items-start { align-items: flex-start; }
    .otedama-items-center { align-items: center; }
    .otedama-items-end { align-items: flex-end; }
    .otedama-items-stretch { align-items: stretch; }
    
    /* Position Utilities */
    .otedama-static { position: static; }
    .otedama-relative { position: relative; }
    .otedama-absolute { position: absolute; }
    .otedama-fixed { position: fixed; }
    .otedama-sticky { position: sticky; }
    
    /* Overflow Utilities */
    .otedama-overflow-auto { overflow: auto; }
    .otedama-overflow-hidden { overflow: hidden; }
    .otedama-overflow-visible { overflow: visible; }
    .otedama-overflow-scroll { overflow: scroll; }
    .otedama-overflow-x-auto { overflow-x: auto; overflow-y: hidden; }
    .otedama-overflow-y-auto { overflow-y: auto; overflow-x: hidden; }
  `;
}

/**
 * Responsive observer for dynamic behavior
 */
export class ResponsiveObserver {
  constructor(callback, options = {}) {
    this.callback = callback;
    this.options = {
      debounce: 150,
      breakpoints: Object.keys(ResponsiveBreakpoints),
      ...options
    };
    
    this.currentBreakpoint = ViewportUtils.getCurrentBreakpoint();
    this.resizeHandler = this.debounce(this.handleResize.bind(this), this.options.debounce);
  }
  
  start() {
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('orientationchange', this.resizeHandler);
    
    // Initial call
    this.callback({
      breakpoint: this.currentBreakpoint,
      viewport: ViewportUtils.getViewport(),
      isMobile: ViewportUtils.isMobile(),
      isTablet: ViewportUtils.isTablet(),
      isDesktop: ViewportUtils.isDesktop()
    });
  }
  
  stop() {
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('orientationchange', this.resizeHandler);
  }
  
  handleResize() {
    const newBreakpoint = ViewportUtils.getCurrentBreakpoint();
    
    if (newBreakpoint !== this.currentBreakpoint || this.options.alwaysNotify) {
      this.currentBreakpoint = newBreakpoint;
      
      this.callback({
        breakpoint: newBreakpoint,
        previousBreakpoint: this.currentBreakpoint,
        viewport: ViewportUtils.getViewport(),
        isMobile: ViewportUtils.isMobile(),
        isTablet: ViewportUtils.isTablet(),
        isDesktop: ViewportUtils.isDesktop()
      });
    }
  }
  
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

export default {
  ResponsiveBreakpoints,
  MediaQuery,
  ViewportUtils,
  ResponsiveGrid,
  ResponsiveSpacing,
  ResponsiveVisibility,
  ResponsiveTypography,
  ResponsiveContainer,
  ResponsiveObserver,
  generateResponsiveStyles
};