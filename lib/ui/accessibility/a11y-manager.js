/**
 * Accessibility Manager
 * WCAG 2.1 AA compliant accessibility features
 */

import { DesignTokens } from '../core/design-system.js';

/**
 * Accessibility Manager
 */
export class A11yManager {
  constructor(options = {}) {
    this.options = {
      enableKeyboardNavigation: true,
      enableScreenReaderAnnouncements: true,
      enableHighContrast: true,
      enableReducedMotion: true,
      enableFocusIndicators: true,
      skipLinks: true,
      ...options
    };
    
    this.focusTrap = null;
    this.announcer = null;
    this.keyboardNav = null;
    this.initialized = false;
  }
  
  /**
   * Initialize accessibility features
   */
  initialize() {
    if (this.initialized) return;
    
    // Create announcer for screen readers
    if (this.options.enableScreenReaderAnnouncements) {
      this.createAnnouncer();
    }
    
    // Set up keyboard navigation
    if (this.options.enableKeyboardNavigation) {
      this.setupKeyboardNavigation();
    }
    
    // Add skip links
    if (this.options.skipLinks) {
      this.addSkipLinks();
    }
    
    // Set up focus management
    if (this.options.enableFocusIndicators) {
      this.setupFocusManagement();
    }
    
    // Respect user preferences
    this.respectUserPreferences();
    
    // Add ARIA live regions
    this.setupLiveRegions();
    
    this.initialized = true;
  }
  
  /**
   * Create screen reader announcer
   */
  createAnnouncer() {
    this.announcer = document.createElement('div');
    this.announcer.className = 'otedama-a11y-announcer';
    this.announcer.setAttribute('aria-live', 'polite');
    this.announcer.setAttribute('aria-atomic', 'true');
    this.announcer.setAttribute('role', 'status');
    
    // Visually hidden but available to screen readers
    Object.assign(this.announcer.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: '0'
    });
    
