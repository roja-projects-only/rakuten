#!/bin/bash
# User data script for Coordinator EC2 instance

# Update system
yum update -y

# Install Docker
yum install -y docker git
systemctl start docker
systemctl enable docker
usermod -a -G docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/download/v2.20.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create application directory
mkdir -p /opt/rakuten-checker
cd /opt/rakuten-checker

# Clone repository (replace with your actual repository)
git clone https://github.com/your-org/rakuten-checker.git .

# Build Docker image
docker build -f Dockerfile.coordinator -t rakuten-coordinator .

# Create logs and data directories
mkdir -p logs data
chown -R 1001:1001 logs data

# Copy environment file template
cp deployment/.env.coordinator.example .env.coordinator

# Install systemd service
cp deployment/coordinator.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable coordinator

# Note: Service will fail to start until .env.coordinator is properly configured
# Admin must SSH in and configure environment variables before starting