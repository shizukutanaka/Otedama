# Otedama Deployment Guide

This guide covers deployment options for Otedama mining pool software.

## Table of Contents

- [Docker Deployment](#docker-deployment)
- [Docker Compose](#docker-compose)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Helm Installation](#helm-installation)
- [Production Considerations](#production-considerations)

## Docker Deployment

### Quick Start

```bash
# Build the image
docker build -t otedama:latest .

# Run with default configuration
docker run -d \
  --name otedama \
  -p 8080:8080 \
  -p 8081:8081 \
  -p 3333:3333 \
  -p 30303:30303 \
  -p 9090:9090 \
  -v $(pwd)/config.yaml:/etc/otedama/config.yaml:ro \
  -v otedama-data:/var/lib/otedama \
  otedama:latest
```

### Environment Variables

- `LOG_LEVEL`: Set logging level (debug, info, warn, error)
- `OTEDAMA_ENV`: Environment name (development, staging, production)
- `TZ`: Timezone (default: UTC)

### Volumes

- `/etc/otedama`: Configuration files
- `/var/lib/otedama`: Persistent data
- `/var/log/otedama`: Log files

## Docker Compose

### Basic Setup

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f otedama

# Stop services
docker-compose down
```

### Services Included

- **otedama**: Main application
- **prometheus**: Metrics collection
- **grafana**: Metrics visualization
- **nginx**: Reverse proxy with SSL

### Configuration

Edit `docker-compose.yml` to customize:

```yaml
environment:
  - LOG_LEVEL=debug
  - GF_ADMIN_PASSWORD=secure-password
```

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.21+)
- kubectl configured
- Storage class for persistent volumes

### Manual Deployment

```bash
# Create namespace
kubectl apply -f k8s/namespace.yaml

# Apply configurations
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml

# Create persistent volume claim
kubectl apply -f k8s/pvc.yaml

# Deploy application
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# Configure autoscaling
kubectl apply -f k8s/hpa.yaml

# Setup ingress
kubectl apply -f k8s/ingress.yaml

# Apply RBAC
kubectl apply -f k8s/rbac.yaml
```

### Verify Deployment

```bash
# Check pod status
kubectl get pods -n otedama

# View logs
kubectl logs -n otedama -l app=otedama

# Check services
kubectl get svc -n otedama
```

## Helm Installation

### Add Repository

```bash
# Add Otedama Helm repository
# helm repo add otedama [YOUR_HELM_REPO_URL]
helm repo update
```

### Install Chart

```bash
# Install with default values
helm install otedama otedama/otedama -n otedama --create-namespace

# Install with custom values
helm install otedama otedama/otedama \
  -n otedama \
  --create-namespace \
  -f values-production.yaml
```

### Custom Values Example

Create `values-production.yaml`:

```yaml
replicaCount: 5

image:
  tag: "v2.1.0"

resources:
  limits:
    cpu: 8
    memory: 16Gi
  requests:
    cpu: 4
    memory: 8Gi

config:
  pool:
    fee: 0.5
    minPayout: 0.01
  
  stratum:
    maxConnections: 50000

persistence:
  size: 500Gi

secrets:
  apiKey: "your-secure-api-key"
  dashboardPassword: "your-secure-password"
```

### Upgrade

```bash
# Upgrade to new version
helm upgrade otedama otedama/otedama -n otedama

# Rollback if needed
helm rollback otedama -n otedama
```

## Production Considerations

### Security

1. **API Keys**: Always use strong, unique API keys
2. **TLS/SSL**: Enable HTTPS for all external endpoints
3. **Firewall**: Restrict access to necessary ports only
4. **Updates**: Keep the software and dependencies updated

### High Availability

1. **Replicas**: Run at least 3 replicas in production
2. **Anti-affinity**: Spread pods across different nodes
3. **Load Balancing**: Use proper load balancers for services
4. **Persistent Storage**: Use redundant storage solutions

### Monitoring

1. **Prometheus**: Monitor application metrics
2. **Grafana**: Create dashboards for visualization
3. **Alerts**: Set up alerting for critical metrics
4. **Logs**: Centralize logging with ELK or similar

### Backup

1. **Data**: Regular backups of persistent volumes
2. **Configuration**: Version control for configurations
3. **Disaster Recovery**: Test recovery procedures

### Performance

1. **Resources**: Allocate sufficient CPU and memory
2. **Network**: Ensure low latency connectivity
3. **Storage**: Use fast SSDs for data storage
4. **Tuning**: Optimize based on workload

### Example Production Setup

```bash
# Create production namespace
kubectl create namespace otedama-prod

# Apply production configurations
helm install otedama otedama/otedama \
  -n otedama-prod \
  --set image.tag=v2.1.0 \
  --set replicaCount=5 \
  --set persistence.size=1Ti \
  --set resources.requests.cpu=8 \
  --set resources.requests.memory=16Gi \
  --set config.pool.fee=0.5 \
  --set config.stratum.maxConnections=100000 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=pool.yourdomain.com
```

## Troubleshooting

### Common Issues

1. **Pod not starting**: Check logs with `kubectl logs`
2. **Service unavailable**: Verify service endpoints
3. **Storage issues**: Check PVC status
4. **Performance problems**: Review resource usage

### Debug Commands

```bash
# Describe pod
kubectl describe pod -n otedama <pod-name>

# Execute shell in pod
kubectl exec -it -n otedama <pod-name> -- /bin/sh

# Check events
kubectl get events -n otedama --sort-by='.lastTimestamp'

# View resource usage
kubectl top pods -n otedama
```

## Support

For additional help:
- Documentation: See the `/docs` directory
- Issues: https://github.com/shizukutanaka/Otedama/issues
- Community: Create issues on GitHub for support