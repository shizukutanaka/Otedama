// Otedama Service Worker v0.5
// Provides offline functionality and performance optimization

const CACHE_NAME = 'otedama-v0.5';
const STATIC_CACHE = 'otedama-static-v0.5';
const API_CACHE = 'otedama-api-v0.5';

// Files to cache for offline use
const STATIC_FILES = [
  '/mobile.html',
  '/dashboard.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install');
  
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[ServiceWorker] Caching static assets');
      return cache.addAll(STATIC_FILES);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && 
              cacheName !== STATIC_CACHE && 
              cacheName !== API_CACHE) {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event - serve from cache when possible
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }
  
  // Handle API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }
  
  // Handle static assets
  event.respondWith(handleStaticRequest(request));
});

// Handle API requests with network-first strategy
async function handleApiRequest(request) {
  const cache = await caches.open(API_CACHE);
  
  try {
    // Try network first
    const response = await fetch(request);
    
    // Cache successful responses
    if (response.status === 200) {
      const clonedResponse = response.clone();
      cache.put(request, clonedResponse);
    }
    
    return response;
  } catch (error) {
    // Fallback to cache
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      console.log('[ServiceWorker] Serving API from cache:', request.url);
      return cachedResponse;
    }
    
    // Return offline response
    return new Response(JSON.stringify({
      error: 'Offline',
      message: 'Data not available offline'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handle static assets with cache-first strategy
async function handleStaticRequest(request) {
  const cache = await caches.open(STATIC_CACHE);
  
  // Check cache first
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    // Fetch from network
    const response = await fetch(request);
    
    // Cache successful responses
    if (response.status === 200) {
      const clonedResponse = response.clone();
      cache.put(request, clonedResponse);
    }
    
    return response;
  } catch (error) {
    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
      const offlineResponse = await cache.match('/mobile.html');
      if (offlineResponse) {
        return offlineResponse;
      }
    }
    
    // Return 404 for other requests
    return new Response('Not found', { status: 404 });
  }
}

// Background sync for offline actions
self.addEventListener('sync', (event) => {
  console.log('[ServiceWorker] Sync event:', event.tag);
  
  if (event.tag === 'sync-stats') {
    event.waitUntil(syncStats());
  }
});

// Sync stats when back online
async function syncStats() {
  try {
    const response = await fetch('/api/stats');
    const data = await response.json();
    
    // Send update to all clients
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'stats-update',
        data: data
      });
    });
  } catch (error) {
    console.error('[ServiceWorker] Sync failed:', error);
  }
}

// Push notifications
self.addEventListener('push', (event) => {
  console.log('[ServiceWorker] Push received');
  
  let options = {
    body: 'New update from Otedama',
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    vibrate: [200, 100, 200],
    data: {
      timestamp: Date.now()
    },
    actions: [
      {
        action: 'open',
        title: 'Open Dashboard',
        icon: '/icon-96.png'
      }
    ]
  };
  
  if (event.data) {
    try {
      const data = event.data.json();
      options = { ...options, ...data };
    } catch (e) {
      options.body = event.data.text();
    }
  }
  
  event.waitUntil(
    self.registration.showNotification('Otedama Mining Pool', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', (event) => {
  console.log('[ServiceWorker] Notification click');
  
  event.notification.close();
  
  if (event.action === 'open') {
    event.waitUntil(
      clients.openWindow('/mobile.html')
    );
  } else {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(clientList => {
        // Focus existing window or open new one
        for (const client of clientList) {
          if (client.url.includes('/mobile.html') && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow('/mobile.html');
      })
    );
  }
});

// Periodic background sync for regular updates
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-stats') {
    event.waitUntil(updateStats());
  }
});

// Update stats in background
async function updateStats() {
  try {
    const response = await fetch('/api/stats');
    const data = await response.json();
    
    // Check for important alerts
    if (data.alerts && data.alerts.active > 0) {
      await self.registration.showNotification('Otedama Alert', {
        body: `${data.alerts.active} active alerts`,
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'alert',
        renotify: true
      });
    }
    
    // Check fee collection status
    if (data.fees && data.fees.totalCollectedBTC > 0) {
      const cache = await caches.open(API_CACHE);
      const lastFeesResponse = await cache.match('/api/fees');
      
      if (lastFeesResponse) {
        const lastFees = await lastFeesResponse.json();
        const newFees = data.fees.totalCollectedBTC - (lastFees.totalCollectedBTC || 0);
        
        if (newFees > 0.001) { // Significant fee collection
          await self.registration.showNotification('Fee Collection', {
            body: `Collected ${newFees.toFixed(8)} BTC`,
            icon: '/icon-192.png',
            badge: '/icon-96.png',
            tag: 'fees'
          });
        }
      }
    }
  } catch (error) {
    console.error('[ServiceWorker] Background update failed:', error);
  }
}

// Message handling
self.addEventListener('message', (event) => {
  console.log('[ServiceWorker] Message received:', event.data);
  
  if (event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

// Performance optimization - precache important API responses
async function precacheApiData() {
  const apiEndpoints = [
    '/api/stats',
    '/api/fees', 
    '/api/dex/prices'
  ];
  
  const cache = await caches.open(API_CACHE);
  
  for (const endpoint of apiEndpoints) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        await cache.put(endpoint, response);
      }
    } catch (error) {
      console.error(`[ServiceWorker] Failed to precache ${endpoint}:`, error);
    }
  }
}

// Precache on activation
self.addEventListener('activate', event => {
  event.waitUntil(precacheApiData());
});
