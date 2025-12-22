#!/bin/bash
# User data script for Worker EC2 instances

# Update system
yum update -y

# Install Docker
yum install -y docker git
systemctl start docker
systemctl enable docker
usermod -a -G docker ec2-user

# Create application directory
mkdir -p /opt/rakuten-checker
cd /opt/rakuten-checker

# Clone repository (replace with your actual repository)
git clone https://github.com/your-org/rakuten-checker.git .

# Build Docker image
docker build -f Dockerfile.worker -t rakuten-worker .

# Create logs directory
mkdir -p logs
chown -R 1001:1001 logs

# Copy environment file template
cp deployment/.env.worker.example .env.worker

# Install systemd service template
cp deployment/worker.service /etc/systemd/system/worker@.service
systemctl daemon-reload

# Generate unique worker ID based on instance ID
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
WORKER_ID="worker-${INSTANCE_ID}"

# Update environment file with worker ID
echo "WORKER_ID=${WORKER_ID}" >> .env.worker

# Enable and start worker service
systemctl enable worker@1
# Note: Service will fail to start until .env.worker is properly configured
# Admin must SSH in and configure environment variables before starting