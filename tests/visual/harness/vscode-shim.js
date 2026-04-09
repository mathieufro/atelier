// VS Code API shim for visual testing
// Provides the same postMessage API that the real VS Code webview uses

window.__testOutbox = [];
window.__testState = {};

window.acquireVsCodeApi = function() {
  return {
    postMessage: function(msg) { window.__testOutbox.push(msg); },
    getState: function() { return window.__testState || {}; },
    setState: function(s) { window.__testState = s; },
  };
};

window.__injectMessage = function(msg) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
};
