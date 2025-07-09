// Direct blockchain RPC calls (Carmack style)
import { Share } from '../domain/share';

export class BlockchainClient {
  constructor(
    private rpcUrl: string,
    private rpcUser: string,
    private rpcPassword: string
  ) {}
  
  // Direct RPC call - no abstraction layers
  async submitBlock(share: Share): Promise<boolean> {
    const blockHex = share.toBlockHex();
    
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'submitblock',
          params: [blockHex],
          id: Date.now()
        })
      });
      
      const result = await response.json();
      return !result.error && result.result === null;
    } catch (error) {
      console.error('Block submission failed:', error);
      return false;
    }
  }
  
  // Get new block template
  async getBlockTemplate(): Promise<any> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getblocktemplate',
          params: [{"capabilities": ["coinbasetxn", "workid", "coinbase/append"]}],
          id: Date.now()
        })
      });
      
      const result = await response.json();
      return result.result;
    } catch (error) {
      console.error('Failed to get block template:', error);
      throw error;
    }
  }
  
  // Check blockchain height
  async getBlockCount(): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'getblockcount',
          params: [],
          id: Date.now()
        })
      });
      
      const result = await response.json();
      return result.result;
    } catch (error) {
      console.error('Failed to get block count:', error);
      throw error;
    }
  }
}
