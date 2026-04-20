var logger = require('./lib/logger');

module.exports = {
  configure: logger.configure,
  createLogger: logger.createLogger,
  requestLogger: logger.requestLogger,
  purge: logger.purge,
  destroy: logger.destroy,
  LEVELS: logger.LEVELS
};
