// Test environment helpers: load the extension's IIFE scripts into a real
// (jsdom) DOM so the DOM-dependent adapter code runs against actual selectors,
// AG-Grid markup, hidden ArrayStore inputs, etc. — not a hand-rolled stub.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT_ROOT = path.join(__dirname, '..', '..');

function readScript(rel) {
  return fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8');
}

// jsdom performs no layout, so getClientRects()/offsetParent always report an
// element as zero-size — which would make the hearings adapter's isVisibleEl()
// treat every grid as hidden. Emulate a usable visibility model: an element is
// "visible" unless it (or an ancestor) is hidden via the `hidden` attribute or
// an inline display:none / visibility:hidden style.
function patchVisibility(w) {
  const proto = w.HTMLElement.prototype;
  function visible(el) {
    while (el && el.nodeType === 1) {
      if (el.hasAttribute && el.hasAttribute('hidden')) return false;
      const st = (el.getAttribute && el.getAttribute('style')) || '';
      if (/display\s*:\s*none/i.test(st) || /visibility\s*:\s*hidden/i.test(st)) return false;
      el = el.parentNode;
    }
    return true;
  }
  proto.getClientRects = function () {
    return visible(this) ? [{ width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20, x: 0, y: 0 }] : [];
  };
  proto.getBoundingClientRect = function () {
    const r = this.getClientRects();
    return r[0] || { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  };
}

// A minimal in-memory chrome.* stub. `store` backs chrome.storage.local.
function makeChrome(store) {
  store = store || {};
  const changeListeners = [];
  function pick(keys) {
    const out = {};
    keys.forEach((k) => { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
    return out;
  }
  return {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (_msg, cb) => { if (typeof cb === 'function') cb({ ok: true }); },
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get(key, cb) {
          let out = {};
          if (key == null) out = Object.assign({}, store);
          else if (typeof key === 'string') out = pick([key]);
          else if (Array.isArray(key)) out = pick(key);
          else if (typeof key === 'object') {
            // chrome semantics: object keys are defaults; stored values win.
            out = Object.assign({}, key, pick(Object.keys(key)));
          }
          cb(out);
        },
        set(obj, cb) {
          const changes = {};
          Object.keys(obj).forEach((k) => { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; });
          if (typeof cb === 'function') cb();
          changeListeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
        },
        remove(key, cb) {
          (Array.isArray(key) ? key : [key]).forEach((k) => { delete store[k]; });
          if (typeof cb === 'function') cb();
        },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    permissions: { request: (_opts, cb) => cb(true) },
    identity: {},
    tabs: { create: () => {} },
  };
}

// Build a jsdom window for the given HTML + URL, expose a chrome stub, and
// `eval` each extension script INSIDE that window so the IIFEs see the real
// `window`/`document`/`location`. Returns { dom, window, CD }.
function loadScripts(html, opts) {
  opts = opts || {};
  const url = opts.url || 'https://securesso.court.gov.il/Ngcs.Web.Secured/Decision/DecisionList.aspx';
  const dom = new JSDOM(html || '<!DOCTYPE html><html><head><title>נט המשפט</title></head><body></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = makeChrome(opts.store);
  // requestAnimationFrame isn't always present in jsdom; some scripts use it.
  if (!w.requestAnimationFrame) w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  patchVisibility(w);
  for (const rel of (opts.scripts || [])) {
    w.eval(readScript(rel));
  }
  return { dom, window: w, CD: w.CD };
}

// Convenience: load just the net-court documents adapter against a fixture.
function loadNetCourt(html, url) {
  const env = loadScripts(html, { url, scripts: ['content/adapters/net-court.js'] });
  return { window: env.window, adapter: env.CD.adapters['net-court'], document: env.window.document };
}

// Convenience: load the hearings adapter against a fixture.
function loadHearings(html, url) {
  const env = loadScripts(html, { url, scripts: ['content/adapters/net-court-hearings.js'] });
  return { window: env.window, adapter: env.CD.adapters['net-court-hearings'], document: env.window.document };
}

// Load a pure shared module (no DOM dependency) into a plain sandbox object
// and return its CD namespace. Used for ics-builder / csv.
function loadShared(relList, chromeStore) {
  const sandbox = {};
  sandbox.self = sandbox.window = sandbox;
  sandbox.console = console;
  if (chromeStore !== undefined) sandbox.chrome = makeChrome(chromeStore);
  const vm = require('vm');
  vm.createContext(sandbox);
  for (const rel of relList) vm.runInContext(readScript(rel), sandbox, { filename: rel });
  return sandbox.CD;
}

module.exports = { EXT_ROOT, readScript, makeChrome, loadScripts, loadNetCourt, loadHearings, loadShared };
