#!/usr/bin/env node

/**
 * EC2 Instance Deployment Script
 * 
 * Automatically updates chosen EC2 instances with latest repository code
 * Supports selective deployment to worker, pow-service, and coordinator instances
 */

require('dotenv').config();
const { spawn, exec } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Instance configuration
const INSTANCES = {
  'worker-1': {
    ip: '52.197.138.132',
    type: 'worker',
    services: ['rakuten-worker'],
    deployScript: './scripts/deploy/deploy-worker-fix.sh'
  },
  'worker-2': {
    ip: '13.231.114.62',
    type: 'worker', 
    services: ['rakuten-worker'],
    deployScript: './scripts/deploy/deploy-worker-fix.sh'
  },
  'pow-service': {
    ip: '35.77.110.215',
    type: 'pow-service',
    services: ['pow-service'],
    deployScript: './deployment/deploy-pow-service.sh'
  },
  'coordinator': {
    ip: '43.207.4.202',
    type: 'coordinator',
    services: ['rakuten-coordinator'],
    deployScript: null // Manual deployment
  }
};

const SSH_KEY = 'rakuten.pem';
const SSH_USER = 'ubuntu';
const PROJECT_DIR = '/home/ubuntu/rakuten';

class InstanceDeployer {
  constructor() {
    this.selectedInstances = [];
    this.deploymentResults = {};
  }

  async run() {
    console.log('🚀 EC2 Instance Deployment Tool');
    console.log('================================\n');

    // Check prerequisites
    await this.checkPrerequisites();
    
    // Select instances
    await this.selectInstances();
    
    // Confirm deployment
    await this.confirmDeployment();
    
    // Deploy to selected instances
    await this.deployInstances();
    
    // Show results
    this.showResults();
  }

  async checkPrerequisites() {
    console.log('🔍 Checking prerequisites...');
    
    // Check SSH key exists
    if (!fs.existsSync(SSH_KEY)) {
      console.error(`❌ SSH key not found: ${SSH_KEY}`);
      console.error('   Please ensure rakuten.pem is in the project root');
      process.exit(1);
    }
    
    // Check SSH key permissions (on Unix systems)
    if (process.platform !== 'win32') {
      try {
        const stats = fs.statSync(SSH_KEY);
        const mode = stats.mode & parseInt('777', 8);
        if (mode !== parseInt('600', 8)) {
          console.log('🔧 Fixing SSH key permissions...');
          fs.chmodSync(SSH_KEY, '600');
        }
      } catch (error) {
        console.warn('⚠️  Could not check SSH key permissions:', error.message);
      }
    }
    
    // Check git status
    try {
      const { stdout } = await this.execCommand('git status --porcelain');
      if (stdout.trim()) {
        console.warn('⚠️  You have uncommitted changes:');
        console.log(stdout);
        
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await new Promise(resolve => {
          rl.question('Continue deployment anyway? (y/N): ', resolve);
        });
        
        rl.close();
        
        if (answer.toLowerCase() !== 'y') {
          console.log('Deployment cancelled');
          process.exit(0);
        }
      }
    } catch (error) {
      console.warn('⚠️  Could not check git status:', error.message);
    }
    
    console.log('✅ Prerequisites check passed\n');
  }

  async selectInstances() {
    console.log('📋 Available instances:');
    const instanceNames = Object.keys(INSTANCES);
    
    instanceNames.forEach((name, index) => {
      const instance = INSTANCES[name];
      console.log(`   ${index + 1}. ${name} (${instance.ip}) - ${instance.type}`);
    });
    
    console.log(`   ${instanceNames.length + 1}. All instances`);
    console.log(`   ${instanceNames.length + 2}. All workers`);
    console.log('');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const selection = await new Promise(resolve => {
      rl.question('Select instances to deploy (comma-separated numbers or ranges): ', resolve);
    });
    
    rl.close();
    
    // Parse selection
    const selections = selection.split(',').map(s => s.trim());
    const selectedIndexes = new Set();
    
    for (const sel of selections) {
      const num = parseInt(sel);
      
      if (num >= 1 && num <= instanceNames.length) {
        selectedIndexes.add(num - 1);
      } else if (num === instanceNames.length + 1) {
        // All instances
        for (let i = 0; i < instanceNames.length; i++) {
          selectedIndexes.add(i);
        }
      } else if (num === instanceNames.length + 2) {
        // All workers
        instanceNames.forEach((name, index) => {
          if (INSTANCES[name].type === 'worker') {
            selectedIndexes.add(index);
          }
        });
      }
    }
    
    this.selectedInstances = Array.from(selectedIndexes).map(i => instanceNames[i]);
    
    if (this.selectedInstances.length === 0) {
      console.error('❌ No valid instances selected');
      process.exit(1);
    }
    
    console.log('\n✅ Selected instances:');
    this.selectedInstances.forEach(name => {
      const instance = INSTANCES[name];
      console.log(`   • ${name} (${instance.ip}) - ${instance.type}`);
    });
    console.log('');
  }

