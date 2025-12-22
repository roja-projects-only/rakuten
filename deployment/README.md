# POW Service Deployment Guide

This guide covers deploying the POW Service to an EC2 c6i.large spot instance.

## Prerequisites

- AWS EC2 c6i.large spot instance running Ubuntu 20.04 LTS
- Redis server accessible from the EC2 instance
- SSH access to the EC2 instance
- Docker installed (or will be installed by the script)

## Quick Deployment

1. **Upload files to EC2 instance:**
   ```bash
   # Copy deployment files
   scp -r deployment/ ubuntu@your-ec2-ip:/tmp/
   scp Dockerfile.pow-service ubuntu@your-ec2-ip:/tmp/
   scp pow-service.js ubuntu@your-ec2-ip:/tmp/
   scp -r shared/ ubuntu@your-ec2-ip:/tmp/
   scp -r automation/ ubuntu@your-ec2-ip:/tmp/
   scp logger.js ubuntu@your-ec2-ip:/tmp/
   scp package*.json ubuntu@your-ec2-ip:/tmp/
   ```

2. **SSH to EC2 instance:**
   ```bash
   ssh ubuntu@your-ec2-ip
   ```

3. **Run deployment script:**
   ```bash
   cd /tmp
   chmod +x deployment/deploy-pow-service.sh
   sudo ./deployment/deploy-pow-service.sh
   ```

4. **Configure environment:**
   ```bash
   sudo nano /opt/pow-service/.env
   # Edit REDIS_URL and other settings
   ```

5. **Restart service:**
   ```bash
   sudo systemctl restart pow-service
   ```

## Manual Deployment Steps

If you prefer manual deployment:

### 1. Install Docker

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Start Docker
sudo systemctl start docker
sudo systemctl enable docker
```

### 2. Create Service User

```bash
# Create powservice user
sudo useradd --system --shell /bin/false --home-dir /opt/pow-service --create-home powservice
sudo usermod -aG docker powservice

