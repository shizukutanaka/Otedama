/**
 * Intuitive Navigation System
 * Modern, responsive, and accessible navigation components
 */

import { DesignTokens } from '../core/design-system.js';
import { BaseComponent } from '../components/base-components.js';

/**
 * Navigation item configuration
 */
export class NavItem {
  constructor(config) {
    this.id = config.id;
    this.label = config.label;
    this.icon = config.icon;
    this.href = config.href;
    this.action = config.action;
    this.children = config.children?.map(child => new NavItem(child)) || [];
    this.badge = config.badge;
    this.disabled = config.disabled || false;
    this.hidden = config.hidden || false;
    this.meta = config.meta || {};
    this.permissions = config.permissions || [];
  }
  
  /**
   * Check if item has children
   */
  hasChildren() {
    return this.children.length > 0;
  }
  
  /**
   * Check if user has permission
   */
  hasPermission(userPermissions = []) {
    if (this.permissions.length === 0) return true;
    return this.permissions.some(perm => userPermissions.includes(perm));
  }
}

/**
 * Navigation Bar Component
 */
export class NavigationBar extends BaseComponent {
  constructor(props) {
    super({
      variant: 'horizontal', // horizontal, vertical
      position: 'top', // top, left, right, bottom
      sticky: true,
      collapsible: true,
      showLogo: true,
      showSearch: true,
      showUserMenu: true,
      mobileBreakpoint: 'md',
      ...props
    });
    
    this.state = {
      mobileMenuOpen: false,
      activeItem: null,
      searchOpen: false
    };
  }
  
  render() {
    const { 
      variant, position, sticky, showLogo, showSearch, showUserMenu,
      items = [], user, className = '' 
    } = this.props;
    
    const { mobileMenuOpen, searchOpen } = this.state;
    
    const navClasses = `
      otedama-nav
      otedama-nav--${variant}
      otedama-nav--${position}
      ${sticky ? 'otedama-nav--sticky' : ''}
      ${mobileMenuOpen ? 'otedama-nav--mobile-open' : ''}
      ${className}
    `.trim();
    
    return `
      <nav 
        id="${this.id}"
        class="${navClasses}"
        role="navigation"
        aria-label="Main navigation"
      >
        <div class="otedama-nav__container">
          ${this.renderHeader(showLogo, showSearch)}
          ${this.renderNavItems(items)}
          ${this.renderActions(showUserMenu, user)}
        </div>
        
        ${this.renderMobileMenu(items, user)}
        ${searchOpen ? this.renderSearchOverlay() : ''}
      </nav>
    `;
  }
  
  /**
   * Render navigation header
   */
  renderHeader(showLogo, showSearch) {
    return `
      <div class="otedama-nav__header">
        ${showLogo ? `
          <a href="/" class="otedama-nav__logo" aria-label="Otedama Home">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="currentColor">
              <circle cx="16" cy="16" r="14" fill="${DesignTokens.colors.primary[500]}" />
              <text x="16" y="22" text-anchor="middle" fill="white" font-size="16" font-weight="bold">O</text>
            </svg>
            <span class="otedama-nav__logo-text">Otedama</span>
          </a>
        ` : ''}
        
        <button 
          class="otedama-nav__mobile-toggle"
          aria-label="Toggle mobile menu"
          aria-expanded="${this.state.mobileMenuOpen}"
          onclick="this.closest('.otedama-nav').classList.toggle('otedama-nav--mobile-open')"
        >
          <span class="otedama-nav__mobile-toggle-icon"></span>
        </button>
      </div>
    `;
  }
  
  /**
   * Render navigation items
   */
  renderNavItems(items) {
    return `
      <ul class="otedama-nav__items" role="list">
        ${items.map(item => this.renderNavItem(item)).join('')}
      </ul>
    `;
  }
  
