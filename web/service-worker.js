/**
 * Otedama Ver0.6 Service Worker
 * PWA support for BTC-only mining pool
 */

const CACHE_NAME = 'otedama-v0.6.0';
const STATIC_CACHE = 'otedama-static-v0.6.0';
const DYNAMIC_CACHE = 'otedama-dynamic-v0.6.0';

// Files to cache for offline use
const STATIC_FILES = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/analytics.html',
  '/mobile-app.html',
  '/manifest.json',
  '/css/responsive.css',
  '/components/mobile-nav.js',
  '/api/health',
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNGRkQ3MDAiLz4KPHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiBzdHlsZT0idHJhbnNmb3JtOiB0cmFuc2xhdGUoNnB4LCA2cHgpIj4KPHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIGZpbGw9IiMwMDAiPgo8L3N2Zz4KPC9zdmc+'
];

// API endpoints to cache dynamically
const API_ENDPOINTS = [
  '/api/stats',
  '/api/pool',
  '/api/dex',
  '/api/fees',
  '/api/languages'
];

// Install event - cache static files
self.addEventListener('install', event => {
  console.log('🔧 Service Worker Ver0.6 installing...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('📦 Caching static files for offline use');
        return cache.addAll(STATIC_FILES);
      })
      .then(() => {
        console.log('✅ Service Worker Ver0.6 installed successfully');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('❌ Service Worker installation failed:', error);
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', event => {
  console.log('🚀 Service Worker Ver0.6 activating...');
  
  event.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== STATIC_CACHE && cacheName !== DYNAMIC_CACHE) {
              console.log('🗑️ Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      // Take control of all pages
      self.clients.claim()
    ])
    .then(() => {
      console.log('✅ Service Worker Ver0.6 activated and ready');
    })
  );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }
  
  // Skip WebSocket connections
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }
  
  // Handle different types of requests
  if (url.pathname.startsWith('/api/')) {
    // API requests - network first, cache fallback
    event.respondWith(handleAPIRequest(request));
  } else {
    // Static files - cache first, network fallback
    event.respondWith(handleStaticRequest(request));
  }
});

