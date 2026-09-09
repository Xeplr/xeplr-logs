var fs = require('fs');
var path = require('path');

// ─────────────────────────────────────────────────────────────────────────
// THE TWO QUESTIONS EVERY LOG LINE ANSWERS
//
//   1. WHAT is it about?          → `referenceId`
//   2. WHERE should it be kept?   → `to`
//
// (1) is the identity of the unit of work the line belongs to: a job
// occurrence, a move run, an action run. It used to be called `sessionId`,
// which was wrong in a way that caused a bug — "session" reads as HTTP
// session, so requestLogger felt entitled to INVENT one for any request that
// arrived without a header. That made "this line belongs to a run" and "this
// line belongs to nothing" the same shape, which is exactly the distinction
// the whole design turns on. No key now means no key.
//
// (2) decides the destination: an app-level file, a file per referenceId, or
// rows in a database the host owns. Bound when the logger is created, and
// overridable per entry.
//
// ─────────────────────────────────────────────────────────────────────────
// CONSOLE IS ALWAYS WRITTEN, AND IT IS NEVER BUFFERED
//
// Whichever destination a line is bound for — app file, session file, database
// — it goes to the console too, gated only by `consoleLevel`. The console is
// not a destination you choose between; it is unconditional.
//
// That is what makes buffering everything else safe. A process that dies with
// 200 lines pending loses them, and those are the lines explaining why it
// died — so the usual answer is a synchronous write-through on error, which is
// slow and STILL loses the twenty info lines before it that carry the story.
// Here there is nothing to write through: by the time a line entered the
// buffer it had already been printed. Whatever is watching stdout — PM2,
// Docker, a terminal, systemd — already has it.
//
// That is a bonus copy, NOT a dependency. This package does not require PM2,
// does not require pm2-logrotate, and does not assume anything is capturing
// stdout at all. It keeps its own text files and its own retention (purge()).
// If the surrounding infrastructure also keeps a copy, that is the
// infrastructure's business and duplication is cheap.
//
// `consoleLevel` defaults to `important` in production for volume, not for
// safety: twenty concurrent runs' batch chatter on stdout helps nobody. The
// levels that must survive a crash are exactly the ones still printed.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THE LEVEL GATE IS THE FIRST THING _write DOES
//
// The previous version built the timestamp, concatenated four strings and
// JSON.stringify'd the metadata BEFORE deciding anything — and then always
// wrote to file, at every level, with no way to switch debug off at all. On a
// single-core box that is the dominant cost of logging, and no setting could
// stop it.
//
// So: resolve the destinations first, and if a line is going nowhere, return
// before touching a string. A disabled log.debug now costs one integer
// comparison. Formatting for the store is deferred to flush time — the buffer
// holds raw fields, not finished lines.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY BATCHING, GIVEN fs WRITE STREAMS ARE ALREADY ASYNC
//
// Non-blocking is not free. Every line costs a syscall and a threadpool
// handoff, and where something is also capturing stdout it costs a second
// syscall in that process too. On one core all of them take turns on the same
// CPU, paying a context switch each way. So batching is not about unblocking
// the event loop — that was never blocked; it is about doing fewer syscalls
// and fewer switches, which is exactly the cost that bites when there is no
// spare core.
//
// Both destinations are buffered, for that reason. The database is where it
// stops being an optimisation and becomes the difference between viable and
// not: 200 lines is 200 round trips unbatched, and one insert batched.
// ─────────────────────────────────────────────────────────────────────────

var LEVELS = { debug: 1, info: 2, important: 3, error: 4, critical: 5 };
var LEVEL_NAMES = ['', 'DEBUG', 'INFO', 'IMPORTANT', 'ERROR', 'CRITICAL'];

// Destinations. `console` is not one of them — console is orthogonal and
// always applies, gated only by consoleLevel.
var DESTINATIONS = { app: true, session: true, db: true };

