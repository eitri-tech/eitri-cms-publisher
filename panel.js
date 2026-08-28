'use strict';

var PERSISTED_QUERY = {
  version: 1,
  sha256Hash: '71b61575b97541db1619d22546a0817b6b659c4fb1f35bbb2dcab111c9b23405',
  sender: 'vtex.admin-cms@1.x',
  provider: 'vtex.admin-cms-graphql-rc@1.x',
};

var el = {};
[
  'status-pill', 'not-supported', 'main-content',
  'builderId', 'pageType', 'documentId', 'documentVersionId',
  'reload-sync', 'capture-info',
  'current-count', 'current-list',
  'export-json', 'export-feedback',
  'json-input', 'json-error',
  'apply', 'log',
].forEach(function (id) {
  el[id] = document.getElementById(id);
});

var activeTab = null;
var lastState = null;
var primaryFrameId = null; // frame whose sniffer actually captured GraphQL traffic

function setPill(kind, text) {
  el['status-pill'].className = 'pill pill-' + kind;
  el['status-pill'].textContent = text;
}

function log(msg) {
  var ts = new Date().toLocaleTimeString();
  el.log.textContent = '[' + ts + '] ' + msg + '\n' + el.log.textContent;
}

function isSupportedUrl(url) {
  try {
    var u = new URL(url);
    return /\.myvtex\.com$/i.test(u.hostname) && /\/admin\/(?:app\/)?new-cms\//i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function renderState(state) {
  lastState = state;
  el.builderId.value = state.builderId || '';
  el.pageType.value = state.pageType || '';
  el.documentId.value = state.documentId || '';
  el.documentVersionId.value = state.documentVersionId || '';

  var sections = state.sections || [];
  el['current-count'].textContent = String(sections.length);
  el['current-list'].innerHTML = '';
  sections.forEach(function (s) {
    var li = document.createElement('li');
    li.textContent = (s && s.data && s.data.name) || '(sem nome)';
    el['current-list'].appendChild(li);
  });

  el['export-json'].disabled = sections.length === 0;
  el['export-feedback'].textContent = '';

  if (state.capturedAt) {
    el['capture-info'].textContent =
      'sections capturadas às ' + new Date(state.capturedAt).toLocaleTimeString();
  } else {
    el['capture-info'].textContent = sections.length
      ? ''
      : 'nenhuma section capturada ainda — recarregue a página do editor';
  }

  if (state.documentId && state.documentVersionId) {
    setPill('ok', 'pronto');
  } else if (state.documentId) {
    setPill('warn', 'faltando documentVersionId');
  } else {
    setPill('warn', 'aguardando dados');
  }
}

// The CMS editor renders inside a same-origin iframe, so the frame that
// actually captures GraphQL traffic isn't the tab's top frame. We read
// window.__eitriCmsState__ (set by src/main-world.js) from every frame and
// keep whichever one actually has data.
function scoreState(s) {
  if (!s) return -1;
  return (s.sections ? 2 : 0) + (s.lastGraphqlUrl ? 1 : 0);
}

function readStateFromAllFrames() {
  return chrome.scripting
    .executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      world: 'MAIN',
      func: function () {
        return window.__eitriCmsState__ || null;
      },
    })
    .then(function (results) {
      var best = null;
      var bestFrameId = null;
      (results || []).forEach(function (r) {
        if (scoreState(r.result) > scoreState(best)) {
          best = r.result;
          bestFrameId = r.frameId;
        }
      });
      primaryFrameId = bestFrameId;
      return best;
    });
}

function requestState() {
  return readStateFromAllFrames().then(function (state) {
    if (state) renderState(state);
    return state;
  });
}

function runApply(payload) {
  if (primaryFrameId == null) {
    return Promise.resolve({
      ok: false,
      error: 'Nenhum frame com dados capturados ainda. Clique em "Recarregar página & sincronizar" primeiro.',
    });
  }
  return chrome.scripting
    .executeScript({
      target: { tabId: activeTab.id, frameIds: [primaryFrameId] },
      world: 'MAIN',
      func: function (p) {
        return window.__eitriCmsApply__
          ? window.__eitriCmsApply__(p)
          : { ok: false, error: 'Sniffer não carregado neste frame.' };
      },
      args: [payload],
    })
    .then(function (results) {
      return results && results[0] && results[0].result;
    });
}

