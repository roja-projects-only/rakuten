# Rakuten Checker - Distributed Deployment Guide

## Overview

This guide covers deploying the Rakuten credential checker in a distributed architecture across AWS EC2 instances. The system consists of three main components:

- **Coordinator**: Telegram bot and job orchestration (t3.small)
- **Workers**: Credential checking processes (t3.micro spot instances)
- **POW Service**: Proof-of-work computation service (c6i.large spot)

## Architecture Diagram

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Coordinator   │    │   POW Service   │    │   Worker Pool   │
│   (t3.small)    │    │  (c6i.large)    │    │  (t3.micro×N)   │
│                 │    │                 │    │                 │
│ - Telegram Bot  │    │ - HTTP API      │    │ - Task Puller   │
│ - Job Queue Mgr │    │ - Worker Threads│    │ - HTTP Client   │
│ - Progress Track│    │ - Redis Cache   │    │ - Result Pub    │
│ - Channel Fwd   │    │ - /compute      │    │ - Heartbeat     │
└─────────┬───────┘    └─────────┬───────┘    └─────────┬───────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                    ┌─────────────────┐
                    │  Redis Cluster  │
                    │ (ElastiCache or │
                    │  EC2 instance)  │
                    └─────────────────┘
```

## AWS EC2 Setup

### 1. Security Groups

Create the following security groups:

#### Coordinator Security Group
```bash
# Allow Telegram webhook (if using webhook mode)
aws ec2 authorize-security-group-ingress \
  --group-id sg-coordinator \
  --protocol tcp \
  --port 3000 \
  --cidr 149.154.160.0/20

# Allow metrics endpoint
aws ec2 authorize-security-group-ingress \
  --group-id sg-coordinator \
  --protocol tcp \
  --port 9090 \
  --source-group sg-monitoring

# Allow SSH
aws ec2 authorize-security-group-ingress \
  --group-id sg-coordinator \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0
```

#### POW Service Security Group
```bash
# Allow HTTP API from workers and coordinator
aws ec2 authorize-security-group-ingress \
  --group-id sg-pow-service \
  --protocol tcp \
  --port 8080 \
  --source-group sg-coordinator

aws ec2 authorize-security-group-ingress \
  --group-id sg-pow-service \
  --protocol tcp \
  --port 8080 \
  --source-group sg-workers

# Allow SSH
aws ec2 authorize-security-group-ingress \
  --group-id sg-pow-service \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0
```

#### Worker Security Group
```bash
# Workers only need outbound access (no inbound rules except SSH)
aws ec2 authorize-security-group-ingress \
  --group-id sg-workers \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0
```

#### Redis Security Group
```bash
# Allow Redis access from all components
aws ec2 authorize-security-group-ingress \
  --group-id sg-redis \
  --protocol tcp \
  --port 6379 \
  --source-group sg-coordinator

aws ec2 authorize-security-group-ingress \
  --group-id sg-redis \
  --protocol tcp \
  --port 6379 \
  --source-group sg-workers

aws ec2 authorize-security-group-ingress \
  --group-id sg-redis \
  --protocol tcp \
  --port 6379 \
  --source-group sg-pow-service