var _config = {
  appName: 'app',
  logDir: './logs',
  isDev: true,

  // What reaches stdout. Null means "derive from isDev" — debug in
  // development, important in production. Set it explicitly to override.
  consoleLevel: null,

  // What reaches the store (app file / session file / database). Independent
  // of the console, on purpose: a run's own store wants its info lines, while
  // the console must not carry twenty concurrent runs' batch chatter.
  //
  // debug is OFF by default and switched on at runtime — configure() merges,
  // so an app can raise it WHILE something is misbehaving rather than needing
  // a restart that clears the state it was trying to look at.
  storeLevel: 'info',

  // to:'db' writer, injected. This package has no dependencies and does not
  // own a database — same rule as everywhere else in the workspace. The host
  // supplies one function; it is called with an ARRAY of records.
  store: null,

  // Destination for a logger that has a referenceId but was not told where to
  // put things.
  //
  // 'app' — the dated <appName>-<date>.log, which is where everything went
  // before and where anything unremarkable should keep going.
  //
  // NOT 'session', and the reason bit immediately when it was: every existing
  // call site passes a CATEGORY as its key — createLogger('jobs'),
  // createLogger('movement') — not a run id. Defaulting those to a session
  // file would open xeplr-bi-jobs.log and append to it forever, and purge()
  // could never reclaim it, because purge deletes by mtime and that file is
  // written every minute. The app file has a date in its name and rolls on its
  // own; a session file does not, because a run belongs to ONE file whether or
  // not it crosses midnight.
  //
  // So: a session file assumes a bounded unit of work. Ask for it explicitly,
  // with a real run id — createLogger({ referenceId: occId, to: 'session' }) —
  // or point all keyed logging at the database with
  // configure({ defaultTo: 'db' }).
  defaultTo: 'app',

  // HOW A FILE LINE IS WRITTEN: 'text' or 'ndjson'.
  //
  // text is for a person tailing a file. ndjson is for a PROGRAM — one JSON
  // record per line, the same fields the database store receives, so a log
  // analyzer has one record shape whether the lines came from a table or a
  // file. Reports keep their logs in files and jobs keep theirs in the
  // database; without this that difference would mean two readers, one of them
  // a parser for our own prose.
  //
  // Text stays the default: a file nobody can read at a glance is a worse
  // default than one no program can read.
  fileFormat: 'text',

  // Write <appName>-<date>.log ourselves.
  //
  // ON. This package keeps its own text record and its own retention, and does
  // not care whether something outside is also capturing stdout. Where PM2 is
  // in front of it there are two copies of the same lines — that is fine and
  // deliberate: a duplicated write is cheap, and a package that only works
  // when deployed a particular way is not a package.
  //
  // Turn it off only if you have decided the surrounding infrastructure is the
  // record.
  appFile: true,

  // Flush cadence. Whichever comes first.
  flushMs: 1000,
  maxBatch: 200,

  // Email alerts.
  emailThreshold: 5,
  emailTo: null,
  emailService: null,

  // A FOURTH DESTINATION FOR ERRORS — see _notifySink.
  //
  // This package writes text, which is the right shape for "what happened
  // during X" and the wrong shape for "has anything broken at all". The second
  // question needs rows: something you can list newest-first, count
  // occurrences on, mark as dealt with, and read from a machine that did not
  // write the file.
  //
  // Rather than ask every app to report failures TWICE (a call that will be
  // missing in exactly the place it matters), an app that wants rows supplies
  // one function here and keeps calling log.error as normal.
  onError: null,
  sinkThreshold: 4,

  // How long this app's own log files are kept. NULL = never purge, because
  // deleting an app's files is not something a library should start doing on
  // its own. Set it and purging schedules itself — see _schedulePurge.
  retentionDays: null,

  // Accepted for backward compatibility. consoleLevel supersedes it.
  fatalThreshold: 4
};

// Raw records awaiting a flush. NOT formatted — see the header.
var _buffer = [];
var _timer = null;
var _purgeTimer = null;
var _flushing = false;
var _warned = {};