# Create directories
sudo mkdir -p /opt/pow-service/{logs,config}
sudo chown -R powservice:powservice /opt/pow-service
```

### 3. Build Docker Image

```bash
# Copy files to service directory
sudo cp -r /tmp/* /opt/pow-service/
cd /opt/pow-service

# Build Docker image
sudo docker build -f Dockerfile.pow-service -t pow-service:latest .
```

### 4. Configure Environment

```bash
# Copy environment template
sudo cp deployment/.env.pow-service.example /opt/pow-service/.env
sudo chown powservice:powservice /opt/pow-service/.env
sudo chmod 600 /opt/pow-service/.env

# Edit configuration
sudo nano /opt/pow-service/.env
```

Required environment variables:
- `REDIS_URL`: Redis connection URL
- `PORT`: Service port (default: 3001)
- `LOG_LEVEL`: Logging level (info, debug, etc.)

### Timeout Configuration

For distributed worker deployments, configure these timeout values:

```bash
# Redis timeouts (in milliseconds)
REDIS_COMMAND_TIMEOUT=60000    # Must be > WORKER_QUEUE_TIMEOUT
WORKER_QUEUE_TIMEOUT=30000     # BLPOP timeout for task dequeue
WORKER_TASK_TIMEOUT=120000     # Max time per credential check
WORKER_HEARTBEAT_INTERVAL=10000 # Heartbeat frequency
```

**Important**: `REDIS_COMMAND_TIMEOUT` must be greater than `WORKER_QUEUE_TIMEOUT` to prevent Redis client timeouts during normal BLPOP operations.

### 5. Install Systemd Service

```bash
# Copy service file
sudo cp deployment/pow-service.service /etc/systemd/system/

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable pow-service
sudo systemctl start pow-service
```

### 6. Configure Firewall

```bash
# Allow service ports
sudo ufw allow 3001/tcp comment "POW Service"
sudo ufw allow 9090/tcp comment "POW Service Metrics"
sudo ufw allow 8080/tcp comment "POW Service Health"
```

## Verification

### Check Service Status

```bash
# Service status
sudo systemctl status pow-service

# View logs
sudo journalctl -u pow-service -f

# Check health endpoint
curl http://localhost:3001/health

# Check metrics endpoint
curl http://localhost:9090/metrics
```

### Test POW Computation

```bash
# Test compute endpoint
curl -X POST http://localhost:3001/compute \
  -H "Content-Type: application/json" \
  -d '{
    "mask": "0000",
    "key": "abc123",
    "seed": 42
  }'
```

Expected response:
```json
{
  "cres": "abc123xyz789abcd",
  "cached": false,
  "computeTimeMs": 234
}
```

## Monitoring

### Service Endpoints

- **Health Check**: `http://your-ec2-ip:3001/health`
- **Metrics**: `http://your-ec2-ip:9090/metrics`
- **Compute API**: `http://your-ec2-ip:3001/compute`

### Key Metrics to Monitor

- `pow_requests_total`: Total requests processed
- `pow_cache_hit_rate`: Cache efficiency (target: >60%)
- `pow_computation_duration_seconds`: Average computation time
- `pow_workers_active`: Active worker threads
- `pow_queue_depth`: Queued tasks

### Log Locations

- **Systemd logs**: `sudo journalctl -u pow-service`
- **Application logs**: `/opt/pow-service/logs/` (if file logging enabled)

## Troubleshooting

### Common Issues

1. **Service won't start**:
   ```bash
   # Check logs
   sudo journalctl -u pow-service -n 50
   
   # Check Docker image
   sudo docker images | grep pow-service
   
   # Test Docker run manually
   sudo docker run --rm -p 3001:3001 --env-file /opt/pow-service/.env pow-service:latest
   ```

2. **Redis connection issues**:
   ```bash
   # Test Redis connectivity
   redis-cli -u $REDIS_URL ping
   
   # Check Redis logs
   sudo journalctl -u redis -n 50
   ```

3. **High CPU usage**:
   - Check worker thread count in configuration
   - Monitor POW request rate
   - Consider scaling to multiple instances

4. **Memory issues**:
   - Check Docker memory limits
   - Monitor cache size and hit rate
   - Consider Redis memory optimization

5. **Worker timeout errors**:
   ```bash
   # Check for "Command timed out" errors
   docker logs rakuten-worker | grep "Command timed out"
   
   # Verify timeout configuration
   docker exec rakuten-worker env | grep -E "(REDIS_COMMAND_TIMEOUT|WORKER_QUEUE_TIMEOUT)"
   
   # Fix: Ensure REDIS_COMMAND_TIMEOUT > WORKER_QUEUE_TIMEOUT
   # Example: REDIS_COMMAND_TIMEOUT=60000, WORKER_QUEUE_TIMEOUT=30000
   ```

### Performance Tuning

For c6i.large instances (2 vCPU, 4GB RAM):

```bash
# Optimal configuration in .env
WORKER_CONCURRENCY=3
POW_WORKER_COUNT=1
POW_TASK_TIMEOUT=5000
POW_MAX_ITERATIONS=8000000
```

### Security Considerations

1. **Firewall**: Only expose necessary ports
2. **User permissions**: Service runs as non-root user
3. **Redis security**: Use authentication and encryption
4. **Updates**: Keep Docker and system packages updated

## Scaling

### Horizontal Scaling

To handle higher loads:

1. **Deploy multiple instances**:
   - Use Application Load Balancer
   - Deploy to different AZs for HA
   - Share Redis cache across instances

2. **Auto Scaling Group**:
   - Configure based on CPU/memory metrics
   - Use spot instances for cost optimization
   - Set appropriate health checks

### Vertical Scaling

For higher per-instance performance:
- Upgrade to c6i.xlarge (4 vCPU, 8GB RAM)
- Increase worker thread count
- Optimize Redis configuration

## Cost Optimization

### Spot Instance Configuration

- **Instance Type**: c6i.large (~$0.04/hour spot)
- **Availability**: Monitor spot price trends
- **Interruption Handling**: Graceful shutdown on termination

### Resource Monitoring

```bash
# Monitor resource usage
htop
docker stats
iostat -x 1
```

Target utilization:
- **CPU**: 60-80% average
- **Memory**: <80% usage
- **Network**: Monitor Redis connection latency

## Backup and Recovery

### Configuration Backup

```bash
# Backup configuration
sudo tar -czf pow-service-config-$(date +%Y%m%d).tar.gz /opt/pow-service/.env /etc/systemd/system/pow-service.service
```

### Disaster Recovery

1. **Redis failover**: Configure Redis cluster/sentinel
2. **Multi-AZ deployment**: Deploy across availability zones
3. **Health monitoring**: Set up CloudWatch alarms
4. **Automated recovery**: Use Auto Scaling Groups

## Support

For issues and questions:
1. Check service logs: `sudo journalctl -u pow-service -f`
2. Verify configuration: `/opt/pow-service/.env`
3. Test endpoints manually with curl
4. Monitor system resources with htop/iostat