/**
 * Progressive Web App (PWA) Implementation
 * Offline support, push notifications, and app-like experience
 */

import { logger } from '../../core/logger.js';

/**
 * PWA Manager
 */
export class PWAManager {
  constructor(options = {}) {
    this.options = {
      name: 'Otedama',
      shortName: 'Otedama',
      description: 'Advanced cryptocurrency trading and mining platform',
      startUrl: '/',
      display: 'standalone',
      orientation: 'any',
      themeColor: '#2196f3',
      backgroundColor: '#0a0a0a',
      icons: options.icons || this.getDefaultIcons(),
      cacheVersion: 'v1',
      cacheStrategies: options.cacheStrategies || this.getDefaultCacheStrategies(),
      ...options
    };
    
    this.registration = null;
    this.deferredPrompt = null;
    this.isOnline = navigator.onLine;
    this.subscribers = new Map();
  }
  
  /**
   * Get default icons
   */
  getDefaultIcons() {
    return [
      { src: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { src: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png' },
      { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { src: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { src: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ];
  }
  
  /**
   * Get default cache strategies
   */
  getDefaultCacheStrategies() {
    return {
      // Cache first for static assets
      static: {
        pattern: /\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ttf|eot)$/,
        strategy: 'cacheFirst',
        cacheName: 'static-assets',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      },
      
      // Network first for API calls
      api: {
        pattern: /\/api\//,
        strategy: 'networkFirst',
        cacheName: 'api-cache',
        maxAge: 5 * 60 * 1000 // 5 minutes
      },
      
      // Stale while revalidate for pages
      pages: {
        pattern: /\.html$|\/$/,
        strategy: 'staleWhileRevalidate',
        cacheName: 'pages-cache',
        maxAge: 24 * 60 * 60 * 1000 // 1 day
      }
    };
  }
  
  /**
   * Initialize PWA
   */
  async initialize() {
    if (!('serviceWorker' in navigator)) {
      logger.warn('Service Worker not supported');
      return false;
    }
    
    try {
      // Register service worker
      await this.registerServiceWorker();
      
      // Set up event listeners
      this.setupEventListeners();
      
      // Generate and inject manifest
      this.injectManifest();
      
      // Check for updates
      this.checkForUpdates();
      
      logger.info('PWA initialized successfully');
      return true;
      
    } catch (error) {
      logger.error('Failed to initialize PWA:', error);
      return false;
    }
  }
  
  /**
   * Register service worker
   */
  async registerServiceWorker() {
    const swPath = '/sw.js';
    
    // Generate service worker if needed
    await this.generateServiceWorker();
    
    this.registration = await navigator.serviceWorker.register(swPath);
    
    logger.info('Service Worker registered');
    
    // Handle updates
    this.registration.addEventListener('updatefound', () => {
      const newWorker = this.registration.installing;
      
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          this.onUpdateAvailable();
        }
      });
    });
    
    return this.registration;
  }
  
  /**
   * Generate service worker
   */
  async generateServiceWorker() {
    const sw = `
// Otedama Service Worker
const CACHE_VERSION = '${this.options.cacheVersion}';
const CACHE_NAMES = {
  static: 'static-assets-' + CACHE_VERSION,
  api: 'api-cache-' + CACHE_VERSION,
  pages: 'pages-cache-' + CACHE_VERSION
};

// Install event
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAMES.static).then(cache => {
      return cache.addAll([
        '/',
        '/offline.html',
        '/css/app.css',
        '/js/app.js'
      ]);
    })
  );
  
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (!Object.values(CACHE_NAMES).includes(cacheName)) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  self.clients.claim();
});

// Fetch event
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') return;
  
  // Apply cache strategies
  ${Object.entries(this.options.cacheStrategies).map(([name, config]) => `
  if (${config.pattern}.test(url.pathname)) {
    event.respondWith(${config.strategy}(request, '${config.cacheName}'));
    return;
  }
  `).join('')}
  
  // Default to network
  event.respondWith(
    fetch(request).catch(() => {
      return caches.match('/offline.html');
    })
  );
});

// Cache strategies
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  if (cached) {
    return cached;
  }
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  });
  
  return cached || fetchPromise;
}

// Push notification handling
self.addEventListener('push', event => {
  const options = {
    body: event.data ? event.data.text() : 'New notification',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    }
  };
  
  event.waitUntil(
    self.registration.showNotification('Otedama', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  event.waitUntil(
    clients.openWindow('/')
  );
});

// Background sync
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  // Implement data synchronization
  console.log('[SW] Syncing data...');
}
    `;
    
    // This would normally write to file system
    // For now, we'll store it for the service worker to use
    this._serviceWorkerContent = sw;
    
    return sw;
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Online/offline events
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.onOnline();
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.onOffline();
    });
    
