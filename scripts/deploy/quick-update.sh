#!/bin/bash

###############################################################################
# Quick Update Script for AWS Instances
# 
# Uses raw Docker commands with --env-file (no docker-compose)
# 
# Usage:
#   ./scripts/deploy/quick-update.sh [service]
# 
# Services: coordinator, worker, pow-service (pow), all
# 
# Prerequisites:
#   - .env.coordinator configured
#   - .env.worker configured
#   - .env.pow-service configured
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

# Service to update (default: coordinator)
SERVICE="${1:-coordinator}"

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

# Get service config
get_dockerfile() {
  case "$1" in
    coordinator) echo "Dockerfile.coordinator" ;;
    worker)      echo "Dockerfile.worker" ;;
    pow-service) echo "Dockerfile.pow-service" ;;
  esac
}

get_image() {
  case "$1" in
    coordinator) echo "rakuten-coordinator" ;;
    worker)      echo "rakuten-worker" ;;
    pow-service) echo "rakuten-pow" ;;
  esac
}

get_container() {
  case "$1" in
    coordinator) echo "rakuten-coordinator" ;;
    worker)      echo "rakuten-worker" ;;
    pow-service) echo "rakuten-pow" ;;
  esac
}

get_env_file() {
  case "$1" in
    coordinator) echo ".env.coordinator" ;;
    worker)      echo ".env.worker" ;;
    pow-service) echo ".env.pow-service" ;;
  esac
}

get_ports() {
  case "$1" in
    coordinator) echo "-p 9090:9090" ;;
    worker)      echo "" ;;
    pow-service) echo "-p 8080:8080 -p 9090:9090" ;;
  esac
}

update_service() {
  local service=$1
  local dockerfile=$(get_dockerfile "$service")
  local image=$(get_image "$service")
  local container=$(get_container "$service")
  local env_file=$(get_env_file "$service")
  local ports=$(get_ports "$service")
  
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}🚀 Updating ${service^^}${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  
  # Check env file exists
  if [ ! -f "$env_file" ]; then
    log_error "Environment file not found: $env_file"
    log_info "Create it with: cp deployment/${env_file}.example $env_file && nano $env_file"
    return 1
  fi
  
  log_success "Using env file: $env_file"
  
  # Step 1: Stop container
  log_step 1 4 "Stopping $container"
  if docker stop "$container" 2>/dev/null; then
    log_success "Stopped $container"
  else
    log_warning "Container $container not running (OK)"
  fi
  
  # Step 2: Remove container
  log_step 2 4 "Removing $container"
  if docker rm -f "$container" 2>/dev/null; then
    log_success "Removed $container"
  else
    log_warning "Container $container not found (OK)"
  fi
  
  # Step 3: Build image
  log_step 3 4 "Building $image"
  if docker build -f "$dockerfile" -t "$image" .; then
    log_success "Built $image"
  else
    log_error "Failed to build $image"
    return 1
  fi
  
  # Step 4: Run container
  log_step 4 4 "Starting $container"
  
  local run_cmd="docker run -d --name $container --restart unless-stopped"
  
  if [ -n "$ports" ]; then
    run_cmd="$run_cmd $ports"
  fi
  
  run_cmd="$run_cmd --env-file $env_file $image"
  
  log_info "Command: $run_cmd"
  
  if eval $run_cmd; then
    log_success "Started $container"
  else
    log_error "Failed to start $container"
    return 1
  fi
  
  echo ""
  log_success "$service updated successfully! 🎉"
  
  # Show logs
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}📋 Logs for $container (Ctrl+C to exit):${RESET}"
  echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  
  docker logs --tail=50 -f "$container"
}

show_usage() {
  echo "Usage: $0 [service]"
  echo ""
  echo "Services:"
  echo "  coordinator  - Telegram bot and job orchestration"
  echo "  worker       - Credential checking worker"
  echo "  pow-service  - Proof-of-work service (alias: pow)"
  echo "  all          - Update all services (no log follow)"
  echo ""
  echo "Examples:"
  echo "  $0 coordinator"
  echo "  $0 worker"
  echo "  $0 pow"
  echo "  $0 all"
  echo ""
  echo "Prerequisites:"
  echo "  - .env.coordinator"
  echo "  - .env.worker"
  echo "  - .env.pow-service"
}

update_all() {
  echo ""
  log_info "Updating all services: pow-service → coordinator → worker"
  
  for svc in pow-service coordinator worker; do
    local dockerfile=$(get_dockerfile "$svc")
    local image=$(get_image "$svc")
    local container=$(get_container "$svc")
    local env_file=$(get_env_file "$svc")
    local ports=$(get_ports "$svc")
    
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}🚀 Updating ${svc^^}${RESET}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
    
    # Check env file
    if [ ! -f "$env_file" ]; then
      log_error "Missing: $env_file"
      continue
    fi
    
    # Stop & remove
    docker stop "$container" 2>/dev/null || true
    docker rm -f "$container" 2>/dev/null || true
    
    # Build
    log_info "Building $image..."
    if ! docker build -f "$dockerfile" -t "$image" .; then
      log_error "Failed to build $svc"
      continue
    fi
    
    # Run
    local run_cmd="docker run -d --name $container --restart unless-stopped"
    [ -n "$ports" ] && run_cmd="$run_cmd $ports"
    run_cmd="$run_cmd --env-file $env_file $image"
    
    if eval $run_cmd; then
      log_success "$svc started"
    else
      log_error "$svc failed to start"
    fi
  done
  
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}📊 SUMMARY${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
  docker ps --filter "name=rakuten" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  
  echo ""
  log_success "All services updated! 🎉"
  log_info "View logs: docker logs -f rakuten-coordinator"
}

# Main
main() {
  print_header
  
  # Normalize service name
  case "$SERVICE" in
    pow|pow-service)
      SERVICE="pow-service"
      ;;
    coordinator|worker)
      # Already valid
      ;;
    all)
      # Update all
      ;;
    -h|--help|help)
      show_usage
      exit 0
      ;;
    *)
      log_error "Unknown service: $SERVICE"
      show_usage
      exit 1
      ;;
  esac
  
  # Git pull
  log_info "Pulling latest code..."
  if git pull; then
    log_success "Git pull successful"
  else
    log_error "Git pull failed"
    exit 1
  fi
  
  # Update
  if [ "$SERVICE" = "all" ]; then
    update_all
  else
    update_service "$SERVICE"
  fi
}

# Run
main
