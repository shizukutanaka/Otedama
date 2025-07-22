/**
 * Mobile-First Responsive Components
 * Touch-optimized UI components for mobile devices
 */

import { BaseComponent } from '../components/base-components.js';
import { DesignTokens } from '../core/design-system.js';

/**
 * Mobile Navigation Component
 */
export class MobileNavigation extends BaseComponent {
  constructor(props) {
    super({
      items: [],
      activeItem: null,
      variant: 'bottom', // bottom, drawer, tabs
      showLabels: true,
      ...props
    });
    
    this.state = {
      isOpen: false,
      activeItem: props.activeItem
    };
  }
  
  render() {
    const { variant, className = '' } = this.props;
    
    const baseClasses = `
      otedama-mobile-nav
      otedama-mobile-nav--${variant}
      ${className}
    `.trim();
    
    switch (variant) {
      case 'drawer':
        return this.renderDrawer(baseClasses);
      case 'tabs':
        return this.renderTabs(baseClasses);
      case 'bottom':
      default:
        return this.renderBottomNav(baseClasses);
    }
  }
  
  renderBottomNav(classes) {
    const { items, showLabels } = this.props;
    const { activeItem } = this.state;
    
    return `
      <nav id="${this.id}" class="${classes}" role="navigation">
        <div class="otedama-mobile-nav__container">
          ${items.map(item => `
            <button
              class="otedama-mobile-nav__item ${activeItem === item.id ? 'otedama-mobile-nav__item--active' : ''}"
              onclick="document.getElementById('${this.id}').selectItem('${item.id}')"
              aria-label="${item.label}"
              ${activeItem === item.id ? 'aria-current="page"' : ''}
            >
              <span class="otedama-mobile-nav__icon">${item.icon}</span>
              ${showLabels ? `<span class="otedama-mobile-nav__label">${item.label}</span>` : ''}
              ${item.badge ? `<span class="otedama-mobile-nav__badge">${item.badge}</span>` : ''}
            </button>
          `).join('')}
        </div>
      </nav>
    `;
  }
  
  renderDrawer(classes) {
    const { items } = this.props;
    const { isOpen, activeItem } = this.state;
    
    return `
      <div id="${this.id}" class="${classes} ${isOpen ? 'otedama-mobile-nav--open' : ''}">
        <!-- Backdrop -->
        <div 
          class="otedama-mobile-nav__backdrop"
          onclick="document.getElementById('${this.id}').close()"
        ></div>
        
        <!-- Drawer -->
        <nav class="otedama-mobile-nav__drawer" role="navigation">
          <div class="otedama-mobile-nav__header">
            <h2 class="otedama-mobile-nav__title">Menu</h2>
            <button
              class="otedama-mobile-nav__close"
              onclick="document.getElementById('${this.id}').close()"
              aria-label="Close menu"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.3 5.71a.996.996 0 0 0-1.41 0L12 10.59 7.11 5.7A.996.996 0 1 0 5.7 7.11L10.59 12 5.7 16.89a.996.996 0 1 0 1.41 1.41L12 13.41l4.89 4.89a.996.996 0 1 0 1.41-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"/>
              </svg>
            </button>
          </div>
          
          <div class="otedama-mobile-nav__content">
            ${items.map(item => `
              <button
                class="otedama-mobile-nav__drawer-item ${activeItem === item.id ? 'otedama-mobile-nav__drawer-item--active' : ''}"
                onclick="document.getElementById('${this.id}').selectItem('${item.id}')"
                ${activeItem === item.id ? 'aria-current="page"' : ''}
              >
                <span class="otedama-mobile-nav__icon">${item.icon}</span>
                <span class="otedama-mobile-nav__label">${item.label}</span>
                ${item.badge ? `<span class="otedama-mobile-nav__badge">${item.badge}</span>` : ''}
              </button>
            `).join('')}
          </div>
        </nav>
      </div>
    `;
  }
  
