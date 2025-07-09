import React, { useEffect, useState } from 'react';
import { Chart } from 'chart.js';
import { WebSocketClient } from '../../websocket/client';
import { PoolStats, Miner, Block } from '../../types';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#1976d2',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
});

interface DashboardProps {
  wsClient: WebSocketClient;
}

export const Dashboard: React.FC<DashboardProps> = ({ wsClient }) => {
  const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
  const [miners, setMiners] = useState<Miner[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [hashrateChart, setHashrateChart] = useState<Chart | null>(null);
  const [difficultyChart, setDifficultyChart] = useState<Chart | null>(null);

  useEffect(() => {
    // Setup WebSocket listeners
    wsClient.on('poolStatsUpdated', (stats: PoolStats) => {
      setPoolStats(stats);
    });

    wsClient.on('minerStatusChanged', (miner: Miner) => {
      setMiners((prev) => {
        const index = prev.findIndex((m) => m.address === miner.address);
        if (index !== -1) {
          prev[index] = miner;
        } else {
          prev.push(miner);
        }
        return [...prev];
      });
    });

    wsClient.on('newBlock', (block: Block) => {
      setBlocks((prev) => [...prev, block].slice(-10));
    });

    // Initialize charts
    const ctx1 = document.getElementById('hashrateChart') as HTMLCanvasElement;
    const ctx2 = document.getElementById('difficultyChart') as HTMLCanvasElement;

    if (ctx1 && ctx2) {
      const hashrateChart = new Chart(ctx1, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Hashrate (GH/s)',
            data: [],
            borderColor: '#1976d2',
            tension: 0.1,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
            },
          },
        },
      });

      const difficultyChart = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Difficulty',
            data: [],
            borderColor: '#1976d2',
            tension: 0.1,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
            },
          },
        },
      });

      setHashrateChart(hashrateChart);
      setDifficultyChart(difficultyChart);
    }

    // Cleanup
    return () => {
      wsClient.off('poolStatsUpdated');
      wsClient.off('minerStatusChanged');
      wsClient.off('newBlock');
      hashrateChart?.destroy();
      difficultyChart?.destroy();
    };
  }, [wsClient]);

  useEffect(() => {
    if (poolStats && hashrateChart) {
      const labels = Array.from({ length: 60 }, (_, i) => 
        format(new Date(Date.now() - (59 - i) * 60000), 'HH:mm', { locale: ja })
      );
      
      hashrateChart.data.labels = labels;
      hashrateChart.data.datasets[0].data = Array(60).fill(poolStats.totalHashrate);
      hashrateChart.update();
    }
  }, [poolStats, hashrateChart]);

  useEffect(() => {
    if (blocks.length > 0 && difficultyChart) {
      const labels = blocks.map((block) => format(new Date(block.timestamp), 'HH:mm:ss', { locale: ja }));
      const difficulties = blocks.map((block) => block.difficulty);
      
      difficultyChart.data.labels = labels;
      difficultyChart.data.datasets[0].data = difficulties;
      difficultyChart.update();
    }
  }, [blocks, difficultyChart]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
        <Grid container spacing={3}>
          {/* Main Stats */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
              <Typography component="h2" variant="h6" color="primary" gutterBottom>
                プール統計
              </Typography>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography>総ハッシュレート: {poolStats?.totalHashrate?.toFixed(2)} GH/s</Typography>
                <Typography>アクティブマイナー: {poolStats?.activeMiners}人</Typography>
                <Typography>支払い残高: {poolStats?.pendingPayments?.toFixed(8)} BTC</Typography>
              </Box>
            </Paper>
          </Grid>

          {/* Charts */}
          <Grid item xs={12} md={6}>
            <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
              <Typography component="h2" variant="h6" color="primary" gutterBottom>
                ハッシュレート
              </Typography>
              <canvas id="hashrateChart"></canvas>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6}>
            <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
              <Typography component="h2" variant="h6" color="primary" gutterBottom>
                難易度
              </Typography>
              <canvas id="difficultyChart"></canvas>
            </Paper>
          </Grid>

          {/* Recent Blocks */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
              <Typography component="h2" variant="h6" color="primary" gutterBottom>
                最近のブロック
              </Typography>
              <Box sx={{ overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>高さ</th>
                      <th>ハッシュ</th>
                      <th>報酬</th>
                      <th>マイナー</th>
                      <th>時間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocks.map((block) => (
                      <tr key={block.id}>
                        <td>{block.height}</td>
                        <td>{block.hash.slice(0, 10)}...</td>
                        <td>{block.reward.toFixed(8)} BTC</td>
                        <td>{block.miner?.address}</td>
                        <td>{format(new Date(block.timestamp), 'HH:mm:ss', { locale: ja })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          </Grid>

          {/* Active Miners */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
              <Typography component="h2" variant="h6" color="primary" gutterBottom>
                アクティブマイナー
              </Typography>
              <Box sx={{ overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>アドレス</th>
                      <th>ハッシュレート</th>
                      <th>シェア</th>
                      <th>最終接続</th>
                      <th>ステータス</th>
                    </tr>
                  </thead>
                  <tbody>
                    {miners.map((miner) => (
                      <tr key={miner.address}>
                        <td>{miner.address}</td>
                        <td>{miner.hashrate.toFixed(2)} GH/s</td>
                        <td>{miner.shares}</td>
                        <td>{format(new Date(miner.lastSeen), 'HH:mm:ss', { locale: ja })}</td>
                        <td>{miner.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          </Grid>
        </Grid>
      </Container>
    </ThemeProvider>
  );
};