```

### 2. Instance Types and Specifications

#### Coordinator Instance (t3.small)
- **vCPUs**: 2
- **Memory**: 2 GiB
- **Network**: Up to 5 Gigabit
- **Cost**: ~$0.0208/hour (~$15/month)
- **Use case**: Telegram bot, job orchestration, low CPU usage

#### POW Service Instance (c6i.large spot)
- **vCPUs**: 2
- **Memory**: 4 GiB
- **Network**: Up to 12.5 Gigabit
- **Cost**: ~$0.0408/hour spot (~$30/month)
- **Use case**: CPU-intensive proof-of-work computation

#### Worker Instances (t3.micro spot)
- **vCPUs**: 2
- **Memory**: 1 GiB
- **Network**: Up to 5 Gigabit
- **Cost**: ~$0.0031/hour spot (~$2.25/month each)
- **Use case**: HTTP credential checking, I/O bound

#### Redis Instance Options

**Option 1: ElastiCache (Managed)**
- **Instance**: cache.t3.micro
- **Memory**: 0.5 GiB
- **Cost**: ~$0.017/hour (~$12/month)
- **Benefits**: Managed, automatic backups, high availability

**Option 2: EC2 Self-Managed**
- **Instance**: t3.micro
- **Memory**: 1 GiB
- **Cost**: ~$0.0104/hour (~$7.5/month)
- **Benefits**: Lower cost, full control

### 3. Launch Templates

#### Coordinator Launch Template
```bash
aws ec2 create-launch-template \
  --launch-template-name coordinator-template \
  --launch-template-data '{
    "ImageId": "ami-0abcdef1234567890",
    "InstanceType": "t3.small",
    "SecurityGroupIds": ["sg-coordinator"],
    "IamInstanceProfile": {"Name": "coordinator-role"},
    "UserData": "'$(base64 -w 0 deployment/user-data-coordinator.sh)'",
    "TagSpecifications": [{
      "ResourceType": "instance",
      "Tags": [
        {"Key": "Name", "Value": "rakuten-coordinator"},
        {"Key": "Environment", "Value": "production"},
        {"Key": "Component", "Value": "coordinator"}
      ]
    }]
  }'
```

#### Worker Launch Template (Spot)
```bash
aws ec2 create-launch-template \
  --launch-template-name worker-template \
  --launch-template-data '{
    "ImageId": "ami-0abcdef1234567890",
    "InstanceType": "t3.micro",
    "SecurityGroupIds": ["sg-workers"],
    "IamInstanceProfile": {"Name": "worker-role"},
    "UserData": "'$(base64 -w 0 deployment/user-data-worker.sh)'",
    "InstanceMarketOptions": {
      "MarketType": "spot",
      "SpotOptions": {
        "MaxPrice": "0.005",
        "SpotInstanceType": "one-time"
      }
    },
    "TagSpecifications": [{
      "ResourceType": "instance",
      "Tags": [
        {"Key": "Name", "Value": "rakuten-worker"},
        {"Key": "Environment", "Value": "production"},
        {"Key": "Component", "Value": "worker"}
      ]
    }]
  }'
```

## Environment Variable Configuration

### Coordinator Environment Variables

Create `/opt/rakuten-checker/.env.coordinator`:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F
REDIS_URL=redis://your-redis-endpoint:6379
POW_SERVICE_URL=http://pow-service-private-ip:8080

# Optional
FORWARD_CHANNEL_ID=-1001234567890
ALLOWED_USER_IDS=123456789,987654321
PROXY_POOL=proxy1:port1,proxy2:port2,proxy3:port3

# Performance
BATCH_CONCURRENCY=1
BATCH_MAX_RETRIES=2
BATCH_DELAY_MS=50
TIMEOUT_MS=60000

# Monitoring
LOG_LEVEL=info
METRICS_PORT=9090
```

### Worker Environment Variables

Create `/opt/rakuten-checker/.env.worker`:

```bash
# Required
REDIS_URL=redis://your-redis-endpoint:6379
POW_SERVICE_URL=http://pow-service-private-ip:8080
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F

# Performance
TIMEOUT_MS=60000
BATCH_MAX_RETRIES=2
LOG_LEVEL=info
```

### POW Service Environment Variables

Create `/opt/rakuten-checker/.env.pow-service`:

```bash
# Required
REDIS_URL=redis://your-redis-endpoint:6379
PORT=8080

# Performance
LOG_LEVEL=info
NODE_ENV=production
```

## Deployment Steps

### Phase 1: Infrastructure Setup

1. **Create VPC and Subnets** (if not using default)
2. **Set up Security Groups** (see above)
3. **Launch Redis Instance** (ElastiCache or EC2)
4. **Create IAM Roles** for EC2 instances

