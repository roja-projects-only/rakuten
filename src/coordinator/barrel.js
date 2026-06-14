/**
 * Coordinator Components Index (barrel)
 * 
 * Exports all coordinator components for the distributed worker architecture.
 * Imported as the new src/coordinator barrel (renamed to avoid conflict with entrypoint).
 */

const JobQueueManager = require('./JobQueueManager');
const ProxyPoolManager = require('./ProxyPoolManager');
const ProgressTracker = require('./ProgressTracker');
const ChannelForwarder = require('./ChannelForwarder');
const Coordinator = require('./Coordinator');

module.exports = {
  JobQueueManager,
  ProxyPoolManager,
  ProgressTracker,
  ChannelForwarder,
  Coordinator
};
