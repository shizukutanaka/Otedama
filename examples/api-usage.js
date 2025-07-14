#!/usr/bin/env node

/**
 * Otedama - Example: Using the API
 * This example demonstrates how to interact with Otedama's API
 */

import { WebSocket } from 'ws';

const API_BASE = 'http://localhost:8080';
const WS_URL = 'ws://localhost:8080';

// Get pool statistics
async function getStats() {
  try {
    const response = await fetch(`${API_BASE}/api/stats`);
    const data = await response.json();
    console.log('Pool Statistics:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to get stats:', error.message);
  }
}

// Connect to WebSocket for real-time updates
function connectWebSocket() {
  const ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    console.log('Connected to Otedama WebSocket');
    
    // Subscribe to all events
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: '*'
    }));
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('Received:', message);
    } catch (e) {
      console.error('Invalid message:', e.message);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
  
  ws.on('close', () => {
    console.log('Disconnected from WebSocket');
  });
  
  return ws;
}

// Example DEX operations
async function dexExample() {
  try {
    // Get available pools
    const response = await fetch(`${API_BASE}/api/dex/pools`);
    const pools = await response.json();
    console.log('Available pools:', pools);
    
    // Example swap request (requires DEX to be enabled)
    if (pools.length > 0) {
      const swapData = {
        poolId: pools[0].id,
        tokenIn: pools[0].token0,
        amountIn: '1000000', // Amount in smallest unit
        minAmountOut: '0'
      };
      
      console.log('Swap request:', swapData);
      // Uncomment to actually perform swap:
      // const swapResponse = await fetch(`${API_BASE}/api/dex/swap`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(swapData)
      // });
      // console.log('Swap result:', await swapResponse.json());
    }
  } catch (error) {
    console.error('DEX example error:', error.message);
  }
}

// Main function
async function main() {
  console.log('Otedama API Example\n');
  
  // Get initial stats
  await getStats();
  
  // Connect WebSocket
  console.log('\nConnecting to WebSocket...');
  const ws = connectWebSocket();
  
  // Test DEX
  console.log('\nTesting DEX endpoints...');
  await dexExample();
  
  // Keep running for 30 seconds
  console.log('\nListening for updates for 30 seconds...');
  setTimeout(() => {
    console.log('\nClosing connection...');
    ws.close();
    process.exit(0);
  }, 30000);
}

// Run the example
main().catch(console.error);
