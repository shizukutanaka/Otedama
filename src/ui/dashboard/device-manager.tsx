/**
 * Device Management UI - Web Management Interface
 * Following Carmack/Martin/Pike principles:
 * - Real-time device monitoring
 * - Clean, responsive interface
 * - Efficient data updates
 */

import React, { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  BarElement
} from 'chart.js';
import { Line, Doughnut, Bar } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  BarElement
);

interface Device {
  id: string;
  name: string;
  type: 'cpu' | 'gpu' | 'asic';
  status: 'active' | 'idle' | 'error' | 'offline';
  hashRate: number;
  temperature: number;
  power: number;
  efficiency: number;
  errors: number;
  uptime: number;
  algorithm: string;
}

interface DeviceSettings {
  id: string;
  enabled: boolean;
  algorithm: string;
  intensity: number;
  threads?: number;
  tempLimit: number;
  powerLimit: number;
  fanSpeed?: number;
}

interface HistoricalData {
  timestamp: Date;
  hashRate: number;
  temperature: number;
  power: number;
  efficiency: number;
}

const DeviceManager: React.FC = () => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [settings, setSettings] = useState<Map<string, DeviceSettings>>(new Map());
  const [history, setHistory] = useState<Map<string, HistoricalData[]>>(new Map());
  const [socket, setSocket] = useState<Socket | null>(null);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [totalStats, setTotalStats] = useState({
    hashRate: 0,
    power: 0,
    efficiency: 0,
    activeDevices: 0
  });

  // Connect to WebSocket
  useEffect(() => {
    const ws = io('/devices', {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    ws.on('connect', () => {
      console.log('Connected to device manager');
      ws.emit('subscribe', { events: ['devices', 'stats', 'alerts'] });
    });

    ws.on('devices:update', (data: Device[]) => {
      setDevices(data);
      updateTotalStats(data);
    });

    ws.on('device:history', (data: { deviceId: string; history: HistoricalData[] }) => {
      setHistory(prev => new Map(prev.set(data.deviceId, data.history)));
    });

    ws.on('alert', (alert: string) => {
      setAlerts(prev => [...prev.slice(-9), alert]);
    });

    ws.on('disconnect', () => {
      console.log('Disconnected from device manager');
    });

    setSocket(ws);

    return () => {
      ws.disconnect();
    };
  }, []);

  // Update total statistics
  const updateTotalStats = (deviceList: Device[]) => {
    const stats = deviceList.reduce((acc, device) => {
      if (device.status === 'active') {
        acc.hashRate += device.hashRate;
        acc.power += device.power;
        acc.activeDevices += 1;
      }
      return acc;
    }, { hashRate: 0, power: 0, activeDevices: 0, efficiency: 0 });

    stats.efficiency = stats.power > 0 ? stats.hashRate / stats.power : 0;
    setTotalStats(stats);
  };

  // Update device settings
  const updateDeviceSettings = useCallback((deviceId: string, newSettings: Partial<DeviceSettings>) => {
    if (!socket) return;

    const currentSettings = settings.get(deviceId) || {
      id: deviceId,
      enabled: true,
      algorithm: 'sha256',
      intensity: 80,
      tempLimit: 85,
      powerLimit: 100
    };

    const updatedSettings = { ...currentSettings, ...newSettings };
    
    socket.emit('device:updateSettings', updatedSettings);
    setSettings(prev => new Map(prev.set(deviceId, updatedSettings)));
  }, [socket, settings]);

  // Toggle device
  const toggleDevice = useCallback((deviceId: string) => {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;

    const currentSettings = settings.get(deviceId);
    updateDeviceSettings(deviceId, { 
      enabled: !currentSettings?.enabled 
    });
  }, [devices, settings, updateDeviceSettings]);

  // Get chart data for selected device
  const getChartData = useCallback((deviceId: string) => {
    const deviceHistory = history.get(deviceId) || [];
    const last100 = deviceHistory.slice(-100);

    return {
      hashRate: {
        labels: last100.map(h => new Date(h.timestamp).toLocaleTimeString()),
        datasets: [{
          label: 'Hash Rate (MH/s)',
          data: last100.map(h => h.hashRate / 1000000),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1
        }]
      },
      temperature: {
        labels: last100.map(h => new Date(h.timestamp).toLocaleTimeString()),
        datasets: [{
          label: 'Temperature (°C)',
          data: last100.map(h => h.temperature),
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          tension: 0.1
        }]
      },
      power: {
        labels: last100.map(h => new Date(h.timestamp).toLocaleTimeString()),
        datasets: [{
          label: 'Power (W)',
          data: last100.map(h => h.power),
          borderColor: 'rgb(255, 205, 86)',
          backgroundColor: 'rgba(255, 205, 86, 0.2)',
          tension: 0.1
        }]
      }
    };
  }, [history]);

  // Get device status color
  const getStatusColor = (status: Device['status']) => {
    switch (status) {
      case 'active': return 'text-green-500';
      case 'idle': return 'text-yellow-500';
      case 'error': return 'text-red-500';
      case 'offline': return 'text-gray-500';
      default: return 'text-gray-500';
    }
  };

  // Get device icon
  const getDeviceIcon = (type: Device['type']) => {
    switch (type) {
      case 'cpu': return '💻';
      case 'gpu': return '🎮';
      case 'asic': return '⚡';
      default: return '📱';
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Device Manager
          </h1>
          <div className="mt-2 flex space-x-6 text-sm">
            <span className="text-gray-600 dark:text-gray-300">
              Total Hash Rate: <strong>{(totalStats.hashRate / 1000000).toFixed(2)} MH/s</strong>
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              Total Power: <strong>{totalStats.power.toFixed(0)} W</strong>
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              Efficiency: <strong>{(totalStats.efficiency / 1000).toFixed(2)} KH/W</strong>
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              Active Devices: <strong>{totalStats.activeDevices}</strong>
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device List */}
          <div className="lg:col-span-1">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">Devices</h2>
              <div className="space-y-3">
                {devices.map(device => (
                  <div
                    key={device.id}
                    className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                      selectedDevice === device.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                    }`}
                    onClick={() => setSelectedDevice(device.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <span className="text-2xl">{getDeviceIcon(device.type)}</span>
                        <div>
                          <h3 className="font-medium text-gray-900 dark:text-white">
                            {device.name}
                          </h3>
                          <p className={`text-sm ${getStatusColor(device.status)}`}>
                            {device.status.toUpperCase()}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleDevice(device.id);
                        }}
                        className={`px-3 py-1 rounded text-sm font-medium ${
                          settings.get(device.id)?.enabled !== false
                            ? 'bg-green-500 text-white hover:bg-green-600'
                            : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                        }`}
                      >
                        {settings.get(device.id)?.enabled !== false ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="mt-3 text-sm text-gray-600 dark:text-gray-400">
                      <div>Hash: {(device.hashRate / 1000000).toFixed(2)} MH/s</div>
                      <div>Temp: {device.temperature}°C | Power: {device.power}W</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Alerts */}
            {alerts.length > 0 && (
              <div className="mt-6 bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                  Recent Alerts
                </h2>
                <div className="space-y-2">
                  {alerts.map((alert, index) => (
                    <div
                      key={index}
                      className="text-sm text-red-600 dark:text-red-400 p-2 bg-red-50 dark:bg-red-900/20 rounded"
                    >
                      {alert}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Device Details */}
          <div className="lg:col-span-2">
            {selectedDevice ? (
              <div className="space-y-6">
                {/* Device Settings */}
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                  <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                    Device Settings
                  </h2>
                  {(() => {
                    const device = devices.find(d => d.id === selectedDevice);
                    const deviceSettings = settings.get(selectedDevice) || {
                      id: selectedDevice,
                      enabled: true,
                      algorithm: device?.algorithm || 'sha256',
                      intensity: 80,
                      threads: device?.type === 'cpu' ? 4 : undefined,
                      tempLimit: 85,
                      powerLimit: 100,
                      fanSpeed: device?.type === 'gpu' ? 70 : undefined
                    };

                    return (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Algorithm
                          </label>
                          <select
                            value={deviceSettings.algorithm}
                            onChange={(e) => updateDeviceSettings(selectedDevice, { algorithm: e.target.value })}
                            className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 shadow-sm"
                          >
                            <option value="sha256">SHA256</option>
                            <option value="scrypt">Scrypt</option>
                            <option value="ethash">Ethash</option>
                            <option value="randomx">RandomX</option>
                            <option value="cryptonight">CryptoNight</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Intensity (%)
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={deviceSettings.intensity}
                            onChange={(e) => updateDeviceSettings(selectedDevice, { intensity: parseInt(e.target.value) })}
                            className="mt-1 block w-full"
                          />
                          <span className="text-sm text-gray-500">{deviceSettings.intensity}%</span>
                        </div>

                        {device?.type === 'cpu' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              Threads
                            </label>
                            <input
                              type="number"
                              min="1"
                              max="32"
                              value={deviceSettings.threads || 4}
                              onChange={(e) => updateDeviceSettings(selectedDevice, { threads: parseInt(e.target.value) })}
                              className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 shadow-sm"
                            />
                          </div>
                        )}

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Temperature Limit (°C)
                          </label>
                          <input
                            type="number"
                            min="50"
                            max="100"
                            value={deviceSettings.tempLimit}
                            onChange={(e) => updateDeviceSettings(selectedDevice, { tempLimit: parseInt(e.target.value) })}
                            className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 shadow-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Power Limit (%)
                          </label>
                          <input
                            type="range"
                            min="50"
                            max="120"
                            value={deviceSettings.powerLimit}
                            onChange={(e) => updateDeviceSettings(selectedDevice, { powerLimit: parseInt(e.target.value) })}
                            className="mt-1 block w-full"
                          />
                          <span className="text-sm text-gray-500">{deviceSettings.powerLimit}%</span>
                        </div>

                        {device?.type === 'gpu' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                              Fan Speed (%)
                            </label>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={deviceSettings.fanSpeed || 70}
                              onChange={(e) => updateDeviceSettings(selectedDevice, { fanSpeed: parseInt(e.target.value) })}
                              className="mt-1 block w-full"
                            />
                            <span className="text-sm text-gray-500">{deviceSettings.fanSpeed || 70}%</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Performance Charts */}
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                  <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                    Performance Metrics
                  </h2>
                  <div className="space-y-6">
                    {(() => {
                      const chartData = getChartData(selectedDevice);
                      const chartOptions = {
                        responsive: true,
                        plugins: {
                          legend: {
                            display: false
                          }
                        },
                        scales: {
                          x: {
                            display: false
                          }
                        }
                      };

                      return (
                        <>
                          <div>
                            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Hash Rate
                            </h3>
                            <Line data={chartData.hashRate} options={chartOptions} />
                          </div>
                          <div>
                            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Temperature
                            </h3>
                            <Line data={chartData.temperature} options={chartOptions} />
                          </div>
                          <div>
                            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              Power Consumption
                            </h3>
                            <Line data={chartData.power} options={chartOptions} />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Device Info */}
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                  <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
                    Device Information
                  </h2>
                  {(() => {
                    const device = devices.find(d => d.id === selectedDevice);
                    if (!device) return null;

                    return (
                      <dl className="grid grid-cols-2 gap-4">
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Type</dt>
                          <dd className="mt-1 text-sm text-gray-900 dark:text-white">
                            {device.type.toUpperCase()}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Status</dt>
                          <dd className={`mt-1 text-sm font-medium ${getStatusColor(device.status)}`}>
                            {device.status.toUpperCase()}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Uptime</dt>
                          <dd className="mt-1 text-sm text-gray-900 dark:text-white">
                            {Math.floor(device.uptime / 3600)}h {Math.floor((device.uptime % 3600) / 60)}m
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Errors</dt>
                          <dd className="mt-1 text-sm text-gray-900 dark:text-white">
                            {device.errors}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                            Current Hash Rate
                          </dt>
                          <dd className="mt-1 text-sm text-gray-900 dark:text-white">
                            {(device.hashRate / 1000000).toFixed(2)} MH/s
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                            Efficiency
                          </dt>
                          <dd className="mt-1 text-sm text-gray-900 dark:text-white">
                            {(device.efficiency / 1000).toFixed(2)} KH/W
                          </dd>
                        </div>
                      </dl>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center">
                <p className="text-gray-500 dark:text-gray-400">
                  Select a device to view details and settings
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeviceManager;
