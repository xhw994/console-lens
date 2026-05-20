// Console Lens — Pure query engine: parseQuery, resolve, matchesFilters.
// Extracted to allow unit testing without the DevTools panel context.
// Exposed as window.ConsoleLensEngine for use by panel.js and test harnesses.
(function () {
  'use strict';

  // ── Query parser ──
  // Tokenises a query string into column display paths and value filters.
  //   'status'               → { columns:['status'], filters:[] }
  //   'status=active'        → { columns:['status'], filters:[{path:'status', values:['active']}] }
  //   'role=admin,editor'    → OR across values
  //   'status=active type=x' → AND across tokens
  function parseQuery(input) {
    var result = { columns: [], filters: [] };
    var trimmed = input.trim();
    if (!trimmed) return result;

    var tokens = trimmed.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var eqIndex = token.indexOf('=');
      if (eqIndex === -1) {
        if (result.columns.indexOf(token) === -1) result.columns.push(token);
      } else {
        var path = token.substring(0, eqIndex);
        var valuesStr = token.substring(eqIndex + 1);
        var values = valuesStr.split(',').filter(Boolean);
        result.filters.push({ path: path, values: values });
        if (result.columns.indexOf(path) === -1) result.columns.push(path);
      }
    }
    return result;
  }

  // ── Dot-path resolver ──
  // Traverses obj along dotPath, auto-flattening arrays at each level.
  //   resolve({a:{b:1}}, 'a.b')              → [1]
  //   resolve({items:[{id:1},{id:2}]}, 'items.id') → [1, 2]
  //   resolve({x:null}, 'x')                 → [null]
  //   resolve({}, 'missing')                 → []
  function resolve(obj, dotPath) {
    if (!obj || !dotPath) return [];

    var segments = dotPath.split('.');
    var frontier = [obj];

    for (var s = 0; s < segments.length; s++) {
      var segment = segments[s];
      var next = [];
      for (var f = 0; f < frontier.length; f++) {
        var item = frontier[f];
        if (Array.isArray(item)) {
          for (var a = 0; a < item.length; a++) {
            if (item[a] != null && typeof item[a] === 'object' && segment in item[a]) {
              next.push(item[a][segment]);
            }
          }
        } else if (item != null && typeof item === 'object' && segment in item) {
          next.push(item[segment]);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    var flat = [];
    for (var i = 0; i < frontier.length; i++) {
      if (Array.isArray(frontier[i])) {
        for (var j = 0; j < frontier[i].length; j++) flat.push(frontier[i][j]);
      } else {
        flat.push(frontier[i]);
      }
    }
    return flat;
  }

  // ── Filter matching ──
  // Returns true if entry satisfies all active filters.
  // strictMode: if true, entries missing a queried path are excluded.
  //             if false (lenient), they are included with an empty pill.
  function matchesFilters(entry, labelText, parsed, level, strictMode) {
    if (level && entry.method !== level) return false;
    if (labelText && entry.label.toLowerCase().indexOf(labelText.toLowerCase()) === -1) return false;

    for (var i = 0; i < parsed.filters.length; i++) {
      var filter = parsed.filters[i];
      var resolved = resolve(entry.data, filter.path);

      if (resolved.length === 0) {
        if (strictMode) return false;
        else continue;
      }

      var match = false;
      for (var r = 0; r < resolved.length; r++) {
        var valStr = String(resolved[r]);
        for (var v = 0; v < filter.values.length; v++) {
          if (valStr === filter.values[v]) { match = true; break; }
        }
        if (match) break;
      }
      if (!match) return false;
    }

    return true;
  }

  window.ConsoleLensEngine = { parseQuery: parseQuery, resolve: resolve, matchesFilters: matchesFilters };
})();
