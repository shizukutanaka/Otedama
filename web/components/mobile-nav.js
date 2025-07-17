/**
 * Mobile Navigation Component
 * Responsive navigation for Otedama web interface
 */

class MobileNav {
    constructor() {
        this.menuOpen = false;
        this.touchStartY = 0;
        this.touchEndY = 0;
        this.init();
    }

    init() {
        this.createNavigation();
        this.bindEvents();
        this.checkMobileView();
    }

    createNavigation() {
        // Create mobile menu button
        const menuButton = document.createElement('button');
        menuButton.className = 'mobile-menu-btn d-lg-none';
        menuButton.innerHTML = '<span></span><span></span><span></span>';
        menuButton.setAttribute('aria-label', 'Toggle navigation');
        menuButton.setAttribute('aria-expanded', 'false');

        // Create mobile navigation overlay
        const overlay = document.createElement('div');
        overlay.className = 'mobile-nav-overlay';
        
        // Create mobile navigation menu
        const mobileNav = document.createElement('nav');
        mobileNav.className = 'mobile-nav';
        mobileNav.innerHTML = `
            <div class="mobile-nav-header">
                <a href="/" class="mobile-nav-logo">
                    <i class="fas fa-cube"></i> Otedama
                </a>
                <button class="mobile-nav-close" aria-label="Close navigation">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <ul class="mobile-nav-menu">
                <li><a href="/" class="mobile-nav-link active">
                    <i class="fas fa-home"></i> Home
                </a></li>
                <li><a href="/dashboard.html" class="mobile-nav-link">
                    <i class="fas fa-tachometer-alt"></i> Dashboard
                </a></li>
                <li><a href="/analytics.html" class="mobile-nav-link">
                    <i class="fas fa-chart-line"></i> Analytics
                </a></li>
                <li><a href="/mobile-app.html" class="mobile-nav-link">
                    <i class="fas fa-mobile-alt"></i> Mobile App
                </a></li>
                <li><a href="/api/docs" class="mobile-nav-link">
                    <i class="fas fa-code"></i> API Docs
                </a></li>
            </ul>
            <div class="mobile-nav-footer">
                <div class="mobile-nav-stats">
                    <div class="stat">
                        <span class="stat-label">Pool Hashrate</span>
                        <span class="stat-value" id="mobile-hashrate">Loading...</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Active Miners</span>
                        <span class="stat-value" id="mobile-miners">Loading...</span>
                    </div>
                </div>
            </div>
        `;

        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            /* Mobile Menu Button */
            .mobile-menu-btn {
                position: fixed;
                top: var(--spacing-md);
                right: var(--spacing-md);
                z-index: calc(var(--z-modal) + 10);
                width: 48px;
                height: 48px;
                background: rgba(255, 255, 255, 0.9);
                border: none;
                border-radius: var(--radius-md);
                box-shadow: var(--shadow-lg);
                cursor: pointer;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                gap: 4px;
                transition: var(--transition-base);
            }

            .mobile-menu-btn span {
                width: 24px;
                height: 3px;
                background: var(--primary);
                border-radius: 2px;
                transition: var(--transition-base);
            }

            .mobile-menu-btn:hover {
                background: white;
                transform: scale(1.05);
            }

            .mobile-menu-btn.active span:nth-child(1) {
                transform: rotate(45deg) translate(6px, 6px);
            }

            .mobile-menu-btn.active span:nth-child(2) {
                opacity: 0;
            }

            .mobile-menu-btn.active span:nth-child(3) {
                transform: rotate(-45deg) translate(6px, -6px);
            }

            /* Mobile Navigation Overlay */
            .mobile-nav-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                opacity: 0;
                visibility: hidden;
                transition: var(--transition-base);
                z-index: var(--z-modal);
            }

            .mobile-nav-overlay.active {
                opacity: 1;
                visibility: visible;
            }

            /* Mobile Navigation */
            .mobile-nav {
                position: fixed;
                top: 0;
                right: -300px;
                width: 300px;
                height: 100%;
                background: white;
                box-shadow: var(--shadow-xl);
                transition: var(--transition-base);
                z-index: calc(var(--z-modal) + 5);
                overflow-y: auto;
                display: flex;
                flex-direction: column;
            }

            .mobile-nav.active {
                right: 0;
            }

