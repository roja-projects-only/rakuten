#!/bin/bash
# User data script for POW Service EC2 instance

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

# Install dependencies (includes native modules for POW)
npm install

# Create logs directory
mkdir -p logs
chown -R 1001:1001 logs

# Copy environment file
cp deployment/env/pow-service.env.example /opt/rakuten-checker/.env

# Install systemd service
cp deployment/systemd/pow-service.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable pow-service

# Note: Service will fail to start until .env is properly configured
# Admin must SSH in and configure environment variables before starting
