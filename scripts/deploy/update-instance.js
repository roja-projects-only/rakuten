#!/usr/bin/env node

/**
 * Deployment Update Script
 * 
 * Handles the complete update workflow for AWS/Railway instances:
 * 1. Stop running containers
 * 2. Remove old containers
 * 3. Build new images
 * 4. Start containers
 * 5. Show logs
 * 
 * Usage:
 *   node scripts/deploy/update-instance.js [service]
 * 
 * Services: coordinator, worker, pow-service, all (default)
 * 
 * Examples:
 *   node scripts/deploy/update-instance.js              # Update all services
 *   node scripts/deploy/update-instance.js coordinator  # Update coordinator only
 *   node scripts/deploy/update-instance.js worker       # Update worker only
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step, total, message) {
  log(`\n[${ step}/${total}] ${message}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function execCommand(command, options = {}) {
  try {
    const output = execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...options
    });
    return { success: true, output };
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      output: error.stdout || error.stderr || ''
    };
  }
}

function detectDockerCompose() {
  // Try docker-compose first, then docker compose
  const tryCompose = execCommand('docker-compose --version', { silent: true });
  if (tryCompose.success) {
    return 'docker-compose';
  }
  
  const tryDockerCompose = execCommand('docker compose version', { silent: true });
  if (tryDockerCompose.success) {
    return 'docker compose';
  }
  
  return null;
}

function getRunningContainers(service = null) {
  const cmd = service 
    ? `docker ps --filter "name=${service}" --format "{{.Names}}"` 
    : 'docker ps --filter "name=rakuten" --format "{{.Names}}"';
  
  const result = execCommand(cmd, { silent: true });
  if (!result.success || !result.output) {
    return [];
  }
  
  return result.output.trim().split('\n').filter(Boolean);
}

function stopService(service, dockerCmd) {
  logInfo(`Stopping ${service}...`);
  
  // Try docker-compose stop first
  if (fs.existsSync('docker-compose.yml')) {
    const result = execCommand(`${dockerCmd} stop ${service}`, { silent: true });
    if (result.success) {
      logSuccess(`Stopped ${service} via docker-compose`);
      return true;
    }
  }
  
  // Fallback: stop container by name
  const containers = getRunningContainers(service);
  if (containers.length === 0) {
    logWarning(`No running containers found for ${service}`);
    return true;
  }
  
  for (const container of containers) {
    const result = execCommand(`docker stop ${container}`, { silent: true });
    if (result.success) {
      logSuccess(`Stopped container: ${container}`);
    } else {
      logError(`Failed to stop container: ${container}`);
    }
  }
  
  return true;
}

function removeService(service, dockerCmd) {
  logInfo(`Removing old ${service} container...`);
  
  // Try docker-compose rm first
  if (fs.existsSync('docker-compose.yml')) {
    const result = execCommand(`${dockerCmd} rm -f ${service}`, { silent: true });
    if (result.success) {
      logSuccess(`Removed ${service} via docker-compose`);
      return true;
    }
  }
  
  // Fallback: remove by name pattern
  const allContainers = execCommand(`docker ps -a --filter "name=${service}" --format "{{.Names}}"`, { silent: true });
  if (!allContainers.success || !allContainers.output) {
    return true;
  }
  
  const containers = allContainers.output.trim().split('\n').filter(Boolean);
  for (const container of containers) {
    execCommand(`docker rm -f ${container}`, { silent: true });
  }
  
  logSuccess(`Removed ${service} containers`);
  return true;
}

function buildService(service, dockerCmd) {
  logInfo(`Building ${service}...`);
  
  if (!fs.existsSync('docker-compose.yml')) {
    logError('docker-compose.yml not found');
    return false;
  }
  
  // Build with --no-cache option to ensure fresh build
  // Note: Env var warnings during build are expected and can be ignored
  const result = execCommand(`${dockerCmd} build ${service}`);
  if (result.success) {
    logSuccess(`Built ${service}`);
    return true;
  } else {
    logError(`Failed to build ${service}`);
    return false;
  }
}

function startService(service, dockerCmd) {
  logInfo(`Starting ${service}...`);
  
  if (!fs.existsSync('docker-compose.yml')) {
    logError('docker-compose.yml not found');
    return false;
  }
  
  // Use --no-deps to prevent starting dependency services
  const result = execCommand(`${dockerCmd} up -d --no-deps ${service}`);
  if (result.success) {
    logSuccess(`Started ${service}`);
    return true;
  } else {
    logError(`Failed to start ${service}`);
    return false;
  }
}

function showLogs(service, dockerCmd, lines = 50) {
  log(`\n${'='.repeat(60)}`, 'dim');
  log(`📋 Logs for ${service} (last ${lines} lines):`, 'bright');
  log('='.repeat(60), 'dim');
  
  if (fs.existsSync('docker-compose.yml')) {
    execCommand(`${dockerCmd} logs --tail=${lines} ${service}`);
  } else {
    const containers = getRunningContainers(service);
    if (containers.length > 0) {
      execCommand(`docker logs --tail=${lines} ${containers[0]}`);
    } else {
      logWarning(`No running containers for ${service}`);
    }
  }
}

function updateService(service, dockerCmd) {
  log(`\n${'═'.repeat(60)}`, 'bright');
  log(`🚀 Updating ${service.toUpperCase()}`, 'bright');
  log('═'.repeat(60), 'bright');
  
  const steps = [
    { name: 'Stop', fn: () => stopService(service, dockerCmd) },
    { name: 'Remove', fn: () => removeService(service, dockerCmd) },
    { name: 'Build', fn: () => buildService(service, dockerCmd) },
    { name: 'Start', fn: () => startService(service, dockerCmd) },
  ];
  
  for (let i = 0; i < steps.length; i++) {
    logStep(i + 1, steps.length, steps[i].name);
    const success = steps[i].fn();
    if (!success && steps[i].name !== 'Stop' && steps[i].name !== 'Remove') {
      logError(`Failed at step: ${steps[i].name}`);
      return false;
    }
  }
  
  // Show logs
  showLogs(service, dockerCmd, 30);
  
  log(`\n✅ ${service} updated successfully!`, 'green');
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const targetService = args[0] || 'all';
  
  log('\n╔═══════════════════════════════════════════════════════════╗', 'bright');
  log('║                                                           ║', 'bright');
  log('║        🔄  RAKUTEN DEPLOYMENT UPDATER  🔄                ║', 'bright');
  log('║                                                           ║', 'bright');
  log('╚═══════════════════════════════════════════════════════════╝', 'bright');
  
  // Detect docker-compose command
  const dockerCmd = detectDockerCompose();
  if (!dockerCmd) {
    logError('Docker Compose not found!');
    logInfo('Install docker-compose or use Docker with Compose plugin');
    process.exit(1);
  }
  
  logSuccess(`Using: ${dockerCmd}`);
  
  // Check if docker-compose.yml exists
  if (!fs.existsSync('docker-compose.yml')) {
    logError('docker-compose.yml not found in current directory');
    logInfo('Run this script from the project root');
    process.exit(1);
  }
  
  // Determine which services to update
  const allServices = ['coordinator', 'worker1', 'worker2', 'worker3', 'pow-service'];
  let services;
  
  if (targetService === 'all') {
    services = allServices;
  } else if (targetService === 'worker') {
    // 'worker' is alias for all workers
    services = ['worker1', 'worker2', 'worker3'];
  } else {
    services = [targetService];
  }
  
  // Validate service names (skip if already expanded from 'worker' alias)
  if (targetService !== 'worker' && targetService !== 'all') {
    for (const service of services) {
      if (!allServices.includes(service)) {
        logError(`Unknown service: ${service}`);
        logInfo(`Valid services: coordinator, worker (all workers), worker1, worker2, worker3, pow-service, all`);
        process.exit(1);
      }
    }
  }
  
  logInfo(`Updating services: ${services.join(', ')}`);
  
  // Update each service
  const results = {};
  for (const service of services) {
    results[service] = updateService(service, dockerCmd);
  }
  
  // Summary
  log(`\n${'═'.repeat(60)}`, 'bright');
  log('📊 DEPLOYMENT SUMMARY', 'bright');
  log('═'.repeat(60), 'bright');
  
  const successes = Object.values(results).filter(Boolean).length;
  const failures = Object.values(results).filter(r => !r).length;
  
  for (const [service, success] of Object.entries(results)) {
    if (success) {
      logSuccess(`${service}: Updated`);
    } else {
      logError(`${service}: Failed`);
    }
  }
  
  log('');
  if (failures === 0) {
    logSuccess(`All ${successes} service(s) updated successfully! 🎉`);
    logInfo('\nNext steps:');
    logInfo(`  - Monitor logs: ${dockerCmd} logs -f [service]`);
    logInfo(`  - Check status: ${dockerCmd} ps`);
    logInfo('  - Test /config command in Telegram');
  } else {
    logError(`${failures} service(s) failed to update`);
    logInfo('\nTroubleshooting:');
    logInfo(`  - Check logs: ${dockerCmd} logs [service]`);
    logInfo('  - Check build errors above');
    logInfo(`  - Manual restart: ${dockerCmd} restart [service]`);
    process.exit(1);
  }
}

// Run main
if (require.main === module) {
  try {
    main();
  } catch (error) {
    logError(`Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

module.exports = { updateService };
