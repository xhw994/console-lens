// Console Lens — Panel logic: polling, query engine, rendering.
(function () {
  'use strict';

  // ── Constants ──
  var CONSTANTS = {
    POLL_FAST:       50,   // ms — poll interval while draining a backlog
    POLL_IDLE:       300,  // ms — poll interval at idle
    POLL_BATCH:      100,  // entries drained per poll tick
    DEBOUNCE_QUERY:  350,  // ms — query bar input debounce
    VIRT_OVERSCAN:   8,    // extra cards above/below viewport to keep rendered
    VIRT_EST_HEIGHT: 38,   // px — estimated slot height for a collapsed card (header ~34px + 4px margin)
  };

  // ── State ──
  var logs = [];
  var nextId = 0;
  var sortKeys = true;
  var strictMode = true;
  var strippedPaths = new Set();
  // ── Persisted settings ──
  var settings = {
    panelLogLimit:  2500,  // max entries kept in logs[]; 0 = unlimited
    pageBufferLimit: 5000, // page-side ring buffer high-water mark
    cloneDepth:     12,    // safeClone MAX_DEPTH
  };

  var renderedIds     = new Set(); // IDs of entries currently in the DOM (virtual window)
  var logsById        = {};        // id → entry for O(1) lookup
  var lastColumns     = [];        // columns from last render; column changes force a full rebuild
  var filteredLogs    = [];        // ordered entries passing the current filter
  var heightPrefixSum = [0];       // heightPrefixSum[i] = sum of slot heights for filteredLogs[0..i-1]
  var cardHeightCache = {};        // id → last-measured slot height (offsetHeight + margin)
  var virtStart       = 0;         // index of first rendered entry in filteredLogs
  var virtEnd         = -1;        // index of last rendered entry (inclusive)
  var topSpacer       = null;      // DOM div above the rendered window
  var bottomSpacer    = null;      // DOM div below the rendered window
  var scrollRaf       = null;      // requestAnimationFrame handle for scroll handler

  // ResizeObserver keeps height cache accurate when cards expand/collapse
  var cardResizeObs = (typeof ResizeObserver !== 'undefined')
    ? new ResizeObserver(function (entries) {
        var changed = false;
        for (var i = 0; i < entries.length; i++) {
          var card = entries[i].target;
          var id = parseInt(card.dataset.id, 10);
          // Use borderBoxSize when available (includes border); fallback to contentRect
          var h = entries[i].borderBoxSize
            ? Math.round(entries[i].borderBoxSize[0].blockSize) + 4
            : Math.round(entries[i].contentRect.height) + 6;
          if (h > 4 && cardHeightCache[id] !== h) {
            cardHeightCache[id] = h;
            changed = true;
          }
        }
        if (changed) { rebuildPrefixSum(); updateSpacers(); }
      })
    : null;

  // ── DOM refs ──
  var levelFilter    = document.getElementById('level-filter');
  var labelFilter    = document.getElementById('label-filter');
  var queryBar       = document.getElementById('query-bar');
  var clearBtn       = document.getElementById('clear-btn');
  var settingsBtn    = document.getElementById('settings-btn');
  var settingsPanel  = document.getElementById('settings-panel');
  var sortKeysToggle = document.getElementById('sort-keys');
  var strictToggle   = document.getElementById('strict-mode');
  var autoClear      = document.getElementById('auto-clear');
  var stripTextarea  = document.getElementById('strip-textarea');
  var stripApplyBtn  = document.getElementById('strip-apply-btn');
  var stripClearBtn  = document.getElementById('strip-clear-btn');
  var stripStatus    = document.getElementById('strip-status');
  var logCount            = document.getElementById('log-count');
  var cardList            = document.getElementById('card-list');
  var panelLogLimitSel    = document.getElementById('panel-log-limit');
  var pageBufferLimitSel  = document.getElementById('page-buffer-limit');
  var cloneDepthSel       = document.getElementById('clone-depth');

  // ── Poll the page buffer directly via inspectedWindow.eval ──
  // Drain strategy: splice(0,100) destructively removes entries from the page buffer.
  // Trade-off: if DevTools closes mid-poll the ~100ms in-flight batch is lost.
  // The alternative (index pointer) would require unbounded page-side buffer growth
  // with a separate GC step — not worth the complexity. The ring buffer (5000 → 2500)
  // already caps memory; this loss window is negligible in practice.
  var pollTimer = null;

  function pollBuffer() {
    chrome.devtools.inspectedWindow.eval(
      '(function() {' +
      '  var buf = window.__consoleLensBuffer;' +
      '  if (!buf || buf.length === 0) return JSON.stringify([]);' +
      '  var batch = buf.splice(0, Math.min(buf.length, ' + CONSTANTS.POLL_BATCH + '));' +
      '  return JSON.stringify(batch);' +
      '})()',
      function (result, error) {
        var hasMore = false;
        if (!error && result) {
          try {
            var items = JSON.parse(result);
            for (var i = 0; i < items.length; i++) {
              addLog(items[i].label, items[i].data, items[i].timestamp, items[i].method, items[i].count);
            }
            hasMore = items.length >= CONSTANTS.POLL_BATCH;
          } catch (e) {
            // Parse error — skip this poll cycle
          }
        }
        // Poll faster while draining a backlog
        pollTimer = setTimeout(pollBuffer, hasMore ? CONSTANTS.POLL_FAST : CONSTANTS.POLL_IDLE);
      }
    );
  }

  pollBuffer();

  // Clear logs on page navigation if option is set; always re-inject config
  // because the page reload wipes window.__consoleLensConfig.
  chrome.devtools.network.onNavigated.addListener(function () {
    if (autoClear.checked) clearLogs();
    applyPageConfig();
  });

  // ── Event listeners ──
  var debounceTimer = null;
  function onQueryChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderAll, CONSTANTS.DEBOUNCE_QUERY);
  }

  levelFilter.addEventListener('change', onQueryChange);
  labelFilter.addEventListener('input', onQueryChange);
  queryBar.addEventListener('input', onQueryChange);
  clearBtn.addEventListener('click', clearLogs);

  // Settings panel toggle
  settingsBtn.addEventListener('click', function () {
    var willOpen = settingsPanel.hidden;
    settingsPanel.hidden = !willOpen;
    settingsBtn.classList.toggle('active', willOpen);
  });

  sortKeysToggle.addEventListener('change', function () {
    sortKeys = sortKeysToggle.checked;
    renderAll(true); // full rebuild — JSON trees need re-sorting
  });

  strictToggle.addEventListener('change', function () {
    strictMode = strictToggle.checked;
    renderAll();
  });

  stripApplyBtn.addEventListener('click', applyStrip);
  stripClearBtn.addEventListener('click', function () {
    stripTextarea.value = '';
    applyStrip();
  });

  function applyStrip() {
    var lines = stripTextarea.value
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(Boolean);
    strippedPaths = new Set(lines);
    // Show/hide clear button and status indicator
    var active = strippedPaths.size > 0;
    stripClearBtn.hidden = !active;
    stripStatus.textContent = active
      ? 'Stripping ' + strippedPaths.size + ' field' + (strippedPaths.size > 1 ? 's' : '')
      : '';
    renderAll(true); // full rebuild — JSON trees need re-stripping
  }

  // ── Configurable limits ──

  // Inject current page-side limits into the inspected page so page-script.js
  // picks them up on the next pushToBuffer call. Re-called after navigation
  // because page reloads wipe window.__consoleLensConfig.
  function applyPageConfig() {
    chrome.devtools.inspectedWindow.eval(
      'window.__consoleLensConfig = ' + JSON.stringify({
        bufferLimit:  settings.pageBufferLimit,
        bufferTrimTo: Math.floor(settings.pageBufferLimit / 2),
        maxDepth:     settings.cloneDepth,
      })
    );
  }

  function saveSettings() {
    chrome.storage.local.set({ consoleLensSettings: settings });
  }

  // Drop the oldest entries so logs[] stays within the panel limit.
  function trimLogs(limit) {
    if (limit === 0 || logs.length <= limit) return;
    var trimmed = logs.splice(0, logs.length - limit);
    for (var i = 0; i < trimmed.length; i++) delete logsById[trimmed[i].id];
    renderAll(false);
  }

  panelLogLimitSel.addEventListener('change', function () {
    settings.panelLogLimit = parseInt(this.value, 10);
    saveSettings();
    trimLogs(settings.panelLogLimit);
  });

  pageBufferLimitSel.addEventListener('change', function () {
    settings.pageBufferLimit = parseInt(this.value, 10);
    saveSettings();
    applyPageConfig();
  });

  cloneDepthSel.addEventListener('change', function () {
    settings.cloneDepth = parseInt(this.value, 10);
    saveSettings();
    applyPageConfig();
  });

  // ── Virtual scroll helpers ──

  function rebuildPrefixSum() {
    heightPrefixSum = new Array(filteredLogs.length + 1);
    heightPrefixSum[0] = 0;
    for (var i = 0; i < filteredLogs.length; i++) {
      var h = cardHeightCache[filteredLogs[i].id] || CONSTANTS.VIRT_EST_HEIGHT;
      heightPrefixSum[i + 1] = heightPrefixSum[i] + h;
    }
  }

  // Binary search: first index in filteredLogs whose bottom edge exceeds targetPx
  function findFirstIndex(targetPx) {
    var lo = 0, hi = filteredLogs.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (heightPrefixSum[mid + 1] <= targetPx) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function computeWindow() {
    var scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    var viewportH = document.documentElement.clientHeight || window.innerHeight;
    var overshoot = CONSTANTS.VIRT_OVERSCAN * CONSTANTS.VIRT_EST_HEIGHT;
    var start = Math.max(0, findFirstIndex(Math.max(0, scrollTop - overshoot)) - CONSTANTS.VIRT_OVERSCAN);
    var end   = Math.min(filteredLogs.length - 1, findFirstIndex(scrollTop + viewportH + overshoot) + CONSTANTS.VIRT_OVERSCAN);
    return { start: start, end: end };
  }

  function ensureSpacers() {
    if (!topSpacer || !topSpacer.parentNode) {
      topSpacer = document.createElement('div');
      topSpacer.className = 'virt-spacer';
      cardList.insertBefore(topSpacer, cardList.firstChild);
    }
    if (!bottomSpacer || !bottomSpacer.parentNode) {
      bottomSpacer = document.createElement('div');
      bottomSpacer.className = 'virt-spacer';
      cardList.appendChild(bottomSpacer);
    }
  }

  function updateSpacers() {
    if (!topSpacer || !bottomSpacer) return;
    var totalH  = heightPrefixSum[filteredLogs.length] || 0;
    var topH    = virtStart > 0 ? (heightPrefixSum[virtStart] || 0) : 0;
    var rendH   = virtEnd >= virtStart && virtEnd >= 0
      ? (heightPrefixSum[virtEnd + 1] - heightPrefixSum[virtStart])
      : 0;
    topSpacer.style.height    = topH + 'px';
    bottomSpacer.style.height = Math.max(0, totalH - topH - rendH) + 'px';
  }

  // Core render function for the virtual window.
  // Two-pass diff: remove cards outside [start,end], insert missing ones in order.
  function applyVirtualWindow(start, end, columns) {
    ensureSpacers();

    // Build desired window ID set
    var windowIds = new Set();
    for (var i = start; i <= end; i++) windowIds.add(filteredLogs[i].id);

    // Pass 1: remove cards outside window (static NodeList — safe mid-loop)
    var existing = cardList.querySelectorAll('.card');
    for (var c = 0; c < existing.length; c++) {
      var id = parseInt(existing[c].dataset.id, 10);
      if (!windowIds.has(id)) {
        var h = existing[c].offsetHeight + 4;
        if (h > 4) cardHeightCache[id] = h;
        if (cardResizeObs) cardResizeObs.unobserve(existing[c]);
        cardList.removeChild(existing[c]);
        renderedIds.delete(id);
      }
    }

    // Pass 2: insert missing cards in arrival order using topSpacer as anchor.
    // refNode starts at the first child after topSpacer (first card or bottomSpacer).
    // Inserting before refNode places the new card at the correct position;
    // refNode is unchanged after insertion (still the next expected sibling).
    // For already-rendered cards, we advance refNode past them.
    var refNode = topSpacer.nextSibling;
    for (var j = start; j <= end; j++) {
      var entry = filteredLogs[j];
      if (renderedIds.has(entry.id)) {
        refNode = refNode.nextSibling;
      } else {
        var newCard = buildCard(entry, columns);
        cardList.insertBefore(newCard, refNode);
        if (cardResizeObs) cardResizeObs.observe(newCard);
        renderedIds.add(entry.id);
        var measuredH = newCard.offsetHeight + 4;
        if (measuredH > 4) cardHeightCache[entry.id] = measuredH;
      }
    }

    virtStart = start;
    virtEnd   = end;
    updateSpacers();
  }

  // ── Log management ──
  function addLog(label, data, timestamp, method, count) {
    var entry = {
      id: nextId++,
      label: label,
      data: data,
      timestamp: timestamp,
      method: method || 'log',
      count: count || 1,
    };
    logs.push(entry);
    logsById[entry.id] = entry;

    // Enforce panel history limit (trim oldest if over cap)
    if (settings.panelLogLimit > 0 && logs.length > settings.panelLogLimit) {
      var oldest = logs.shift();
      delete logsById[oldest.id];
    }

    // Remove empty state on first log
    if (logs.length === 1) {
      var es = cardList.querySelector('.empty-state');
      if (es) cardList.removeChild(es);
    }

    var parsed = parseQuery(queryBar.value);
    if (!matchesFilters(entry, labelFilter.value.trim(), parsed, levelFilter.value)) {
      updateCount();
      return;
    }

    // Add to filteredLogs (always at end — logs arrive in order)
    filteredLogs.push(entry);
    heightPrefixSum.push(heightPrefixSum[heightPrefixSum.length - 1] + CONSTANTS.VIRT_EST_HEIGHT);

    var newIdx = filteredLogs.length - 1;

    // Extend the virtual window if the previous tail was rendered (user is near the bottom)
    if (newIdx === 0 || virtEnd >= newIdx - 1) {
      ensureSpacers();
      var newCard = buildCard(entry, parsed.columns);
      cardList.insertBefore(newCard, bottomSpacer);
      if (cardResizeObs) cardResizeObs.observe(newCard);
      renderedIds.add(entry.id);
      var measuredH = newCard.offsetHeight + 4;
      if (measuredH > 4) {
        cardHeightCache[entry.id] = measuredH;
        heightPrefixSum[newIdx + 1] = heightPrefixSum[newIdx] + measuredH;
      }
      virtEnd = newIdx;
    }

    updateSpacers();
    updateCount();
  }

  function clearLogs() {
    if (cardResizeObs) {
      var allCards = cardList.querySelectorAll('.card');
      for (var i = 0; i < allCards.length; i++) cardResizeObs.unobserve(allCards[i]);
    }
    logs           = [];
    logsById       = {};
    filteredLogs   = [];
    heightPrefixSum = [0];
    cardHeightCache = {};
    renderedIds    = new Set();
    lastColumns    = [];
    virtStart      = 0;
    virtEnd        = -1;
    topSpacer      = null;
    bottomSpacer   = null;
    cardList.innerHTML = '';
    updateCount();
  }

  function updateCount() {
    var total = logs.length;
    var shown = filteredLogs.length; // all entries passing the filter, not just the rendered window
    logCount.textContent =
      shown === total
        ? total + ' logs'
        : total + ' logs (showing ' + shown + ')';
  }

  // ── Query engine (parseQuery / resolve / matchesFilters) ──
  // Delegated to query-engine.js (window.ConsoleLensEngine) so the pure
  // functions can be unit-tested independently of the DevTools panel context.
  var parseQuery     = ConsoleLensEngine.parseQuery;
  var resolve        = ConsoleLensEngine.resolve;

  function matchesFilters(entry, labelText, parsed, level) {
    return ConsoleLensEngine.matchesFilters(entry, labelText, parsed, level, strictMode);
  }

  // ── Rendering ──
  // fullRebuild=true: unobserve all cards, wipe spacers, and recreate from scratch.
  //   Required when display settings change (sort-keys, strip-fields) because existing
  //   card bodies (JSON trees) would be stale.
  // fullRebuild=false (default): recompute filteredLogs, rebuild prefix sum, then call
  //   applyVirtualWindow which diffs the current window against the DOM.
  //   If columns changed, the rebuild is also forced (pill values would be stale).
  function renderAll(fullRebuild) {
    var parsed    = parseQuery(queryBar.value);
    var labelText = labelFilter.value.trim();
    var level     = levelFilter.value;

    if (logs.length === 0) {
      if (cardResizeObs) {
        var stale = cardList.querySelectorAll('.card');
        for (var s = 0; s < stale.length; s++) cardResizeObs.unobserve(stale[s]);
      }
      renderedIds     = new Set();
      filteredLogs    = [];
      heightPrefixSum = [0];
      virtStart       = 0;
      virtEnd         = -1;
      topSpacer       = null;
      bottomSpacer    = null;
      lastColumns     = [];
      cardList.innerHTML =
        '<div class="empty-state">' +
        '<h2>Console Lens</h2>' +
        '<p>Waiting for console.log calls...<br/>' +
        'Logs with format <code>console.log(\'label\', { object })</code> will appear here.</p>' +
        '</div>';
      updateCount();
      return;
    }

    var columnsChanged = parsed.columns.join('\0') !== lastColumns.join('\0');
    lastColumns = parsed.columns.slice();

    if (fullRebuild || columnsChanged) {
      // Unobserve before wiping
      if (cardResizeObs) {
        var old = cardList.querySelectorAll('.card');
        for (var o = 0; o < old.length; o++) cardResizeObs.unobserve(old[o]);
      }
      renderedIds = new Set();
      topSpacer   = null;
      bottomSpacer = null;
      cardList.innerHTML = '';
    }

    // Recompute filteredLogs and prefix sums
    var newFiltered = [];
    for (var i = 0; i < logs.length; i++) {
      if (matchesFilters(logs[i], labelText, parsed, level)) newFiltered.push(logs[i]);
    }
    filteredLogs = newFiltered;
    rebuildPrefixSum();

    var win = computeWindow();
    applyVirtualWindow(win.start, win.end, parsed.columns);
    updateCount();
  }

  function buildCard(entry, columns) {
    var card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = entry.id;

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'card-header';

    var toggle = document.createElement('span');
    toggle.className = 'card-toggle';
    toggle.textContent = '\u25B6';

    var labelEl = document.createElement('span');
    labelEl.className = 'card-label';
    labelEl.textContent = entry.label;

    var ts = document.createElement('span');
    ts.className = 'card-timestamp';
    ts.textContent = formatTime(entry.timestamp);

    header.appendChild(toggle);
    header.appendChild(labelEl);
    header.appendChild(ts);
    if (entry.count > 1) {
      var countBadge = document.createElement('span');
      countBadge.className = 'card-count';
      countBadge.textContent = '\u00d7' + entry.count;
      header.appendChild(countBadge);
    }
    header.addEventListener('click', function () {
      card.classList.toggle('expanded');
    });
    card.appendChild(header);

    // ── Column pills ──
    if (columns && columns.length > 0) {
      var pillContainer = document.createElement('div');
      pillContainer.className = 'card-columns';

      for (var c = 0; c < columns.length; c++) {
        var col = columns[c];
        var values = resolve(entry.data, col);
        if (values.length === 0) continue;

        var pill = document.createElement('span');
        pill.className = 'column-pill';

        var keySpan = document.createElement('span');
        keySpan.className = 'column-pill-key';
        keySpan.textContent = col.split('.').pop() + ':';

        var isAllNull = values.every(function (v) { return v === null; });
        var valSpan = document.createElement('span');
        valSpan.className = 'column-pill-value' + (isAllNull ? ' is-null' : '');
        valSpan.textContent = formatPillValues(values);

        pill.appendChild(keySpan);
        pill.appendChild(valSpan);
        pillContainer.appendChild(pill);
      }

      if (pillContainer.children.length > 0) card.appendChild(pillContainer);
    }

    // ── JSON body ──
    var body = document.createElement('div');
    body.className = 'card-body';
    var jsonContainer = document.createElement('div');
    jsonContainer.className = 'json-pre';
    var displayData = applyStripToData(entry.data, strippedPaths);
    jsonContainer.appendChild(buildJsonTree(displayData, 0, ''));
    body.appendChild(jsonContainer);
    card.appendChild(body);

    // ── Right-click context menu ──
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      // Remove any existing menu
      var existing = document.querySelector('.ctx-menu');
      if (existing) existing.remove();

      var menu = document.createElement('div');
      menu.className = 'ctx-menu';
      // Clamp to viewport so it doesn't go off-screen
      menu.style.top = e.clientY + 'px';
      menu.style.left = e.clientX + 'px';

      function addMenuItem(text, action) {
        var item = document.createElement('div');
        item.className = 'ctx-menu-item';
        item.textContent = text;
        item.addEventListener('click', function () {
          action();
          menu.remove();
        });
        menu.appendChild(item);
      }

      addMenuItem('Copy as JSON', function () {
        navigator.clipboard.writeText(JSON.stringify(entry.data, null, 2));
      });
      addMenuItem('Copy label', function () {
        navigator.clipboard.writeText(entry.label);
      });

      document.body.appendChild(menu);

      // Dismiss on any click outside the menu (defer to avoid catching this same event)
      setTimeout(function () {
        document.addEventListener('click', function dismiss(ev) {
          if (!menu.contains(ev.target)) {
            menu.remove();
            document.removeEventListener('click', dismiss, true);
          }
        }, true);
      }, 0);
    });

    return card;
  }

  // ── Strip helpers ──
  function applyStripToData(data, paths) {
    if (!paths || paths.size === 0) return data;
    try {
      var clone = JSON.parse(JSON.stringify(data));
      paths.forEach(function (path) {
        deleteAtPath(clone, path.split('.'));
      });
      return clone;
    } catch (e) {
      return data;
    }
  }

  function deleteAtPath(obj, segments) {
    if (!obj || typeof obj !== 'object') return;
    if (segments.length === 1) { delete obj[segments[0]]; return; }
    deleteAtPath(obj[segments[0]], segments.slice(1));
  }

  // ── JSON tree builder ──
  // Replaces the old syntaxHighlight() regex approach with a proper recursive DOM tree
  // that supports per-node collapse/expand, sort-keys, and strip-fields.
  function buildJsonTree(value, depth, path) {
    // ── Primitives (leaves) ──
    if (value === null)            return makeLeaf('null', 'json-null');
    if (typeof value === 'string') return makeLeaf('"' + escapeStr(value) + '"', 'json-string');
    if (typeof value === 'number') return makeLeaf(String(value), 'json-number');
    if (typeof value === 'boolean') return makeLeaf(String(value), 'json-boolean');
    if (typeof value !== 'object') return makeLeaf(String(value), 'json-null');

    // ── Objects and Arrays ──
    var isArr = Array.isArray(value);
    var keys = isArr ? null : Object.keys(value);
    if (keys && sortKeys) keys.sort();
    var len = isArr ? value.length : keys.length;
    var open = isArr ? '[' : '{';
    var close = isArr ? ']' : '}';

    // Empty container — no toggle, render inline
    if (len === 0) return makeLeaf(open + close, 'json-punctuation');

    // ── Collapsible node ──
    var node = document.createElement('span');
    node.className = 'json-node';

    var nodeToggle = document.createElement('span');
    nodeToggle.className = 'json-node-toggle';
    nodeToggle.textContent = '\u25BC'; // ▼

    // Summary shown when collapsed: ▶ { …5 keys }
    var summary = document.createElement('span');
    summary.className = 'json-summary';
    summary.textContent = '\u202f\u2026' + len +
      (isArr
        ? (len === 1 ? ' item' : ' items')
        : (len === 1 ? ' key' : ' keys')) +
      '\u202f' + close;

    // Children block (indented)
    var childrenEl = document.createElement('span');
    childrenEl.className = 'json-children';

    for (var i = 0; i < len; i++) {
      var entryDiv = document.createElement('div');
      entryDiv.className = 'json-entry';

      if (!isArr) {
        (function (key) {
          var keyPath = path ? path + '.' + key : key;
          var keySpan = document.createElement('span');
          keySpan.className = 'json-key';
          keySpan.textContent = '"' + key + '": ';
          keySpan.title = keyPath;
          keySpan.addEventListener('click', function (e) {
            e.stopPropagation();
            navigator.clipboard.writeText(keyPath);
            keySpan.classList.add('copied');
            setTimeout(function () { keySpan.classList.remove('copied'); }, 1200);
          });
          entryDiv.appendChild(keySpan);
          entryDiv.appendChild(buildJsonTree(value[key], depth + 1, keyPath));
        })(keys[i]);
      } else {
        entryDiv.appendChild(buildJsonTree(value[i], depth + 1, path));
      }

      if (i < len - 1) entryDiv.appendChild(makePunct(','));
      childrenEl.appendChild(entryDiv);
    }

    // Closing brace on its own line
    var closeDiv = document.createElement('div');
    closeDiv.className = 'json-close';
    closeDiv.appendChild(makePunct(close));

    // Toggle collapse/expand on click
    nodeToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var collapsed = node.classList.toggle('collapsed');
      nodeToggle.textContent = collapsed ? '\u25BA' : '\u25BC'; // ▶ or ▼
    });

    node.appendChild(nodeToggle);
    node.appendChild(makePunct(open));
    node.appendChild(summary);
    node.appendChild(childrenEl);
    node.appendChild(closeDiv);

    return node;
  }

  function makeLeaf(text, cls) {
    var span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    return span;
  }

  function makePunct(text) {
    return makeLeaf(text, 'json-punctuation');
  }

  function escapeStr(s) {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  // ── Formatting helpers ──
  function formatValue(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'object') {
      var json = JSON.stringify(val, null, 2);
      var lines = json.split('\n');
      if (lines.length <= 5) return json;
      return lines.slice(0, 5).join('\n') + '\n\u2026';
    }
    return String(val);
  }

  function formatPillValues(values) {
    if (values.length === 0) return '';
    if (values.length === 1) return formatValue(values[0]);
    if (values.length <= 3) return values.map(formatValue).join(', ');
    return values.slice(0, 3).map(formatValue).join(', ') + ' \u2026+' + (values.length - 3);
  }

  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) +
      '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  // ── Virtual scroll listener ──
  // Debounced via RAF so layout thrashing is avoided on rapid scroll events.
  window.addEventListener('scroll', function () {
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = null;
      if (filteredLogs.length === 0) return;
      var win = computeWindow();
      if (win.start !== virtStart || win.end !== virtEnd) {
        var parsed = parseQuery(queryBar.value);
        applyVirtualWindow(win.start, win.end, parsed.columns);
      }
    });
  }, { passive: true });

  // ── Keyboard shortcuts ──
  // / — focus query bar (blur if already focused)
  // Escape — clear query bar and re-render
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== queryBar) {
      e.preventDefault();
      queryBar.focus();
      queryBar.select();
    } else if (e.key === 'Escape' && document.activeElement === queryBar) {
      queryBar.value = '';
      queryBar.blur();
      renderAll();
    }
  });

  // Load persisted settings, apply page config, then show initial empty state.
  chrome.storage.local.get('consoleLensSettings', function (stored) {
    var s = stored.consoleLensSettings;
    if (s) {
      if (s.panelLogLimit  !== undefined) { settings.panelLogLimit  = s.panelLogLimit;  panelLogLimitSel.value   = String(s.panelLogLimit);  }
      if (s.pageBufferLimit !== undefined) { settings.pageBufferLimit = s.pageBufferLimit; pageBufferLimitSel.value = String(s.pageBufferLimit); }
      if (s.cloneDepth      !== undefined) { settings.cloneDepth      = s.cloneDepth;      cloneDepthSel.value      = String(s.cloneDepth);      }
    }
    applyPageConfig();
    renderAll();
  });
})();
