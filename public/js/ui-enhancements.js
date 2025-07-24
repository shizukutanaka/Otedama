/**
 * UI Enhancements
 * Progressive enhancement for better UX
 */

class UIEnhancements {
    constructor() {
        this.init();
    }

    init() {
        this.setupAccessibility();
        this.setupFormValidation();
        this.setupCopyToClipboard();
        this.setupLoadingStates();
        this.setupErrorHandling();
        this.setupTooltips();
        this.setupKeyboardNavigation();
        this.setupResponsiveMenus();
        this.setupAnimations();
    }

    /**
     * Accessibility Enhancements
     */
    setupAccessibility() {
        // Announce dynamic content changes
        this.createLiveRegion();
        
        // Add focus indicators
        document.addEventListener('focusin', (e) => {
            if (e.target.matches('button, a, input, select, textarea')) {
                e.target.setAttribute('data-focus-visible', 'true');
            }
        });
        
        document.addEventListener('focusout', (e) => {
            e.target.removeAttribute('data-focus-visible');
        });
        
        // Escape key to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal--open');
                if (openModal) {
                    this.closeModal(openModal);
                }
            }
        });
    }

    createLiveRegion() {
        const liveRegion = document.createElement('div');
        liveRegion.id = 'live-region';
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('aria-atomic', 'true');
        liveRegion.className = 'sr-only';
        document.body.appendChild(liveRegion);
    }

    announce(message) {
        const liveRegion = document.getElementById('live-region');
        if (liveRegion) {
            liveRegion.textContent = message;
            setTimeout(() => {
                liveRegion.textContent = '';
            }, 1000);
        }
    }

    /**
     * Form Validation
     */
    setupFormValidation() {
        const forms = document.querySelectorAll('form[data-validate]');
        
        forms.forEach(form => {
            form.addEventListener('submit', (e) => {
                if (!this.validateForm(form)) {
                    e.preventDefault();
                }
            });
            
            // Real-time validation
            form.querySelectorAll('input, select, textarea').forEach(field => {
                field.addEventListener('blur', () => {
                    this.validateField(field);
                });
                
                field.addEventListener('input', () => {
                    if (field.classList.contains('input--error')) {
                        this.validateField(field);
                    }
                });
            });
        });
    }

    validateForm(form) {
        let isValid = true;
        const fields = form.querySelectorAll('[required], [pattern], [type="email"]');
        
        fields.forEach(field => {
            if (!this.validateField(field)) {
                isValid = false;
            }
        });
        
        return isValid;
    }

    validateField(field) {
        const wrapper = field.closest('.input-group, .form-group');
        let isValid = true;
        let errorMessage = '';
        
        // Remove previous error
        this.clearFieldError(field);
        
        // Required validation
        if (field.hasAttribute('required') && !field.value.trim()) {
            isValid = false;
            errorMessage = field.dataset.errorRequired || 'This field is required';
        }
        
        // Pattern validation
        else if (field.hasAttribute('pattern')) {
            const pattern = new RegExp(field.getAttribute('pattern'));
            if (!pattern.test(field.value)) {
                isValid = false;
                errorMessage = field.dataset.errorPattern || 'Please match the requested format';
            }
        }
        
        // Email validation
        else if (field.type === 'email' && field.value) {
            const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailPattern.test(field.value)) {
                isValid = false;
                errorMessage = 'Please enter a valid email address';
            }
        }
        
        // Show error if invalid
        if (!isValid && wrapper) {
            this.showFieldError(field, errorMessage);
        }
        
        return isValid;
    }

    showFieldError(field, message) {
        const wrapper = field.closest('.input-group, .form-group');
        field.classList.add('input--error');
        field.setAttribute('aria-invalid', 'true');
        
        if (wrapper) {
            const errorId = `error-${field.id || Math.random().toString(36).substr(2, 9)}`;
            const errorElement = document.createElement('div');
            errorElement.id = errorId;
            errorElement.className = 'input-error';
            errorElement.innerHTML = `<span aria-hidden="true">⚠️</span> ${message}`;
            
            wrapper.appendChild(errorElement);
            field.setAttribute('aria-describedby', errorId);
        }
        
        this.announce(`Error: ${message}`);
    }

    clearFieldError(field) {
        const wrapper = field.closest('.input-group, .form-group');
        field.classList.remove('input--error');
        field.removeAttribute('aria-invalid');
        field.removeAttribute('aria-describedby');
        
        if (wrapper) {
            const error = wrapper.querySelector('.input-error');
            if (error) {
                error.remove();
            }
        }
    }

    /**
     * Copy to Clipboard
     */
    setupCopyToClipboard() {
        document.addEventListener('click', async (e) => {
            const trigger = e.target.closest('[data-copy]');
            if (!trigger) return;
            
            const textToCopy = trigger.dataset.copy || trigger.textContent;
            
            try {
                await navigator.clipboard.writeText(textToCopy);
                this.showCopyFeedback(trigger, 'Copied!');
                this.announce('Copied to clipboard');
            } catch (err) {
                this.showCopyFeedback(trigger, 'Failed to copy', false);
                console.error('Copy failed:', err);
            }
        });
    }

    showCopyFeedback(element, message, success = true) {
        const existingFeedback = element.querySelector('.copy-feedback');
        
        const feedback = existingFeedback || document.createElement('div');
        feedback.className = 'copy-feedback';
        feedback.textContent = message;
        
        if (!success) {
            feedback.style.background = 'var(--color-error)';
        }
        
        if (!existingFeedback) {
            element.style.position = 'relative';
            element.appendChild(feedback);
        }
        
        // Show feedback
        requestAnimationFrame(() => {
            feedback.classList.add('show');
        });
        
        // Hide after delay
        setTimeout(() => {
            feedback.classList.remove('show');
        }, 2000);
    }

    /**
     * Loading States
     */
    setupLoadingStates() {
        // Add loading state to buttons
        document.addEventListener('click', (e) => {
            const button = e.target.closest('button[data-loading-text]');
            if (!button || button.disabled) return;
            
            const originalText = button.textContent;
            const loadingText = button.dataset.loadingText;
            
            button.disabled = true;
            button.classList.add('btn--loading');
            button.textContent = loadingText;
            
            // Store original text for restoration
            button.dataset.originalText = originalText;
        });
    }

    setButtonLoading(button, isLoading) {
        if (isLoading) {
            button.disabled = true;
            button.classList.add('btn--loading');
            button.dataset.originalText = button.textContent;
            button.textContent = button.dataset.loadingText || 'Loading...';
        } else {
            button.disabled = false;
            button.classList.remove('btn--loading');
            button.textContent = button.dataset.originalText || button.textContent;
        }
    }

    /**
     * Error Handling
     */
    setupErrorHandling() {
        // Global error handler
        window.addEventListener('error', (e) => {
            console.error('Global error:', e);
            this.showGlobalError('An unexpected error occurred. Please try again.');
        });
        
        // Unhandled promise rejection
        window.addEventListener('unhandledrejection', (e) => {
            console.error('Unhandled promise rejection:', e);
            this.showGlobalError('An unexpected error occurred. Please try again.');
        });
    }

    showGlobalError(message) {
        const container = document.querySelector('.container');
        if (!container) return;
        
        const existingError = document.getElementById('global-error');
        
        const errorDiv = existingError || document.createElement('div');
        errorDiv.id = 'global-error';
        errorDiv.className = 'error';
        errorDiv.innerHTML = `
            <span class="error__icon" aria-hidden="true">⚠️</span>
            <span class="error__message">${message}</span>
            <button class="btn btn--sm btn--ghost" onclick="UIEnhancements.hideGlobalError()" aria-label="Dismiss error">×</button>
        `;
        
        if (!existingError) {
            container.insertBefore(errorDiv, container.firstChild);
        }
        
        this.announce(`Error: ${message}`);
        
        // Auto-hide after 10 seconds
        setTimeout(() => {
            this.hideGlobalError();
        }, 10000);
    }

    static hideGlobalError() {
        const error = document.getElementById('global-error');
        if (error) {
            error.style.opacity = '0';
            setTimeout(() => error.remove(), 300);
        }
    }

    /**
     * Tooltips
     */
    setupTooltips() {
        // Initialize tooltips on hover
        document.addEventListener('mouseenter', (e) => {
            const trigger = e.target.closest('[data-tooltip]');
            if (!trigger) return;
            
            this.showTooltip(trigger);
        }, true);
        
        document.addEventListener('mouseleave', (e) => {
            const trigger = e.target.closest('[data-tooltip]');
            if (!trigger) return;
            
            this.hideTooltip(trigger);
        }, true);
        
        // Touch support
        document.addEventListener('touchstart', (e) => {
            const trigger = e.target.closest('[data-tooltip]');
            if (!trigger) return;
            
            e.preventDefault();
            this.toggleTooltip(trigger);
        });
    }

    showTooltip(element) {
        const text = element.dataset.tooltip;
        const position = element.dataset.tooltipPosition || 'top';
        
        const tooltip = document.createElement('div');
        tooltip.className = `tooltip-content tooltip-content--${position}`;
        tooltip.textContent = text;
        tooltip.setAttribute('role', 'tooltip');
        
        element.appendChild(tooltip);
        
        // Position adjustment
        requestAnimationFrame(() => {
            const rect = tooltip.getBoundingClientRect();
            if (rect.left < 0) {
                tooltip.style.left = '0';
                tooltip.style.transform = 'translateX(0)';
            } else if (rect.right > window.innerWidth) {
                tooltip.style.left = 'auto';
                tooltip.style.right = '0';
                tooltip.style.transform = 'translateX(0)';
            }
        });
    }

    hideTooltip(element) {
        const tooltip = element.querySelector('.tooltip-content');
        if (tooltip) {
            tooltip.remove();
        }
    }

    toggleTooltip(element) {
        const existingTooltip = element.querySelector('.tooltip-content');
        if (existingTooltip) {
            this.hideTooltip(element);
        } else {
            this.showTooltip(element);
        }
    }

    /**
     * Keyboard Navigation
     */
    setupKeyboardNavigation() {
        // Tab navigation for custom components
        document.addEventListener('keydown', (e) => {
            // Arrow key navigation for tabs
            if (e.target.matches('.tab')) {
                this.handleTabKeyboard(e);
            }
            
            // Enter/Space for clickable elements
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) {
                e.preventDefault();
                e.target.click();
            }
        });
    }

    handleTabKeyboard(e) {
        const tabs = Array.from(e.target.parentElement.querySelectorAll('.tab'));
        const currentIndex = tabs.indexOf(e.target);
        let newIndex;
        
        switch (e.key) {
            case 'ArrowRight':
                newIndex = (currentIndex + 1) % tabs.length;
                break;
            case 'ArrowLeft':
                newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                break;
            case 'Home':
                newIndex = 0;
                break;
            case 'End':
                newIndex = tabs.length - 1;
                break;
            default:
                return;
        }
        
        e.preventDefault();
        tabs[newIndex].focus();
        tabs[newIndex].click();
    }

    /**
     * Responsive Menus
     */
    setupResponsiveMenus() {
        // Mobile menu toggle
        const menuToggles = document.querySelectorAll('[data-menu-toggle]');
        
        menuToggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                const targetId = toggle.dataset.menuToggle;
                const target = document.getElementById(targetId);
                
                if (target) {
                    target.classList.toggle('is-open');
                    toggle.setAttribute('aria-expanded', target.classList.contains('is-open'));
                }
            });
        });
        
        // Close menu on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('[data-menu-toggle], .menu')) {
                document.querySelectorAll('.menu.is-open').forEach(menu => {
                    menu.classList.remove('is-open');
                    const toggle = document.querySelector(`[data-menu-toggle="${menu.id}"]`);
                    if (toggle) {
                        toggle.setAttribute('aria-expanded', 'false');
                    }
                });
            }
        });
    }

    /**
     * Animations
     */
    setupAnimations() {
        // Respect prefers-reduced-motion
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        
        if (prefersReducedMotion.matches) {
            document.documentElement.classList.add('reduce-motion');
        }
        
        prefersReducedMotion.addEventListener('change', (e) => {
            if (e.matches) {
                document.documentElement.classList.add('reduce-motion');
            } else {
                document.documentElement.classList.remove('reduce-motion');
            }
        });
        
        // Intersection Observer for fade-in animations
        if ('IntersectionObserver' in window) {
            const animatedElements = document.querySelectorAll('[data-animate]');
            
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible');
                        observer.unobserve(entry.target);
                    }
                });
            }, {
                threshold: 0.1
            });
            
            animatedElements.forEach(el => observer.observe(el));
        }
    }

    /**
     * Modal Management
     */
    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        
        modal.classList.add('modal--open');
        document.body.style.overflow = 'hidden';
        
        // Focus management
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length) {
            focusableElements[0].focus();
        }
        
        // Trap focus
        modal.addEventListener('keydown', (e) => this.trapFocus(e, modal));
        
        this.announce('Dialog opened');
    }

    closeModal(modal) {
        modal.classList.remove('modal--open');
        document.body.style.overflow = '';
        
        // Restore focus
        const trigger = document.querySelector(`[data-modal-trigger="${modal.id}"]`);
        if (trigger) {
            trigger.focus();
        }
        
        this.announce('Dialog closed');
    }

    trapFocus(e, container) {
        if (e.key !== 'Tab') return;
        
        const focusableElements = container.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        
        if (e.shiftKey && document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
        }
    }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.uiEnhancements = new UIEnhancements();
    });
} else {
    window.uiEnhancements = new UIEnhancements();
}

// Export for use in other scripts
window.UIEnhancements = UIEnhancements;