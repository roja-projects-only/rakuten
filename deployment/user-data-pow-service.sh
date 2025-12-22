#!/bin/bash
# User data script for POW Service EC2 instance

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
docker build -f Dockerfile.pow-service -t rakuten-pow-service .

# Create logs directory
mkdir -p logs
chown -R 1001:1001 logs

# Copy environment file template
cp deployment/.env.pow-service.example .env.pow-service

# Install systemd service
cp deployment/pow-service.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable pow-service

# Note: Service will fail to start until .env.pow-service is properly configured
# Admin must SSH in and configure environment variables before starting