function configure(config) {
  if (!config) return;

  if (config.appName) _config.appName = config.appName;
  if (config.logDir) _config.logDir = config.logDir;
  if (config.isDev !== undefined) _config.isDev = config.isDev;

  if (config.consoleLevel !== undefined) _config.consoleLevel = config.consoleLevel;
  if (config.storeLevel !== undefined) _config.storeLevel = config.storeLevel;

  if (config.store !== undefined) _config.store = config.store;
  if (config.defaultTo) _config.defaultTo = config.defaultTo;
  if (config.appFile !== undefined) _config.appFile = config.appFile;
  if (config.fileFormat) _config.fileFormat = config.fileFormat;

  if (config.flushMs !== undefined) _config.flushMs = config.flushMs;
  if (config.maxBatch !== undefined) _config.maxBatch = config.maxBatch;

  if (config.fatalThreshold !== undefined) _config.fatalThreshold = config.fatalThreshold;
  if (config.emailThreshold !== undefined) _config.emailThreshold = config.emailThreshold;
  if (config.emailTo) {
    _config.emailTo = Array.isArray(config.emailTo) ? config.emailTo : [config.emailTo];
  }
  if (config.emailService) _config.emailService = config.emailService;

  // Explicit null clears it — an app must be able to switch the sink off (in a
  // test, or before its database is up) without reloading the module.
  if (config.onError !== undefined) _config.onError = config.onError;
  if (config.sinkThreshold !== undefined) _config.sinkThreshold = config.sinkThreshold;

  if (config.retentionDays !== undefined) {
    _config.retentionDays = config.retentionDays;
    _schedulePurge();
  }

  // Only make the directory if something will actually write into it.
  if (_config.appFile || _config.defaultTo === 'session') _ensureDir();
}

