
import 'dotenv/config';

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

/**
 * Fetches the latest prices from the CoinGecko API.
 * @returns {Promise<Object|null>} A promise that resolves to the price data object or null if an error occurs.
 */
/**
 * Fetches prices from CoinMarketCap as a fallback.
 * @returns {Promise<Object|null>} Price data or null.
 */
async function fetchFromCoinMarketCap() {
    if (!process.env.COINMARKETCAP_API_KEY) {
        console.warn('CoinMarketCap API key not found. Skipping fallback.');
        return null;
    }

    const params = new URLSearchParams({
        symbol: COIN_SYMBOLS.join(','),
        convert: 'USD,BTC',
    });

    try {
        const response = await fetch(`${COINMARKETCAP_API_URL}?${params}`, {
            headers: {
                'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY,
            },
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`CoinMarketCap API request failed: ${response.status}`, errorBody);
            return null;
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
    } catch (error) {
        console.error('Error fetching from CoinMarketCap:', error.message);
        return null;
    }
}

/**
 * Fetches the latest prices from CoinGecko with a fallback to CoinMarketCap.
 * @returns {Promise<Object|null>} A promise that resolves to the price data object or null if an error occurs.
 */
async function getPrices() {
    const params = new URLSearchParams({
        ids: COIN_IDS.join(','),
        vs_currencies: VS_CURRENCIES,
    });

    try {
        const response = await fetch(`${COINGECKO_API_URL}?${params}`);
        if (!response.ok) {
            // Log the error with status for better debugging
            const errorBody = await response.text();
            console.error(`CoinGecko API request failed with status: ${response.status}`, errorBody);
            throw new Error(`API request failed: ${response.status}`);
        }
        const data = await response.json();
        console.log('Successfully fetched latest prices:', data);
        return data;
    } catch (error) {
        console.error('Error fetching prices from CoinGecko:', error.message);
        console.log('Attempting to fetch from CoinMarketCap as a fallback...');
        return fetchFromCoinMarketCap();
    }
}

export { getPrices, COIN_IDS, VS_CURRENCIES };