            .mobile-nav-header {
                padding: var(--spacing-lg);
                border-bottom: 1px solid var(--border);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .mobile-nav-logo {
                font-size: 1.5rem;
                font-weight: 700;
                color: var(--primary);
                text-decoration: none;
                display: flex;
                align-items: center;
                gap: var(--spacing-sm);
            }

            .mobile-nav-close {
                background: none;
                border: none;
                font-size: 1.5rem;
                color: var(--text-light);
                cursor: pointer;
                padding: var(--spacing-sm);
                transition: var(--transition-base);
            }

            .mobile-nav-close:hover {
                color: var(--primary);
                transform: rotate(90deg);
            }

            /* Mobile Nav Menu */
            .mobile-nav-menu {
                list-style: none;
                padding: 0;
                margin: 0;
                flex: 1;
            }

            .mobile-nav-link {
                display: flex;
                align-items: center;
                gap: var(--spacing-md);
                padding: var(--spacing-md) var(--spacing-lg);
                color: var(--text);
                text-decoration: none;
                font-weight: 500;
                transition: var(--transition-base);
                border-left: 3px solid transparent;
            }

            .mobile-nav-link:hover {
                background: var(--light);
                color: var(--primary);
                border-left-color: var(--primary);
            }

            .mobile-nav-link.active {
                background: rgba(255, 107, 53, 0.1);
                color: var(--primary);
                border-left-color: var(--primary);
            }

            .mobile-nav-link i {
                width: 20px;
                text-align: center;
            }

            /* Mobile Nav Footer */
            .mobile-nav-footer {
                padding: var(--spacing-lg);
                border-top: 1px solid var(--border);
                background: var(--light);
            }

            .mobile-nav-stats {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: var(--spacing-md);
            }

            .mobile-nav-stats .stat {
                text-align: center;
            }

            .mobile-nav-stats .stat-label {
                display: block;
                font-size: 0.75rem;
                color: var(--text-light);
                margin-bottom: var(--spacing-xs);
            }

            .mobile-nav-stats .stat-value {
                display: block;
                font-size: 1rem;
                font-weight: 600;
                color: var(--primary);
            }

            /* Responsive */
            @media (min-width: 992px) {
                .mobile-menu-btn,
                .mobile-nav-overlay,
                .mobile-nav {
                    display: none !important;
                }
            }

            /* Dark mode support */
            @media (prefers-color-scheme: dark) {
                .mobile-nav {
                    background: var(--dark);
                    color: var(--light);
                }

                .mobile-nav-link {
                    color: var(--light);
                }

                .mobile-nav-link:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .mobile-nav-footer {
                    background: rgba(255, 255, 255, 0.05);
                }
            }

            /* Swipe gesture indicator */
            .swipe-indicator {
                position: fixed;
                top: 50%;
                right: 0;
                transform: translateY(-50%);
                width: 20px;
                height: 60px;
                background: rgba(255, 107, 53, 0.2);
                border-radius: 10px 0 0 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: var(--transition-base);
                z-index: var(--z-fixed);
            }

            .swipe-indicator::before {
                content: '◀';
                color: var(--primary);
                font-size: 12px;
            }

            @media (max-width: 768px) {
                .swipe-indicator {
                    opacity: 0.8;
                }
            }
        `;

        // Append elements to DOM
        document.head.appendChild(style);
        document.body.appendChild(menuButton);
        document.body.appendChild(overlay);
        document.body.appendChild(mobileNav);

        // Store references
        this.menuButton = menuButton;
        this.overlay = overlay;
        this.mobileNav = mobileNav;
        this.closeButton = mobileNav.querySelector('.mobile-nav-close');
    }

    bindEvents() {
        // Menu button click
        this.menuButton.addEventListener('click', () => this.toggleMenu());

        // Close button click
        this.closeButton.addEventListener('click', () => this.closeMenu());

        // Overlay click
        this.overlay.addEventListener('click', () => this.closeMenu());

        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.menuOpen) {
                this.closeMenu();
            }
        });

        // Touch gestures for swipe
        let touchStartX = 0;
        let touchEndX = 0;

        document.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        });

        document.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            this.handleSwipe(touchStartX, touchEndX);
        });

        // Resize handler
        window.addEventListener('resize', () => this.checkMobileView());

        // Active link highlighting
        this.highlightActiveLink();
    }

    toggleMenu() {
        if (this.menuOpen) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }

    openMenu() {
        this.menuOpen = true;
        this.menuButton.classList.add('active');
        this.overlay.classList.add('active');
        this.mobileNav.classList.add('active');
        this.menuButton.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
    }

    closeMenu() {
        this.menuOpen = false;
        this.menuButton.classList.remove('active');
        this.overlay.classList.remove('active');
        this.mobileNav.classList.remove('active');
        this.menuButton.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }

    handleSwipe(startX, endX) {
        const swipeThreshold = 100;
        const diff = startX - endX;

        // Swipe left to open menu (from right edge)
        if (diff < -swipeThreshold && startX > window.innerWidth - 50) {
            this.openMenu();
        }
        // Swipe right to close menu
        else if (diff > swipeThreshold && this.menuOpen) {
            this.closeMenu();
        }
    }

    checkMobileView() {
        if (window.innerWidth >= 992) {
            this.closeMenu();
        }
    }

    highlightActiveLink() {
        const currentPath = window.location.pathname;
        const links = this.mobileNav.querySelectorAll('.mobile-nav-link');
        
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (href === currentPath || (href === '/' && currentPath === '/index.html')) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

    updateStats(hashrate, miners) {
        const hashrateEl = document.getElementById('mobile-hashrate');
        const minersEl = document.getElementById('mobile-miners');
        
        if (hashrateEl) hashrateEl.textContent = hashrate;
        if (minersEl) minersEl.textContent = miners;
    }
}

// Initialize mobile navigation when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.mobileNav = new MobileNav();
    });
} else {
    window.mobileNav = new MobileNav();
}

export default MobileNav;