  renderTabs(classes) {
    const { items } = this.props;
    const { activeItem } = this.state;
    
    return `
      <nav id="${this.id}" class="${classes}" role="tablist">
        <div class="otedama-mobile-nav__tabs">
          ${items.map(item => `
            <button
              class="otedama-mobile-nav__tab ${activeItem === item.id ? 'otedama-mobile-nav__tab--active' : ''}"
              onclick="document.getElementById('${this.id}').selectItem('${item.id}')"
              role="tab"
              aria-selected="${activeItem === item.id}"
              aria-controls="${item.id}-panel"
            >
              ${item.icon ? `<span class="otedama-mobile-nav__icon">${item.icon}</span>` : ''}
              <span class="otedama-mobile-nav__label">${item.label}</span>
              ${item.badge ? `<span class="otedama-mobile-nav__badge">${item.badge}</span>` : ''}
            </button>
          `).join('')}
        </div>
        <div class="otedama-mobile-nav__indicator"></div>
      </nav>
    `;
  }
  
  selectItem(itemId) {
    this.setState({ activeItem: itemId });
    
    const item = this.props.items.find(i => i.id === itemId);
    if (item && item.onClick) {
      item.onClick();
    }
    
    if (this.props.variant === 'drawer') {
      this.close();
    }
    
    this.emit('select', { itemId, item });
  }
  
  open() {
    if (this.props.variant === 'drawer') {
      this.setState({ isOpen: true });
      document.body.style.overflow = 'hidden';
    }
  }
  
  close() {
    if (this.props.variant === 'drawer') {
      this.setState({ isOpen: false });
      document.body.style.overflow = '';
    }
  }
  
  static styles = `
    /* Bottom Navigation */
    .otedama-mobile-nav--bottom {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--surface-card);
      border-top: 1px solid var(--border-primary);
      z-index: ${DesignTokens.zIndex.sticky};
      padding-bottom: env(safe-area-inset-bottom);
    }
    
    .otedama-mobile-nav__container {
      display: flex;
      justify-content: space-around;
      align-items: center;
      height: 56px;
    }
    
    .otedama-mobile-nav__item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: ${DesignTokens.spacing[0.5]};
      padding: ${DesignTokens.spacing[2]};
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      position: relative;
      transition: all 0.2s ease;
      -webkit-tap-highlight-color: transparent;
    }
    
    .otedama-mobile-nav__item--active {
      color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-mobile-nav__icon {
      font-size: 24px;
      line-height: 1;
    }
    
    .otedama-mobile-nav__label {
      font-size: ${DesignTokens.typography.fontSize.xs};
      font-weight: ${DesignTokens.typography.fontWeight.medium};
    }
    
    .otedama-mobile-nav__badge {
      position: absolute;
      top: 4px;
      right: calc(50% - 16px);
      min-width: 18px;
      height: 18px;
      padding: 0 ${DesignTokens.spacing[1]};
      background: ${DesignTokens.colors.semantic.error};
      color: white;
      border-radius: ${DesignTokens.borderRadius.full};
      font-size: ${DesignTokens.typography.fontSize.xs};
      font-weight: ${DesignTokens.typography.fontWeight.bold};
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    /* Drawer Navigation */
    .otedama-mobile-nav--drawer {
      position: fixed;
      inset: 0;
      z-index: ${DesignTokens.zIndex.modal};
      pointer-events: none;
    }
    
    .otedama-mobile-nav--drawer.otedama-mobile-nav--open {
      pointer-events: auto;
    }
    
    .otedama-mobile-nav__backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .otedama-mobile-nav--open .otedama-mobile-nav__backdrop {
      opacity: 1;
    }
    
    .otedama-mobile-nav__drawer {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      width: 280px;
      max-width: 85vw;
      background: var(--surface-card);
      box-shadow: ${DesignTokens.shadows.xl};
      transform: translateX(-100%);
      transition: transform 0.3s ease;
      display: flex;
      flex-direction: column;
    }
    
    .otedama-mobile-nav--open .otedama-mobile-nav__drawer {
      transform: translateX(0);
    }
    
    .otedama-mobile-nav__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${DesignTokens.spacing[4]};
      border-bottom: 1px solid var(--border-primary);
    }
    
    .otedama-mobile-nav__title {
      margin: 0;
      font-size: ${DesignTokens.typography.fontSize.lg};
      font-weight: ${DesignTokens.typography.fontWeight.semibold};
    }
    
    .otedama-mobile-nav__close {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      border-radius: ${DesignTokens.borderRadius.full};
      transition: all 0.2s ease;
    }
    
    .otedama-mobile-nav__close:hover {
      background: var(--background-secondary);
    }
    
    .otedama-mobile-nav__content {
      flex: 1;
      overflow-y: auto;
      padding: ${DesignTokens.spacing[2]};
    }
    
    .otedama-mobile-nav__drawer-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[3]};
      padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[4]};
      background: transparent;
      border: none;
      border-radius: ${DesignTokens.borderRadius.md};
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }
    
    .otedama-mobile-nav__drawer-item:hover {
      background: var(--background-secondary);
    }
    
    .otedama-mobile-nav__drawer-item--active {
      background: ${DesignTokens.colors.primary[500]}22;
      color: ${DesignTokens.colors.primary[500]};
    }
    
    /* Tab Navigation */
    .otedama-mobile-nav--tabs {
      background: var(--surface-card);
      border-bottom: 1px solid var(--border-primary);
      position: relative;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    
    .otedama-mobile-nav--tabs::-webkit-scrollbar {
      display: none;
    }
    
    .otedama-mobile-nav__tabs {
      display: flex;
      min-width: min-content;
    }
    
    .otedama-mobile-nav__tab {
      flex: 1;
      min-width: 90px;
      padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[4]};
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-weight: ${DesignTokens.typography.fontWeight.medium};
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      position: relative;
    }
    
    .otedama-mobile-nav__tab--active {
      color: ${DesignTokens.colors.primary[500]};
    }
    
    .otedama-mobile-nav__indicator {
      position: absolute;
      bottom: 0;
      height: 3px;
      background: ${DesignTokens.colors.primary[500]};
      transition: all 0.3s ease;
    }
  `;
}