  /**
   * Render single navigation item
   */
  renderNavItem(item, level = 0) {
    if (item.hidden) return '';
    
    const hasChildren = item.hasChildren();
    const isActive = this.isItemActive(item);
    
    return `
      <li class="otedama-nav__item ${isActive ? 'otedama-nav__item--active' : ''}">
        ${hasChildren ? `
          <button
            class="otedama-nav__link"
            aria-expanded="false"
            aria-haspopup="true"
            ${item.disabled ? 'disabled' : ''}
          >
            ${item.icon ? `<span class="otedama-nav__icon">${item.icon}</span>` : ''}
            <span class="otedama-nav__label">${item.label}</span>
            ${item.badge ? `<span class="otedama-nav__badge">${item.badge}</span>` : ''}
            <svg class="otedama-nav__chevron" width="12" height="12" viewBox="0 0 12 12">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" fill="none" />
            </svg>
          </button>
          
          <ul class="otedama-nav__dropdown" role="list">
            ${item.children.map(child => this.renderNavItem(child, level + 1)).join('')}
          </ul>
        ` : `
          <a
            href="${item.href || '#'}"
            class="otedama-nav__link"
            ${item.action ? `onclick="${item.action}"` : ''}
            ${item.disabled ? 'aria-disabled="true"' : ''}
          >
            ${item.icon ? `<span class="otedama-nav__icon">${item.icon}</span>` : ''}
            <span class="otedama-nav__label">${item.label}</span>
            ${item.badge ? `<span class="otedama-nav__badge">${item.badge}</span>` : ''}
          </a>
        `}
      </li>
    `;
  }
  
