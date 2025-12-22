/**
 * Coordinator Components Index
 * 
 * Exports all coordinator components for the distributed worker architecture.
 */

const JobQueueManager = require('./JobQueueManager');
const ProxyPoolManager = require('./ProxyPoolManager');

module.exports = {
  JobQueueManager,
  ProxyPoolManager
};