// Handle API requests with network-first strategy
async function handleAPIRequest(request) {
  const url = new URL(request.url);
  
  try {
    // Try network first
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cache successful API responses
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
      
      // Add BTC-specific headers
      const modifiedResponse = new Response(networkResponse.body, {
        status: networkResponse.status,
        statusText: networkResponse.statusText,
        headers: {
          ...Object.fromEntries(networkResponse.headers.entries()),
          'X-Otedama-Version': '0.6.0',
          'X-Payout-Currency': 'BTC'
        }
      });
      
      return modifiedResponse;
    }
    
    throw new Error('Network response not ok');
    
  } catch (error) {
    console.log('🌐 Network failed for API, trying cache:', url.pathname);
    
    // Fallback to cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Return offline response for critical API endpoints
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        status: 'offline',
        message: 'Service Worker active, app cached',
        version: '0.6.0',
        payoutCurrency: 'BTC',
        btcOnlyPayouts: true
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname === '/api/stats') {
      return new Response(JSON.stringify({
        miners: 0,
        hashrate: 0,
        totalBTCPaid: 0,
        efficiency: 0,
        status: 'offline',
        version: '0.6.0'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Generic API error response
    return new Response(JSON.stringify({
      error: 'Offline - cached data not available',
      version: '0.6.0',
      btcOnlyPayouts: true
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Handle static requests with cache-first strategy
async function handleStaticRequest(request) {
  try {
    // Try cache first
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Try network
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cache new static content
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
    
  } catch (error) {
    console.log('🌐 Request failed:', request.url);
    
    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
      const offlineHTML = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Otedama Ver0.6 - Offline</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    background: linear-gradient(135deg, #FF6B35, #FFD700);
                    color: white; 
                    text-align: center; 
                    padding: 50px;
                    margin: 0;
                }
                .container { 
                    max-width: 600px; 
                    margin: 0 auto; 
                    background: rgba(0,0,0,0.2);
                    padding: 40px;
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                }
                .btc-icon { font-size: 4em; margin-bottom: 20px; }
                h1 { color: #FFD700; margin-bottom: 20px; }
                .button { 
                    background: #FFD700; 
                    color: #000; 
                    padding: 15px 30px; 
                    border: none; 
                    border-radius: 10px; 
                    font-weight: bold;
                    margin: 10px;
                    cursor: pointer;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="btc-icon">₿</div>
                <h1>Otedama Ver0.6 - Offline Mode</h1>
                <p>You're currently offline, but don't worry!</p>
                <p>Your BTC mining data is cached and will sync when you're back online.</p>
                <p><strong>Features available offline:</strong></p>
                <ul style="text-align: left; display: inline-block;">
                    <li>✅ Cached mining statistics</li>
                    <li>✅ BTC conversion rates</li>
                    <li>✅ Pool configuration</li>
                    <li>✅ Language settings</li>
                </ul>
                <br><br>
                <button class="button" onclick="window.location.reload()">
                    🔄 Try Again
                </button>
                <button class="button" onclick="window.location.href='/'">
                    🏠 Home
                </button>
            </div>
            
            <script>
                // Auto-refresh when back online
                window.addEventListener('online', function() {
                    setTimeout(() => window.location.reload(), 1000);
                });
                
                // Show online status
                if (navigator.onLine) {
                    document.body.innerHTML += '<p style="margin-top: 20px;">🟢 Connection restored - refreshing...</p>';
                    setTimeout(() => window.location.reload(), 2000);
                }
            </script>
        </body>
        </html>
      `;
      
      return new Response(offlineHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    // Return error for other requests
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
}

// Handle messages from main thread
self.addEventListener('message', event => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'GET_VERSION':
      event.ports[0].postMessage({ 
        version: '0.6.0',
        btcOnlyPayouts: true,
        cacheStatus: 'active'
      });
      break;
      
    case 'CACHE_BTC_DATA':
      cacheBTCData(data);
      break;
      
    case 'CLEAR_CACHE':
      clearAllCaches();
      break;
      
    default:
      console.log('Unknown message type:', type);
  }
});

// Cache BTC-specific data
async function cacheBTCData(data) {
  try {
    const cache = await caches.open(DYNAMIC_CACHE);
    
    // Cache BTC conversion rates
    if (data.rates) {
      const ratesResponse = new Response(JSON.stringify(data.rates), {
        headers: { 'Content-Type': 'application/json' }
      });
      await cache.put('/api/btc-rates', ratesResponse);
    }
    
    // Cache BTC balance data
    if (data.balance) {
      const balanceResponse = new Response(JSON.stringify(data.balance), {
        headers: { 'Content-Type': 'application/json' }
      });
      await cache.put('/api/btc-balance', balanceResponse);
    }
    
    console.log('✅ BTC data cached successfully');
    
  } catch (error) {
    console.error('❌ Failed to cache BTC data:', error);
  }
}

// Clear all caches
async function clearAllCaches() {
  try {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.map(cacheName => caches.delete(cacheName))
    );
    console.log('🗑️ All caches cleared');
  } catch (error) {
    console.error('❌ Failed to clear caches:', error);
  }
}

// Background sync for BTC data
self.addEventListener('sync', event => {
  if (event.tag === 'btc-sync') {
    event.waitUntil(syncBTCData());
  }
});

async function syncBTCData() {
  try {
    console.log('🔄 Syncing BTC data in background...');
    
    const responses = await Promise.allSettled([
      fetch('/api/stats'),
      fetch('/api/fees'),
      fetch('/api/pool')
    ]);
    
    const cache = await caches.open(DYNAMIC_CACHE);
    
    responses.forEach((response, index) => {
      if (response.status === 'fulfilled' && response.value.ok) {
        const endpoints = ['/api/stats', '/api/fees', '/api/pool'];
        cache.put(endpoints[index], response.value.clone());
      }
    });
    
    console.log('✅ BTC data sync completed');
    
  } catch (error) {
    console.error('❌ BTC data sync failed:', error);
  }
}

// Push notifications for BTC payouts
self.addEventListener('push', event => {
  if (!event.data) return;
  
  try {
    const data = event.data.json();
    
    if (data.type === 'btc_payout') {
      const options = {
        body: `You received ${data.amount} BTC! 💰`,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'btc-payout',
        requireInteraction: true,
        actions: [
          {
            action: 'view',
            title: 'View Balance',
            icon: '/action-view.png'
          },
          {
            action: 'close',
            title: 'Close',
            icon: '/action-close.png'
          }
        ],
        data: {
          url: '/?page=balance',
          amount: data.amount
        }
      };
      
      event.waitUntil(
        self.registration.showNotification('₿ BTC Payout Received!', options)
      );
    }
    
  } catch (error) {
    console.error('❌ Push notification error:', error);
  }
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow(event.notification.data.url || '/')
    );
  }
});

console.log('🚀 Otedama Ver0.6 Service Worker loaded - BTC-only payouts ready!');
