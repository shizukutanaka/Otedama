# Otedama Mobile App (React Native) Development Guide

## Overview

This guide provides instructions for developing a React Native mobile application that connects to the Otedama mining pool system. The mobile app allows users to monitor and control their mining operations, manage their wallet, and use the DEX functionality from their mobile devices.

## Architecture

The mobile app communicates with Otedama through:
1. **REST API** - For standard requests and responses
2. **WebSocket** - For real-time updates
3. **Mobile Bridge** - Specialized API for mobile-optimized data

## Prerequisites

- React Native development environment set up
- Node.js 16+ and npm/yarn
- iOS: Xcode 12+ and CocoaPods
- Android: Android Studio and Android SDK

## Getting Started

### 1. Create a new React Native project

```bash
npx react-native init OtedamaMobile
cd OtedamaMobile
```

### 2. Install required dependencies

```bash
npm install axios react-native-websocket react-native-keychain @react-navigation/native
# Additional UI libraries
npm install react-native-elements react-native-vector-icons react-native-chart-kit
```

### 3. iOS Setup

```bash
cd ios && pod install
```

### 4. Android Setup

Add internet permission to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## API Integration

### Authentication

First, authenticate your mobile app with the Otedama server:

```javascript
import axios from 'axios';
import DeviceInfo from 'react-native-device-info';

const API_BASE_URL = 'http://your-otedama-server:8080';

class OtedamaAPI {
  constructor() {
    this.apiKey = null;
    this.axios = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
    });
  }

  async authenticate() {
    try {
      const deviceId = await DeviceInfo.getUniqueId();
      const platform = DeviceInfo.getSystemName().toLowerCase();
      const appVersion = DeviceInfo.getVersion();

      const response = await this.axios.post('/api/mobile/auth', {
        deviceId,
        platform,
        appVersion,
        capabilities: ['mining', 'wallet', 'dex', 'monitoring']
      });

      this.apiKey = response.data.apiKey;
      
      // Set default header for future requests
      this.axios.defaults.headers.common['X-API-Key'] = this.apiKey;
      
      return response.data;
    } catch (error) {
      console.error('Authentication failed:', error);
      throw error;
    }
  }
}
```

### Mining Control

Control mining operations from the mobile app:

```javascript
class MiningController {
  constructor(api) {
    this.api = api;
  }

  async getStatus() {
    const response = await this.api.axios.get('/api/mobile/status');
    return response.data;
  }

  async getMiningStats() {
    const response = await this.api.axios.get('/api/mobile/mining/stats');
    return response.data;
  }

  async startMining() {
    const response = await this.api.axios.post('/api/mobile/mining/start');
    return response.data;
  }

  async stopMining() {
    const response = await this.api.axios.post('/api/mobile/mining/stop');
    return response.data;
  }

  async pauseMining() {
    const response = await this.api.axios.post('/api/mobile/mining/pause');
    return response.data;
  }
}
```

### WebSocket Connection

For real-time updates:

```javascript
import WebSocket from 'react-native-websocket';

class OtedamaWebSocket {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.listeners = new Map();
  }

  connect() {
    const wsUrl = `ws://your-otedama-server:8080/ws`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      // Subscribe to mobile updates
      this.send({
        type: 'mobile:subscribe',
        apiKey: this.apiKey
      });
    };
    
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Attempt reconnection
      setTimeout(() => this.connect(), 5000);
    };
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  handleMessage(message) {
    const listeners = this.listeners.get(message.type) || [];
    listeners.forEach(callback => callback(message.data));
  }
}
```

## React Native Components

### Mining Dashboard

```jsx
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Button,
  ActivityIndicator
} from 'react-native';
import { Card, Header } from 'react-native-elements';
import { LineChart } from 'react-native-chart-kit';

