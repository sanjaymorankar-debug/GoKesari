/**
 * JavaScript injected into every website page the app shows: the page half of
 * the bridge (bridge.ts is the native half). It fills in what a WebView lacks
 * or gets wrong, so the website needs no app-specific code:
 *
 *   navigator.share        → the native share sheet (Android's WebView has none)
 *   navigator.geolocation  → the device's location service, one permission
 *                            prompt instead of iOS's two, and the same
 *                            behaviour on both platforms
 *   window.print()         → the native print dialog (a no-op in a WebView)
 *   links to other sites   → the browser or the right app, not inside GoKesari
 *   downloads (iOS)        → fetched with the page's session, then the share
 *                            sheet ("Save to Files", WhatsApp, print…)
 *
 * It installs only on the website's own origin, and every message carries a
 * per-launch secret: an iframe on the page (a payment widget, a map) can reach
 * `window.ReactNativeWebView` on Android but cannot read the secret, so it
 * cannot drive native features. The native side also checks the page's URL.
 *
 * Plain ES2017 in a string: Hermes does not keep function source in release
 * builds, so this cannot be written as a function and stringified.
 */
export interface BridgeScriptOptions {
  siteOrigin: string;
  token: string;
  platform: "ios" | "android";
  version: string;
}

export function buildBridgeScript({ siteOrigin, token, platform, version }: BridgeScriptOptions): string {
  return `(function () {
  "use strict";
  if (window.__gokesariApp) return;
  if (window.location.origin !== ${JSON.stringify(siteOrigin)}) return;

  var TOKEN = ${JSON.stringify(token)};
  var nextRequestId = 1;
  var nextWatchId = 1;
  var pending = {};
  var watchers = {};

  function post(message) {
    var channel = window.ReactNativeWebView;
    if (!channel || typeof channel.postMessage !== "function") return false;
    message.token = TOKEN;
    channel.postMessage(JSON.stringify(message));
    return true;
  }

  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextRequestId++;
      pending[id] = { resolve: resolve, reject: reject };
      var message = payload || {};
      message.type = type;
      message.id = id;
      if (!post(message)) {
        delete pending[id];
        reject({ name: "NotSupportedError", message: "The app bridge is not available." });
      }
    });
  }

  /* ---------------------------------------------------------------- share */

  function text(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function share(data) {
    data = data || {};
    return request("share", { title: text(data.title), text: text(data.text), url: text(data.url) }).then(
      function () {},
      function (error) {
        var name = error && error.name === "AbortError" ? "AbortError" : "NotAllowedError";
        throw new DOMException((error && error.message) || "Sharing failed.", name);
      }
    );
  }

  function canShare(data) {
    return !data || !data.files || data.files.length === 0;
  }

  /* ---------------------------------------------------------- geolocation */

  var GEO_CODES = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };

  function positionError(code, message) {
    var error = { code: code || 2, message: message || "Location unavailable." };
    for (var key in GEO_CODES) error[key] = GEO_CODES[key];
    return error;
  }

  function toPosition(fix) {
    var coords = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy == null ? 0 : fix.accuracy,
      altitude: fix.altitude == null ? null : fix.altitude,
      altitudeAccuracy: fix.altitudeAccuracy == null ? null : fix.altitudeAccuracy,
      heading: fix.heading == null || fix.heading < 0 ? null : fix.heading,
      speed: fix.speed == null || fix.speed < 0 ? null : fix.speed
    };
    coords.toJSON = function () { var copy = {}; for (var k in coords) if (k !== "toJSON") copy[k] = coords[k]; return copy; };
    return { coords: coords, timestamp: fix.timestamp || Date.now(), toJSON: function () { return { coords: coords.toJSON(), timestamp: fix.timestamp }; } };
  }

  function geoOptions(options) {
    options = options || {};
    return {
      enableHighAccuracy: Boolean(options.enableHighAccuracy),
      timeout: typeof options.timeout === "number" && isFinite(options.timeout) ? Math.max(0, options.timeout) : null,
      maximumAge: typeof options.maximumAge === "number" && isFinite(options.maximumAge) ? Math.max(0, options.maximumAge) : 0
    };
  }

  var geolocation = {
    getCurrentPosition: function (success, failure, options) {
      if (typeof success !== "function") throw new TypeError("getCurrentPosition needs a success callback.");
      request("geo.current", { options: geoOptions(options) }).then(
        function (fix) { success(toPosition(fix)); },
        function (error) { if (typeof failure === "function") failure(positionError(error && error.code, error && error.message)); }
      );
    },
    watchPosition: function (success, failure, options) {
      if (typeof success !== "function") throw new TypeError("watchPosition needs a success callback.");
      var watchId = nextWatchId++;
      watchers[watchId] = { success: success, failure: failure };
      post({ type: "geo.watch", watchId: watchId, options: geoOptions(options) });
      return watchId;
    },
    clearWatch: function (watchId) {
      if (!watchers[watchId]) return;
      delete watchers[watchId];
      post({ type: "geo.clearWatch", watchId: watchId });
    }
  };

  /* ---------------------------------------------------------------- print */

  function printableHtml() {
    var css = "";
    for (var i = 0; i < document.styleSheets.length; i++) {
      try {
        var rules = document.styleSheets[i].cssRules;
        for (var j = 0; j < rules.length; j++) css += rules[j].cssText + "\\n";
      } catch (error) {
        /* a cross-origin stylesheet: its rules cannot be read */
      }
    }
    var copy = document.documentElement.cloneNode(true);
    var drop = copy.querySelectorAll("script, noscript, link[rel='stylesheet'], style");
    for (var d = 0; d < drop.length; d++) drop[d].parentNode.removeChild(drop[d]);
    var head = copy.querySelector("head") || copy.insertBefore(document.createElement("head"), copy.firstChild);
    var base = document.createElement("base");
    base.href = window.location.href;
    head.insertBefore(base, head.firstChild);
    var style = document.createElement("style");
    style.textContent = css;
    head.appendChild(style);
    return "<!doctype html>" + copy.outerHTML;
  }

  function print() {
    request("print", { html: printableHtml(), title: document.title }).catch(function () {});
  }

  /* ------------------------------------------------------------- download */

  function filenameFrom(disposition, url) {
    var match = /filename\\*=(?:UTF-8'')?([^;]+)/i.exec(disposition || "");
    if (match) {
      try { return decodeURIComponent(match[1].trim().replace(/^"|"$/g, "")); } catch (error) { /* fall through */ }
    }
    match = /filename="?([^";]+)"?/i.exec(disposition || "");
    if (match) return match[1].trim();
    var last = url.split("#")[0].split("?")[0].split("/").pop();
    return last || "download";
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { var result = String(reader.result); resolve(result.slice(result.indexOf(",") + 1)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function download(url) {
    fetch(url, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("The file could not be downloaded (" + response.status + ").");
        var filename = filenameFrom(response.headers.get("content-disposition"), url);
        var mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
        return response.blob().then(blobToBase64).then(function (base64) {
          return request("saveFile", { filename: filename, mimeType: mimeType, base64: base64 });
        });
      })
      .catch(function (error) {
        post({ type: "downloadFailed", message: String((error && error.message) || error) });
      });
  }

  /* ---------------------------------------------------- links to elsewhere */

  // Bubble phase on document: React's own handlers (on the root element) run
  // first, so a link the website handles itself has defaultPrevented set.
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) return;
    var href = anchor.href;
    if (!/^https?:/i.test(href)) return;
    var origin;
    try { origin = new URL(href).origin; } catch (error) { return; }
    if (origin === window.location.origin) return;
    event.preventDefault();
    post({ type: "openExternal", url: href });
  });

  /* ------------------------------------------------- messages from native */

  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "reply") {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) waiting.reject(message.error);
      else waiting.resolve(message.result);
    } else if (message.type === "position") {
      var watcher = watchers[message.watchId];
      if (!watcher) return;
      if (message.error) {
        if (typeof watcher.failure === "function") watcher.failure(positionError(message.error.code, message.error.message));
      } else {
        watcher.success(toPosition(message.fix));
      }
    } else if (message.type === "download" && typeof message.url === "string") {
      download(message.url);
    }
  }

  /* -------------------------------------------------------------- install */

  var app = {
    platform: ${JSON.stringify(platform)},
    version: ${JSON.stringify(version)},
    signInWithGoogle: function () { return request("signInWithGoogle", {}); },
    receive: receive
  };
  Object.defineProperty(window, "__gokesariApp", { value: app });

  function define(target, name, value) {
    try {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, writable: true, value: value });
    } catch (error) {
      /* leave the WebView's own version in place */
    }
  }
  define(navigator, "share", share);
  define(navigator, "canShare", canShare);
  try {
    Object.defineProperty(navigator, "geolocation", { configurable: true, enumerable: true, get: function () { return geolocation; } });
  } catch (error) {
    /* keep the WebView's geolocation */
  }
  define(window, "print", print);

  // A new page: native drops location watches the previous page left running.
  if (!post({ type: "hello" })) {
    document.addEventListener("DOMContentLoaded", function () { post({ type: "hello" }); });
  }
})();
true;`;
}