### Phase 2: POW Service Deployment

1. **Launch POW Service Instance**:
```bash
aws ec2 run-instances \
  --launch-template LaunchTemplateName=pow-service-template \
  --min-count 1 \
  --max-count 1
```

2. **Deploy POW Service**:
```bash
# SSH to POW service instance
ssh -i your-key.pem ec2-user@pow-service-ip

# Install Docker
sudo yum update -y
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -a -G docker ec2-user

# Clone repository and build
git clone https://github.com/your-org/rakuten-checker.git
cd rakuten-checker
docker build -f Dockerfile.pow-service -t rakuten-pow-service .

# Create environment file
sudo mkdir -p /opt/rakuten-checker
sudo cp deployment/.env.pow-service.example /opt/rakuten-checker/.env.pow-service
sudo nano /opt/rakuten-checker/.env.pow-service  # Edit with your values

# Install and start systemd service
sudo cp deployment/pow-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pow-service
sudo systemctl start pow-service
```

3. **Verify POW Service**:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/metrics
```

### Phase 3: Coordinator Deployment

1. **Launch Coordinator Instance**:
```bash
aws ec2 run-instances \
  --launch-template LaunchTemplateName=coordinator-template \
  --min-count 1 \
  --max-count 1
```

2. **Deploy Coordinator**:
```bash
# SSH to coordinator instance
ssh -i your-key.pem ec2-user@coordinator-ip

# Install Docker (same as POW service)
# Clone repository and build
docker build -f Dockerfile.coordinator -t rakuten-coordinator .

# Create environment file
sudo cp deployment/.env.coordinator.example /opt/rakuten-checker/.env.coordinator
sudo nano /opt/rakuten-checker/.env.coordinator  # Edit with your values

# Install and start systemd service
sudo cp deployment/coordinator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable coordinator
sudo systemctl start coordinator
```

3. **Verify Coordinator**:
```bash
# Check logs
sudo journalctl -u coordinator -f

# Test Telegram bot
# Send .chk test@example.com:password to your bot

# Check metrics
curl http://localhost:9090/metrics
```

### Phase 4: Worker Deployment

1. **Launch Worker Instances**:
```bash
# Launch 5 workers initially
for i in {1..5}; do
  aws ec2 run-instances \
    --launch-template LaunchTemplateName=worker-template \
    --min-count 1 \
    --max-count 1 \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=rakuten-worker-$i}]"
done
```

2. **Deploy Workers** (repeat for each instance):
```bash
# SSH to worker instance
ssh -i your-key.pem ec2-user@worker-ip

# Install Docker and clone repository (same as above)
docker build -f Dockerfile.worker -t rakuten-worker .

# Create environment file
sudo cp deployment/.env.worker.example /opt/rakuten-checker/.env.worker
sudo nano /opt/rakuten-checker/.env.worker  # Edit with your values

# Install and start systemd service
sudo cp deployment/worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable worker@1  # Use unique instance number
sudo systemctl start worker@1
```

3. **Verify Workers**:
```bash
# Check worker logs
sudo journalctl -u worker@1 -f

# Check coordinator logs for worker registration
ssh coordinator-ip
sudo journalctl -u coordinator -f | grep "worker"
```

## Scaling Procedures

### Adding More Workers

1. **Launch New Worker Instance**:
```bash
aws ec2 run-instances \
  --launch-template LaunchTemplateName=worker-template \
  --min-count 1 \
  --max-count 1
```

2. **Deploy Worker** (same as Phase 4 step 2)

3. **Verify Registration**:
```bash
# Check coordinator logs for new worker
sudo journalctl -u coordinator -f | grep "worker registration"