  async confirmDeployment() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      rl.question(`⚠️  Deploy to ${this.selectedInstances.length} instance(s)? This will update code and restart services. (y/N): `, resolve);
    });
    
    rl.close();
    
    if (answer.toLowerCase() !== 'y') {
      console.log('Deployment cancelled');
      process.exit(0);
    }
  }

  async deployInstances() {
    console.log('🚀 Starting deployment...\n');
    
    for (const instanceName of this.selectedInstances) {
      await this.deployInstance(instanceName);
    }
  }

  async deployInstance(instanceName) {
    const instance = INSTANCES[instanceName];
    const startTime = Date.now();
    
    console.log(`📦 Deploying to ${instanceName} (${instance.ip})...`);
    
    try {
      // Test SSH connectivity
      console.log(`   🔗 Testing SSH connection...`);
      await this.sshCommand(instance.ip, 'echo "SSH connection successful"');
      
      // Update repository
      console.log(`   📥 Updating repository...`);
      await this.updateRepository(instance.ip);
      
      // Run deployment script
      if (instance.deployScript) {
        console.log(`   🔧 Running deployment script...`);
        await this.runDeploymentScript(instance.ip, instance.deployScript);
      } else {
        console.log(`   ⚠️  No deployment script configured for ${instance.type}`);
      }
      
      // Verify services
      console.log(`   ✅ Verifying services...`);
      await this.verifyServices(instance.ip, instance.services);
      
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`   ✅ ${instanceName} deployed successfully (${duration}s)\n`);
      
      this.deploymentResults[instanceName] = {
        success: true,
        duration,
        error: null
      };
      
    } catch (error) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`   ❌ ${instanceName} deployment failed: ${error.message} (${duration}s)\n`);
      
      this.deploymentResults[instanceName] = {
        success: false,
        duration,
        error: error.message
      };
    }
  }

  async updateRepository(ip) {
    // Navigate to project directory and pull latest changes
    const commands = [
      `cd ${PROJECT_DIR}`,
      'git fetch origin',
      'git reset --hard origin/main',
      'git clean -fd',
      'npm install --production'
    ];
    
    await this.sshCommand(ip, commands.join(' && '));
  }

  async runDeploymentScript(ip, scriptPath) {
    // Make script executable and run it
    const commands = [
      `cd ${PROJECT_DIR}`,
      `chmod +x ${scriptPath}`,
      scriptPath
    ];
    
    await this.sshCommand(ip, commands.join(' && '));
  }

  async verifyServices(ip, services) {
    for (const service of services) {
      try {
        // Check if service is running
        await this.sshCommand(ip, `docker ps | grep ${service} || systemctl is-active ${service}`);
      } catch (error) {
        console.log(`   ⚠️  Service ${service} may not be running properly`);
      }
    }
  }

  async sshCommand(ip, command) {
    return new Promise((resolve, reject) => {
      const sshCmd = `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_USER}@${ip} "${command}"`;
      
      exec(sshCmd, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`SSH command failed: ${error.message}`));
          return;
        }
        
        if (stderr && !stderr.includes('Warning')) {
          console.log(`   📝 ${stderr.trim()}`);
        }
        
        if (stdout) {
          console.log(`   📝 ${stdout.trim()}`);
        }
        
        resolve(stdout);
      });
    });
  }

  async execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  showResults() {
    console.log('📊 Deployment Results');
    console.log('=====================\n');
    
    let successCount = 0;
    let failureCount = 0;
    
    for (const [instanceName, result] of Object.entries(this.deploymentResults)) {
      const instance = INSTANCES[instanceName];
      const status = result.success ? '✅ SUCCESS' : '❌ FAILED';
      const duration = `${result.duration}s`;
      
      console.log(`${status} ${instanceName} (${instance.ip}) - ${duration}`);
      
      if (!result.success) {
        console.log(`   Error: ${result.error}`);
        failureCount++;
      } else {
        successCount++;
      }
    }
    
    console.log('');
    console.log(`📈 Summary: ${successCount} successful, ${failureCount} failed`);
    
    if (failureCount > 0) {
      console.log('\n🔧 For failed deployments:');
      console.log('   1. Check SSH connectivity manually');
      console.log('   2. Verify instance is running');
      console.log('   3. Check deployment logs on the instance');
      console.log('   4. Re-run deployment for specific instances');
    } else {
      console.log('\n🎉 All deployments completed successfully!');
      console.log('✅ Your instances are now running the latest code');
    }
  }
}

// Run deployment
if (require.main === module) {
  const deployer = new InstanceDeployer();
  deployer.run().catch(error => {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
  });
}

module.exports = { InstanceDeployer };