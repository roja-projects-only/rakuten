/**
 * Coordinator Components Index
 * 
 * Exports all coordinator components for the distributed worker architecture.
 */

const JobQueueManager = require('./JobQueueManager');
const ProxyPoolManager = require('./ProxyPoolManager');
const ProgressTracker = require('./ProgressTracker');

module.exports = {
  JobQueueManager,
  ProxyPoolManager,
  ProgressTracker
};