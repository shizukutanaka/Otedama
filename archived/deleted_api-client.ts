/**
 * Example: Using Otedama API
 * 
 * This example demonstrates how to interact with the Otedama API
 * using both REST and WebSocket connections.
 */

import WebSocket from 'ws';
import fetch from 'node-fetch';

const API_BASE = 'http://localhost:8080/api';
const WS_URL = 'ws://localhost:8080';

class OtedamaClient {
  private ws?: WebSocket;

  /**
   * Get pool statistics via REST API
   */
  async getStats() {
    const response = await fetch(`${API_BASE}/stats`);
    return response.json();
  }

  /**
   * Get connected miners
   */
  async getMiners() {
    const response = await fetch(`${API_BASE}/miners`);
    return response.json();
  }

  /**
   * Get specific miner details
   */
  async getMiner(address: string) {
    const response = await fetch(`${API_BASE}/miner/${address}`);
    return response.json();
  }

  /**
   * Connect to WebSocket for real-time updates
   */
  connectWebSocket() {
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('Connected to Otedama WebSocket');
      
      // Subscribe to channels
      this.subscribe('stats');
      this.subscribe('miners');
      this.subscribe('blocks');
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.handleMessage(message);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('Disconnected from Otedama WebSocket');
    });
  }

  /**
   * Subscribe to a channel
   */
  private subscribe(channel: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        channel
      }));
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: any) {
    switch (message.type) {
      case 'stats:update':
        console.log('Stats update:', message.data);
        break;
      
      case 'miner:connected':
        console.log('New miner connected:', message.data);
        break;
      
      case 'block:found':
        console.log('Block found!', message.data);
        break;
      
      default:
        console.log('Unknown message:', message);
    }
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Example usage
async function main() {
  const client = new OtedamaClient();

  // Get initial stats
  console.log('Getting pool stats...');
  const stats = await client.getStats();
  console.log('Pool stats:', stats);

  // Get miners
  console.log('\nGetting miners...');
  const miners = await client.getMiners();
  console.log('Connected miners:', miners);

  // Connect WebSocket for real-time updates
  console.log('\nConnecting to WebSocket...');
  client.connectWebSocket();

  // Keep running for 60 seconds to receive updates
  setTimeout(() => {
    console.log('\nDisconnecting...');
    client.disconnect();
    process.exit(0);
  }, 60000);
}

// Run the example
main().catch(console.error);
