var fs = require('fs');
var path = require('path');

var LEVELS = { debug: 1, info: 2, important: 3, error: 4, critical: 5 };
var LEVEL_NAMES = ['', 'DEBUG', 'INFO', 'IMPORTANT', 'ERROR', 'CRITICAL'];

var _config = {
  appName: 'app',
  logDir: './logs',
  fatalThreshold: 4,
  emailThreshold: 5,
  emailTo: null,
  emailService: null,
  isDev: true
};

var _streams = {};
var _currentDate = null;

function configure(config) {
  if (config.appName) _config.appName = config.appName;
  if (config.logDir) _config.logDir = config.logDir;
  if (config.fatalThreshold !== undefined) _config.fatalThreshold = config.fatalThreshold;
  if (config.emailThreshold !== undefined) _config.emailThreshold = config.emailThreshold;
  if (config.emailTo) {
    _config.emailTo = Array.isArray(config.emailTo) ? config.emailTo : [config.emailTo];
  }
  if (config.emailService) _config.emailService = config.emailService;
  if (config.isDev !== undefined) _config.isDev = config.isDev;

  var dir = path.resolve(_config.logDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _getStream(sessionId) {
  var today = _today();

  // Daily rotation — close old streams if date changed
  if (_currentDate && _currentDate !== today) {
    Object.keys(_streams).forEach(function(key) {
      _streams[key].end();
    });
    _streams = {};
  }
  _currentDate = today;

  var key = sessionId + ':' + today;
  if (!_streams[key]) {
    var dir = path.resolve(_config.logDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    var filename = sessionId + '-' + today + '.log';
    _streams[key] = fs.createWriteStream(path.join(dir, filename), { flags: 'a' });
  }
  return _streams[key];
}

function _write(level, sessionId, message, metadata) {
  var levelNum = LEVELS[level] || 2;
  var levelLabel = LEVEL_NAMES[levelNum];
  var ts = new Date().toISOString();
  var sid = sessionId || _config.appName;

  var line = '[' + ts + '] [' + sid + '] [' + levelLabel + '] ' + message;
  if (metadata) {
    line += ' ' + (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  }

  // Always write to file
  var stream = _getStream(_config.appName);
  stream.write(line + '\n');

  // Console: errors/critical always, rest only in dev or >= fatalThreshold
  if (levelNum >= 4) {
    console.error(line);
  } else if (_config.isDev || levelNum >= _config.fatalThreshold) {
    console.log(line);
  }

  // Email
  if (_config.emailTo && _config.emailService && levelNum >= _config.emailThreshold) {
    _sendAlert(levelLabel, sid, message, metadata);
  }
}

function _sendAlert(levelLabel, sessionId, message, metadata) {
  var subject = levelLabel + ': [' + _config.appName + '] [' + sessionId + '] ' + message.slice(0, 80);
  var html = '<h2 style="color:red;">' + levelLabel + '</h2>'
    + '<p><strong>App:</strong> ' + _config.appName + '</p>'
    + '<p><strong>Session:</strong> ' + sessionId + '</p>'
    + '<p><strong>Message:</strong> ' + message + '</p>'
    + (metadata ? '<pre>' + JSON.stringify(metadata, null, 2) + '</pre>' : '');

  try {
    _config.emailService.send(_config.emailTo, subject, html);
  } catch (e) {
    // Don't let email failure crash the app
  }
}

/**
 * Create a logger bound to a session ID.
 * All methods: debug, info, important, error, critical
 */
function createLogger(sessionId) {
  var sid = sessionId || _config.appName;
  return {
    debug: function(msg, meta) { _write('debug', sid, msg, meta); },
    info: function(msg, meta) { _write('info', sid, msg, meta); },
    important: function(msg, meta) { _write('important', sid, msg, meta); },
    error: function(msg, meta) { _write('error', sid, msg, meta); },
    critical: function(msg, meta) { _write('critical', sid, msg, meta); }
  };
}

/**
 * Express middleware — logs request entry/exit.
 * Reads session ID from x-session-id header, or generates one.
 */
function requestLogger() {
  return function(req, res, next) {
    var sessionId = req.headers['x-session-id'] || _generateSessionId();
    req.sessionId = sessionId;
    req.log = createLogger(sessionId);

    var method = req.method;
    var url = req.originalUrl || req.url;
    var entryTime = Date.now();

    req.log.info('→ ' + method + ' ' + url);

    var originalEnd = res.end;
    res.end = function() {
      res.end = originalEnd;
      res.end.apply(res, arguments);

      var duration = Date.now() - entryTime;
      var status = res.statusCode;
      var level = status >= 500 ? 'error' : status >= 400 ? 'important' : 'info';
      _write(level, sessionId, '← ' + method + ' ' + url + ' ' + status + ' ' + duration + 'ms');
    };

    next();
  };
}

function _generateSessionId() {
  return 'sid-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Purge log files older than retentionDays.
 */
function purge(retentionDays) {
  var dir = path.resolve(_config.logDir);
  if (!fs.existsSync(dir)) return 0;

  var cutoff = Date.now() - (retentionDays || 30) * 86400000;
  var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.log'); });
  var purged = 0;

  files.forEach(function(file) {
    var filePath = path.join(dir, file);
    var stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      purged++;
    }
  });

  return purged;
}

/**
 * Destroy all open streams (for graceful shutdown).
 */
function destroy() {
  Object.keys(_streams).forEach(function(key) {
    _streams[key].end();
  });
  _streams = {};
}

module.exports = {
  configure,
  createLogger,
  requestLogger,
  purge,
  destroy,
  LEVELS
};
