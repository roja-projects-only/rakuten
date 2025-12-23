#!/bin/bash

###############################################################################
# Quick Update Script for AWS/Railway Instances
# 
# Handles git pull + Docker rebuild + restart with nice UX
# 
# Usage:
#   ./scripts/deploy/quick-update.sh [service]
# 
# Services: coordinator, worker, pow-service, all (default)
# 
# Examples:
#   ./scripts/deploy/quick-update.sh              # Update all
#   ./scripts/deploy/quick-update.sh coordinator  # Update coordinator only
###############################################################################

set -e  # Exit on error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Service to update (default: all)
SERVICE="${1:-all}"

# Functions
log_step() {
  echo -e "${CYAN}[$1/$2] $3${RESET}"
}

log_success() {
  echo -e "${GREEN}✅ $1${RESET}"
}

log_error() {
  echo -e "${RED}❌ $1${RESET}"
}

log_warning() {
  echo -e "${YELLOW}⚠️  $1${RESET}"
}

log_info() {
  echo -e "${BLUE}ℹ️  $1${RESET}"
}

print_header() {
  echo ""
  echo -e "${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║                                                           ║${RESET}"
  echo -e "${BOLD}║        🔄  RAKUTEN QUICK UPDATE  🔄                      ║${RESET}"
  echo -e "${BOLD}║                                                           ║${RESET}"
  echo -e "${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}"
  echo ""
}

detect_docker_compose() {
  if command -v docker-compose &> /dev/null; then
    echo "docker-compose"
  elif docker compose version &> /dev/null; then
    echo "docker compose"
  else
    echo ""
  fi
}

update_service() {
  local service=$1
  local docker_cmd=$2
  
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}🚀 Updating ${service^^}${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  
  # Step 1: Stop
  log_step 1 4 "Stopping $service"
  if $docker_cmd stop $service 2>/dev/null; then
    log_success "Stopped $service"
  else
    log_warning "No running container found for $service"
  fi
  
  # Step 2: Remove
  log_step 2 4 "Removing old container"
  $docker_cmd rm -f $service 2>/dev/null || true
  log_success "Removed old $service container"
  
  # Step 3: Build
  log_step 3 4 "Building new image"
  if $docker_cmd build $service; then
    log_success "Built $service"
  else
    log_error "Failed to build $service"
    return 1
  fi
  
  # Step 4: Start
  log_step 4 4 "Starting $service"
  if $docker_cmd up -d $service; then
    log_success "Started $service"
  else
    log_error "Failed to start $service"
    return 1
  fi
  
  # Show logs
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}📋 Recent logs for $service:${RESET}"
  echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  $docker_cmd logs --tail=30 $service
  
  echo ""
  log_success "$service updated successfully!"
  
  return 0
}

# Main
main() {
  print_header
  
  # Detect docker-compose command
  DOCKER_CMD=$(detect_docker_compose)
  if [ -z "$DOCKER_CMD" ]; then
    log_error "Docker Compose not found!"
    log_info "Install docker-compose or use Docker with Compose plugin"
    exit 1
  fi
  
  log_success "Using: $DOCKER_CMD"
  
  # Check docker-compose.yml
  if [ ! -f "docker-compose.yml" ]; then
    log_error "docker-compose.yml not found"
    log_info "Run this script from the project root"
    exit 1
  fi
  
  # Git pull
  echo ""
  log_info "Pulling latest code..."
  if git pull; then
    log_success "Git pull successful"
  else
    log_error "Git pull failed"
    exit 1
  fi
  
  # Determine services to update
  if [ "$SERVICE" = "all" ]; then
    SERVICES=("coordinator" "worker" "pow-service")
  else
    SERVICES=("$SERVICE")
  fi
  
  log_info "Updating services: ${SERVICES[*]}"
  
  # Update each service
  FAILED=0
  for svc in "${SERVICES[@]}"; do
    if ! update_service "$svc" "$DOCKER_CMD"; then
      FAILED=$((FAILED + 1))
    fi
  done
  
  # Summary
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}📊 UPDATE SUMMARY${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  
  if [ $FAILED -eq 0 ]; then
    log_success "All services updated successfully! 🎉"
    echo ""
    log_info "Next steps:"
    log_info "  - Monitor logs: $DOCKER_CMD logs -f [service]"
    log_info "  - Check status: $DOCKER_CMD ps"
    log_info "  - Test /config command in Telegram"
    echo ""
  else
    log_error "$FAILED service(s) failed to update"
    echo ""
    log_info "Troubleshooting:"
    log_info "  - Check logs: $DOCKER_CMD logs [service]"
    log_info "  - Manual restart: $DOCKER_CMD restart [service]"
    echo ""
    exit 1
  fi
}

# Run
main
