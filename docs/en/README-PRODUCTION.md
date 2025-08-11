# Otedama Production Deployment Guide

**Version**: 2.1.6  
**Last Updated**: 2025-08-06  

This guide provides comprehensive instructions for deploying Otedama P2P Mining Pool in a production environment.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/shizukutanaka/Otedama.git
cd otedama

# Copy and configure environment variables
cp .env.production.example .env.production
# Edit .env.production with your settings

# Deploy with Docker Compose
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps
docker-compose -f docker-compose.production.yml logs -f
```

## Production Files Overview

### Configuration Files
- `.env.production.example` - Environment variables template
- `config.yaml` - Main application configuration
- `config/nginx.production.conf` - Nginx reverse proxy configuration
- `config/prometheus.yml` - Prometheus monitoring configuration
- `config/prometheus/alerts/otedama_alerts.yml` - Alert rules
- `config/grafana/` - Grafana dashboard configurations

### Deployment Files
- `docker-compose.production.yml` - Production Docker Compose configuration
- `Dockerfile.production` - Optimized production Docker image
- `scripts/docker-entrypoint.sh` - Container initialization script
- `scripts/otedama.service` - systemd service file

### Database
- `scripts/postgres-init.sql` - PostgreSQL initialization and schema

### Operational Scripts
- `scripts/backup.sh` - Automated backup script
- `scripts/health-check.sh` - Health monitoring script
- `docs/DEPLOYMENT_GUIDE.md` - Detailed deployment instructions
- `docs/OPERATIONS_CHECKLIST.md` - Daily/weekly/monthly operational tasks

## Minimum System Requirements

### Hardware
- CPU: 8 cores (16 recommended)
- RAM: 16GB (32GB recommended)
- Storage: 500GB SSD (1TB recommended)
- Network: 1 Gbps connection

### Software
- Ubuntu 20.04 LTS or newer
- Docker 20.10+
- Docker Compose 2.0+
- PostgreSQL 14+
- Redis 7+

## Security Considerations

1. **SSL/TLS Configuration**
   - Update SSL certificate paths in nginx.production.conf
   - Use Let's Encrypt for free certificates
   - Enable HTTP/2 and TLS 1.3

2. **Firewall Rules**
   ```bash
   # Stratum ports
   ufw allow 3333:3337/tcp
   
   # Web/API
   ufw allow 80/tcp
   ufw allow 443/tcp
   
   # Federation
   ufw allow 4444/tcp
   ```

3. **Environment Variables**
   - Generate strong passwords for all services
   - Use unique JWT secrets (minimum 32 characters)
   - Configure API rate limits

4. **Database Security**
   - Enable SSL for PostgreSQL connections
   - Use connection pooling
   - Regular security updates

## Monitoring Setup

### Prometheus Metrics
- Pool hashrate and efficiency
- Worker statistics
- Payment processing
- System resources
- Security events

### Grafana Dashboards
- Real-time pool overview
- Miner performance
- System health
- Payment analytics
- Security monitoring

### Alerts
- Service availability
- Resource utilization
- Security threats
- Payment failures
- Federation issues

## Backup Strategy

### Automated Backups
```bash
# Configure backup script
chmod +x scripts/backup.sh

# Add to crontab for daily backups
0 2 * * * /app/scripts/backup.sh
```

### Backup Targets
- PostgreSQL database
- Configuration files
- Recent logs
- Wallet data

### Recovery Testing
- Monthly recovery drills
- Document recovery procedures
- Test restore times

## High Availability

### Load Balancing
- Use nginx for HTTP/HTTPS
- HAProxy for stratum connections
- Geographic distribution

### Database Replication
- PostgreSQL streaming replication
- Automated failover
- Regular replication monitoring

### Federation Network
- Minimum 3 peer connections
- Automatic peer discovery
- Work redistribution

## Performance Tuning

### PostgreSQL
```sql
-- Apply optimizations from postgres-init.sql
ALTER SYSTEM SET shared_buffers = '1GB';
ALTER SYSTEM SET effective_cache_size = '3GB';
```

### Redis
```bash
# Configure in docker-compose.production.yml
maxmemory 512mb
maxmemory-policy allkeys-lru
```

### Application
- Configure worker limits in .env.production
- Tune connection timeouts
- Enable profit switching

## Troubleshooting

### Common Issues
1. **High CPU Usage**
   - Check worker count
   - Review share validation
   - Monitor database queries

2. **Memory Leaks**
   - Check Redis memory usage
   - Review connection pooling
   - Monitor goroutine count

3. **Payment Delays**
   - Verify wallet balance
   - Check blockchain connectivity
   - Review payment queue

### Diagnostic Commands
```bash
# Check health
./scripts/health-check.sh

# View logs
docker-compose -f docker-compose.production.yml logs -f otedama

# Database queries
docker exec -it otedama_postgres psql -U otedama

# Redis status
docker exec -it otedama_redis redis-cli info
```

## Support

- Documentation: `/docs` directory
- Issues: GitHub Issues
- Security: security@otedama.io

## License

See LICENSE file in the repository root.