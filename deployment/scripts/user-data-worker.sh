#!/bin/bash
# User data script for Worker EC2 instances

# Update system
yum update -y

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs git

# Create application directory
mkdir -p /opt/rakuten-checker
cd /opt/rakuten-checker

# Clone repository (replace with your actual repository)
git clone https://github.com/your-org/rakuten-checker.git .

# Install dependencies
npm ci --omit=dev

# Create logs directory
mkdir -p logs
chown -R 1001:1001 logs

# Copy environment file
cp deployment/env/worker.env.example /opt/rakuten-checker/.env

# Generate unique worker ID based on instance ID
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
WORKER_ID="worker-${INSTANCE_ID}"

# Update environment file with worker ID
echo "WORKER_ID=${WORKER_ID}" >> /opt/rakuten-checker/.env

# Install systemd service
cp deployment/systemd/worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable worker

# Note: Service will fail to start until .env is properly configured
# Admin must SSH in and configure environment variables before starting
