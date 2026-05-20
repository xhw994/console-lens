// Runs in the PAGE context via "world": "MAIN" at document_start.
// Intercepts console output and buffers structured logs for the DevTools panel.
(function () {
  'use strict';

  var CONSTANTS = {
    MAX_PAYLOAD_SIZE: 1024 * 1024, // bytes — entries larger than this are replaced with an error stub
    MAX_DEPTH:        12,          // safeClone recursion depth limit
    MAX_KEYS:         200,         // max object keys captured per level
    MAX_ARRAY:        200,         // max array elements captured per level
    BUFFER_LIMIT:     5000,        // ring buffer high-water mark
    BUFFER_TRIM_TO:   2500,        // entries kept after trimming
  };
  var METHODS = ['log', 'debug', 'info', 'warn', 'error'];

  // Buffer that the DevTools panel will poll and flush
  window.__consoleLensBuffer = [];

  // ── Group label tracking ──
  // Many logging frameworks use grouped output:
  //   console.groupCollapsed('%c Label %s', css, 'event.name')
  //   console.log(properties)
  //   console.groupEnd()
  // We intercept group/groupCollapsed to capture the label, then apply
  // it to the next object-only log call within that group.
  //
  // FIX: Sequence counter prevents group label theft.
  // Without this, any object-only log between group() and its first child
  // could steal the pending label. The counter ensures only the IMMEDIATELY
  // FOLLOWING console call (callSeq === pendingGroupSeq + 1) gets the label.
  // Any intervening call from third-party code expires it.
  var pendingGroupLabel = null;
  var pendingGroupSeq = -1;
  var callSeq = 0;
  var groupDepth = 0;

  // ── Consecutive deduplication ──
  // If the same log fires repeatedly (e.g. an error retry loop), we increment
  // count on the last buffer entry rather than pushing a new one. The panel
  // renders a ×N badge. Window: 1000 ms; resets on any different message.
  var _dedupSig  = '';
  var _dedupTime = 0;

  // ── Deep clone ──
  function safeClone(obj, depth, seen, maxDepth) {
    if (maxDepth === undefined) maxDepth = CONSTANTS.MAX_DEPTH;
    if (depth > maxDepth) return '<<depth limit>>';
    if (obj === null || obj === undefined) return obj;

    var type = typeof obj;
    if (type === 'string' || type === 'number' || type === 'boolean') return obj;
    if (type === 'function') return '<<function>>';
    if (type === 'symbol') return obj.toString();
    if (type === 'bigint') return obj.toString();

    if (typeof obj !== 'object') return String(obj);

    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (obj instanceof Error) {
      return { __error: obj.message, stack: obj.stack ? obj.stack.substring(0, 500) : undefined };
    }
    if (typeof Node !== 'undefined' && obj instanceof Node) {
      return '<<' + obj.nodeName + '>>';
    }

    if (seen.has(obj)) return '<<circular>>';
    seen.add(obj);

    try {
      if (Array.isArray(obj)) {
        var arr = [];
        var len = Math.min(obj.length, CONSTANTS.MAX_ARRAY);
        for (var i = 0; i < len; i++) {
          arr.push(safeClone(obj[i], depth + 1, seen, maxDepth));
        }
        if (obj.length > CONSTANTS.MAX_ARRAY) {
          arr.push('<<' + (obj.length - CONSTANTS.MAX_ARRAY) + ' more items>>');
        }
        return arr;
      }

      var result = {};
      var keys;
      try { keys = Object.keys(obj); } catch (e) { return '<<non-enumerable object>>'; }
      var keyCount = Math.min(keys.length, CONSTANTS.MAX_KEYS);
      for (var k = 0; k < keyCount; k++) {
        try {
          result[keys[k]] = safeClone(obj[keys[k]], depth + 1, seen, maxDepth);
        } catch (e) {
          result[keys[k]] = '<<access error>>';
        }
      }
      if (keys.length > CONSTANTS.MAX_KEYS) {
        result['__truncated'] = keys.length - CONSTANTS.MAX_KEYS + ' more keys';
      }
      return result;
    } catch (e) {
      return '<<clone error>>';
    } finally {
      seen.delete(obj);
    }
  }

  // ── Format string processing ──
  // Reconstructs the label from printf-style format strings:
  //   '%cLabel %s' + [css, 'event.name'] → 'Label event.name'
  function processFormatString(args) {
    if (args.length === 0) return { label: null, remaining: args };

    var first = args[0];
    if (typeof first !== 'string') return { label: null, remaining: args };

    if (!/%./.test(first)) {
      return { label: first.trim(), remaining: Array.prototype.slice.call(args, 1) };
    }

    var argIndex = 1;
    var assembled = first.replace(/%([csdifoO])/g, function (match, specifier) {
      if (argIndex >= args.length) return '';
      var val = args[argIndex++];
      if (specifier === 'c') return '';
      if (specifier === 's') return String(val);
      if (specifier === 'd' || specifier === 'i') return String(parseInt(val, 10));
      if (specifier === 'f') return String(parseFloat(val));
      return ''; // %o, %O
    });

    var label = assembled.trim();
    var remaining = Array.prototype.slice.call(args, argIndex);
    return { label: label.length > 0 ? label : null, remaining: remaining };
  }

  // ── Key fingerprint ──
  function keyFingerprint(obj) {
    try {
      var keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      var shown = keys.slice(0, 3).join(', ');
      if (keys.length > 3) shown += ', …';
      return '{' + shown + '}';
    } catch (e) {
      return '(object)';
    }
  }

  // ── Main buffer logic ──
  function pushToBuffer(method, args) {
    try {
      if (args.length < 1) return;

      // Read live config injected by the DevTools panel (may change at runtime)
      var cfg          = window.__consoleLensConfig || {};
      var maxDepth     = cfg.maxDepth     || CONSTANTS.MAX_DEPTH;
      var bufferLimit  = cfg.bufferLimit  || CONSTANTS.BUFFER_LIMIT;
      var bufferTrimTo = cfg.bufferTrimTo || CONSTANTS.BUFFER_TRIM_TO;

      var processed = processFormatString(args);
      var label = processed.label;
      var remaining = processed.remaining;

      // Find the first object in remaining args
      var data = null;
      for (var i = 0; i < remaining.length; i++) {
        var arg = remaining[i];
        if (typeof arg === 'string') continue;
        if (arg !== null && typeof arg === 'object') {
          data = arg;
          break;
        }
      }

      if (data === null && label === null) return;

      if (data === null) {
        data = { message: label };
      }
      if (label === null) {
        // Use the pending group label ONLY if this is the immediately-following
        // console call after group/groupCollapsed (sequence counter match).
        // This prevents third-party logs from stealing the label.
        if (pendingGroupLabel && callSeq === pendingGroupSeq + 1) {
          label = pendingGroupLabel;
          pendingGroupLabel = null;
        } else {
          if (pendingGroupLabel) pendingGroupLabel = null; // Expire stale label
          label = keyFingerprint(data);
        }
      }

      var cloned = safeClone(data, 0, new WeakSet(), maxDepth);
      var payload;
      try {
        payload = JSON.stringify(cloned);
      } catch (e) {
        var preview = '';
        try { preview = String(data).substring(0, 200); } catch (e2) { preview = '(unable to preview)'; }
        var topKeys = '';
        try { topKeys = Object.keys(data).slice(0, 10).join(', '); } catch (e3) { topKeys = '(no keys)'; }
        window.__consoleLensBuffer.push({
          label: label,
          data: {
            __consoleLensError: 'Failed to serialize after safe clone',
            preview: preview,
            topKeys: topKeys,
            originalType: Object.prototype.toString.call(data),
          },
          timestamp: Date.now(),
          method: method,
        });
        return;
      }

      if (payload && payload.length > CONSTANTS.MAX_PAYLOAD_SIZE) {
        var summaryKeys = '';
        try { summaryKeys = Object.keys(data).slice(0, 20).join(', '); } catch (e4) { summaryKeys = '(no keys)'; }
        window.__consoleLensBuffer.push({
          label: label,
          data: {
            __consoleLensError: 'Payload too large (' + Math.round(payload.length / 1024) + 'KB, limit ' + Math.round(CONSTANTS.MAX_PAYLOAD_SIZE / 1024) + 'KB)',
            topKeys: summaryKeys,
            originalType: Object.prototype.toString.call(data),
          },
          timestamp: Date.now(),
          method: method,
        });
        return;
      }

      if (payload) {
        var sig = method + '\0' + String(label || '') + '\0' + payload.slice(0, 500);
        var now = Date.now();
        var buf = window.__consoleLensBuffer;
        if (sig === _dedupSig && now - _dedupTime < 1000 && buf.length > 0) {
          // Consecutive duplicate — extend the existing entry's count
          buf[buf.length - 1].count = (buf[buf.length - 1].count || 1) + 1;
          _dedupTime = now;
        } else {
          _dedupSig  = sig;
          _dedupTime = now;
          buf.push({
            label: label,
            data: cloned,
            timestamp: Date.now(),
            method: method,
            count: 1,
          });
          if (buf.length > bufferLimit) {
            window.__consoleLensBuffer = buf.slice(-bufferTrimTo);
          }
        }
      }
    } catch (e) {
      // Silently fail — never break the page
    }
  }

  // ── Monkey-patching ──

  // Intercept log/debug/info/warn/error
  for (var m = 0; m < METHODS.length; m++) {
    (function (method) {
      var original = console[method];
      if (typeof original !== 'function') return;
      console[method] = function () {
        original.apply(console, arguments);
        callSeq++;
        pushToBuffer(method, Array.prototype.slice.call(arguments));
      };
    })(METHODS[m]);
  }

  // Intercept group/groupCollapsed to capture labels for object-only logs within
  var GROUP_METHODS = ['group', 'groupCollapsed'];
  for (var g = 0; g < GROUP_METHODS.length; g++) {
    (function (method) {
      var original = console[method];
      if (typeof original !== 'function') return;
      console[method] = function () {
        original.apply(console, arguments);
        callSeq++;
        groupDepth++;
        // Extract the label from the group header and record sequence
        try {
          var processed = processFormatString(Array.prototype.slice.call(arguments));
          if (processed.label) {
            // Strip trailing colon/whitespace from group labels like "my.event: "
            pendingGroupLabel = processed.label.replace(/:\s*$/, '');
            pendingGroupSeq = callSeq;
          }
        } catch (e) {}
      };
    })(GROUP_METHODS[g]);
  }

  // Intercept groupEnd to clear group state
  var originalGroupEnd = console.groupEnd;
  if (typeof originalGroupEnd === 'function') {
    console.groupEnd = function () {
      originalGroupEnd.apply(console, arguments);
      callSeq++;
      if (groupDepth > 0) groupDepth--;
      if (groupDepth === 0) pendingGroupLabel = null;
    };
  }
})();