function waitForTabComplete(tabId) {
  return new Promise(function (resolve) {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // give the SPA a moment to fire its own GraphQL calls after load
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function normalizeInputSections(parsed) {
  var arr;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && Array.isArray(parsed.sections)) {
    arr = parsed.sections;
  } else {
    throw new Error('JSON inválido: esperado um array de sections, ou um objeto com a chave "sections".');
  }

  var baseTs = Date.now();
  return arr.map(function (s, i) {
    if (!s || typeof s !== 'object') {
      throw new Error('Section #' + (i + 1) + ' inválida.');
    }
    // Already-wrapped shape: { data: { id, name, props, errors } }
    if (s.data && typeof s.data === 'object' && s.data.name && s.data.props !== undefined) {
      return {
        data: {
          id: String(s.data.id != null ? s.data.id : baseTs + i),
          name: s.data.name,
          props: s.data.props,
          errors: s.data.errors || {},
        },
      };
    }
    // Friendly shape: { id?, name, data } or { id?, name, props }
    var name = s.name;
    var props = s.data !== undefined ? s.data : s.props;
    if (!name || props === undefined) {
      throw new Error('Section #' + (i + 1) + ' inválida: precisa ter "name" e "data"/"props".');
    }
    return {
      data: {
        id: String(s.id != null ? s.id : baseTs + i),
        name: name,
        props: props,
        errors: {},
      },
    };
  });
}

function sectionsToFriendly(wireSections) {
  return wireSections.map(function (s) {
    var d = s.data || s;
    return { name: d.name, data: d.props };
  });
}

function buildPayload(builderId, documentId, documentVersionId, sections) {
  var variablesJson = JSON.stringify({
    input: {
      builderId: builderId,
      documentId: documentId,
      documentVersionId: documentVersionId,
      documentVersionSections: sections,
      documentVersionConfigurationDataSet: [],
    },
  });
  var b64 = btoa(unescape(encodeURIComponent(variablesJson)));
  return {
    operationName: 'PublishByReleases',
    variables: {},
    extensions: {
      persistedQuery: PERSISTED_QUERY,
      variables: b64,
    },
  };
}

function syncWithTab(tab) {
  activeTab = tab;
  lastState = null;
  primaryFrameId = null;

  if (!activeTab || !isSupportedUrl(activeTab.url || '')) {
    setPill('err', 'página não suportada');
    el['not-supported'].classList.remove('hidden');
    el['main-content'].classList.add('hidden');
    return;
  }
  el['not-supported'].classList.add('hidden');
  el['main-content'].classList.remove('hidden');

  requestState().catch(function (err) {
    setPill('err', 'sem conexão com a página');
    log('Não foi possível falar com o content script: ' + err.message + '. Recarregue a aba.');
  });
}

function init() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    syncWithTab(tabs[0]);
  });

  chrome.tabs.onActivated.addListener(function (activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function (tab) {
      syncWithTab(tab);
    });
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (activeTab && tabId === activeTab.id && changeInfo.url) {
      syncWithTab(tab);
    }
  });
}

el['reload-sync'].addEventListener('click', function () {
  if (!activeTab) return;
  el['reload-sync'].disabled = true;
  el['capture-info'].textContent = 'recarregando…';
  var tabId = activeTab.id;
  chrome.tabs.reload(tabId);
  waitForTabComplete(tabId).then(function () {
    return requestState();
  }).then(function () {
    el['reload-sync'].disabled = false;
    log('Sincronizado após recarregar a página.');
  }).catch(function (err) {
    el['reload-sync'].disabled = false;
    log('Falha ao sincronizar: ' + err.message);
  });
});

el['export-json'].addEventListener('click', function () {
  if (!lastState || !lastState.sections || lastState.sections.length === 0) return;
  var friendly = sectionsToFriendly(lastState.sections);
  var json = JSON.stringify(friendly, null, 2);
  navigator.clipboard.writeText(json).then(function () {
    el['export-feedback'].textContent = 'Copiado!';
    el['export-feedback'].className = 'hint export-ok';
    setTimeout(function () {
      el['export-feedback'].textContent = '';
      el['export-feedback'].className = 'hint';
    }, 2000);
    log('JSON exportado (' + friendly.length + ' sections) copiado para clipboard.');
  }).catch(function (err) {
    el['export-feedback'].textContent = 'Falha ao copiar';
    el['export-feedback'].className = 'hint error';
    log('Falha ao copiar para clipboard: ' + err.message);
  });
});

el.apply.addEventListener('click', function () {
  el['json-error'].classList.add('hidden');

  var builderId = el.builderId.value.trim();
  var documentId = el.documentId.value.trim();
  var documentVersionId = el.documentVersionId.value.trim();
  var mode = document.querySelector('input[name="mode"]:checked').value;

  if (!builderId || !documentId || !documentVersionId) {
    el['json-error'].textContent = 'Preencha builderId, documentId e documentVersionId (recarregue a página se estiverem vazios).';
    el['json-error'].classList.remove('hidden');
    return;
  }

  var parsed;
  try {
    parsed = JSON.parse(el['json-input'].value);
  } catch (e) {
    el['json-error'].textContent = 'JSON inválido: ' + e.message;
    el['json-error'].classList.remove('hidden');
    return;
  }

  var inputSections;
  try {
    inputSections = normalizeInputSections(parsed);
  } catch (e) {
    el['json-error'].textContent = e.message;
    el['json-error'].classList.remove('hidden');
    return;
  }

  var currentSections = (lastState && lastState.sections) || [];
  var finalSections = mode === 'ADD' ? currentSections.concat(inputSections) : inputSections;

  var summary =
    'Modo ' + mode + '. Resultado: ' + finalSections.length + ' section(s) em documentId ' +
    documentId + ' (builderId ' + builderId + ').' +
    (mode === 'REPLACE' ? ' Isso substitui TODAS as sections publicadas atualmente.' : '');

  if (!window.confirm(summary + '\n\nConfirma a publicação agora?')) {
    log('Publicação cancelada pelo usuário.');
    return;
  }

  var payload = buildPayload(builderId, documentId, documentVersionId, finalSections);

  el.apply.disabled = true;
  log('Enviando ' + mode + ' com ' + finalSections.length + ' section(s)...');

  runApply(payload)
    .then(function (res) {
      el.apply.disabled = false;
      if (res && res.ok) {
        log('OK (status ' + res.status + '): ' + JSON.stringify(res.body));
        requestState().catch(function () {});
      } else {
        log('Falha: ' + JSON.stringify(res));
      }
    })
    .catch(function (err) {
      el.apply.disabled = false;
      log('Erro ao aplicar: ' + err.message);
    });
});

init();
