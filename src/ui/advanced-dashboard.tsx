/**
 * 高度なリアルタイムダッシュボード
 * React + WebSocket + チャート機能を統合した最新のUI
 * 
 * 設計思想：
 * - Carmack: 高速でレスポンシブなリアルタイム更新
 * - Martin: モジュール化されたコンポーネント設計
 * - Pike: シンプルで直感的なインターフェース
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import { io, Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import {
  Box, Container, Grid, Card, CardContent, Typography,
  AppBar, Toolbar, IconButton, Switch, Avatar,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Chip, LinearProgress, Alert, Snackbar,
  Drawer, List, ListItem, ListItemIcon, ListItemText,
  Button, Dialog, DialogTitle, DialogContent,
  useMediaQuery, CssBaseline
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  People as PeopleIcon,
  ShowChart as ChartIcon,
  Settings as SettingsIcon,
  Notifications as NotificationsIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
  Menu as MenuIcon,
  Download as DownloadIcon,
  Security as SecurityIcon,
  Language as LanguageIcon
} from '@mui/icons-material';

// === 型定義 ===
interface PoolStats {
  hashrate: number;
  activeMiners: number;
  totalShares: number;
  validShares: number;
  blocksFound: number;
  totalPaid: number;
  networkDifficulty: number;
  networkHashrate: number;
}

interface MinerData {
  minerId: string;
  address: string;
  hashrate: number;
  shares: number;
  balance: number;
  lastSeen: number;
  status: 'active' | 'inactive' | 'offline';
}

interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    borderColor?: string;
    backgroundColor?: string;
    tension?: number;
  }>;
}

interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  read: boolean;
}

interface DashboardProps {
  apiEndpoint: string;
  wsEndpoint: string;
  userRole: 'admin' | 'user' | 'viewer';
  userId: string;
}

// === メインダッシュボードコンポーネント ===
export const AdvancedDashboard: React.FC<DashboardProps> = ({
  apiEndpoint,
  wsEndpoint,
  userRole,
  userId
}) => {
  const { t, i18n } = useTranslation();
  const [darkMode, setDarkMode] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  
  // データ状態
  const [poolStats, setPoolStats] = useState<PoolStats>({
    hashrate: 0,
    activeMiners: 0,
    totalShares: 0,
    validShares: 0,
    blocksFound: 0,
    totalPaid: 0,
    networkDifficulty: 0,
    networkHashrate: 0
  });
  
  const [miners, setMiners] = useState<MinerData[]>([]);
  const [hashrateHistory, setHashrateHistory] = useState<ChartData>({
    labels: [],
    datasets: []
  });
  
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  
  // レスポンシブ対応
  const isMobile = useMediaQuery('(max-width:600px)');
  const isTablet = useMediaQuery('(max-width:960px)');
  
  // テーマ設定
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: darkMode ? 'dark' : 'light',
          primary: {
            main: '#00ff41',
          },
          secondary: {
            main: '#1976d2',
          },
          background: {
            default: darkMode ? '#0a0a0a' : '#f5f5f5',
            paper: darkMode ? '#1a1a1a' : '#ffffff',
          },
        },
        typography: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
        },
        components: {
          MuiCard: {
            styleOverrides: {
              root: {
                borderRadius: 12,
                boxShadow: darkMode 
                  ? '0 4px 6px rgba(0, 0, 0, 0.3)' 
                  : '0 2px 4px rgba(0, 0, 0, 0.1)',
              },
            },
          },
        },
      }),
    [darkMode]
  );
  
  // WebSocket接続
  useEffect(() => {
    const newSocket = io(wsEndpoint, {
      auth: { userId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });
    
    newSocket.on('connect', () => {
      console.log('Connected to dashboard socket');
      addNotification('success', t('dashboard.connected'));
    });
    
    newSocket.on('poolStats', (data: PoolStats) => {
      setPoolStats(data);
    });
    
    newSocket.on('minerUpdate', (data: MinerData[]) => {
      setMiners(data);
    });
    
    newSocket.on('hashrateHistory', (data: ChartData) => {
      setHashrateHistory(data);
    });
    
    newSocket.on('notification', (notification: Notification) => {
      addNotification(notification.type, notification.message);
    });
    
    newSocket.on('disconnect', () => {
      console.log('Disconnected from dashboard socket');
      addNotification('error', t('dashboard.disconnected'));
    });
    
    setSocket(newSocket);
    
    return () => {
      newSocket.close();
    };
  }, [wsEndpoint, userId, t]);
  
  // 通知の追加
  const addNotification = useCallback((type: Notification['type'], message: string) => {
    const notification: Notification = {
      id: Date.now().toString(),
      type,
      message,
      timestamp: Date.now(),
      read: false
    };
    
    setNotifications(prev => [notification, ...prev].slice(0, 50));
  }, []);
  
  // データエクスポート
  const exportData = useCallback(async (format: 'csv' | 'json') => {
    try {
      const response = await fetch(`${apiEndpoint}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('apiToken')}`
        },
        body: JSON.stringify({ format, data: 'all' })
      });
      
      if (!response.ok) throw new Error('Export failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mining-data-${Date.now()}.${format}`;
      a.click();
      
      addNotification('success', t('dashboard.exportSuccess'));
    } catch (error) {
      addNotification('error', t('dashboard.exportError'));
    }
  }, [apiEndpoint, t, addNotification]);
  
  // ハッシュレートのフォーマット
  const formatHashrate = useCallback((hashrate: number): string => {
    if (hashrate > 1e15) return `${(hashrate / 1e15).toFixed(2)} PH/s`;
    if (hashrate > 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
    if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
    if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
    return `${hashrate.toFixed(2)} H/s`;
  }, []);
  
  // サイドバーのコンテンツ
  const drawer = (
    <Box>
      <Toolbar />
      <List>
        <ListItem button>
          <ListItemIcon>
            <DashboardIcon style={{ color: theme.palette.primary.main }} />
          </ListItemIcon>
          <ListItemText primary={t('dashboard.overview')} />
        </ListItem>
        <ListItem button>
          <ListItemIcon>
            <PeopleIcon />
          </ListItemIcon>
          <ListItemText primary={t('dashboard.miners')} />
        </ListItem>
        <ListItem button>
          <ListItemIcon>
            <ChartIcon />
          </ListItemIcon>
          <ListItemText primary={t('dashboard.analytics')} />
        </ListItem>
        {userRole === 'admin' && (
          <>
            <ListItem button>
              <ListItemIcon>
                <SecurityIcon />
              </ListItemIcon>
              <ListItemText primary={t('dashboard.security')} />
            </ListItem>
            <ListItem button>
              <ListItemIcon>
                <SettingsIcon />
              </ListItemIcon>
              <ListItemText primary={t('dashboard.settings')} />
            </ListItem>
          </>
        )}
      </List>
    </Box>
  );
  
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex' }}>
        {/* アプリバー */}
        <AppBar position="fixed" sx={{ zIndex: theme.zIndex.drawer + 1 }}>
          <Toolbar>
            <IconButton
              color="inherit"
              edge="start"
              onClick={() => setMobileOpen(!mobileOpen)}
              sx={{ mr: 2, display: { sm: 'none' } }}
            >
              <MenuIcon />
            </IconButton>
            
            <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
              ⚡ Otedama Mining Pool
            </Typography>
            
            {/* 言語切り替え */}
            <IconButton
              color="inherit"
              onClick={() => {
                const newLang = i18n.language === 'en' ? 'ja' : 'en';
                i18n.changeLanguage(newLang);
              }}
            >
              <LanguageIcon />
            </IconButton>
            
            {/* ダークモード切り替え */}
            <IconButton
              color="inherit"
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
            
            {/* 通知 */}
            <IconButton
              color="inherit"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <NotificationsIcon />
              {notifications.filter(n => !n.read).length > 0 && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: 'error.main'
                  }}
                />
              )}
            </IconButton>
            
            {/* ユーザーアバター */}
            <Avatar sx={{ ml: 2 }}>{userId[0].toUpperCase()}</Avatar>
          </Toolbar>
        </AppBar>
        
        {/* サイドバー */}
        <Box
          component="nav"
          sx={{ width: { sm: 240 }, flexShrink: { sm: 0 } }}
        >
          <Drawer
            variant={isMobile ? 'temporary' : 'permanent'}
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{
              '& .MuiDrawer-paper': {
                width: 240,
                boxSizing: 'border-box',
              },
            }}
          >
            {drawer}
          </Drawer>
        </Box>
        
        {/* メインコンテンツ */}
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
            width: { sm: `calc(100% - 240px)` },
            mt: 8
          }}
        >
          <Container maxWidth="xl">
            <Grid container spacing={3}>
              {/* 統計カード */}
              <Grid item xs={12} sm={6} md={3}>
                <StatsCard
                  title={t('dashboard.hashrate')}
                  value={formatHashrate(poolStats.hashrate)}
                  trend="+5.2%"
                  icon={<ChartIcon />}
                  color="primary"
                />
              </Grid>
              
              <Grid item xs={12} sm={6} md={3}>
                <StatsCard
                  title={t('dashboard.activeMiners')}
                  value={poolStats.activeMiners.toString()}
                  trend="+12"
                  icon={<PeopleIcon />}
                  color="secondary"
                />
              </Grid>
              
              <Grid item xs={12} sm={6} md={3}>
                <StatsCard
                  title={t('dashboard.totalShares')}
                  value={poolStats.totalShares.toLocaleString()}
                  trend={`${((poolStats.validShares / poolStats.totalShares) * 100).toFixed(1)}%`}
                  icon={<DashboardIcon />}
                  color="success"
                />
              </Grid>
              
              <Grid item xs={12} sm={6} md={3}>
                <StatsCard
                  title={t('dashboard.blocksFound')}
                  value={poolStats.blocksFound.toString()}
                  trend="Today: 2"
                  icon={<SecurityIcon />}
                  color="warning"
                />
              </Grid>
              
              {/* ハッシュレートチャート */}
              <Grid item xs={12} lg={8}>
                <Card>
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                      <Typography variant="h6">{t('dashboard.hashrateChart')}</Typography>
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={() => exportData('csv')}
                      >
                        {t('dashboard.export')}
                      </Button>
                    </Box>
                    <Box sx={{ height: 300 }}>
                      <Line
                        data={hashrateHistory}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                            legend: {
                              display: true,
                              position: 'top',
                            },
                          },
                          scales: {
                            y: {
                              beginAtZero: true,
                              ticks: {
                                callback: (value) => formatHashrate(value as number),
                              },
                            },
                          },
                        }}
                      />
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
              
              {/* マイナー分布 */}
              <Grid item xs={12} lg={4}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      {t('dashboard.minerDistribution')}
                    </Typography>
                    <Box sx={{ height: 300 }}>
                      <Doughnut
                        data={{
                          labels: miners.slice(0, 5).map(m => m.minerId),
                          datasets: [{
                            data: miners.slice(0, 5).map(m => m.hashrate),
                            backgroundColor: [
                              '#00ff41',
                              '#1976d2',
                              '#ff9800',
                              '#e91e63',
                              '#9c27b0'
                            ],
                          }],
                        }}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                            legend: {
                              position: 'right',
                            },
                          },
                        }}
                      />
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
              
              {/* マイナーテーブル */}
              <Grid item xs={12}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      {t('dashboard.topMiners')}
                    </Typography>
                    <TableContainer>
                      <Table>
                        <TableHead>
                          <TableRow>
                            <TableCell>{t('dashboard.miner')}</TableCell>
                            <TableCell align="right">{t('dashboard.hashrate')}</TableCell>
                            <TableCell align="right">{t('dashboard.shares')}</TableCell>
                            <TableCell align="right">{t('dashboard.balance')}</TableCell>
                            <TableCell align="center">{t('dashboard.status')}</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {miners.slice(0, 10).map((miner) => (
                            <TableRow key={miner.minerId}>
                              <TableCell>
                                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                                  {miner.minerId.substring(0, 8)}...
                                </Typography>
                              </TableCell>
                              <TableCell align="right">
                                {formatHashrate(miner.hashrate)}
                              </TableCell>
                              <TableCell align="right">
                                {miner.shares.toLocaleString()}
                              </TableCell>
                              <TableCell align="right">
                                {miner.balance.toFixed(8)} BTC
                              </TableCell>
                              <TableCell align="center">
                                <Chip
                                  label={miner.status}
                                  color={
                                    miner.status === 'active' ? 'success' :
                                    miner.status === 'inactive' ? 'warning' : 'error'
                                  }
                                  size="small"
                                />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          </Container>
        </Box>
        
        {/* 通知ドロワー */}
        <Drawer
          anchor="right"
          open={showNotifications}
          onClose={() => setShowNotifications(false)}
        >
          <Box sx={{ width: 350, p: 2 }}>
            <Typography variant="h6" gutterBottom>
              {t('dashboard.notifications')}
            </Typography>
            <List>
              {notifications.map((notification) => (
                <Alert
                  key={notification.id}
                  severity={notification.type}
                  sx={{ mb: 1 }}
                  onClose={() => {
                    setNotifications(prev => 
                      prev.filter(n => n.id !== notification.id)
                    );
                  }}
                >
                  <Typography variant="body2">{notification.message}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {new Date(notification.timestamp).toLocaleTimeString()}
                  </Typography>
                </Alert>
              ))}
            </List>
          </Box>
        </Drawer>
      </Box>
    </ThemeProvider>
  );
};

// === 統計カードコンポーネント ===
interface StatsCardProps {
  title: string;
  value: string;
  trend: string;
  icon: React.ReactNode;
  color: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
}

const StatsCard: React.FC<StatsCardProps> = ({ title, value, trend, icon, color }) => {
  return (
    <Card>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
          <Box
            sx={{
              p: 1,
              borderRadius: 2,
              backgroundColor: `${color}.light`,
              color: `${color}.main`,
              mr: 2
            }}
          >
            {icon}
          </Box>
          <Typography color="text.secondary" variant="body2">
            {title}
          </Typography>
        </Box>
        <Typography variant="h4" component="div" gutterBottom>
          {value}
        </Typography>
        <Typography variant="body2" color={trend.startsWith('+') ? 'success.main' : 'text.secondary'}>
          {trend}
        </Typography>
      </CardContent>
    </Card>
  );
};

export default AdvancedDashboard;