#!/bin/bash
# =============================================================================
# POW SERVICE DEPLOYMENT SCRIPT - EC2 c6i.large spot instance
# =============================================================================
# 
# This script deploys the POW service to an EC2 instance with:
# - Docker installation and configuration
# - Service user creation
# - Systemd service setup
# - Security hardening
# - Health endpoint testing
# 
# Usage: ./deploy-pow-service.sh
# 
# Requirements: 6.3, 10.4
# =============================================================================

set -euo pipefail

# Configuration
SERVICE_NAME="pow-service"
SERVICE_USER="powservice"
SERVICE_DIR="/opt/pow-service"
DOCKER_IMAGE="pow-service:latest"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

# Install Docker if not present
install_docker() {
    if ! command -v docker &> /dev/null; then
        log_info "Installing Docker..."
        
        # Update package index
        apt-get update
        
        # Install prerequisites
        apt-get install -y \
            apt-transport-https \
            ca-certificates \
            curl \
            gnupg \
            lsb-release
        
        # Add Docker GPG key
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
        
        # Add Docker repository
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
        
        # Install Docker
        apt-get update
        apt-get install -y docker-ce docker-ce-cli containerd.io
        
        # Start and enable Docker
        systemctl start docker
        systemctl enable docker
        
        log_info "Docker installed successfully"
    else
        log_info "Docker is already installed"
    fi
}

# Create service user
create_service_user() {
    if ! id "$SERVICE_USER" &>/dev/null; then
        log_info "Creating service user: $SERVICE_USER"
        
        useradd --system --shell /bin/false --home-dir "$SERVICE_DIR" --create-home "$SERVICE_USER"
        usermod -aG docker "$SERVICE_USER"
        
        log_info "Service user created successfully"
    else
        log_info "Service user already exists"
    fi
}

# Create service directory structure
create_directories() {
    log_info "Creating service directories..."
    
    mkdir -p "$SERVICE_DIR"/{logs,config}
    chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_DIR"
    chmod 755 "$SERVICE_DIR"
    chmod 750 "$SERVICE_DIR"/{logs,config}
    
    log_info "Service directories created"
}

# Build Docker image
build_docker_image() {
    log_info "Building Docker image..."
    
    # Assume we're in the project root
    if [[ ! -f "Dockerfile.pow-service" ]]; then
        log_error "Dockerfile.pow-service not found. Run this script from the project root."
        exit 1
    fi
    
    docker build -f Dockerfile.pow-service -t "$DOCKER_IMAGE" .
    
    log_info "Docker image built successfully"
}

# Copy configuration files
copy_config() {
    log_info "Copying configuration files..."
    
    # Copy environment file template
    if [[ -f "deployment/.env.pow-service.example" ]]; then
        cp "deployment/.env.pow-service.example" "$SERVICE_DIR/.env"
        chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_DIR/.env"
        chmod 600 "$SERVICE_DIR/.env"
        
        log_warn "Please edit $SERVICE_DIR/.env with your configuration"
    fi
    
    # Copy systemd service file
    if [[ -f "deployment/pow-service.service" ]]; then
        cp "deployment/pow-service.service" "/etc/systemd/system/"
        chmod 644 "/etc/systemd/system/pow-service.service"
    fi
    
    log_info "Configuration files copied"
}

# Configure systemd service
setup_systemd() {
    log_info "Setting up systemd service..."
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable service
    systemctl enable "$SERVICE_NAME"
    
    log_info "Systemd service configured"
}

# Configure firewall
configure_firewall() {
    log_info "Configuring firewall..."
    
    # Allow POW service port (3001)
    if command -v ufw &> /dev/null; then
        ufw allow 3001/tcp comment "POW Service"
        ufw allow 9090/tcp comment "POW Service Metrics"
        ufw allow 8080/tcp comment "POW Service Health"
    elif command -v firewall-cmd &> /dev/null; then
        firewall-cmd --permanent --add-port=3001/tcp
        firewall-cmd --permanent --add-port=9090/tcp
        firewall-cmd --permanent --add-port=8080/tcp
        firewall-cmd --reload
    else
        log_warn "No firewall detected. Please manually configure ports 3001, 8080, 9090"
    fi
    
    log_info "Firewall configured"
}

# Start service
start_service() {
    log_info "Starting POW service..."
    
    systemctl start "$SERVICE_NAME"
    
    # Wait a moment for startup
    sleep 5
    
    # Check status
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "POW service started successfully"
    else
        log_error "Failed to start POW service"
        systemctl status "$SERVICE_NAME"
        exit 1
    fi
}

# Test health endpoint
test_health() {
    log_info "Testing health endpoint..."
    
    local max_attempts=10
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -f -s http://localhost:3001/health > /dev/null; then
            log_info "Health check passed"
            return 0
        fi
        
        log_warn "Health check attempt $attempt/$max_attempts failed, retrying..."
        sleep 5
        ((attempt++))
    done
    
    log_error "Health check failed after $max_attempts attempts"
    return 1
}

# Display service info
show_service_info() {
    log_info "POW Service deployment complete!"
    echo
    echo "Service Status:"
    systemctl status "$SERVICE_NAME" --no-pager -l
    echo
    echo "Service Endpoints:"
    echo "  Health:  http://$(hostname -I | awk '{print $1}'):3001/health"
    echo "  Metrics: http://$(hostname -I | awk '{print $1}'):9090/metrics"
    echo "  Compute: http://$(hostname -I | awk '{print $1}'):3001/compute"
    echo
    echo "Useful Commands:"
    echo "  View logs:    sudo journalctl -u $SERVICE_NAME -f"
    echo "  Restart:      sudo systemctl restart $SERVICE_NAME"
    echo "  Stop:         sudo systemctl stop $SERVICE_NAME"
    echo "  Status:       sudo systemctl status $SERVICE_NAME"
    echo
    echo "Configuration:"
    echo "  Service dir:  $SERVICE_DIR"
    echo "  Config file:  $SERVICE_DIR/.env"
    echo "  Logs dir:     $SERVICE_DIR/logs"
}

# Main deployment function
main() {
    log_info "Starting POW Service deployment on EC2..."
    
    check_root
    install_docker
    create_service_user
    create_directories
    build_docker_image
    copy_config
    setup_systemd
    configure_firewall
    start_service
    
    if test_health; then
        show_service_info
    else
        log_error "Deployment completed but health check failed"
        log_error "Check logs: sudo journalctl -u $SERVICE_NAME -f"
        exit 1
    fi
}

# Run main function
main "$@"