function _ensureDir() {
  var dir = path.resolve(_config.logDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _consoleMin() {
  if (_config.consoleLevel) return LEVELS[_config.consoleLevel] || 1;
  return _config.isDev ? LEVELS.debug : LEVELS.important;
}

function _storeMin() {
  return LEVELS[_config.storeLevel] || LEVELS.info;
}

// MEMOISED, because this used to run once per record at flush time — a
// 200-line batch built 200 Date objects and formatted 200 identical strings.
//
// Cached with an EXPIRY rather than refreshed on a timer. A timer that ticks
// hourly leaves lines written just after midnight landing in yesterday's file,
// and costs a wakeup in an otherwise idle process; comparing against the next
// UTC midnight is exact, recomputes once a day, and needs no timer at all.
// Date.now() is a vDSO read with no allocation — the comparison is free next
// to the toISOString it replaces.
var _dateStr = null;
var _dateUntil = 0;
function _today() {
  var now = Date.now();
  if (now >= _dateUntil) {
    var d = new Date(now);
    _dateStr = d.toISOString().slice(0, 10);
    _dateUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  return _dateStr;
}

// A referenceId becomes part of a FILENAME, so it is sanitised rather than
// trusted. An id containing '/' or '..' would otherwise write outside logDir,
// and ids arrive from callers this package does not control.
function _safeRef(referenceId) {
  return String(referenceId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Separators are already gone, so '..' cannot traverse — but a filename
    // made of dots is still nobody's intent, and leaving it would mean reading
    // the sanitiser twice to be sure.
    .replace(/\.{2,}/g, '_')
    .slice(0, 120);
}

function _warnOnce(key, message) {
  if (_warned[key]) return;
  _warned[key] = true;
  console.error('[@xeplr/logs] ' + message);
}

/**
 * The one path every log line takes.
 *
 * Order matters: decide, then format, then write. Never the other way round.
 */
function _write(level, referenceId, message, metadata, entryTo) {
  var levelNum = LEVELS[level] || LEVELS.info;

  // ── 1. DECIDE. No strings built yet. ────────────────────────────────────
  var toConsole = levelNum >= _consoleMin();
  var toStore = levelNum >= _storeMin();
  var toSink = Boolean(_config.onError) && levelNum >= _config.sinkThreshold;
  var toEmail = Boolean(_config.emailTo && _config.emailService) && levelNum >= _config.emailThreshold;

  var dest = entryTo || null;
  if (dest && !DESTINATIONS[dest]) {
    _warnOnce('dest:' + dest, 'unknown destination "' + dest + '" — falling back to console only.');
    dest = null;
    toStore = false;
  }

  if (toStore && !dest) dest = referenceId ? _config.defaultTo : 'app';

  // An app file nobody asked for is two copies of what PM2 already keeps.
  if (toStore && dest === 'app' && !_config.appFile) toStore = false;

  // to:'db' with no referenceId is meaningless — the row could never be found
  // again. Degrade rather than throw: a mistake at one call site must not take
  // down the request it was logging. createLogger throws for the same mistake
  // made in configuration, where it is caught immediately.
  if (toStore && dest === 'db' && !referenceId) {
    _warnOnce('db-noref', 'to:"db" needs a referenceId — line kept on console only.');
    toStore = false;
  }
  if (toStore && dest === 'db' && !_config.store) {
    _warnOnce('db-nostore', 'to:"db" needs configure({ store }) — line kept on console only.');
    toStore = false;
  }
  if (toStore && dest === 'session' && !referenceId) {
    dest = 'app';
    if (!_config.appFile) toStore = false;
  }

  if (!toConsole && !toStore && !toSink && !toEmail) return;

  var sid = referenceId || _config.appName;

  // ── 2. CONSOLE. Unbuffered, because it is the durable record. ───────────
  if (toConsole) {
    var line = '[' + new Date().toISOString() + '] [' + sid + '] [' +
      LEVEL_NAMES[levelNum] + '] ' + message;
    if (metadata) {
      line += ' ' + (typeof metadata === 'string' ? metadata : _safeJson(metadata));
    }
    if (levelNum >= LEVELS.error) console.error(line);
    else console.log(line);
  }

  // ── 3. STORE. Raw fields only; formatting happens at flush. ─────────────
  if (toStore) {
    _buffer.push({
      to: dest,
      at: Date.now(),
      level: level,
      levelNum: levelNum,
      appName: _config.appName,
      referenceId: referenceId || null,
      message: String(message == null ? '' : message),
      meta: metadata || null
    });
    if (_buffer.length >= _config.maxBatch) flush();
    else _arm();
  }

  if (toEmail) _sendAlert(LEVEL_NAMES[levelNum], sid, message, metadata);

  // Rows. LAST, so that a slow or broken sink cannot delay or prevent
  // anything above it.
  if (toSink) _notifySink(level, LEVEL_NAMES[levelNum], sid, message, metadata);
}

// Metadata is whatever a caller passed. A circular object would otherwise
// throw INSIDE a log call, which is the worst possible place for it — most
// often while something is already failing.
function _safeJson(value) {
  try { return JSON.stringify(value); }
  catch (e) { return '[unserialisable metadata: ' + (e && e.message) + ']'; }
}

function _arm() {
  if (_timer || !_config.flushMs) return;
  _timer = setTimeout(function() { _timer = null; flush(); }, _config.flushMs);
  // Never hold the process open for a log flush.
  if (_timer.unref) _timer.unref();
}

/**
 * Write everything buffered. Returns a promise, so shutdown and tests can wait
 * for it; nothing in the hot path ever does.
 *
 * Re-entrancy: a flush already in progress returns the same promise rather
 * than starting a second one, or two timers could interleave and write the
 * same records twice.
 */
var _pending = null;
function flush() {
  if (_flushing) return _pending;
  if (!_buffer.length) return Promise.resolve();

  _flushing = true;
  var batch = _buffer;
  _buffer = [];
  if (_timer) { clearTimeout(_timer); _timer = null; }

  _pending = _drain(batch).then(finish, finish);
  function finish() {
    _flushing = false;
    _pending = null;
    // WHAT ARRIVED WHILE WE WERE WRITING.
    //
    // A synchronous burst — a traced call chain, a loop that logs — fills the
    // buffer past maxBatch over and over, and every one of those flush() calls
    // returned early because this one was still in flight. The write path
    // takes the else branch that arms the timer ONLY when the buffer is under
    // maxBatch, so nothing rescheduled the remainder: it sat in memory,
    // growing, until some later line happened to arrive under the threshold.
    //
    // Picking up here is what makes sustained logging drain rather than
    // accumulate.
    if (_buffer.length >= _config.maxBatch) flush();
    else if (_buffer.length) _arm();
  }
  return _pending;
}

function _drain(batch) {
  var files = {};   // absolute path → text to append
  var rows = [];

  for (var i = 0; i < batch.length; i++) {
    var r = batch[i];
    if (r.to === 'db') { rows.push(r); continue; }

    // TWO SHAPES, kept visibly different on purpose:
    //   <appName>.<referenceId>.log   one unit of work, no date — a run
    //                                 belongs to one file even across midnight
    //   <appName>-<date>.log          the app's own stream, rolling daily
    // Both carry the app name, so one directory can hold several apps.
    var file = r.to === 'session'
      ? path.join(_dir(), _config.appName + '.' + _safeRef(r.referenceId) + '.log')
      : path.join(_dir(), _config.appName + '-' + _today() + '.log');

    var text;
    if (_config.fileFormat === 'ndjson') {
      // The SAME fields the db store gets — see logStore in a host app. One
      // record shape, two destinations, so nothing has to parse prose.
      text = _safeJson({
        at: new Date(r.at).toISOString(),
        level: LEVEL_NAMES[r.levelNum],
        appName: r.appName,
        referenceId: r.referenceId || null,
        message: r.message,
        meta: r.meta || null
      });
    } else {
      text = '[' + new Date(r.at).toISOString() + '] [' +
        (r.referenceId || r.appName) + '] [' + LEVEL_NAMES[r.levelNum] + '] ' + r.message;
      if (r.meta) text += ' ' + (typeof r.meta === 'string' ? r.meta : _safeJson(r.meta));
    }

    files[file] = (files[file] || '') + text + '\n';
  }

  var work = Object.keys(files).map(function(file) {
    return new Promise(function(resolve) {
      // appendFile, not a held-open stream. A file per referenceId means
      // thousands of descriptors if they are kept; batching already made one
      // call per file per flush, so opening and closing costs nothing extra.
      fs.appendFile(file, files[file], function() { resolve(); });
    });
  });

  if (rows.length && _config.store) {
    work.push(Promise.resolve()
      .then(function() { return _config.store(rows); })
      .catch(function(e) {
        // The store being down must not become a second failure. The lines are
        // on the console already — see the header.
        _warnOnce('store-failed', 'store() threw, ' + rows.length +
          ' row(s) dropped: ' + ((e && e.message) || e));
      }));
  }

  return Promise.all(work);
}

var _dirCache = null;
function _dir() {
  if (!_dirCache) _dirCache = _ensureDir();
  return _dirCache;
}

/**
 * Hand the error to whatever the app wants to do with it — usually insert a row.
 *
 * FIRE AND FORGET, and it swallows everything. Two separate reasons, both
 * learned the hard way elsewhere:
 *
 *   - _write is SYNCHRONOUS and every caller treats it as such. A database
 *     insert is not, so awaiting it here would make every log.error in the
 *     codebase an await point, or silently return an unhandled promise.
 *   - This runs while the app is ALREADY handling a failure. A sink that
 *     throws would replace the real error — the one somebody needs to read —
 *     with whatever went wrong recording it.
 */
function _notifySink(level, levelLabel, referenceId, message, metadata) {
  try {
    var out = _config.onError({
      level: level,
      levelLabel: levelLabel,
      appName: _config.appName,
      // Kept under BOTH names. `sessionId` is what errorEvents.js and every
      // other existing sink reads; renaming it here would silently blank a
      // column rather than fail.
      sessionId: referenceId,
      referenceId: referenceId,
      message: String(message == null ? '' : message),
      meta: metadata || null,
      at: new Date()
    });
    if (out && typeof out.then === 'function') out.then(null, function() {});
  } catch (e) {
    // Deliberately silent. See above.
  }
}

function _sendAlert(levelLabel, referenceId, message, metadata) {
  var subject = levelLabel + ': [' + _config.appName + '] [' + referenceId + '] ' +
    String(message).slice(0, 80);
  var html = '<h2 style="color:red;">' + levelLabel + '</h2>'
    + '<p><strong>App:</strong> ' + _config.appName + '</p>'
    + '<p><strong>Reference:</strong> ' + referenceId + '</p>'
    + '<p><strong>Message:</strong> ' + message + '</p>'
    + (metadata ? '<pre>' + _safeJson(metadata) + '</pre>' : '');

  try {
    _config.emailService.send(_config.emailTo, subject, html);
  } catch (e) {
    // Don't let email failure crash the app.
  }
}

/**
 * A logger bound to one unit of work.
 *
 *   createLogger('jobs')                              // referenceId only
 *   createLogger({ referenceId: occId, to: 'db' })    // and a destination
 *
 * Every method takes (message, meta, opts?) where opts.to overrides the bound
 * destination for that entry.
 */
function createLogger(options) {
  var referenceId = null;
  var to = null;

  if (typeof options === 'string' || typeof options === 'number') {
    referenceId = String(options);
  } else if (options && typeof options === 'object') {
    referenceId = options.referenceId != null ? String(options.referenceId) : null;
    to = options.to || null;
  }

  // Configuration mistakes throw HERE, where the stack points at the code that
  // made them. The same mistake made per-entry degrades to console instead —
  // see _write. A logger built wrong is a bug; one line logged wrong is not
  // worth an outage.
  if (to && !DESTINATIONS[to]) {
    throw new Error('@xeplr/logs: unknown destination "' + to +
      '". Use one of: app, session, db.');
  }
  if (to === 'db' && !referenceId) {
    throw new Error('@xeplr/logs: to:"db" requires a referenceId — a row with ' +
      'nothing to find it by can never be read back.');
  }

  function at(level) {
    return function(msg, meta, opts) {
      _write(level, referenceId, msg, meta, (opts && opts.to) || to);
    };
  }

  return {
    debug: at('debug'),
    info: at('info'),
    important: at('important'),
    error: at('error'),
    critical: at('critical'),
    referenceId: referenceId,

    /**
     * For call sites whose metadata is expensive to build.
     *
     * The level gate stops _write doing work, but it cannot stop the ARGUMENTS
     * being evaluated — log.debug('x', summarise(rows)) still calls summarise
     * even when debug is off. Guard those with this.
     */
    isEnabled: function(level) {
      var n = LEVELS[level] || LEVELS.info;
      return n >= _consoleMin() || n >= _storeMin();
    },

    /**
     * ENTRY AND EXIT FOR ONE FUNCTION, with how long it took, at debug level.
     *
     *   var activate = log.trace('activate', async function (token) { ... });
     *
     * ── WHY THIS EXISTS RATHER THAN TWO log.debug CALLS ──────────────────
     *
     * Hand-written entry/exit lines cost something even when debug is OFF:
     * `log.debug('enter activate ' + token)` builds that string, every call,
     * and only then discovers nobody wanted it. Twenty-five functions deep in
     * a request, that is the difference between free and seconds.
     *
     * Here the FIRST thing is the gate, and when it is shut the wrapper is a
     * single boolean test and a straight call through — no strings, no
     * timestamps, no allocation. Turn debug on at runtime (configure() merges,
     * so no restart) and the same code starts narrating immediately.
     *
     * Works on sync and async functions alike: a returned thenable is timed to
     * its settlement, anything else to its return. Errors are logged with the
     * elapsed time and RE-THROWN — this observes, it never swallows.
     */
    trace: function(name, fn) {
      var logger = this;
      return function() {
        // The gate, before anything is built. Everything below this line is
        // work that only happens when somebody asked to watch.
        if (!logger.isEnabled('debug')) return fn.apply(this, arguments);

        var startedAt = Date.now();
        logger.debug('→ ' + name);

        function done(outcome, err) {
          var ms = Date.now() - startedAt;
          if (err) logger.debug('✗ ' + name + ' failed after ' + ms + 'ms: ' + err.message);
          else logger.debug('← ' + name + ' ' + ms + 'ms');
        }

        var out;
        try {
          out = fn.apply(this, arguments);
        } catch (err) {
          done('threw', err);
          throw err;
        }
        if (out && typeof out.then === 'function') {
          return out.then(
            function(v) { done('resolved'); return v; },
            function(err) { done('rejected', err); throw err; }
          );
        }
        done('returned');
        return out;
      };
    },

    /**
     * The same, inline, for a block you do not want to name as a function.
     *
     *   await log.span('resolve columns', function () { ... });
     */
    span: function(name, fn) {
      return this.trace(name, fn)();
    },

    /** A child for a different unit of work, keeping this one's destination. */
    for: function(nextReferenceId) {
      return createLogger({ referenceId: nextReferenceId, to: to });
    }
  };
}

/**
 * Express middleware — logs request entry/exit.
 *
 * NO FABRICATED ID. The previous version generated `sid-a1b2c3d4` for any
 * request arriving without an x-reference-id header, which made an unkeyed
 * line indistinguishable from a keyed one — defeating the only distinction
 * this package's storage decisions are based on. A request that is not part of
 * a tracked unit of work has no referenceId, and that is the correct answer.
 */
function requestLogger() {
  return function(req, res, next) {
    var referenceId = req.headers['x-reference-id'] || req.headers['x-session-id'] || null;
    req.referenceId = referenceId;
    // Kept: existing middleware and routes read req.sessionId.
    req.sessionId = referenceId;
    req.log = createLogger(referenceId);

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
      _write(level, referenceId, '← ' + method + ' ' + url + ' ' + status + ' ' + duration + 'ms');
    };

    next();
  };
}

/**
 * Delete this app's log files whose last write was more than retentionDays ago.
 *
 * THE retention policy for everything this package writes — dated app files
 * and session files alike. Nothing outside can do it: whatever is capturing
 * stdout rotates its own copy and has never heard of these.
 *
 * BY MTIME, NOT BY THE NAME. Right for both shapes: the app file's mtime is
 * its last line, and a session file's is when that run last did anything — so
 * a run that finished forty days ago ages out correctly despite having no date
 * in its filename.
 *
 * ONLY THIS APP'S FILES. The previous version deleted every *.log in logDir,
 * so pointing two apps at one directory — or at a directory holding anything
 * else — meant each of them quietly eating the others' history.
 *
 * ASYNC, because it is O(files): a readdir plus a stat each. The synchronous
 * version was fine at a few hundred files and a visible stall at tens of
 * thousands, which is exactly what a per-run file count grows into.
 */
async function purge(retentionDays) {
  var dir = path.resolve(_config.logDir);
  var fsp = fs.promises;

  var names;
  try { names = await fsp.readdir(dir); }
  catch (e) { return 0; }   // no directory means nothing to purge

  var cutoff = Date.now() - (retentionDays || _config.retentionDays || 30) * 86400000;
  var mine = names.filter(function(f) {
    if (!f.endsWith('.log')) return false;
    return f.indexOf(_config.appName + '-') === 0 || f.indexOf(_config.appName + '.') === 0;
  });

  var purged = 0;
  for (var i = 0; i < mine.length; i++) {
    var filePath = path.join(dir, mine[i]);
    try {
      var stat = await fsp.stat(filePath);
      if (stat.mtimeMs < cutoff) { await fsp.unlink(filePath); purged++; }
    } catch (e) {
      // Gone already, or not ours to delete. Either way not worth failing over.
    }
  }
  return purged;
}

/**
 * Keep purging, on the app's say-so.
 *
 * OFF unless `retentionDays` is configured, because deletion is destructive
 * and a package should never quietly start removing an app's data because it
 * was upgraded. Set it and this package handles retention itself — no host
 * scheduler required, which is the point: it has to work the same whether it
 * is running under PM2, in a container, or as a bare process.
 *
 * Hourly, not daily: a daily timer in a process restarted every few hours
 * never fires at all.
 */
function _schedulePurge() {
  if (_purgeTimer) { clearInterval(_purgeTimer); _purgeTimer = null; }
  if (!_config.retentionDays) return;

  _purgeTimer = setInterval(function() {
    purge(_config.retentionDays).catch(function() {});
  }, 3600000);
  // Never hold the process open for housekeeping.
  if (_purgeTimer.unref) _purgeTimer.unref();
}

/** Flush and stop. Await it in a shutdown handler. */
function destroy() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_purgeTimer) { clearInterval(_purgeTimer); _purgeTimer = null; }
  return flush();
}

module.exports = {
  configure,
  createLogger,
  requestLogger,
  purge,
  flush,
  destroy,
  LEVELS
};
