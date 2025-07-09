# Plugin Development Guide

## Overview

The Otedama Pool plugin system allows developers to extend the pool's functionality without modifying the core code. Plugins can hook into various events, add new features, and integrate with external services.

## Quick Start

### 1. Create Plugin Directory

```
plugins/
└── my-plugin/
    ├── plugin.json
    └── index.ts
```

### 2. Create Plugin Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "author": "Your Name",
  "license": "MIT",
  "main": "index.ts",
  "hooks": [
    "poolStatsUpdate",
    "shareSubmitted"
  ],
  "permissions": [
    "read:stats",
    "write:webhook"
  ],
  "config": {
    "updateInterval": 60000
  }
}
```

### 3. Create Plugin Code (index.ts)

```typescript
import { BasePlugin, Hook } from '@otedama/plugin-sdk';

export default class MyPlugin extends BasePlugin {
  async onEnable() {
    this.logger.info('My plugin enabled!');
  }

  @Hook('poolStatsUpdate')
  async onPoolStats(stats) {
    this.logger.info('Pool stats:', stats);
    // Your logic here
  }
}
```

## Plugin Structure

### Manifest Fields

- `name` (required): Unique plugin identifier
- `version` (required): Semver version string
- `main` (required): Entry point file
- `description`: Brief description
- `author`: Author name or object
- `license`: License identifier
- `hooks`: Array of hook names to subscribe to
- `permissions`: Required permissions
- `dependencies`: Other plugins required
- `config`: Default configuration

### Lifecycle Methods

```typescript
class MyPlugin extends BasePlugin {
  // Called when plugin is loaded
  async onLoad() {}
  
  // Called when plugin is enabled
  async onEnable() {}
  
  // Called when plugin is disabled
  async onDisable() {}
  
  // Called when plugin is unloaded
  async onUnload() {}
}
```

## Available Hooks

### Pool Events

- `poolStatsUpdate` - Pool statistics updated
- `newBlockFound` - New block found by pool
- `shareSubmitted` - Share submitted by miner
- `shareAccepted` - Share accepted
- `shareRejected` - Share rejected

### Miner Events

- `minerConnected` - Miner connected
- `minerDisconnected` - Miner disconnected
- `minerAuthenticated` - Miner authenticated
- `minerBanned` - Miner banned

### Payment Events

- `paymentProcessed` - Payment processed
- `paymentSent` - Payment sent to blockchain
- `paymentConfirmed` - Payment confirmed

### System Events

- `systemStartup` - System starting up
- `systemShutdown` - System shutting down
- `configChanged` - Configuration changed

## Plugin API

### Context Properties

```typescript
class MyPlugin extends BasePlugin {
  constructor(context) {
    super(context);
    
    // Available properties
    this.logger;  // Plugin-specific logger
    this.config;  // Plugin configuration
    this.api;     // Plugin API methods
  }
}
```

### API Methods

```typescript
// Get pool statistics
const stats = await this.api.getPoolStats();

// Get miner statistics
const minerStats = await this.api.getMinerStats(minerId);

// Register webhook
await this.api.registerWebhook(url, ['shareAccepted']);

// Store plugin data
await this.storeData('key', value);

// Retrieve plugin data
const value = await this.retrieveData('key');

// Schedule recurring task
const taskId = this.scheduleTask(() => {
  console.log('Periodic task');
}, 60000);

// Cancel task
this.cancelTask(taskId);
```

## Decorators

### @Hook Decorator

```typescript
@Hook('poolStatsUpdate', 5)  // Hook name, priority (lower = higher)
async handleStats(stats) {
  // Handler code
}
```

### @RequirePermission Decorator

```typescript
@RequirePermission('admin:write')
async adminMethod() {
  // Protected method
}
```

### @Cache Decorator

```typescript
@Cache(60000)  // Cache for 60 seconds
async expensiveOperation() {
  // This result will be cached
}
```

## Advanced Features

### Custom Events

```typescript
// Emit custom event
this.emit('customEvent', { data: 'value' });

// Listen in another plugin
@Hook('plugin:my-plugin:customEvent')
async onCustomEvent(data) {
  // Handle event
}
```

### Inter-Plugin Communication

```typescript
// Get another plugin
const otherPlugin = this.pluginManager.getPlugin('other-plugin');

// Call public method
if (otherPlugin) {
  await otherPlugin.instance.publicMethod();
}
```

### Configuration Schema

```json
{
  "config": {
    "apiKey": "",
    "interval": 60000
  },
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for external service"
      },
      "interval": {
        "type": "number",
        "minimum": 1000,
        "description": "Update interval in milliseconds"
      }
    },
    "required": ["apiKey"]
  }
}
```

## Example Plugins

### Discord Notifier

```typescript
import { BasePlugin, Hook } from '@otedama/plugin-sdk';
import axios from 'axios';

export default class DiscordNotifier extends BasePlugin {
  @Hook('newBlockFound')
  async onNewBlock(block) {
    const embed = {
      title: '🎉 New Block Found!',
      color: 0x00ff00,
      fields: [
        { name: 'Height', value: block.height },
        { name: 'Reward', value: `${block.reward} BTC` },
        { name: 'Miner', value: block.miner }
      ]
    };

    await axios.post(this.config.webhookUrl, {
      embeds: [embed]
    });
  }
}
```

### Auto-Payout

```typescript
import { BasePlugin, Hook } from '@otedama/plugin-sdk';

export default class AutoPayout extends BasePlugin {
  private checkInterval;

  async onEnable() {
    this.checkInterval = this.scheduleTask(
      () => this.checkPayouts(),
      this.config.checkInterval || 3600000 // 1 hour
    );
  }

  async onDisable() {
    this.cancelTask(this.checkInterval);
  }

  async checkPayouts() {
    const miners = await this.api.getMinersWithBalance();
    
    for (const miner of miners) {
      if (miner.balance >= this.config.threshold) {
        await this.api.requestPayout(miner.address, miner.balance);
        this.logger.info(`Payout requested for ${miner.address}`);
      }
    }
  }
}
```

## Best Practices

1. **Error Handling**: Always wrap hook handlers in try-catch
2. **Resource Cleanup**: Clean up timers, connections in `onDisable()`
3. **Configuration**: Use config schema for validation
4. **Logging**: Use appropriate log levels
5. **Performance**: Cache expensive operations
6. **Security**: Validate all external input

## Testing

```typescript
import { PluginManager } from '@otedama/plugin-sdk';
import MyPlugin from './index';

describe('MyPlugin', () => {
  let manager;
  let plugin;

  beforeEach(async () => {
    manager = new PluginManager('./test-plugins');
    await manager.loadPlugin('./my-plugin');
    plugin = manager.getPlugin('my-plugin');
  });

  test('handles pool stats', async () => {
    const stats = { hashrate: 1000000 };
    await manager.executeHook('poolStatsUpdate', stats);
    // Assert expected behavior
  });
});
```

## Publishing

1. Create `.npmignore` file
2. Add `otedama-plugin` keyword to package.json
3. Publish to npm: `npm publish`

## Security Considerations

- Plugins run in sandboxed environment
- Limited module access (no fs, net, etc.)
- Permissions must be explicitly granted
- Resource limits enforced

## Debugging

Enable debug logging:
```
DEBUG=Plugin:* node pool.js
```

Use Chrome DevTools:
```
node --inspect pool.js
```

## Support

- Documentation: https://docs.otedama-pool.com/plugins
- Examples: https://github.com/otedama/plugin-examples
- Discord: #plugin-dev channel