const MiningDashboard = ({ api, ws }) => {
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hashRateHistory, setHashRateHistory] = useState([]);

  useEffect(() => {
    loadData();
    
    // Subscribe to real-time updates
    ws.on('mining:stats', (data) => {
      setStats(data);
      updateHashRateHistory(data.hashrate);
    });
    
    // Refresh every 30 seconds
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [statusData, statsData] = await Promise.all([
        api.getStatus(),
        api.getMiningStats()
      ]);
      
      setStatus(statusData);
      setStats(statsData);
      setLoading(false);
    } catch (error) {
      console.error('Failed to load data:', error);
      setLoading(false);
    }
  };

  const updateHashRateHistory = (hashrate) => {
    setHashRateHistory(prev => {
      const updated = [...prev, hashrate];
      return updated.slice(-20); // Keep last 20 points
    });
  };

  const controlMining = async (action) => {
    try {
      if (action === 'start') {
        await api.startMining();
      } else if (action === 'stop') {
        await api.stopMining();
      } else if (action === 'pause') {
        await api.pauseMining();
      }
      
      // Reload status
      loadData();
    } catch (error) {
      console.error(`Failed to ${action} mining:`, error);
    }
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0000ff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Header
        centerComponent={{ text: 'Otedama Mining', style: { color: '#fff' } }}
        backgroundColor="#2196F3"
      />
      
      <Card title="Mining Status">
        <Text style={styles.label}>Status: {status?.mining?.enabled ? 'Active' : 'Inactive'}</Text>
        <Text style={styles.label}>Algorithm: {stats?.algorithm}</Text>
        <Text style={styles.label}>Current Hashrate: {formatHashrate(stats?.hashrate?.current)}</Text>
        <Text style={styles.label}>Shares: {stats?.shares?.accepted || 0}</Text>
        
        <View style={styles.buttonContainer}>
          <Button
            title="Start"
            onPress={() => controlMining('start')}
            disabled={status?.mining?.enabled}
          />
          <Button
            title="Pause"
            onPress={() => controlMining('pause')}
            disabled={!status?.mining?.enabled}
          />
          <Button
            title="Stop"
            onPress={() => controlMining('stop')}
            disabled={!status?.mining?.enabled}
          />
        </View>
      </Card>
      
      {hashRateHistory.length > 0 && (
        <Card title="Hashrate History">
          <LineChart
            data={{
              labels: [],
              datasets: [{
                data: hashRateHistory
              }]
            }}
            width={300}
            height={200}
            chartConfig={{
              backgroundColor: '#ffffff',
              backgroundGradientFrom: '#ffffff',
              backgroundGradientTo: '#ffffff',
              decimalPlaces: 0,
              color: (opacity = 1) => `rgba(33, 150, 243, ${opacity})`,
              style: {
                borderRadius: 16
              }
            }}
            bezier
            style={{
              marginVertical: 8,
              borderRadius: 16
            }}
          />
        </Card>
      )}
    </View>
  );
};

const formatHashrate = (hashrate) => {
  if (!hashrate) return '0 H/s';
  
  if (hashrate > 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
  if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
  if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
  if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
  return `${hashrate.toFixed(2)} H/s`;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  label: {
    fontSize: 16,
    marginBottom: 10,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
  },
});

export default MiningDashboard;
```

### DEX Interface

```jsx
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity
} from 'react-native';
import { Card, ListItem, Button } from 'react-native-elements';

const DexInterface = ({ api }) => {
  const [pools, setPools] = useState([]);
  const [selectedPool, setSelectedPool] = useState(null);
  const [swapAmount, setSwapAmount] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadDexData();
  }, []);

  const loadDexData = async () => {
    try {
      const response = await api.axios.get('/api/mobile/dex');
      setPools(response.data.pools);
    } catch (error) {
      console.error('Failed to load DEX data:', error);
    }
  };

  const executeSwap = async () => {
    if (!selectedPool || !swapAmount) return;
    
    setLoading(true);
    try {
      const response = await api.axios.post('/api/mobile/dex/swap', {
        tokenIn: selectedPool.tokenA,
        tokenOut: selectedPool.tokenB,
        amountIn: swapAmount,
        minAmountOut: calculateMinOutput(swapAmount),
        recipient: 'user-wallet-address'
      });
      
      console.log('Swap executed:', response.data);
      // Show success message
      setSwapAmount('');
    } catch (error) {
      console.error('Swap failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const calculateMinOutput = (amountIn) => {
    // Simplified calculation - in production, use actual DEX math
    return (parseFloat(amountIn) * 0.97).toString(); // 3% slippage
  };

  return (
    <ScrollView style={styles.container}>
      <Card title="Liquidity Pools">
        {pools.map((pool, index) => (
          <ListItem
            key={pool.id}
            title={`${pool.tokenA}/${pool.tokenB}`}
            subtitle={`TVL: $${formatNumber(pool.totalLiquidity)}`}
            onPress={() => setSelectedPool(pool)}
            bottomDivider
            chevron
            containerStyle={
              selectedPool?.id === pool.id ? styles.selectedPool : {}
            }
          />
        ))}
      </Card>
      
      {selectedPool && (
        <Card title="Swap">
          <Text style={styles.label}>From: {selectedPool.tokenA}</Text>
          <TextInput
            style={styles.input}
            placeholder="Amount"
            value={swapAmount}
            onChangeText={setSwapAmount}
            keyboardType="numeric"
          />
          
          <Text style={styles.label}>To: {selectedPool.tokenB}</Text>
          <Text style={styles.estimate}>
            Estimated: {calculateMinOutput(swapAmount || '0')} {selectedPool.tokenB}
          </Text>
          
          <Button
            title="Swap"
            onPress={executeSwap}
            loading={loading}
            disabled={!swapAmount || loading}
            buttonStyle={styles.swapButton}
          />
        </Card>
      )}
    </ScrollView>
  );
};

const formatNumber = (num) => {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  selectedPool: {
    backgroundColor: '#e3f2fd',
  },
  label: {
    fontSize: 16,
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 5,
    padding: 10,
    marginBottom: 15,
    fontSize: 16,
  },
  estimate: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
  },
  swapButton: {
    backgroundColor: '#2196F3',
    borderRadius: 5,
  },
});

