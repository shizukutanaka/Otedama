
import 'dotenv/config';
import { getErrorHandler, OtedamaError, ErrorCategory, CircuitBreaker } from '../lib/core/standardized-error-handler.js';
import { RetryManager } from '../lib/retry-manager.js';

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINMARKETCAP_API_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
// As per the roadmap, we'll start with a few key currencies.
// Expanded based on package.json keywords and common mining coins
const COIN_IDS = [
    'bitcoin', 'ethereum', 'monero', 'ravencoin', 'litecoin', 'dogecoin', 
    'bitcoin-cash', 'zcash', 'ethereum-classic', 'dash', 'cardano', 'solana', 'polkadot'
];
const COIN_SYMBOLS = [
    'BTC', 'ETH', 'XMR', 'RVN', 'LTC', 'DOGE', 
    'BCH', 'ZEC', 'ETC', 'DASH', 'ADA', 'SOL', 'DOT'
];
const VS_CURRENCIES = 'usd,btc';

// Initialize retry manager
const retryManager = new RetryManager({
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    timeout: 15000
});

// Configure services
retryManager.configureService('coingecko', {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    timeout: 10000,
    retryableErrors: [429, 503, 'ETIMEDOUT'],
    fallbackUrl: COINMARKETCAP_API_URL,
    healthCheckUrl: 'https://api.coingecko.com/api/v3/ping',
    healthCheckInterval: 300000 // 5 minutes
});

retryManager.configureService('coinmarketcap', {
    maxRetries: 2,
    initialDelay: 2000,
    maxDelay: 10000,
    timeout: 10000,
    retryableErrors: [429, 503],
    healthCheckInterval: 300000
});

/**
 * Fetches the latest prices from the CoinGecko API.
 * @returns {Promise<Object|null>} A promise that resolves to the price data object or null if an error occurs.
 */
// Circuit breakers for external APIs
const coingeckoCircuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 60000, // 1 minute
    successThreshold: 2
});

const cmcCircuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 60000,
    successThreshold: 2
});

/**
 * Fetches prices from CoinMarketCap as a fallback.
 * @returns {Promise<Object|null>} Price data or null.
 */
async function fetchFromCoinMarketCap() {
    let errorHandler;
    try {
        errorHandler = getErrorHandler();
    } catch (e) {
        // Error handler not initialized, continue without it
        errorHandler = null;
    }
    
    if (!process.env.COINMARKETCAP_API_KEY) {
        console.warn('CoinMarketCap API key not found. Skipping fallback.');
        return null;
    }

    const params = new URLSearchParams({
        symbol: COIN_SYMBOLS.join(','),
        convert: 'USD,BTC',
    });

    try {
        return await cmcCircuitBreaker.execute(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            try {
                const response = await fetch(`${COINMARKETCAP_API_URL}?${params}`, {
                    headers: {
                        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY,
                    },
                    signal: controller.signal
                });
                
                clearTimeout(timeout);

                if (!response.ok) {
                    const errorBody = await response.text();
                    throw new OtedamaError(
                        `CoinMarketCap API request failed: ${response.status}`,
                        ErrorCategory.EXTERNAL_API,
                        { 
                            status: response.status,
                            body: errorBody,
                            service: 'coinmarketcap'
                        }
                    );
                }

                const data = await response.json();
                console.log('Successfully fetched prices from CoinMarketCap.');
                
                // Normalize CMC data to match CoinGecko's format
                const normalizedData = {};
                for (const symbol of COIN_SYMBOLS) {
                    const coinData = data.data[symbol];
                    if (coinData) {
                        const coinGeckoId = COIN_IDS[COIN_SYMBOLS.indexOf(symbol)];
                        normalizedData[coinGeckoId] = {
                            usd: coinData.quote.USD.price,
                            btc: coinData.quote.BTC.price,
                        };
                    }
                }
                return normalizedData;
            } finally {
                clearTimeout(timeout);
            }
        });
    } catch (error) {
        if (errorHandler) {
            await errorHandler.handleError(error, {
                service: 'coinmarketcap-api',
                category: ErrorCategory.EXTERNAL_API
            });
        } else {
            console.error('CoinMarketCap API error:', error.message);
        }
        return null;
    }
}

/**
 * Fetches the latest prices from CoinGecko with a fallback to CoinMarketCap.
 * @returns {Promise<Object|null>} A promise that resolves to the price data object or null if an error occurs.
 */
async function getPrices() {
    let errorHandler;
    try {
        errorHandler = getErrorHandler();
    } catch (e) {
        // Error handler not initialized, continue without it
        errorHandler = null;
    }
    const params = new URLSearchParams({
        ids: COIN_IDS.join(','),
        vs_currencies: VS_CURRENCIES,
    });

    try {
        // Try CoinGecko first with circuit breaker
        const data = await coingeckoCircuitBreaker.execute(async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            try {
                const response = await fetch(`${COINGECKO_API_URL}?${params}`, {
                    signal: controller.signal,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Otedama/1.0'
                    }
                });
                
                clearTimeout(timeout);
                
                if (!response.ok) {
                    // Handle rate limiting
                    if (response.status === 429) {
                        const retryAfter = response.headers.get('Retry-After') || '60';
                        throw new OtedamaError(
                            'CoinGecko rate limit exceeded',
                            ErrorCategory.RATE_LIMIT,
                            { 
                                retryAfter: parseInt(retryAfter),
                                service: 'coingecko'
                            }
                        );
                    }
                    
                    const errorBody = await response.text();
                    throw new OtedamaError(
                        `CoinGecko API request failed: ${response.status}`,
                        ErrorCategory.EXTERNAL_API,
                        { 
                            status: response.status,
                            body: errorBody,
                            service: 'coingecko'
                        }
                    );
                }
                
                const data = await response.json();
                console.log('Successfully fetched latest prices from CoinGecko');
                return data;
            } finally {
                clearTimeout(timeout);
            }
        }, async () => {
            // Fallback to CoinMarketCap
            console.log('CoinGecko circuit breaker open, falling back to CoinMarketCap...');
            return fetchFromCoinMarketCap();
        });
        
        return data;
        
    } catch (error) {
        if (errorHandler) {
            await errorHandler.handleError(error, {
                service: 'price-feed',
                category: ErrorCategory.EXTERNAL_API
            });
        } else {
            console.error('Price feed error:', error.message);
        }
        
        // Try fallback if primary failed
        console.log('Primary price feed failed, attempting fallback to CoinMarketCap...');
        return fetchFromCoinMarketCap();
    }
}

export { getPrices, COIN_IDS, VS_CURRENCIES };