# Use /status command in Telegram to see active workers
```

### Scaling POW Service

1. **Launch Additional POW Service Instance**
2. **Update Worker Environment Variables**:
```bash
# Add load balancer or update POW_SERVICE_URL to include multiple endpoints
POW_SERVICE_URL=http://pow-service-1:8080,http://pow-service-2:8080
```

### Auto Scaling (Optional)

Create Auto Scaling Group for workers:

```bash
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name rakuten-workers \
  --launch-template LaunchTemplateName=worker-template,Version=1 \
  --min-size 2 \
  --max-size 20 \
  --desired-capacity 5 \
  --vpc-zone-identifier subnet-12345,subnet-67890 \
  --health-check-type EC2 \
  --health-check-grace-period 300
```

## Monitoring Setup

### CloudWatch Monitoring

1. **Install CloudWatch Agent** on all instances:
```bash
# Download and install
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
sudo rpm -U ./amazon-cloudwatch-agent.rpm

# Configure
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

2. **Custom Metrics**:
- Queue depth (from Redis)
- Worker count (active heartbeats)
- POW cache hit rate
- Batch completion rate

### Prometheus Monitoring (Optional)

1. **Deploy Prometheus**:
```bash
# Launch monitoring instance
aws ec2 run-instances \
  --image-id ami-0abcdef1234567890 \
  --instance-type t3.small \
  --security-group-ids sg-monitoring \
  --key-name your-key

# Install Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.40.0/prometheus-2.40.0.linux-amd64.tar.gz
tar xvfz prometheus-*.tar.gz
cd prometheus-*
```

2. **Configure Prometheus** (`prometheus.yml`):
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'coordinator'
    static_configs:
      - targets: ['coordinator-ip:9090']
  
  - job_name: 'pow-service'
    static_configs:
      - targets: ['pow-service-ip:8080']
```

### Log Aggregation

1. **CloudWatch Logs**:
```bash
# Configure log groups
aws logs create-log-group --log-group-name /rakuten/coordinator
aws logs create-log-group --log-group-name /rakuten/workers
aws logs create-log-group --log-group-name /rakuten/pow-service
```

2. **Log Shipping**:
```bash
# Install and configure CloudWatch Logs agent
sudo yum install -y awslogs
sudo systemctl enable awslogs
sudo systemctl start awslogs
```

## Cost Estimates

### Small Deployment (5 workers)
| Component | Instance Type | Quantity | Monthly Cost |
|-----------|---------------|----------|--------------|
| Coordinator | t3.small (on-demand) | 1 | $15.18 |
| POW Service | c6i.large (spot) | 1 | $29.38 |
| Workers | t3.micro (spot) | 5 | $11.25 |
| Redis | ElastiCache t3.micro | 1 | $12.41 |
| **Total** | | | **$68.22/month** |

### Medium Deployment (10 workers)
| Component | Instance Type | Quantity | Monthly Cost |
|-----------|---------------|----------|--------------|
| Coordinator | t3.small (on-demand) | 1 | $15.18 |
| POW Service | c6i.large (spot) | 1 | $29.38 |
| Workers | t3.micro (spot) | 10 | $22.50 |
| Redis | ElastiCache t3.small | 1 | $24.82 |
| **Total** | | | **$91.88/month** |

### Large Deployment (20 workers)
| Component | Instance Type | Quantity | Monthly Cost |
|-----------|---------------|----------|--------------|
| Coordinator | t3.small (on-demand) | 1 | $15.18 |
| POW Service | c6i.xlarge (spot) | 2 | $117.52 |
| Workers | t3.micro (spot) | 20 | $45.00 |
| Redis | ElastiCache t3.medium | 1 | $49.64 |
| Load Balancer | ALB | 1 | $16.20 |
| **Total** | | | **$243.54/month** |

### Cost Optimization Tips

1. **Use Spot Instances**: 60-90% savings on workers and POW service
2. **Reserved Instances**: 30-60% savings on coordinator (if long-term)
3. **Right-sizing**: Monitor CPU/memory usage and adjust instance types
4. **Auto Scaling**: Scale workers based on queue depth
5. **Scheduled Scaling**: Scale down during low-usage hours

## Troubleshooting

### Common Issues

1. **Workers Not Connecting to Redis**:
```bash
# Check security groups
aws ec2 describe-security-groups --group-ids sg-workers