  /**
   * Render navigation actions
   */
  renderActions(showUserMenu, user) {
    return `
      <div class="otedama-nav__actions">
        ${this.props.showSearch ? `
          <button 
            class="otedama-nav__action otedama-nav__action--search"
            aria-label="Search"
            onclick="document.querySelector('.otedama-nav').classList.add('otedama-nav--search-open')"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2"/>
              <path d="M14 14L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        ` : ''}
        
        <button 
          class="otedama-nav__action otedama-nav__action--notifications"
          aria-label="Notifications"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2C6 2 3 5 3 9V14L2 16V17H18V16L17 14V9C17 5 14 2 10 2Z" stroke="currentColor" stroke-width="2"/>
            <path d="M8 17C8 18 9 19 10 19C11 19 12 18 12 17" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span class="otedama-nav__action-badge">3</span>
        </button>
        
        ${showUserMenu && user ? this.renderUserMenu(user) : ''}
      </div>
    `;
  }
  
  /**
   * Render user menu
   */
  renderUserMenu(user) {
    return `
      <div class="otedama-nav__user-menu">
        <button 
          class="otedama-nav__user-toggle"
          aria-expanded="false"
          aria-haspopup="true"
        >
          <img 
            class="otedama-nav__user-avatar" 
            src="${user.avatar || '/images/default-avatar.png'}" 
            alt="${user.name}"
            width="32"
            height="32"
          />
          <span class="otedama-nav__user-name">${user.name}</span>
          <svg class="otedama-nav__chevron" width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" fill="none" />
          </svg>
        </button>
        
        <div class="otedama-nav__user-dropdown">
          <div class="otedama-nav__user-info">
            <div class="otedama-nav__user-name">${user.name}</div>
            <div class="otedama-nav__user-email">${user.email}</div>
          </div>
          
          <div class="otedama-nav__user-divider"></div>
          
          <a href="/profile" class="otedama-nav__user-link">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="currentColor"/>
              <circle cx="8" cy="6" r="2" stroke="currentColor"/>
              <path d="M4 13C4 11 6 9 8 9C10 9 12 11 12 13" stroke="currentColor"/>
            </svg>
            Profile
          </a>
          
          <a href="/settings" class="otedama-nav__user-link">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2" stroke="currentColor"/>
              <path d="M8 1V3M8 13V15M1 8H3M13 8H15M3 3L4.5 4.5M11.5 11.5L13 13M13 3L11.5 4.5M4.5 11.5L3 13" stroke="currentColor"/>
            </svg>
            Settings
          </a>
          
          <div class="otedama-nav__user-divider"></div>
          
          <button class="otedama-nav__user-link otedama-nav__user-link--logout">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 2H2V14H6M11 11L14 8L11 5M14 8H6" stroke="currentColor"/>
            </svg>
            Logout
          </button>
        </div>
      </div>
    `;
  }
  
  /**
   * Render mobile menu
   */
  renderMobileMenu(items, user) {
    return `
      <div class="otedama-nav__mobile-menu">
        <div class="otedama-nav__mobile-header">
          <a href="/" class="otedama-nav__logo">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="currentColor">
              <circle cx="16" cy="16" r="14" fill="${DesignTokens.colors.primary[500]}" />
              <text x="16" y="22" text-anchor="middle" fill="white" font-size="16" font-weight="bold">O</text>
            </svg>
            <span class="otedama-nav__logo-text">Otedama</span>
          </a>
          
          <button 
            class="otedama-nav__mobile-close"
            aria-label="Close mobile menu"
            onclick="this.closest('.otedama-nav').classList.remove('otedama-nav--mobile-open')"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
        </div>
        
        ${user ? `
          <div class="otedama-nav__mobile-user">
            <img 
              class="otedama-nav__user-avatar" 
              src="${user.avatar || '/images/default-avatar.png'}" 
              alt="${user.name}"
              width="48"
              height="48"
            />
            <div>
              <div class="otedama-nav__user-name">${user.name}</div>
              <div class="otedama-nav__user-email">${user.email}</div>
            </div>
          </div>
        ` : ''}
        
        <ul class="otedama-nav__mobile-items" role="list">
          ${items.map(item => this.renderMobileNavItem(item)).join('')}
        </ul>
        
        <div class="otedama-nav__mobile-actions">
          <a href="/profile" class="otedama-nav__mobile-action">Profile</a>
          <a href="/settings" class="otedama-nav__mobile-action">Settings</a>
          <button class="otedama-nav__mobile-action otedama-nav__mobile-action--logout">Logout</button>
        </div>
      </div>
    `;
  }
  
  /**
   * Render mobile navigation item
   */
  renderMobileNavItem(item) {
    if (item.hidden) return '';
    
    const hasChildren = item.hasChildren();
    
    return `
      <li class="otedama-nav__mobile-item">
        ${hasChildren ? `
          <details class="otedama-nav__mobile-accordion">
            <summary class="otedama-nav__mobile-link">
              ${item.icon ? `<span class="otedama-nav__icon">${item.icon}</span>` : ''}
              <span class="otedama-nav__label">${item.label}</span>
              ${item.badge ? `<span class="otedama-nav__badge">${item.badge}</span>` : ''}
            </summary>
            <ul class="otedama-nav__mobile-subitems">
              ${item.children.map(child => this.renderMobileNavItem(child)).join('')}
            </ul>
          </details>
        ` : `
          <a 
            href="${item.href || '#'}"
            class="otedama-nav__mobile-link"
            ${item.action ? `onclick="${item.action}"` : ''}
          >
            ${item.icon ? `<span class="otedama-nav__icon">${item.icon}</span>` : ''}
            <span class="otedama-nav__label">${item.label}</span>
            ${item.badge ? `<span class="otedama-nav__badge">${item.badge}</span>` : ''}
          </a>
        `}
      </li>
    `;
  }
  
  /**
   * Render search overlay
   */
  renderSearchOverlay() {
    return `
      <div class="otedama-nav__search-overlay">
        <div class="otedama-nav__search-container">
          <input
            type="search"
            class="otedama-nav__search-input"
            placeholder="Search..."
            aria-label="Search"
            autofocus
          />
          
          <button
            class="otedama-nav__search-close"
            aria-label="Close search"
            onclick="document.querySelector('.otedama-nav').classList.remove('otedama-nav--search-open')"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
        </div>
        
        <div class="otedama-nav__search-results">
          <!-- Search results would be rendered here -->
        </div>
      </div>
    `;
  }
  
  /**
   * Check if item is active
   */
  isItemActive(item) {
    const currentPath = window.location.pathname;
    return item.href === currentPath || 
           item.children.some(child => child.href === currentPath);
  }
}

/**
 * Sidebar Navigation Component
 */
export class SidebarNavigation extends BaseComponent {
  constructor(props) {
    super({
      collapsed: false,
      collapsible: true,
      width: '260px',
      minWidth: '80px',
      position: 'left',
      ...props
    });
    
    this.state = {
      collapsed: props.collapsed,
      expandedItems: new Set()
    };
  }
  
  render() {
    const { items = [], position, width, minWidth, className = '' } = this.props;
    const { collapsed } = this.state;
    
    const sidebarClasses = `
      otedama-sidebar
      otedama-sidebar--${position}
      ${collapsed ? 'otedama-sidebar--collapsed' : ''}
      ${className}
    `.trim();
    
    const style = `
      --sidebar-width: ${width};
      --sidebar-min-width: ${minWidth};
    `;
    
    return `
      <aside 
        id="${this.id}"
        class="${sidebarClasses}"
        style="${style}"
        role="navigation"
        aria-label="Sidebar navigation"
      >
        ${this.props.collapsible ? `
          <button
            class="otedama-sidebar__toggle"
            aria-label="${collapsed ? 'Expand' : 'Collapse'} sidebar"
            onclick="this.closest('.otedama-sidebar').classList.toggle('otedama-sidebar--collapsed')"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="${collapsed ? 'M7 5L12 10L7 15' : 'M13 5L8 10L13 15'}" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
        ` : ''}
        
        <div class="otedama-sidebar__content">
          ${this.renderSidebarItems(items)}
        </div>
      </aside>
    `;
  }
  
  /**
   * Render sidebar items
   */
  renderSidebarItems(items, level = 0) {
    return `
      <ul class="otedama-sidebar__items" role="list">
        ${items.map(item => this.renderSidebarItem(item, level)).join('')}
      </ul>
    `;
  }
  
  /**
   * Render sidebar item
   */
  renderSidebarItem(item, level) {
    if (item.hidden) return '';
    
    const hasChildren = item.hasChildren();
    const isExpanded = this.state.expandedItems.has(item.id);
    const isActive = this.isItemActive(item);
    
    return `
      <li class="otedama-sidebar__item">
        ${hasChildren ? `
          <button
            class="otedama-sidebar__link otedama-sidebar__link--expandable"
            aria-expanded="${isExpanded}"
            data-item-id="${item.id}"
            onclick="this.closest('.otedama-sidebar').dispatchEvent(new CustomEvent('toggle-item', { detail: '${item.id}' }))"
          >
            ${item.icon ? `<span class="otedama-sidebar__icon">${item.icon}</span>` : ''}
            <span class="otedama-sidebar__label">${item.label}</span>
            ${item.badge ? `<span class="otedama-sidebar__badge">${item.badge}</span>` : ''}
            <svg class="otedama-sidebar__chevron" width="12" height="12" viewBox="0 0 12 12">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" fill="none" />
            </svg>
          </button>
          
          ${isExpanded ? `
            <ul class="otedama-sidebar__subitems">
              ${item.children.map(child => this.renderSidebarItem(child, level + 1)).join('')}
            </ul>
          ` : ''}
        ` : `
          <a
            href="${item.href || '#'}"
            class="otedama-sidebar__link ${isActive ? 'otedama-sidebar__link--active' : ''}"
            ${item.action ? `onclick="${item.action}"` : ''}
            ${item.disabled ? 'aria-disabled="true"' : ''}
            title="${item.label}"
          >
            ${item.icon ? `<span class="otedama-sidebar__icon">${item.icon}</span>` : ''}
            <span class="otedama-sidebar__label">${item.label}</span>
            ${item.badge ? `<span class="otedama-sidebar__badge">${item.badge}</span>` : ''}
          </a>
        `}
      </li>
    `;
  }
}

/**
 * Breadcrumb Component
 */
export class Breadcrumb extends BaseComponent {
  constructor(props) {
    super({
      separator: '/',
      ...props
    });
  }
  
  render() {
    const { items = [], separator, className = '' } = this.props;
    
    return `
      <nav 
        id="${this.id}"
        class="otedama-breadcrumb ${className}"
        aria-label="Breadcrumb"
      >
        <ol class="otedama-breadcrumb__list">
          ${items.map((item, index) => `
            <li class="otedama-breadcrumb__item">
              ${index < items.length - 1 ? `
                <a href="${item.href}" class="otedama-breadcrumb__link">
                  ${item.label}
                </a>
                <span class="otedama-breadcrumb__separator" aria-hidden="true">
                  ${separator}
                </span>
              ` : `
                <span class="otedama-breadcrumb__current" aria-current="page">
                  ${item.label}
                </span>
              `}
            </li>
          `).join('')}
        </ol>
      </nav>
    `;
  }
}

/**
 * Navigation styles
 */
export const navigationStyles = `
  /* Navigation Bar */
  .otedama-nav {
    background: var(--surface-card);
    border-bottom: 1px solid var(--border-primary);
    position: relative;
    z-index: ${DesignTokens.zIndex.sticky};
  }
  
  .otedama-nav--sticky {
    position: sticky;
    top: 0;
  }
  
  .otedama-nav__container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 ${DesignTokens.spacing[4]};
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 64px;
  }
  
