'use strict';

var UPDATE_REPO = 'eitri-tech/eitri-cms-publisher';
var UPDATE_DB = 'eitri-cms-publisher';
var UPDATE_STORE = 'handles';

var upd = {
  banner: document.getElementById('update-banner'),
  btnApply: document.getElementById('update-apply'),
  msg: document.getElementById('update-msg'),
  link: document.getElementById('update-link'),
};
var latestRelease = null;

function parseVersion(tag) {
  return String(tag).replace(/^v/i, '').split('.').map(function (n) {
    return parseInt(n, 10) || 0;
  });
}

function isNewer(remote, local) {
  var a = parseVersion(remote);
  var b = parseVersion(local);
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    var x = a[i] || 0;
    var y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function setUpdateMsg(text) {
  upd.msg.textContent = text;
}

// The folder handle is persisted so the user only authorizes the extension folder once.
function openHandleDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(UPDATE_DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(UPDATE_STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function handleDbOp(mode, fn) {
  return openHandleDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(UPDATE_STORE, mode);
      var req = fn(tx.objectStore(UPDATE_STORE));
      tx.oncomplete = function () { resolve(req.result); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function loadHandle() {
  return handleDbOp('readonly', function (s) { return s.get('dir'); }).catch(function () { return null; });
}

function saveHandle(h) {
  return handleDbOp('readwrite', function (s) { return s.put(h, 'dir'); });
}

function clearHandle() {
  return handleDbOp('readwrite', function (s) { return s.delete('dir'); }).catch(function () {});
}

// Must run straight from the click handler (user activation is required by both
// requestPermission and showDirectoryPicker).
function getWritableDir() {
  return loadHandle().then(function (saved) {
    if (!saved) return pickDir();
    return saved.requestPermission({ mode: 'readwrite' }).then(function (p) {
      return p === 'granted' ? saved : pickDir();
    });
  });
}

function pickDir() {
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

// Guards against the user picking an unrelated folder that we would then overwrite.
function verifyExtensionDir(dir) {
  return dir.getFileHandle('manifest.json')
    .then(function (fh) { return fh.getFile(); })
    .then(function (f) { return f.text(); })
    .then(function (txt) {
      var m = JSON.parse(txt);
      if (m.name !== chrome.runtime.getManifest().name) throw new Error('wrong-folder');
    })
    .catch(function () {
      return clearHandle().then(function () {
        throw new Error('Pasta incorreta: selecione a pasta onde a extensão está carregada (a que contém o manifest.json).');
      });
    });
}

function inflateRaw(bytes) {
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}

// Minimal zip reader driven by the central directory (no dependencies allowed).
function unzip(buf) {
  var view = new DataView(buf);
  var bytes = new Uint8Array(buf);
  var eocd = -1;
  for (var i = buf.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip inválido');
  var count = view.getUint16(eocd + 10, true);
  var pos = view.getUint32(eocd + 16, true);
  var decoder = new TextDecoder();
  var jobs = [];

  for (var n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('zip corrompido');
    var method = view.getUint16(pos + 10, true);
    var compSize = view.getUint32(pos + 20, true);
    var nameLen = view.getUint16(pos + 28, true);
    var extraLen = view.getUint16(pos + 30, true);
    var commentLen = view.getUint16(pos + 32, true);
    var localOff = view.getUint32(pos + 42, true);
    var name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.slice(-1) === '/') continue;
    if (name.charAt(0) === '/' || name.indexOf('\\') >= 0 || name.split('/').indexOf('..') >= 0) {
      throw new Error('caminho inválido no zip: ' + name);
    }
    var dataStart = localOff + 30 + view.getUint16(localOff + 26, true) + view.getUint16(localOff + 28, true);
    jobs.push({ name: name, method: method, data: bytes.subarray(dataStart, dataStart + compSize) });
  }

  return Promise.all(jobs.map(function (j) {
    if (j.method === 0) return { name: j.name, data: j.data };
    if (j.method !== 8) throw new Error('compressão não suportada: ' + j.name);
    return inflateRaw(j.data).then(function (d) { return { name: j.name, data: d }; });
  }));
}

function writeFileAt(root, path, data) {
  var parts = path.split('/');
  var file = parts.pop();
  var chain = Promise.resolve(root);
  parts.forEach(function (p) {
    chain = chain.then(function (d) { return d.getDirectoryHandle(p, { create: true }); });
  });
  return chain
    .then(function (d) { return d.getFileHandle(file, { create: true }); })
    .then(function (fh) { return fh.createWritable(); })
    .then(function (w) { return w.write(data).then(function () { return w.close(); }); });
}

// Runs silently on open: the banner only appears when a newer release exists.
function checkForUpdate() {
  return fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then(function (r) {
      if (!r.ok) throw new Error('GitHub respondeu ' + r.status);
      return r.json();
    })
    .then(function (rel) {
      var current = chrome.runtime.getManifest().version;
      if (!isNewer(rel.tag_name, current)) return;
      latestRelease = rel;
      setUpdateMsg('Nova versão ' + rel.tag_name + ' disponível.');
      upd.link.href = rel.html_url;
      upd.banner.classList.remove('hidden');
    })
    .catch(function () {});
}

function applyUpdate() {
  if (!latestRelease) return;
  var asset = (latestRelease.assets || []).filter(function (a) { return /\.zip$/i.test(a.name); })[0];
  if (!asset) {
    setUpdateMsg('Este release não tem um .zip anexado.');
    return;
  }
  if (!window.showDirectoryPicker) {
    setUpdateMsg('Este navegador não suporta atualização automática. Use o link para baixar o zip.');
    return;
  }
  upd.btnApply.disabled = true;
  var dirHandle;
  getWritableDir()
    .then(function (dir) {
      dirHandle = dir;
      return verifyExtensionDir(dir);
    })
    .then(function () { return saveHandle(dirHandle); })
    .then(function () {
      setUpdateMsg('baixando ' + asset.name + '…');
      return fetch(asset.browser_download_url);
    })
    .then(function (r) {
      if (!r.ok) throw new Error('download falhou (' + r.status + ')');
      return r.arrayBuffer();
    })
    .then(unzip)
    .then(function (files) {
      if (!files.some(function (f) { return f.name === 'manifest.json'; })) {
        throw new Error('zip sem manifest.json');
      }
      setUpdateMsg('gravando ' + files.length + ' arquivos…');
      // manifest.json goes last so an interrupted update never advertises a version it did not finish.
      files.sort(function (a, b) {
        return (a.name === 'manifest.json') - (b.name === 'manifest.json');
      });
      return files.reduce(function (p, f) {
        return p.then(function () { return writeFileAt(dirHandle, f.name, f.data); });
      }, Promise.resolve());
    })
    .then(function () {
      setUpdateMsg('Atualizado! Recarregando a extensão…');
      setTimeout(function () { chrome.runtime.reload(); }, 600);
    })
    .catch(function (e) {
      if (e && e.name === 'AbortError') setUpdateMsg('Seleção de pasta cancelada.');
      else setUpdateMsg('Erro ao atualizar: ' + e.message);
      upd.btnApply.disabled = false;
    });
}

upd.btnApply.addEventListener('click', applyUpdate);
document.getElementById('update-version').textContent = 'v' + chrome.runtime.getManifest().version;
checkForUpdate();