/**
 * Touch-optimized Card Component
 */
export class TouchCard extends BaseComponent {
  constructor(props) {
    super({
      swipeable: true,
      actions: [],
      onSwipe: null,
      ...props
    });
    
    this.state = {
      touchStartX: 0,
      touchCurrentX: 0,
      isDragging: false,
      swipeDirection: null
    };
  }
  
  render() {
    const { children, actions, className = '' } = this.props;
    const { isDragging, swipeDirection } = this.state;
    
    const baseClasses = `
      otedama-touch-card
      ${isDragging ? 'otedama-touch-card--dragging' : ''}
      ${swipeDirection ? `otedama-touch-card--swipe-${swipeDirection}` : ''}
      ${className}
    `.trim();
    
    return `
      <div 
        id="${this.id}"
        class="${baseClasses}"
        ontouchstart="document.getElementById('${this.id}').handleTouchStart(event)"
        ontouchmove="document.getElementById('${this.id}').handleTouchMove(event)"
        ontouchend="document.getElementById('${this.id}').handleTouchEnd(event)"
      >
        <div class="otedama-touch-card__content">
          ${children || ''}
        </div>
        
        ${actions.length > 0 ? `
          <div class="otedama-touch-card__actions">
            ${actions.map(action => `
              <button
                class="otedama-touch-card__action otedama-touch-card__action--${action.type || 'default'}"
                onclick="${action.onClick}"
              >
                ${action.icon || action.label}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }
  
  handleTouchStart(event) {
    if (!this.props.swipeable) return;
    
    this.state.touchStartX = event.touches[0].clientX;
    this.state.touchCurrentX = event.touches[0].clientX;
    this.setState({ isDragging: true });
  }
  
  handleTouchMove(event) {
    if (!this.state.isDragging) return;
    
    this.state.touchCurrentX = event.touches[0].clientX;
    const deltaX = this.state.touchCurrentX - this.state.touchStartX;
    
    const element = document.getElementById(this.id);
    const content = element.querySelector('.otedama-touch-card__content');
    
    // Apply transform with resistance
    const resistance = 0.5;
    const transform = deltaX * resistance;
    content.style.transform = `translateX(${transform}px)`;
    
    // Determine swipe direction
    if (Math.abs(deltaX) > 50) {
      this.setState({ swipeDirection: deltaX > 0 ? 'right' : 'left' });
    } else {
      this.setState({ swipeDirection: null });
    }
  }
  
  handleTouchEnd(event) {
    if (!this.state.isDragging) return;
    
    const deltaX = this.state.touchCurrentX - this.state.touchStartX;
    const threshold = 100;
    
    const element = document.getElementById(this.id);
    const content = element.querySelector('.otedama-touch-card__content');
    
    if (Math.abs(deltaX) > threshold) {
      // Complete the swipe
      const direction = deltaX > 0 ? 'right' : 'left';
      
      if (this.props.onSwipe) {
        this.props.onSwipe(direction);
      }
      
      content.style.transform = `translateX(${deltaX > 0 ? '100%' : '-100%'})`;
      content.style.opacity = '0';
      
      setTimeout(() => {
        content.style.transform = '';
        content.style.opacity = '';
      }, 300);
    } else {
      // Snap back
      content.style.transform = '';
    }
    
    this.setState({ isDragging: false, swipeDirection: null });
  }
  
  static styles = `
    .otedama-touch-card {
      position: relative;
      overflow: hidden;
      touch-action: pan-y;
    }
    
    .otedama-touch-card__content {
      position: relative;
      background: var(--surface-card);
      border-radius: ${DesignTokens.borderRadius.lg};
      padding: ${DesignTokens.spacing[4]};
      transition: transform 0.3s ease, opacity 0.3s ease;
      will-change: transform;
    }
    
    .otedama-touch-card--dragging .otedama-touch-card__content {
      transition: none;
    }
    
    .otedama-touch-card__actions {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
      padding: 0 ${DesignTokens.spacing[4]};
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    
    .otedama-touch-card--swipe-left .otedama-touch-card__actions {
      opacity: 1;
    }
    
    .otedama-touch-card__action {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-card);
      border: none;
      border-radius: ${DesignTokens.borderRadius.full};
      font-size: 20px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-touch-card__action--danger {
      background: ${DesignTokens.colors.semantic.error};
      color: white;
    }
    
    .otedama-touch-card__action--primary {
      background: ${DesignTokens.colors.primary[500]};
      color: white;
    }
  `;
}

/**
 * Pull to Refresh Component
 */
export class PullToRefresh extends BaseComponent {
  constructor(props) {
    super({
      onRefresh: async () => {},
      threshold: 80,
      ...props
    });
    
    this.state = {
      isPulling: false,
      pullDistance: 0,
      isRefreshing: false
    };
  }
  
  render() {
    const { children, className = '' } = this.props;
    const { isPulling, pullDistance, isRefreshing } = this.state;
    
    const baseClasses = `
      otedama-pull-refresh
      ${isPulling ? 'otedama-pull-refresh--pulling' : ''}
      ${isRefreshing ? 'otedama-pull-refresh--refreshing' : ''}
      ${className}
    `.trim();
    
    const progress = Math.min(pullDistance / this.props.threshold, 1);
    
    return `
      <div 
        id="${this.id}"
        class="${baseClasses}"
        ontouchstart="document.getElementById('${this.id}').handleTouchStart(event)"
        ontouchmove="document.getElementById('${this.id}').handleTouchMove(event)"
        ontouchend="document.getElementById('${this.id}').handleTouchEnd(event)"
      >
        <div class="otedama-pull-refresh__indicator" style="transform: translateY(${pullDistance}px)">
          <div class="otedama-pull-refresh__spinner" style="transform: rotate(${progress * 180}deg)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
          </div>
          <span class="otedama-pull-refresh__text">
            ${isRefreshing ? 'Refreshing...' : pullDistance >= this.props.threshold ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        </div>
        
        <div 
          class="otedama-pull-refresh__content"
          style="transform: translateY(${pullDistance}px)"
        >
          ${children || ''}
        </div>
      </div>
    `;
  }
  
  handleTouchStart(event) {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    if (scrollTop !== 0 || this.state.isRefreshing) return;
    
    this.state.touchStartY = event.touches[0].clientY;
  }
  
  handleTouchMove(event) {
    if (this.state.touchStartY === undefined || this.state.isRefreshing) return;
    
    const touchY = event.touches[0].clientY;
    const deltaY = touchY - this.state.touchStartY;
    
    if (deltaY > 0) {
      event.preventDefault();
      
      // Apply resistance
      const resistance = 2.5;
      const pullDistance = Math.min(deltaY / resistance, this.props.threshold * 1.5);
      
      this.setState({ isPulling: true, pullDistance });
    }
  }
  
  async handleTouchEnd(event) {
    if (!this.state.isPulling) return;
    
    const { pullDistance } = this.state;
    
    if (pullDistance >= this.props.threshold) {
      // Trigger refresh
      this.setState({ isRefreshing: true, pullDistance: this.props.threshold });
      
      try {
        await this.props.onRefresh();
      } catch (error) {
        console.error('Refresh failed:', error);
      }
      
      this.setState({ isRefreshing: false });
    }
    
    // Reset
    this.setState({ isPulling: false, pullDistance: 0 });
    this.state.touchStartY = undefined;
  }
  
  static styles = `
    .otedama-pull-refresh {
      position: relative;
      overflow: hidden;
    }
    
    .otedama-pull-refresh__indicator {
      position: absolute;
      top: -60px;
      left: 0;
      right: 0;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${DesignTokens.spacing[2]};
      color: var(--text-secondary);
      transition: transform 0.3s ease;
    }
    
    .otedama-pull-refresh--pulling .otedama-pull-refresh__indicator {
      transition: none;
    }
    
    .otedama-pull-refresh__spinner {
      transition: transform 0.3s ease;
    }
    
    .otedama-pull-refresh--refreshing .otedama-pull-refresh__spinner {
      animation: spin 1s linear infinite;
    }
    
    .otedama-pull-refresh__text {
      font-size: ${DesignTokens.typography.fontSize.sm};
    }
    
    .otedama-pull-refresh__content {
      transition: transform 0.3s ease;
    }
    
    .otedama-pull-refresh--pulling .otedama-pull-refresh__content {
      transition: none;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
}

/**
 * Floating Action Button
 */
export class FloatingActionButton extends BaseComponent {
  constructor(props) {
    super({
      icon: '+',
      position: 'bottom-right', // bottom-right, bottom-left, bottom-center
      offset: { x: 16, y: 16 },
      mini: false,
      extended: false,
      label: '',
      actions: [], // For speed dial
      ...props
    });
    
    this.state = {
      isOpen: false
    };
  }
  
  render() {
    const { icon, position, mini, extended, label, actions, className = '' } = this.props;
    const { isOpen } = this.state;
    
    const baseClasses = `
      otedama-fab
      otedama-fab--${position}
      ${mini ? 'otedama-fab--mini' : ''}
      ${extended ? 'otedama-fab--extended' : ''}
      ${actions.length > 0 ? 'otedama-fab--speed-dial' : ''}
      ${isOpen ? 'otedama-fab--open' : ''}
      ${className}
    `.trim();
    
    return `
      <div id="${this.id}" class="${baseClasses}">
        ${actions.length > 0 ? this.renderSpeedDial(actions) : ''}
        
        <button
          class="otedama-fab__button"
          onclick="${actions.length > 0 ? `document.getElementById('${this.id}').toggleSpeedDial()` : this.props.onClick || ''}"
          aria-label="${label || 'Floating action button'}"
        >
          <span class="otedama-fab__icon ${isOpen ? 'otedama-fab__icon--close' : ''}">
            ${isOpen ? '×' : icon}
          </span>
          ${extended && label ? `<span class="otedama-fab__label">${label}</span>` : ''}
        </button>
      </div>
    `;
  }
  
  renderSpeedDial(actions) {
    return `
      <div class="otedama-fab__actions">
        ${actions.map((action, index) => `
          <div class="otedama-fab__action" style="transition-delay: ${index * 0.05}s">
            <span class="otedama-fab__action-label">${action.label}</span>
            <button
              class="otedama-fab__action-button"
              onclick="${action.onClick}"
              aria-label="${action.label}"
            >
              ${action.icon}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  }
  
  toggleSpeedDial() {
    this.setState({ isOpen: !this.state.isOpen });
  }
  
  static styles = `
    .otedama-fab {
      position: fixed;
      z-index: ${DesignTokens.zIndex.fixed};
    }
    
    /* Positions */
    .otedama-fab--bottom-right {
      bottom: 16px;
      right: 16px;
    }
    
    .otedama-fab--bottom-left {
      bottom: 16px;
      left: 16px;
    }
    
    .otedama-fab--bottom-center {
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
    }
    
    /* Button */
    .otedama-fab__button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${DesignTokens.spacing[2]};
      width: 56px;
      height: 56px;
      background: ${DesignTokens.colors.primary[500]};
      color: white;
      border: none;
      border-radius: ${DesignTokens.borderRadius.full};
      box-shadow: ${DesignTokens.shadows.lg};
      cursor: pointer;
      transition: all 0.3s ease;
      position: relative;
      z-index: 2;
    }
    
    .otedama-fab--mini .otedama-fab__button {
      width: 40px;
      height: 40px;
    }
    
    .otedama-fab--extended .otedama-fab__button {
      width: auto;
      padding: 0 ${DesignTokens.spacing[4]};
      border-radius: ${DesignTokens.borderRadius.full};
    }
    
    .otedama-fab__button:hover {
      transform: scale(1.05);
      box-shadow: ${DesignTokens.shadows.xl};
    }
    
    .otedama-fab__button:active {
      transform: scale(0.95);
    }
    
    .otedama-fab__icon {
      font-size: 24px;
      transition: transform 0.3s ease;
    }
    
    .otedama-fab__icon--close {
      transform: rotate(45deg);
    }
    
    .otedama-fab__label {
      font-weight: ${DesignTokens.typography.fontWeight.medium};
    }
    
    /* Speed Dial */
    .otedama-fab__actions {
      position: absolute;
      bottom: 100%;
      margin-bottom: ${DesignTokens.spacing[2]};
      display: flex;
      flex-direction: column-reverse;
      gap: ${DesignTokens.spacing[2]};
    }
    
    .otedama-fab__action {
      display: flex;
      align-items: center;
      gap: ${DesignTokens.spacing[2]};
      opacity: 0;
      transform: scale(0) translateY(20px);
      transition: all 0.3s ease;
    }
    
    .otedama-fab--open .otedama-fab__action {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
    
    .otedama-fab__action-label {
      background: var(--surface-card);
      padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[2]};
      border-radius: ${DesignTokens.borderRadius.md};
      font-size: ${DesignTokens.typography.fontSize.sm};
      white-space: nowrap;
      box-shadow: ${DesignTokens.shadows.md};
    }
    
    .otedama-fab__action-button {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-card);
      color: var(--text-primary);
      border: none;
      border-radius: ${DesignTokens.borderRadius.full};
      box-shadow: ${DesignTokens.shadows.md};
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .otedama-fab__action-button:hover {
      transform: scale(1.1);
      box-shadow: ${DesignTokens.shadows.lg};
    }
    
    /* Safe area adjustments */
    @supports (padding-bottom: env(safe-area-inset-bottom)) {
      .otedama-fab--bottom-right,
      .otedama-fab--bottom-left,
      .otedama-fab--bottom-center {
        bottom: calc(16px + env(safe-area-inset-bottom));
      }
    }
  `;
}

/**
 * Export all mobile component styles
 */
export const getAllMobileStyles = () => {
  const components = [
    MobileNavigation,
    TouchCard,
    PullToRefresh,
    FloatingActionButton
  ];
  
  return components
    .map(Component => Component.styles)
    .join('\n\n');
};

export default {
  MobileNavigation,
  TouchCard,
  PullToRefresh,
  FloatingActionButton,
  getAllMobileStyles
};