# Test Redis connectivity
redis-cli -h redis-endpoint -p 6379 ping
```

2. **POW Service Timeout**:
```bash
# Check POW service logs
sudo journalctl -u pow-service -f

# Test POW service directly
curl -X POST http://pow-service-ip:8080/compute \
  -H "Content-Type: application/json" \
  -d '{"mask":"0000","key":"test","seed":123}'
```

3. **High Queue Depth**:
```bash
# Check queue length
redis-cli -h redis-endpoint LLEN queue:tasks

# Add more workers or check worker health
systemctl status worker@*
```

4. **Coordinator Not Receiving Messages**:
```bash
# Check Telegram webhook
curl https://api.telegram.org/bot<token>/getWebhookInfo

# Check coordinator logs
sudo journalctl -u coordinator -f
```

### Performance Tuning

1. **Redis Optimization**:
```bash
# Increase memory limit
redis-cli CONFIG SET maxmemory 1gb

# Optimize persistence
redis-cli CONFIG SET save "900 1 300 10 60 10000"
```

2. **Worker Optimization**:
```bash
# Increase file descriptors
echo "worker soft nofile 65536" >> /etc/security/limits.conf
echo "worker hard nofile 65536" >> /etc/security/limits.conf
```

3. **POW Service Optimization**:
```bash
# Use all CPU cores
export UV_THREADPOOL_SIZE=8  # Set to number of CPU cores
```

## Security Considerations

1. **Network Security**:
   - Use private subnets for workers and POW service
   - Restrict security group rules to minimum required
   - Use VPC endpoints for AWS services

2. **Access Control**:
   - Use IAM roles instead of access keys
   - Rotate credentials regularly
   - Enable CloudTrail for audit logging

3. **Data Protection**:
   - Encrypt Redis data at rest and in transit
   - Use HTTPS for all API communications
   - Implement proper secret management

4. **Container Security**:
   - Use non-root users in containers
   - Scan images for vulnerabilities
   - Keep base images updated

## Backup and Recovery

1. **Redis Backup**:
```bash
# Automated backups (ElastiCache)
aws elasticache create-snapshot \
  --cache-cluster-id rakuten-redis \
  --snapshot-name rakuten-backup-$(date +%Y%m%d)

# Manual backup (EC2 Redis)
redis-cli --rdb /backup/dump-$(date +%Y%m%d).rdb
```

2. **Configuration Backup**:
```bash
# Backup environment files
tar -czf config-backup-$(date +%Y%m%d).tar.gz /opt/rakuten-checker/.env.*
```

3. **Disaster Recovery**:
   - Keep launch templates and deployment scripts in version control
   - Document manual recovery procedures
   - Test recovery process regularly

## Maintenance

### Regular Tasks

1. **Weekly**:
   - Check system logs for errors
   - Monitor resource usage
   - Review cost reports

2. **Monthly**:
   - Update system packages
   - Rotate log files
   - Review security groups

3. **Quarterly**:
   - Update Docker images
   - Review and optimize costs
   - Test disaster recovery procedures

### Updates and Rollbacks

1. **Rolling Updates**:
```bash
# Update workers one by one
for worker in worker-1 worker-2 worker-3; do
  ssh $worker "sudo systemctl stop worker@1"
  # Deploy new version
  ssh $worker "sudo systemctl start worker@1"
  sleep 60  # Wait for health check
done
```

2. **Blue-Green Deployment**:
   - Deploy new version alongside old
   - Switch traffic gradually
   - Keep old version for quick rollback

This deployment guide provides a comprehensive approach to running the Rakuten credential checker in a distributed, scalable architecture on AWS EC2.