export default DexInterface;
```

## App Structure

```
OtedamaMobile/
├── src/
│   ├── api/
│   │   ├── OtedamaAPI.js
│   │   ├── MiningController.js
│   │   └── WebSocketManager.js
│   ├── components/
│   │   ├── MiningDashboard.js
│   │   ├── DexInterface.js
│   │   ├── WalletView.js
│   │   └── PoolStats.js
│   ├── screens/
│   │   ├── HomeScreen.js
│   │   ├── MiningScreen.js
│   │   ├── DexScreen.js
│   │   └── SettingsScreen.js
│   ├── navigation/
│   │   └── AppNavigator.js
│   ├── utils/
│   │   ├── formatters.js
│   │   └── storage.js
│   └── App.js
├── ios/
├── android/
└── package.json
```

## Security Considerations

1. **API Key Storage**: Use `react-native-keychain` to securely store API keys
2. **SSL/TLS**: Always use HTTPS in production
3. **Certificate Pinning**: Implement certificate pinning for additional security
4. **Code Obfuscation**: Use ProGuard (Android) and Swift obfuscation (iOS)

## Push Notifications

### Firebase Cloud Messaging (FCM) Setup

1. Install dependencies:
```bash
npm install @react-native-firebase/app @react-native-firebase/messaging
```

2. Register for notifications:
```javascript
import messaging from '@react-native-firebase/messaging';

const registerForNotifications = async () => {
  const authStatus = await messaging().requestPermission();
  const enabled = authStatus === messaging.AuthorizationStatus.AUTHORIZED;
  
  if (enabled) {
    const token = await messaging().getToken();
    // Send token to Otedama server
    await api.axios.post('/api/mobile/register-token', { token });
  }
};

// Handle notifications
messaging().onMessage(async remoteMessage => {
  console.log('Notification received:', remoteMessage);
  // Show local notification
});
```

## Performance Optimization

1. **Use React.memo** for component optimization
2. **Implement lazy loading** for screens
3. **Use FlatList** for large data sets
4. **Optimize images** with appropriate sizing
5. **Minimize bridge calls** by batching operations

## Testing

### Unit Tests
```bash
npm install --save-dev jest @testing-library/react-native
npm test
```

### E2E Tests
```bash
npm install --save-dev detox
detox test
```

## Building for Production

### iOS
```bash
cd ios
xcodebuild -workspace OtedamaMobile.xcworkspace -scheme OtedamaMobile -configuration Release
```

### Android
```bash
cd android
./gradlew assembleRelease
```

## Publishing

### App Store (iOS)
1. Create App Store Connect account
2. Configure app metadata
3. Upload via Xcode or Transporter

### Google Play (Android)
1. Create Google Play Console account
2. Upload signed APK/AAB
3. Configure store listing

## Support and Resources

- **Otedama API Documentation**: `/docs/API.md`
- **React Native Documentation**: https://reactnative.dev/docs/getting-started
- **Community Forum**: https://forum.otedama.network
- **GitHub Issues**: https://github.com/yourusername/otedama-mobile

## Example API Endpoints

All mobile endpoints require the `X-API-Key` header.

### Authentication
- `POST /api/mobile/auth` - Authenticate device

### Mining
- `GET /api/mobile/status` - Get system status
- `GET /api/mobile/mining/stats` - Get mining statistics
- `POST /api/mobile/mining/:action` - Control mining (start/stop/pause)

### DEX
- `GET /api/mobile/dex` - Get DEX data
- `POST /api/mobile/dex/swap` - Execute swap

### Wallet
- `GET /api/mobile/wallet` - Get wallet info
- `POST /api/mobile/wallet/send` - Send transaction

### Settings
- `GET /api/mobile/settings` - Get user settings
- `PUT /api/mobile/settings` - Update settings

## Troubleshooting

### Common Issues

1. **Connection Failed**
   - Check server URL
   - Verify network connectivity
   - Ensure API is running

2. **Authentication Error**
   - Clear stored API key
   - Re-authenticate device
   - Check device permissions

3. **WebSocket Disconnects**
   - Implement reconnection logic
   - Check firewall settings
   - Verify WebSocket port

4. **Performance Issues**
   - Enable Hermes (Android)
   - Use production builds
   - Profile with Flipper

## License

The Otedama Mobile App follows the same MIT License as the main Otedama project.