    document.body.appendChild(this.announcer);
  }
  
  /**
   * Announce message to screen readers
   */
  announce(message, priority = 'polite') {
    if (!this.announcer) return;
    
    // Clear previous announcement
    this.announcer.textContent = '';
    
    // Set priority
    this.announcer.setAttribute('aria-live', priority);
    
    // Announce after a brief delay to ensure it's picked up
    setTimeout(() => {
      this.announcer.textContent = message;
    }, 100);
    
    // Clear after announcement
    setTimeout(() => {
      this.announcer.textContent = '';
    }, 1000);
  }
  
  /**
   * Setup keyboard navigation
   */
  setupKeyboardNavigation() {
    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Skip to main content (Alt + M)
      if (e.altKey && e.key === 'm') {
        e.preventDefault();
        this.focusMain();
      }
      
      // Skip to navigation (Alt + N)
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        this.focusNavigation();
      }
      
      // Open search (Ctrl/Cmd + K)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openSearch();
      }
      
      // Close modals/popups (Escape)
      if (e.key === 'Escape') {
        this.closeTopmost();
      }
    });
    
    // Roving tabindex for lists and menus
    this.setupRovingTabindex();
  }
  
  /**
   * Setup roving tabindex pattern
   */
  setupRovingTabindex() {
    const groups = document.querySelectorAll('[role="list"], [role="menu"], [role="tablist"]');
    
    groups.forEach(group => {
      const items = group.querySelectorAll('[role="listitem"], [role="menuitem"], [role="tab"]');
      if (items.length === 0) return;
      
      // Set initial tabindex
      items.forEach((item, index) => {
        item.setAttribute('tabindex', index === 0 ? '0' : '-1');
      });
      
      // Handle keyboard navigation
      group.addEventListener('keydown', (e) => {
        const currentIndex = Array.from(items).findIndex(item => 
          item === document.activeElement
        );
        
        let nextIndex = currentIndex;
        
        switch (e.key) {
          case 'ArrowDown':
          case 'ArrowRight':
            e.preventDefault();
            nextIndex = (currentIndex + 1) % items.length;
            break;
            
          case 'ArrowUp':
          case 'ArrowLeft':
            e.preventDefault();
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) nextIndex = items.length - 1;
            break;
            
          case 'Home':
            e.preventDefault();
            nextIndex = 0;
            break;
            
          case 'End':
            e.preventDefault();
            nextIndex = items.length - 1;
            break;
            
          default:
            return;
        }
        
        // Update tabindex and focus
        items[currentIndex].setAttribute('tabindex', '-1');
        items[nextIndex].setAttribute('tabindex', '0');
        items[nextIndex].focus();
      });
    });
  }
  
  /**
   * Add skip links
   */
  addSkipLinks() {
    const skipNav = document.createElement('nav');
    skipNav.className = 'otedama-skip-links';
    skipNav.setAttribute('aria-label', 'Skip links');
    
    skipNav.innerHTML = `
      <a href="#main" class="otedama-skip-link">Skip to main content</a>
      <a href="#nav" class="otedama-skip-link">Skip to navigation</a>
      <a href="#search" class="otedama-skip-link">Skip to search</a>
    `;
    
    // Insert at the beginning of body
    document.body.insertBefore(skipNav, document.body.firstChild);
    
    // Style skip links
    const style = document.createElement('style');
    style.textContent = `
      .otedama-skip-links {
        position: absolute;
        top: -40px;
        left: 0;
        background: var(--background-primary);
        z-index: 9999;
      }
      
      .otedama-skip-link {
        position: absolute;
        top: -40px;
        left: 0;
        background: ${DesignTokens.colors.primary[500]};
        color: white;
        padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[4]};
        text-decoration: none;
        border-radius: ${DesignTokens.borderRadius.md};
      }
      
      .otedama-skip-link:focus {
        top: ${DesignTokens.spacing[2]};
        left: ${DesignTokens.spacing[2]};
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * Setup focus management
   */
  setupFocusManagement() {
    // Track focus source (keyboard vs mouse)
    let usingKeyboard = false;
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        usingKeyboard = true;
      }
    });
    
    document.addEventListener('mousedown', () => {
      usingKeyboard = false;
    });
    
    // Add focus-visible class when using keyboard
    document.addEventListener('focusin', (e) => {
      if (usingKeyboard) {
        e.target.classList.add('focus-visible');
      }
    });
    
    document.addEventListener('focusout', (e) => {
      e.target.classList.remove('focus-visible');
    });
    
    // Ensure all interactive elements are focusable
    this.ensureFocusableElements();
  }
  
  /**
   * Ensure interactive elements are properly focusable
   */
  ensureFocusableElements() {
    // Add tabindex to custom interactive elements
    const customButtons = document.querySelectorAll('[role="button"]:not([tabindex])');
    customButtons.forEach(button => {
      button.setAttribute('tabindex', '0');
    });
    
    // Ensure form controls have labels
    const inputs = document.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
      if (!input.getAttribute('aria-label') && !input.labels?.length) {
        console.warn('Input without label:', input);
      }
    });
    
    // Add keyboard event handlers to custom buttons
    document.querySelectorAll('[role="button"]').forEach(button => {
      if (!button.onclick && !button.hasAttribute('data-a11y-click')) {
        button.setAttribute('data-a11y-click', 'true');
        button.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            button.click();
          }
        });
      }
    });
  }
  
  /**
   * Respect user preferences
   */
  respectUserPreferences() {
    // High contrast mode
    if (this.options.enableHighContrast) {
      const prefersHighContrast = window.matchMedia('(prefers-contrast: high)');
      this.applyHighContrast(prefersHighContrast.matches);
      
      prefersHighContrast.addEventListener('change', (e) => {
        this.applyHighContrast(e.matches);
      });
    }
    
    // Reduced motion
    if (this.options.enableReducedMotion) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.applyReducedMotion(prefersReducedMotion.matches);
      
      prefersReducedMotion.addEventListener('change', (e) => {
        this.applyReducedMotion(e.matches);
      });
    }
    
    // Color scheme
    const prefersColorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    document.documentElement.setAttribute('data-color-scheme', 
      prefersColorScheme.matches ? 'dark' : 'light'
    );
    
    prefersColorScheme.addEventListener('change', (e) => {
      document.documentElement.setAttribute('data-color-scheme', 
        e.matches ? 'dark' : 'light'
      );
    });
  }
  
  /**
   * Apply high contrast mode
   */
  applyHighContrast(enabled) {
    document.documentElement.classList.toggle('high-contrast', enabled);
    
    if (enabled) {
      this.announce('High contrast mode enabled');
    }
  }
  
  /**
   * Apply reduced motion
   */
  applyReducedMotion(enabled) {
    document.documentElement.classList.toggle('reduced-motion', enabled);
    
    if (enabled) {
      this.announce('Animations reduced');
    }
  }
  
  /**
   * Setup ARIA live regions
   */
  setupLiveRegions() {
    // Status messages
    const statusRegion = document.createElement('div');
    statusRegion.id = 'status-region';
    statusRegion.setAttribute('role', 'status');
    statusRegion.setAttribute('aria-live', 'polite');
    statusRegion.className = 'sr-only';
    document.body.appendChild(statusRegion);
    
    // Alert messages
    const alertRegion = document.createElement('div');
    alertRegion.id = 'alert-region';
    alertRegion.setAttribute('role', 'alert');
    alertRegion.setAttribute('aria-live', 'assertive');
    alertRegion.className = 'sr-only';
    document.body.appendChild(alertRegion);
  }
  
  /**
   * Create focus trap
   */
  createFocusTrap(container) {
    const focusableElements = container.querySelectorAll(
      'a[href], button, textarea, input[type="text"], input[type="radio"], ' +
      'input[type="checkbox"], select, [tabindex]:not([tabindex="-1"])'
    );
    
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    
    const trap = (e) => {
      if (e.key !== 'Tab') return;
      
      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable.focus();
        }
      }
    };
    
    container.addEventListener('keydown', trap);
    
    // Focus first element
    if (firstFocusable) {
      firstFocusable.focus();
    }
    
    return {
      release: () => {
        container.removeEventListener('keydown', trap);
      }
    };
  }
  
  /**
   * Focus main content
   */
  focusMain() {
    const main = document.querySelector('main, [role="main"], #main');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus();
      this.announce('Main content');
    }
  }
  
  /**
   * Focus navigation
   */
  focusNavigation() {
    const nav = document.querySelector('nav, [role="navigation"], #nav');
    if (nav) {
      nav.setAttribute('tabindex', '-1');
      nav.focus();
      this.announce('Navigation');
    }
  }
  
  /**
   * Open search
   */
  openSearch() {
    const search = document.querySelector('[role="search"], #search, input[type="search"]');
    if (search) {
      search.focus();
      this.announce('Search opened');
    }
  }
  
  /**
   * Close topmost modal/popup
   */
  closeTopmost() {
    const modals = document.querySelectorAll('[role="dialog"]:not([hidden])');
    const lastModal = modals[modals.length - 1];
    
    if (lastModal) {
      lastModal.setAttribute('hidden', '');
      this.announce('Dialog closed');
      
      // Return focus to trigger element if stored
      const triggerId = lastModal.getAttribute('data-trigger');
      if (triggerId) {
        const trigger = document.getElementById(triggerId);
        if (trigger) trigger.focus();
      }
    }
  }
  
  /**
   * Get contrast ratio between two colors
   */
  getContrastRatio(color1, color2) {
    const rgb1 = this.hexToRgb(color1);
    const rgb2 = this.hexToRgb(color2);
    
    const l1 = this.getLuminance(rgb1);
    const l2 = this.getLuminance(rgb2);
    
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    
    return (lighter + 0.05) / (darker + 0.05);
  }
  
  /**
   * Convert hex to RGB
   */
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255
    } : null;
  }
  
  /**
   * Get relative luminance
   */
  getLuminance(rgb) {
    const { r, g, b } = rgb;
    const sRGB = [r, g, b].map(val => {
      if (val <= 0.03928) {
        return val / 12.92;
      }
      return Math.pow((val + 0.055) / 1.055, 2.4);
    });
    
    return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
  }
  
  /**
   * Check if color combination meets WCAG AA
   */
  meetsWCAG_AA(foreground, background, largeText = false) {
    const ratio = this.getContrastRatio(foreground, background);
    return largeText ? ratio >= 3 : ratio >= 4.5;
  }
  
  /**
   * Check if color combination meets WCAG AAA
   */
  meetsWCAG_AAA(foreground, background, largeText = false) {
    const ratio = this.getContrastRatio(foreground, background);
    return largeText ? ratio >= 4.5 : ratio >= 7;
  }
}

/**
 * Accessibility utilities
 */
export const a11yUtils = {
  /**
   * Generate unique ID
   */
  generateId: (prefix = 'otedama') => {
    return `${prefix}-${Math.random().toString(36).substr(2, 9)}`;
  },
  
  /**
   * Get accessible name
   */
  getAccessibleName: (element) => {
    // Check aria-labelledby
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labels = labelledBy.split(' ').map(id => 
        document.getElementById(id)?.textContent
      ).filter(Boolean);
      if (labels.length) return labels.join(' ');
    }
    
    // Check aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    
    // Check associated label
    if (element.labels?.length) {
      return Array.from(element.labels).map(l => l.textContent).join(' ');
    }
    
    // Check title
    const title = element.getAttribute('title');
    if (title) return title;
    
    // Use text content for buttons and links
    if (element.matches('button, a, [role="button"], [role="link"]')) {
      return element.textContent?.trim();
    }
    
    return '';
  },
  
  /**
   * Set accessible name
   */
  setAccessibleName: (element, name) => {
    element.setAttribute('aria-label', name);
  },
  
  /**
   * Make element describable
   */
  makeDescribable: (element, description) => {
    const id = element.id || a11yUtils.generateId();
    element.id = id;
    
    const descId = `${id}-desc`;
    let descElement = document.getElementById(descId);
    
    if (!descElement) {
      descElement = document.createElement('span');
      descElement.id = descId;
      descElement.className = 'sr-only';
      element.parentNode.insertBefore(descElement, element.nextSibling);
    }
    
    descElement.textContent = description;
    element.setAttribute('aria-describedby', descId);
  }
};

/**
 * Accessibility styles
 */
export const a11yStyles = `
  /* Screen reader only */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  
  /* Focus visible */
  .focus-visible {
    outline: 3px solid ${DesignTokens.colors.primary[500]};
    outline-offset: 2px;
  }
  
  /* High contrast mode */
  .high-contrast {
    filter: contrast(1.5);
  }
  
  .high-contrast * {
    border-width: 2px !important;
  }
  
  /* Reduced motion */
  .reduced-motion * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  
  /* Focus indicators */
  a:focus,
  button:focus,
  input:focus,
  select:focus,
  textarea:focus,
  [tabindex]:focus {
    outline: 3px solid ${DesignTokens.colors.primary[500]};
    outline-offset: 2px;
  }
  
  /* Keyboard navigation hints */
  [aria-keyshortcuts]::after {
    content: " (" attr(aria-keyshortcuts) ")";
    font-size: 0.875em;
    opacity: 0.7;
  }
  
  /* Ensure minimum touch target size */
  button,
  a,
  input,
  select,
  textarea,
  [role="button"],
  [role="link"] {
    min-height: 44px;
    min-width: 44px;
  }
  
  /* Error states */
  [aria-invalid="true"] {
    border-color: ${DesignTokens.colors.semantic.error} !important;
  }
  
  /* Required fields */
  [aria-required="true"]::after,
  [required]::after {
    content: " *";
    color: ${DesignTokens.colors.semantic.error};
  }
`;

export default A11yManager;