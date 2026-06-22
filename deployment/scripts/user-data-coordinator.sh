#!/bin/bash
# User data script for Coordinator EC2 instance

# Update system
yum update -y

# Install Node.js 22
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
yum install -y nodejs git

# Create application directory
mkdir -p /opt/rakuten-checker
cd /opt/rakuten-checker

# Clone repository (replace with your actual repository)
git clone https://github.com/your-org/rakuten-checker.git .

# Install dependencies
npm ci --omit=dev

# Create logs and data directories
mkdir -p logs data
chown -R 1001:1001 logs data

# Copy environment file
cp deployment/env/coordinator.env.example /opt/rakuten-checker/.env

# Install systemd service
cp deployment/systemd/coordinator.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable coordinator

# Note: Service will fail to start until .env is properly configured
# Admin must SSH in and configure environment variables before starting
