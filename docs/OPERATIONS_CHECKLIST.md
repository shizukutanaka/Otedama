# Otedama Production Operations Checklist

**Version**: 2.1.5  
**Last Updated**: 2025-08-05  

This comprehensive checklist covers all operational tasks, monitoring procedures, and emergency protocols for running Otedama P2P Mining Pool in production.

## Pre-Launch Checklist

### Infrastructure
- [ ] Provision servers with recommended specifications
- [ ] Configure firewall rules (ports 3333-3337, 4444, 8080, 443)
- [ ] Set up load balancer with health checks
- [ ] Configure DDoS protection (Cloudflare/AWS Shield)
- [ ] Set up SSL certificates (Let's Encrypt)
- [ ] Configure automated certificate renewal

### Database
- [ ] Install PostgreSQL 14+
- [ ] Configure connection pooling
- [ ] Set up replication (primary/standby)
- [ ] Configure automated backups
- [ ] Test restore procedures
- [ ] Set up monitoring queries

### Configuration
- [ ] Copy and configure .env.production
- [ ] Set strong passwords for all services
- [ ] Configure pool fees and payout thresholds
- [ ] Set up SMTP for alerts
- [ ] Configure backup destinations
- [ ] Set rate limiting parameters

### Security
- [ ] Enable firewall (ufw/iptables)
- [ ] Configure fail2ban
- [ ] Set up intrusion detection (AIDE/Tripwire)
- [ ] Enable audit logging
- [ ] Configure SELinux/AppArmor
- [ ] Set up security scanning

### Monitoring
- [ ] Deploy Prometheus
- [ ] Configure Grafana dashboards
- [ ] Set up alert rules
- [ ] Configure notification channels
- [ ] Test alert delivery
- [ ] Set up uptime monitoring

## Daily Operations (Automated)

### Health Checks (Every 5 minutes)
- [ ] API endpoint availability
- [ ] Database connectivity
- [ ] Redis connectivity
- [ ] Stratum server status
- [ ] Federation peer count
- [ ] Memory usage < 80%
- [ ] CPU usage < 75%
- [ ] Disk usage < 80%

### Performance Monitoring (Every 15 minutes)
- [ ] Pool hashrate variance
- [ ] Share submission rate
- [ ] Block finding rate
- [ ] Payment queue size
- [ ] Network latency to peers
- [ ] Database query performance

### Security Monitoring (Continuous)
- [ ] Failed authentication attempts
- [ ] DDoS attack indicators
- [ ] Unusual traffic patterns
- [ ] New IP geolocation
- [ ] Rate limit violations
- [ ] Suspicious worker behavior

## Daily Manual Tasks

### Morning Review (9 AM)
- [ ] Check overnight alerts
- [ ] Review hashrate trends
- [ ] Verify payment processing
- [ ] Check error log summary
- [ ] Review new miner registrations
- [ ] Check federation status

### Evening Review (6 PM)
- [ ] Review daily statistics
- [ ] Check pending payouts
- [ ] Verify backup completion
- [ ] Review resource usage
- [ ] Check for security alerts
- [ ] Update operational notes

## Weekly Tasks

### Monday - Security Review
- [ ] Review security logs
- [ ] Check for CVE alerts
- [ ] Update security patches
- [ ] Review firewall logs
- [ ] Check SSL certificate expiry
- [ ] Audit user permissions

### Wednesday - Performance Review
- [ ] Analyze hashrate trends
- [ ] Review database slow queries
- [ ] Check connection pool usage
- [ ] Review worker efficiency
- [ ] Optimize indexes if needed
- [ ] Clean up old sessions

### Friday - Maintenance
- [ ] Test backup restoration
- [ ] Clean old log files
- [ ] Update dependencies
- [ ] Review disk usage
- [ ] Check for updates
- [ ] Plan next week

## Monthly Tasks

### First Monday - Full Audit
- [ ] Complete security audit
- [ ] Review all configurations
- [ ] Test disaster recovery
- [ ] Update documentation
- [ ] Review SLAs
- [ ] Plan capacity

### Second Monday - Performance
- [ ] Deep performance analysis
- [ ] Database vacuum full
- [ ] Review mining algorithms
- [ ] Update optimization settings
- [ ] Benchmark comparisons
- [ ] Cost optimization

### Third Monday - Infrastructure
- [ ] Server maintenance windows
- [ ] Network equipment checks
- [ ] Backup system verification
- [ ] Certificate renewals
- [ ] DNS verification
- [ ] CDN cache purge

### Fourth Monday - Business
- [ ] Financial reconciliation
- [ ] Miner satisfaction survey
- [ ] Competition analysis
- [ ] Feature planning
- [ ] Team training
- [ ] Compliance review

## Emergency Procedures

### 1. Complete System Down
```bash
# Quick diagnosis
docker ps -a
systemctl status otedama
journalctl -u otedama -n 100

# Recovery steps
1. Check infrastructure (network, servers)
2. Verify database is running
3. Start services in order: DB → Redis → Otedama
4. Verify stratum connectivity
5. Check miner connections
6. Monitor for 15 minutes
```

### 2. Database Emergency
```bash
# Check connections
psql -U otedama -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Kill long-running queries
psql -U otedama -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
WHERE pid <> pg_backend_pid() AND state = 'active' AND query_start < now() - interval '5 minutes';"

# Emergency vacuum
psql -U otedama -c "VACUUM ANALYZE;"

# Failover to standby (if configured)
pg_ctl promote -D /var/lib/postgresql/14/standby
```

### 3. DDoS Attack Response
```bash
# Enable emergency DDoS mode
curl -X POST http://localhost:8080/api/admin/ddos-protection -d '{"mode":"emergency"}'

# Check attack patterns
tail -f /var/log/otedama/security.log | grep -E "(rate_limit|banned)"

# Block source countries if needed
ufw deny from 1.2.3.0/24

# Contact upstream provider
# Enable Cloudflare "Under Attack" mode
```

### 4. Payment System Failure
```bash
# Check payment processor status
curl http://localhost:8080/api/admin/payments/status

# Pause automatic payments
curl -X POST http://localhost:8080/api/admin/payments/pause

# Manual payment processing
./bin/otedama payments process --manual

# Verify blockchain connectivity
./bin/otedama blockchain verify
```

### 5. Federation Network Split
```bash
# Check peer connectivity
curl http://localhost:8080/api/federation/peers

# Force peer reconnection
curl -X POST http://localhost:8080/api/federation/reconnect

# Verify work sharing
tail -f /var/log/otedama/federation.log

# Emergency standalone mode
./bin/otedama federation disable --emergency
```

## Monitoring Commands

### Real-time Statistics
```bash
# Pool statistics
watch -n 5 'curl -s http://localhost:8080/api/v1/stats | jq .'

# Active connections
watch -n 2 'netstat -an | grep -E ":(3333|3334|3335)" | grep ESTABLISHED | wc -l'

# Database activity
watch -n 5 'psql -U otedama -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"'

# Container resources
docker stats --no-stream
```

### Performance Metrics
```bash
# Hashrate by algorithm
curl -s http://localhost:8080/api/v1/algorithms | jq '.data[] | {name, hashrate}'

# Top miners
curl -s http://localhost:8080/api/v1/miners/top?limit=10 | jq '.data[] | {address, hashrate}'

# Payment queue
curl -s http://localhost:8080/api/admin/payments/queue | jq '.pending_count'
```

### Log Analysis
```bash
# Error summary
grep ERROR /var/log/otedama/error.log | awk '{print $5}' | sort | uniq -c | sort -rn

# Slow queries
grep "slow_query" /var/log/otedama/app.log | tail -20

# Security events
grep -E "(banned|blocked|attack)" /var/log/otedama/security.log | tail -50
```

## Backup and Recovery

### Daily Backup Verification
```bash
# Check latest backup
aws s3 ls s3://otedama-backups/daily/ | tail -1

# Verify backup integrity
./scripts/verify-backup.sh $(date +%Y%m%d)

# Test restore to staging
./scripts/restore-staging.sh
```

### Disaster Recovery Test (Monthly)
```bash
# Full DR test procedure
1. Spin up DR environment
2. Restore latest backup
3. Verify data integrity
4. Test miner connections
5. Verify payment processing
6. Document results
7. Update runbook
```

## Scaling Procedures

### Horizontal Scaling
```bash
# Add new stratum server
1. Provision new server
2. Deploy Otedama in stratum-only mode
3. Update load balancer
4. Test connectivity
5. Monitor for 24 hours

# Add federation peer
1. Exchange peer credentials
2. Update federation config
3. Restart federation service
4. Verify work sharing
```

### Vertical Scaling
```bash
# Increase resources
1. Schedule maintenance window
2. Take snapshot
3. Resize instance
4. Update config limits
5. Restart services
6. Monitor performance
```

## Compliance and Reporting

### Monthly Reports
- [ ] Generate miner statistics report
- [ ] Create financial summary
- [ ] Document security incidents
- [ ] Review SLA compliance
- [ ] Update risk register
- [ ] Prepare board report

### Quarterly Tasks
- [ ] Security penetration test
- [ ] Disaster recovery drill
- [ ] Capacity planning review
- [ ] Technology stack review
- [ ] Team training update
- [ ] Strategic planning

## Contact Information

### Emergency Contacts
- On-call Engineer: +1-XXX-XXX-XXXX
- Database Admin: +1-XXX-XXX-XXXX
- Security Team: security@company.com
- Management: management@company.com

### Vendor Support
- Cloud Provider: support.aws.amazon.com
- DDoS Protection: support.cloudflare.com
- Monitoring: support@grafana.com

### Internal Resources
- Wiki: https://wiki.company.com/otedama
- Runbook: https://runbook.company.com
- Slack: #otedama-ops
- PagerDuty: otedama-oncall