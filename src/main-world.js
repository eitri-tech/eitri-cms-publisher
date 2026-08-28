// Runs in the page's own JS context (world: MAIN) on VTEX CMS admin pages.
// It passively watches the editor app's own GraphQL traffic to learn the
// current builderId / documentId / documentVersionId / sections, and can
// fire a publish mutation using the page's own fetch (so session cookies
// apply exactly like a normal in-app request).
(function () {
  var STATE_KEY = '__eitriCmsState__';
  if (window[STATE_KEY]) return; // already injected (e.g. SPA re-render)

  var state = (window[STATE_KEY] = {
    lastGraphqlUrl: null,
    builderId: null,
    pageType: null,
    documentId: null,
    documentVersionId: null,
    sections: null, // wire format: [{ data: { id, name, props, errors } }]
    capturedAt: null,
  });

  function parseFromLocation() {
    var m = location.pathname.match(
      /\/admin\/(?:app\/)?new-cms\/([^/]+)\/([^/]+)\/edit\/([^/?#]+)/i
    );
    if (m) {
      state.builderId = state.builderId || m[1];
      state.pageType = m[2];
      state.documentId = state.documentId || m[3];
    }
  }
  parseFromLocation();
  window.addEventListener('popstate', parseFromLocation);

  function decodeBase64Json(b64) {
    try {
      var json = decodeURIComponent(escape(atob(b64)));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  // Shape-based detection (id + name + props/data), independent of which
  // GraphQL field name the query actually uses — we don't know that schema.
  function looksLikeSectionItem(o) {
    return (
      o &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      (typeof o.id === 'string' || typeof o.id === 'number') &&
      typeof o.name === 'string' &&
      (o.props !== undefined || o.data !== undefined)
    );
  }

  function toWireSection(o) {
    return {
      data: {
        id: String(o.id),
        name: o.name,
        props: o.props !== undefined ? o.props : o.data,
        errors: o.errors || {},
      },
    };
  }

  function deepScanForSections(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && obj.every(looksLikeSectionItem)) {
        state.sections = obj.map(toWireSection);
        state.capturedAt = Date.now();
        return;
      }
      // already-wrapped shape: [{ data: { id, name, props|data, errors } }]
      if (
        obj.length > 0 &&
        obj.every(function (it) {
          return it && it.data && looksLikeSectionItem(it.data);
        })
      ) {
        state.sections = obj.map(function (it) {
          return toWireSection(it.data);
        });
        state.capturedAt = Date.now();
        return;
      }
      for (var i = 0; i < obj.length; i++) deepScanForSections(obj[i], depth + 1);
      return;
    }
    if (typeof obj.documentVersionId === 'string') state.documentVersionId = obj.documentVersionId;
    if (typeof obj.builderId === 'string') state.builderId = obj.builderId;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var val = obj[k];
      if (Array.isArray(val) && val.length > 0 && val.every(looksLikeSectionItem)) {
        state.sections = val.map(toWireSection);
        state.capturedAt = Date.now();
        // the object holding the sections array is very likely the document
        // version itself, so its own "id" is the documentVersionId
        if (typeof obj.id === 'string' || typeof obj.id === 'number') {
          state.documentVersionId = String(obj.id);
        }
        continue;
      }
      deepScanForSections(val, depth + 1);
    }
  }

  // Trap window.__STATE__ / __APOLLO_STATE__ (VTEX render-runtime's SSR
  // Apollo cache dump used for hydration) so we see the data the instant
  // it's assigned — this data never goes through a network fetch at all,
  // so no fetch/XHR/Response hook could ever catch it otherwise.
  function trapGlobal(name) {
    try {
      var desc = Object.getOwnPropertyDescriptor(window, name);
      if (desc && !desc.configurable) return;
      var stored = desc ? desc.value : undefined;
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: function () {
          return stored;
        },
        set: function (v) {
          stored = v;
          try {
            deepScanForSections(v, 0);
          } catch (e) {}
        },
      });
    } catch (e) {}
  }
  trapGlobal('__STATE__');
  trapGlobal('__APOLLO_STATE__');

  function scan(url, reqBodyObj, resBodyObj) {
    try {
      if (url && url.indexOf('/_v/private/graphql/v1') !== -1) {
        state.lastGraphqlUrl = url;
      }
      var reqVarsB64 = reqBodyObj && reqBodyObj.extensions && reqBodyObj.extensions.variables;
      if (typeof reqVarsB64 === 'string') {
        var decoded = decodeBase64Json(reqVarsB64);
        var input = decoded && (decoded.input || decoded);
        if (input) {
          if (input.builderId) state.builderId = input.builderId;
          if (input.documentId) state.documentId = input.documentId;
          if (input.documentVersionId) state.documentVersionId = input.documentVersionId;
          if (Array.isArray(input.documentVersionSections)) {
            state.sections = input.documentVersionSections;
            state.capturedAt = Date.now();
          }
        }
      }
      if (resBodyObj) deepScanForSections(resBodyObj, 0);
    } catch (e) {
      /* ignore malformed traffic */
    }
  }

  // --- fetch hook ---
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var reqBodyObj = null;
    try {
      var bodyStr = init && init.body ? init.body : typeof input !== 'string' && input.body;
      if (typeof bodyStr === 'string') reqBodyObj = JSON.parse(bodyStr);
    } catch (e) {}
    var p = origFetch.apply(this, arguments);
    if (url.indexOf('/_v/private/graphql/v1') !== -1) {
      p.then(function (res) {
        try {
          res
            .clone()
            .text()
            .then(function (txt) {
              var resBodyObj = null;
              try {
                resBodyObj = JSON.parse(txt);
              } catch (e) {}
              scan(url, reqBodyObj, resBodyObj);
            })
            .catch(function () {});
        } catch (e) {}
      }).catch(function () {});
    }
    return p;
  };

  // --- XHR hook (fallback, in case the app uses XHR) ---
  var OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new OrigXHR();
    var _url = '';
    var _body = null;
    var origOpen = xhr.open;
    xhr.open = function (method, url) {
      _url = url;
      return origOpen.apply(xhr, arguments);
    };
    var origSend = xhr.send;
    xhr.send = function (body) {
      _body = body;
      xhr.addEventListener('load', function () {
        if (_url && _url.indexOf('/_v/private/graphql/v1') !== -1) {
          var reqBodyObj = null,
            resBodyObj = null;
          try {
            reqBodyObj = JSON.parse(_body);
          } catch (e) {}
          try {
            resBodyObj = JSON.parse(xhr.responseText);
          } catch (e) {}
          scan(_url, reqBodyObj, resBodyObj);
        }
      });
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // --- Response.prototype hook ---
  // Catches every response body regardless of which fetch() reference
  // produced it (e.g. a GraphQL client that captured `fetch` before this
  // document_start script ran would bypass the window.fetch hook above,
  // but still constructs a real Response using this realm's prototype).
  if (window.Response && window.Response.prototype.json) {
    var origResJson = window.Response.prototype.json;
    var origResText = window.Response.prototype.text;
    window.Response.prototype.json = function () {
      var self = this;
      return origResJson.call(this).then(function (data) {
        try {
          if (self.url) scanUrl(self.url);
          deepScanForSections(data, 0);
        } catch (e) {}
        return data;
      });
    };
    window.Response.prototype.text = function () {
      var self = this;
      return origResText.call(this).then(function (txt) {
        try {
          if (self.url) scanUrl(self.url);
          var data = JSON.parse(txt);
          deepScanForSections(data, 0);
        } catch (e) {}
        return txt;
      });
    };
  }
  function scanUrl(url) {
    if (url && url.indexOf('/_v/private/graphql/v1') !== -1) state.lastGraphqlUrl = url;
  }

  // Called by the popup via chrome.scripting.executeScript({world:'MAIN'}).
  // Runs the publish POST using this frame's own fetch, so the browser
  // attaches this frame's cookies exactly like a normal in-app request.
  window.__eitriCmsApply__ = function (payload) {
    var url = state.lastGraphqlUrl;
    if (!url) {
      return Promise.resolve({
        ok: false,
        error: 'Nenhuma requisição GraphQL foi capturada neste frame ainda. Recarregue a página do editor e tente de novo.',
      });
    }
    return origFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: '*/*' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {}
          return { ok: res.ok, status: res.status, body: json || text };
        });
      })
      .catch(function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      });
  };
})();
