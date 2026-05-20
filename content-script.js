// Content script: injects page-script.js into the page context.
(function () {
  'use strict';

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-script.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
})();