    // Install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.onInstallPromptAvailable();
    });
    
    // App installed
    window.addEventListener('appinstalled', () => {
      this.onAppInstalled();
    });
  }
  
  /**
   * Inject manifest
   */
  injectManifest() {
    const manifest = {
      name: this.options.name,
      short_name: this.options.shortName,
      description: this.options.description,
      start_url: this.options.startUrl,
      display: this.options.display,
      orientation: this.options.orientation,
      theme_color: this.options.themeColor,
      background_color: this.options.backgroundColor,
      icons: this.options.icons,
      shortcuts: [
        {
          name: 'Trading',
          short_name: 'Trade',
          description: 'Open trading dashboard',
          url: '/trading',
          icons: [{ src: '/icons/trading-96x96.png', sizes: '96x96' }]
        },
        {
          name: 'Mining',
          short_name: 'Mine',
          description: 'Open mining dashboard',
          url: '/mining',
          icons: [{ src: '/icons/mining-96x96.png', sizes: '96x96' }]
        }
      ],
      categories: ['finance', 'cryptocurrency'],
      screenshots: [
        {
          src: '/screenshots/dashboard.png',
          sizes: '1280x720',
          type: 'image/png'
        }
      ]
    };
    
    // Create blob URL for manifest
    const manifestBlob = new Blob([JSON.stringify(manifest)], {
      type: 'application/manifest+json'
    });
    const manifestUrl = URL.createObjectURL(manifestBlob);
    
    // Inject manifest link
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = manifestUrl;
    
    // Add meta tags
    this.addMetaTags();
  }
  
  /**
   * Add PWA meta tags
   */
  addMetaTags() {
    const metaTags = [
      { name: 'theme-color', content: this.options.themeColor },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: this.options.shortName },
      { name: 'mobile-web-app-capable', content: 'yes' }
    ];
    
    metaTags.forEach(tag => {
      let meta = document.querySelector(`meta[name="${tag.name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = tag.name;
        document.head.appendChild(meta);
      }
      meta.content = tag.content;
    });
    
    // Add Apple touch icons
    this.options.icons.forEach(icon => {
      if (icon.sizes === '192x192' || icon.sizes === '512x512') {
        let link = document.querySelector(`link[rel="apple-touch-icon"][sizes="${icon.sizes}"]`);
        if (!link) {
          link = document.createElement('link');
          link.rel = 'apple-touch-icon';
          link.sizes = icon.sizes;
          document.head.appendChild(link);
        }
        link.href = icon.src;
      }
    });
  }
  
  /**
   * Check for updates
   */
  async checkForUpdates() {
    if (!this.registration) return;
    
    try {
      await this.registration.update();
    } catch (error) {
      logger.error('Failed to check for updates:', error);
    }
  }
  
  /**
   * Show install prompt
   */
  async showInstallPrompt() {
    if (!this.deferredPrompt) {
      logger.warn('Install prompt not available');
      return false;
    }
    
    this.deferredPrompt.prompt();
    
    const { outcome } = await this.deferredPrompt.userChoice;
    
    logger.info(`Install prompt outcome: ${outcome}`);
    
    this.deferredPrompt = null;
    
    return outcome === 'accepted';
  }
  
  /**
   * Enable push notifications
   */
  async enablePushNotifications() {
    if (!('Notification' in window)) {
      logger.warn('Notifications not supported');
      return false;
    }
    
    if (Notification.permission === 'denied') {
      logger.warn('Notifications denied');
      return false;
    }
    
    if (Notification.permission === 'granted') {
      return this.subscribeToPush();
    }
    
    // Request permission
    const permission = await Notification.requestPermission();
    
    if (permission === 'granted') {
      return this.subscribeToPush();
    }
    
    return false;
  }
  
  /**
   * Subscribe to push notifications
   */
  async subscribeToPush() {
    if (!this.registration) {
      logger.error('Service worker not registered');
      return false;
    }
    
    try {
      const subscription = await this.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(this.options.vapidPublicKey)
      });
      
      // Send subscription to server
      await this.sendSubscriptionToServer(subscription);
      
      logger.info('Push notifications enabled');
      
      return true;
      
    } catch (error) {
      logger.error('Failed to subscribe to push:', error);
      return false;
    }
  }
  
  /**
   * Send subscription to server
   */
  async sendSubscriptionToServer(subscription) {
    // Implementation would send to your server
    logger.info('Subscription:', subscription);
  }
  
  /**
   * Convert VAPID key
   */
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    
    return outputArray;
  }
  
  /**
   * Show notification
   */
  async showNotification(title, options = {}) {
    if (!('Notification' in window)) return false;
    
    if (Notification.permission !== 'granted') return false;
    
    const notification = new Notification(title, {
      icon: '/icons/icon-192x192.png',
      badge: '/icons/badge-72x72.png',
      vibrate: [200, 100, 200],
      ...options
    });
    
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    
    return true;
  }
  
  /**
   * Event handlers
   */
  onUpdateAvailable() {
    logger.info('App update available');
    this.showUpdateBanner();
  }
  
  onInstallPromptAvailable() {
    logger.info('Install prompt available');
    this.showInstallBanner();
  }
  
  onAppInstalled() {
    logger.info('App installed');
    this.hideInstallBanner();
  }
  
  onOnline() {
    logger.info('App is online');
    this.showOnlineIndicator();
  }
  
  onOffline() {
    logger.info('App is offline');
    this.showOfflineIndicator();
  }
  
  /**
   * UI helpers
   */
  showUpdateBanner() {
    const banner = document.createElement('div');
    banner.className = 'otedama-pwa-banner otedama-pwa-banner--update';
    banner.innerHTML = `
      <div class="otedama-pwa-banner__content">
        <span>A new version is available!</span>
        <button class="otedama-pwa-banner__button" onclick="location.reload()">
          Update
        </button>
      </div>
    `;
    document.body.appendChild(banner);
  }
  
  showInstallBanner() {
    const banner = document.createElement('div');
    banner.className = 'otedama-pwa-banner otedama-pwa-banner--install';
    banner.innerHTML = `
      <div class="otedama-pwa-banner__content">
        <span>Install Otedama for a better experience</span>
        <button class="otedama-pwa-banner__button" id="install-button">
          Install
        </button>
        <button class="otedama-pwa-banner__close" aria-label="Close">×</button>
      </div>
    `;
    
    document.body.appendChild(banner);
    
    document.getElementById('install-button').addEventListener('click', () => {
      this.showInstallPrompt();
    });
    
    banner.querySelector('.otedama-pwa-banner__close').addEventListener('click', () => {
      banner.remove();
    });
  }
  
  hideInstallBanner() {
    const banner = document.querySelector('.otedama-pwa-banner--install');
    if (banner) banner.remove();
  }
  
  showOnlineIndicator() {
    const indicator = document.querySelector('.otedama-pwa-indicator');
    if (indicator) {
      indicator.textContent = 'Online';
      indicator.className = 'otedama-pwa-indicator otedama-pwa-indicator--online';
    }
  }
  
  showOfflineIndicator() {
    const indicator = document.querySelector('.otedama-pwa-indicator');
    if (indicator) {
      indicator.textContent = 'Offline';
      indicator.className = 'otedama-pwa-indicator otedama-pwa-indicator--offline';
    }
  }
}

/**
 * PWA styles
 */
export const pwaStyles = `
  .otedama-pwa-banner {
    position: fixed;
    bottom: 20px;
    left: 20px;
    right: 20px;
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: ${DesignTokens.borderRadius.lg};
    box-shadow: ${DesignTokens.shadows.lg};
    padding: ${DesignTokens.spacing[3]} ${DesignTokens.spacing[4]};
    z-index: ${DesignTokens.zIndex.fixed};
    animation: slide-up 0.3s ease-out;
  }
  
  .otedama-pwa-banner__content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${DesignTokens.spacing[3]};
  }
  
  .otedama-pwa-banner__button {
    padding: ${DesignTokens.spacing[2]} ${DesignTokens.spacing[4]};
    background: ${DesignTokens.colors.primary[500]};
    color: white;
    border: none;
    border-radius: ${DesignTokens.borderRadius.md};
    font-weight: ${DesignTokens.typography.fontWeight.medium};
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .otedama-pwa-banner__button:hover {
    background: ${DesignTokens.colors.primary[600]};
  }
  
  .otedama-pwa-banner__close {
    position: absolute;
    top: ${DesignTokens.spacing[2]};
    right: ${DesignTokens.spacing[2]};
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    font-size: 20px;
    cursor: pointer;
    color: var(--text-secondary);
  }
  
  .otedama-pwa-indicator {
    position: fixed;
    top: 20px;
    right: 20px;
    padding: ${DesignTokens.spacing[1]} ${DesignTokens.spacing[3]};
    border-radius: ${DesignTokens.borderRadius.full};
    font-size: ${DesignTokens.typography.fontSize.xs};
    font-weight: ${DesignTokens.typography.fontWeight.medium};
    z-index: ${DesignTokens.zIndex.fixed};
  }
  
  .otedama-pwa-indicator--online {
    background: ${DesignTokens.colors.semantic.success};
    color: white;
  }
  
  .otedama-pwa-indicator--offline {
    background: ${DesignTokens.colors.semantic.error};
    color: white;
  }
  
  @keyframes slide-up {
    from {
      transform: translateY(100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  
  @media (max-width: ${DesignTokens.breakpoints.sm}) {
    .otedama-pwa-banner {
      left: 10px;
      right: 10px;
      bottom: 10px;
    }
    
    .otedama-pwa-banner__content {
      flex-direction: column;
      text-align: center;
    }
  }
`;

export default PWAManager;