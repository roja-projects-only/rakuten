#!/usr/bin/env node

/**
 * Deployment Update Script (Raw Docker - no docker-compose)
 * 
 * Uses raw Docker commands with --env-file
 * 
 * Usage:
 *   node scripts/deploy/update-instance.js [service]
 * 
 * Services: coordinator, worker, pow-service (pow), all
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
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
  log(`\n[${step}/${total}] ${message}`, 'cyan');
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

function exec(command, options = {}) {
  try {
    const output = execSync(command, {
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...options
    });
    return { success: true, output };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Service configurations
const SERVICES = {
  'coordinator': {
    dockerfile: 'Dockerfile.coordinator',
    image: 'rakuten-coordinator',
    container: 'rakuten-coordinator',
    envFile: '.env.coordinator',
    ports: ['-p', '9090:9090']
  },
  'worker': {
    dockerfile: 'Dockerfile.worker',
    image: 'rakuten-worker',
    container: 'rakuten-worker',
    envFile: '.env.worker',
    ports: []
  },
  'pow-service': {
    dockerfile: 'Dockerfile.pow-service',
    image: 'rakuten-pow',
    container: 'rakuten-pow',
    envFile: '.env.pow-service',
    ports: ['-p', '8080:8080', '-p', '9090:9090']
  }
};

function updateService(serviceName) {
  const config = SERVICES[serviceName];
  if (!config) {
    logError(`Unknown service: ${serviceName}`);
    return false;
  }

  log(`\n${'═'.repeat(60)}`, 'bright');
  log(`🚀 Updating ${serviceName.toUpperCase()}`, 'bright');
  log('═'.repeat(60), 'bright');

  // Check env file exists
  if (!fs.existsSync(config.envFile)) {
    logError(`Environment file not found: ${config.envFile}`);
    logInfo(`Create it with: cp deployment/${config.envFile}.example ${config.envFile}`);
    return false;
  }
  
  logSuccess(`Using env file: ${config.envFile}`);

  // Step 1: Stop container
  logStep(1, 4, `Stopping ${config.container}`);
  const stopResult = exec(`docker stop ${config.container}`, { silent: true });
  if (stopResult.success) {
    logSuccess(`Stopped ${config.container}`);
  } else {
    logWarning(`Container ${config.container} not running (OK)`);
  }

  // Step 2: Remove container
  logStep(2, 4, `Removing ${config.container}`);
  const rmResult = exec(`docker rm -f ${config.container}`, { silent: true });
  if (rmResult.success) {
    logSuccess(`Removed ${config.container}`);
  } else {
    logWarning(`Container ${config.container} not found (OK)`);
  }

  // Step 3: Build image
  logStep(3, 4, `Building ${config.image}`);
  const buildCmd = `docker build -f ${config.dockerfile} -t ${config.image} .`;
  logInfo(`Command: ${buildCmd}`);
  
  const buildResult = exec(buildCmd);
  if (!buildResult.success) {
    logError(`Failed to build ${config.image}`);
    return false;
  }
  logSuccess(`Built ${config.image}`);

  // Step 4: Run container
  logStep(4, 4, `Starting ${config.container}`);
  
  let runCmd = `docker run -d --name ${config.container} --restart unless-stopped`;
  if (config.ports.length > 0) {
    runCmd += ' ' + config.ports.join(' ');
  }
  runCmd += ` --env-file ${config.envFile} ${config.image}`;
  
  logInfo(`Command: ${runCmd}`);
  
  const runResult = exec(runCmd);
  if (!runResult.success) {
    logError(`Failed to start ${config.container}`);
    return false;
  }
  logSuccess(`Started ${config.container}`);

  log(`\n✅ ${serviceName} updated successfully! 🎉`, 'green');
  
  // Show logs
  log(`\n${'═'.repeat(60)}`, 'bright');
  log(`📋 Logs for ${config.container} (Ctrl+C to exit):`, 'bright');
  log('═'.repeat(60), 'bright');
  
  exec(`docker logs --tail=50 -f ${config.container}`);
  
  return true;
}

function updateAll() {
  log('\nUpdating all services: pow-service → coordinator → worker', 'blue');
  
  const order = ['pow-service', 'coordinator', 'worker'];
  const results = {};
  
  for (const serviceName of order) {
    const config = SERVICES[serviceName];
    
    log(`\n${'═'.repeat(60)}`, 'bright');
    log(`🚀 Updating ${serviceName.toUpperCase()}`, 'bright');
    log('═'.repeat(60), 'bright');
    
    // Check env file
    if (!fs.existsSync(config.envFile)) {
      logError(`Missing: ${config.envFile}`);
      results[serviceName] = false;
      continue;
    }
    
    // Stop & remove
    exec(`docker stop ${config.container}`, { silent: true });
    exec(`docker rm -f ${config.container}`, { silent: true });
    
    // Build
    logInfo(`Building ${config.image}...`);
    const buildResult = exec(`docker build -f ${config.dockerfile} -t ${config.image} .`);
    if (!buildResult.success) {
      logError(`Failed to build ${serviceName}`);
      results[serviceName] = false;
      continue;
    }
    
    // Run
    let runCmd = `docker run -d --name ${config.container} --restart unless-stopped`;
    if (config.ports.length > 0) {
      runCmd += ' ' + config.ports.join(' ');
    }
    runCmd += ` --env-file ${config.envFile} ${config.image}`;
    
    const runResult = exec(runCmd, { silent: true });
    if (runResult.success) {
      logSuccess(`${serviceName} started`);
      results[serviceName] = true;
    } else {
      logError(`${serviceName} failed to start`);
      results[serviceName] = false;
    }
  }
  
  // Summary
  log(`\n${'═'.repeat(60)}`, 'bright');
  log('📊 SUMMARY', 'bright');
  log('═'.repeat(60), 'bright');
  
  exec('docker ps --filter "name=rakuten" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"');
  
  const failed = Object.values(results).filter(r => !r).length;
  if (failed === 0) {
    log('\n✅ All services updated! 🎉', 'green');
  } else {
    logError(`${failed} service(s) failed`);
  }
  
  logInfo('View logs: docker logs -f rakuten-coordinator');
}

function showUsage() {
  console.log(`
Usage: node scripts/deploy/update-instance.js [service]

Services:
  coordinator  - Telegram bot and job orchestration
  worker       - Credential checking worker
  pow-service  - Proof-of-work service (alias: pow)
  all          - Update all services

Examples:
  node scripts/deploy/update-instance.js coordinator
  node scripts/deploy/update-instance.js worker
  node scripts/deploy/update-instance.js pow
  node scripts/deploy/update-instance.js all

Prerequisites:
  - .env.coordinator
  - .env.worker
  - .env.pow-service
`);
}

function main() {
  const args = process.argv.slice(2);
  let service = args[0] || 'coordinator';

  log('\n╔═══════════════════════════════════════════════════════════╗', 'bright');
  log('║                                                           ║', 'bright');
  log('║        🔄  RAKUTEN QUICK UPDATE  🔄                      ║', 'bright');
  log('║                                                           ║', 'bright');
  log('╚═══════════════════════════════════════════════════════════╝', 'bright');

  // Normalize service name
  if (service === 'pow') service = 'pow-service';
  if (service === '-h' || service === '--help' || service === 'help') {
    showUsage();
    process.exit(0);
  }

  // Git pull
  logInfo('Pulling latest code...');
  const pullResult = exec('git pull');
  if (pullResult.success) {
    logSuccess('Git pull successful');
  } else {
    logError('Git pull failed');
    process.exit(1);
  }

  // Update
  if (service === 'all') {
    updateAll();
  } else if (SERVICES[service]) {
    updateService(service);
  } else {
    logError(`Unknown service: ${service}`);
    showUsage();
    process.exit(1);
  }
}

// Run
if (require.main === module) {
  main();
}

module.exports = { updateService, SERVICES };