  .otedama-nav__header {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[4]};
  }
  
  .otedama-nav__logo {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[2]};
    text-decoration: none;
    color: var(--text-primary);
    font-weight: ${DesignTokens.typography.fontWeight.bold};
    font-size: ${DesignTokens.typography.fontSize.lg};
  }
  
  .otedama-nav__mobile-toggle {
    display: none;
    width: 40px;
    height: 40px;
    background: none;
    border: none;
    cursor: pointer;
    
    @media (max-width: ${DesignTokens.breakpoints.md}) {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }
  
  .otedama-nav__mobile-toggle-icon {
    width: 24px;
    height: 2px;
    background: currentColor;
    position: relative;
    transition: all 0.3s ease;
    
    &::before,
    &::after {
      content: '';
      position: absolute;
      width: 100%;
      height: 100%;
      background: currentColor;
      left: 0;
      transition: all 0.3s ease;
    }
    
    &::before {
      top: -8px;
    }
    
    &::after {
      top: 8px;
    }
  }
  
  .otedama-nav--mobile-open .otedama-nav__mobile-toggle-icon {
    background: transparent;
    
    &::before {
      top: 0;
      transform: rotate(45deg);
    }
    
    &::after {
      top: 0;
      transform: rotate(-45deg);
    }
  }
  
  .otedama-nav__items {
    display: flex;
    list-style: none;
    margin: 0;
    padding: 0;
    gap: ${DesignTokens.spacing[1]};
    
    @media (max-width: ${DesignTokens.breakpoints.md}) {
      display: none;
    }
  }
  
  .otedama-nav__item {
    position: relative;
  }
  
  .otedama-nav__link {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[2]};
    padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[3]};
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: ${DesignTokens.borderRadius.md};
    transition: all 0.2s ease;
    border: none;
    background: none;
    cursor: pointer;
    font-size: ${DesignTokens.typography.fontSize.base};
    
    &:hover {
      color: var(--text-primary);
      background: var(--background-secondary);
    }
    
    &[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
  
  .otedama-nav__item--active .otedama-nav__link {
    color: ${DesignTokens.colors.primary[500]};
    background: ${DesignTokens.colors.primary[500]}10;
  }
  
  .otedama-nav__icon {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .otedama-nav__badge {
    padding: ${DesignTokens.spacing[0.5]} ${DesignTokens.spacing[2]};
    background: ${DesignTokens.colors.primary[500]};
    color: white;
    border-radius: ${DesignTokens.borderRadius.full};
    font-size: ${DesignTokens.typography.fontSize.xs};
    font-weight: ${DesignTokens.typography.fontWeight.medium};
  }
  
  .otedama-nav__chevron {
    margin-left: auto;
    transition: transform 0.2s ease;
  }
  
  /* Dropdown */
  .otedama-nav__dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 200px;
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: ${DesignTokens.borderRadius.lg};
    box-shadow: ${DesignTokens.shadows.lg};
    padding: ${DesignTokens.spacing[2]};
    margin-top: ${DesignTokens.spacing[1]};
    opacity: 0;
    visibility: hidden;
    transform: translateY(-10px);
    transition: all 0.2s ease;
    list-style: none;
  }
  
  .otedama-nav__item:hover .otedama-nav__dropdown,
  .otedama-nav__item:focus-within .otedama-nav__dropdown {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
  
  /* Actions */
  .otedama-nav__actions {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[2]};
    
    @media (max-width: ${DesignTokens.breakpoints.md}) {
      display: none;
    }
  }
  
  .otedama-nav__action {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    border-radius: ${DesignTokens.borderRadius.md};
    position: relative;
    
    &:hover {
      color: var(--text-primary);
      background: var(--background-secondary);
    }
  }
  
  .otedama-nav__action-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 16px;
    height: 16px;
    background: ${DesignTokens.colors.semantic.error};
    color: white;
    border-radius: ${DesignTokens.borderRadius.full};
    font-size: ${DesignTokens.typography.fontSize.xs};
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  /* User Menu */
  .otedama-nav__user-menu {
    position: relative;
  }
  
  .otedama-nav__user-toggle {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[2]};
    padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[2]};
    background: none;
    border: none;
    cursor: pointer;
    border-radius: ${DesignTokens.borderRadius.full};
    transition: all 0.2s ease;
    
    &:hover {
      background: var(--background-secondary);
    }
  }
  
  .otedama-nav__user-avatar {
    width: 32px;
    height: 32px;
    border-radius: ${DesignTokens.borderRadius.full};
    object-fit: cover;
  }
  
  .otedama-nav__user-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    min-width: 240px;
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: ${DesignTokens.borderRadius.lg};
    box-shadow: ${DesignTokens.shadows.lg};
    margin-top: ${DesignTokens.spacing[2]};
    opacity: 0;
    visibility: hidden;
    transform: translateY(-10px);
    transition: all 0.2s ease;
  }
  
  .otedama-nav__user-menu:hover .otedama-nav__user-dropdown,
  .otedama-nav__user-menu:focus-within .otedama-nav__user-dropdown {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
  
  .otedama-nav__user-info {
    padding: ${DesignTokens.spacing[4]};
  }
  
  .otedama-nav__user-name {
    font-weight: ${DesignTokens.typography.fontWeight.medium};
    color: var(--text-primary);
  }
  
  .otedama-nav__user-email {
    font-size: ${DesignTokens.typography.fontSize.sm};
    color: var(--text-secondary);
  }
  
  .otedama-nav__user-divider {
    height: 1px;
    background: var(--border-primary);
    margin: ${DesignTokens.spacing[2]} 0;
  }
  
  .otedama-nav__user-link {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[3]};
    padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[4]};
    color: var(--text-primary);
    text-decoration: none;
    transition: all 0.2s ease;
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
    
    &:hover {
      background: var(--background-secondary);
    }
  }
  
  .otedama-nav__user-link--logout {
    color: ${DesignTokens.colors.semantic.error};
  }
  
  /* Mobile Menu */
  .otedama-nav__mobile-menu {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--background-primary);
    transform: translateX(-100%);
    transition: transform 0.3s ease;
    overflow-y: auto;
    z-index: ${DesignTokens.zIndex.modal};
    
    @media (min-width: ${DesignTokens.breakpoints.md}) {
      display: none;
    }
  }
  
  .otedama-nav--mobile-open .otedama-nav__mobile-menu {
    transform: translateX(0);
  }
  
  .otedama-nav__mobile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${DesignTokens.spacing[4]};
    border-bottom: 1px solid var(--border-primary);
  }
  
  .otedama-nav__mobile-close {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
  }
  
  .otedama-nav__mobile-user {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[3]};
    padding: ${DesignTokens.spacing[4]};
    border-bottom: 1px solid var(--border-primary);
  }
  
  .otedama-nav__mobile-items {
    list-style: none;
    margin: 0;
    padding: ${DesignTokens.spacing[4]};
  }
  
  .otedama-nav__mobile-link {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[3]};
    padding: ${DesignTokens.spacing[3]};
    color: var(--text-primary);
    text-decoration: none;
    border-radius: ${DesignTokens.borderRadius.md};
    transition: all 0.2s ease;
    
    &:hover {
      background: var(--background-secondary);
    }
  }
  
  .otedama-nav__mobile-accordion summary {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[3]};
    padding: ${DesignTokens.spacing[3]};
    cursor: pointer;
    list-style: none;
    
    &::-webkit-details-marker {
      display: none;
    }
  }
  
  .otedama-nav__mobile-subitems {
    list-style: none;
    padding-left: ${DesignTokens.spacing[8]};
  }
  
  .otedama-nav__mobile-actions {
    padding: ${DesignTokens.spacing[4]};
    border-top: 1px solid var(--border-primary);
  }
  
  .otedama-nav__mobile-action {
    display: block;
    padding: ${DesignTokens.spacing[3]};
    color: var(--text-primary);
    text-decoration: none;
    border-radius: ${DesignTokens.borderRadius.md};
    transition: all 0.2s ease;
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
    
    &:hover {
      background: var(--background-secondary);
    }
  }
  
  .otedama-nav__mobile-action--logout {
    color: ${DesignTokens.colors.semantic.error};
  }
  
  /* Sidebar */
  .otedama-sidebar {
    width: var(--sidebar-width);
    height: 100vh;
    background: var(--surface-card);
    border-right: 1px solid var(--border-primary);
    position: relative;
    transition: width 0.3s ease;
    overflow: hidden;
  }
  
  .otedama-sidebar--collapsed {
    width: var(--sidebar-min-width);
    
    .otedama-sidebar__label,
    .otedama-sidebar__badge,
    .otedama-sidebar__chevron,
    .otedama-sidebar__subitems {
      display: none;
    }
    
    .otedama-sidebar__link {
      justify-content: center;
    }
  }
  
  .otedama-sidebar__toggle {
    position: absolute;
    top: ${DesignTokens.spacing[4]};
    right: ${DesignTokens.spacing[3]};
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--background-secondary);
    border: 1px solid var(--border-primary);
    border-radius: ${DesignTokens.borderRadius.md};
    cursor: pointer;
    z-index: 1;
    
    &:hover {
      background: var(--background-tertiary);
    }
  }
  
  .otedama-sidebar__content {
    padding: ${DesignTokens.spacing[6]} ${DesignTokens.spacing[3]};
    height: 100%;
    overflow-y: auto;
  }
  
  .otedama-sidebar__items {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  
  .otedama-sidebar__link {
    display: flex;
    align-items: center;
    gap: ${DesignTokens.spacing[3]};
    padding: ${DesignTokens.spacing[3]};
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: ${DesignTokens.borderRadius.md};
    transition: all 0.2s ease;
    margin-bottom: ${DesignTokens.spacing[1]};
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
    
    &:hover {
      color: var(--text-primary);
      background: var(--background-secondary);
    }
  }
  
  .otedama-sidebar__link--active {
    color: ${DesignTokens.colors.primary[500]};
    background: ${DesignTokens.colors.primary[500]}10;
  }
  
  .otedama-sidebar__subitems {
    list-style: none;
    margin: 0;
    padding: 0;
    margin-left: ${DesignTokens.spacing[8]};
  }
  
  /* Breadcrumb */
  .otedama-breadcrumb__list {
    display: flex;
    align-items: center;
    list-style: none;
    margin: 0;
    padding: 0;
    flex-wrap: wrap;
  }
  
  .otedama-breadcrumb__item {
    display: flex;
    align-items: center;
  }
  
  .otedama-breadcrumb__link {
    color: var(--text-secondary);
    text-decoration: none;
    transition: color 0.2s ease;
    
    &:hover {
      color: ${DesignTokens.colors.primary[500]};
    }
  }
  
  .otedama-breadcrumb__separator {
    margin: 0 ${DesignTokens.spacing[2]};
    color: var(--text-tertiary);
  }
  
  .otedama-breadcrumb__current {
    color: var(--text-primary);
    font-weight: ${DesignTokens.typography.fontWeight.medium};
  }
`;

export default {
  NavItem,
  NavigationBar,
  SidebarNavigation,
  Breadcrumb,
  navigationStyles
};