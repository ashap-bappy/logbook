/* ============================================================
   SYNC — a JSON file in a private GitHub repo is the store.
   localStorage is only a cache plus the token; the file is truth.
   Merge is field-level, so two devices can both write.
   ============================================================ */
window.Sync = (function () {
  'use strict';

  var CFGKEY = 'hr936.sync.v1';
  var API = 'https://api.github.com';
  var cfg = null, sha = null, timer = null, busy = false, pending = false;
  var status = 'off', statusMsg = '', lastAt = null, listeners = [];
  var host = null;   // { get, set, saveLocal }

  /* ---------- config ---------- */
  function readCfg() {
    try { return JSON.parse(localStorage.getItem(CFGKEY) || 'null'); }
    catch (e) { return null; }
  }
  function writeCfg(c) {
    try {
      if (c) localStorage.setItem(CFGKEY, JSON.stringify(c));
      else localStorage.removeItem(CFGKEY);
    } catch (e) { /* storage blocked — session only */ }
    cfg = c; sha = null;
  }

  /* ---------- utf-8 safe base64 ---------- */
  function enc(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function dec(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function setStatus(s, msg) {
    status = s; statusMsg = msg || '';
    listeners.forEach(function (fn) { try { fn(s, msg, lastAt); } catch (e) {} });
  }

  /* ---------- merge ----------
     Scalars follow the most recently written side.
     Weeks resolve per week. Entries union by id, newest wins,
     and deletes are tombstones so they survive the union.        */
  function merge(a, b) {
    a = a || {}; b = b || {};
    var an = a.updatedAt || 0, bn = b.updatedAt || 0, newer = an >= bn ? a : b;
    var out = {
      deviceId: a.deviceId || b.deviceId,
      startDate: newer.startDate || a.startDate || b.startDate,
      planWeek: newer.planWeek || a.planWeek || b.planWeek || 1,
      updatedAt: Math.max(an, bn),
      weeks: {}, entries: []
    };
    var aw = a.weeks || {}, bw = b.weeks || {}, seen = {};
    Object.keys(aw).concat(Object.keys(bw)).forEach(function (k) {
      if (seen[k]) return; seen[k] = 1;
      var x = aw[k], y = bw[k];
      if (!x) { out.weeks[k] = y; return; }
      if (!y) { out.weeks[k] = x; return; }
      out.weeks[k] = (x.updatedAt || 0) >= (y.updatedAt || 0) ? x : y;
    });
    var map = {};
    (a.entries || []).concat(b.entries || []).forEach(function (e) {
      if (!e || !e.id) return;
      var prev = map[e.id];
      if (!prev || (e.updatedAt || 0) > (prev.updatedAt || 0)) map[e.id] = e;
    });
    Object.keys(map).forEach(function (k) { out.entries.push(map[k]); });
    return out;
  }

  /* ---------- transport ---------- */
  function url() {
    return API + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
           '/contents/' + cfg.path.split('/').map(encodeURIComponent).join('/');
  }
  function headers() {
    return {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }
  function explain(res) {
    if (res.status === 401) return 'Token rejected. It may have expired or been revoked.';
    if (res.status === 403) return 'Access refused. Check the token has Contents: Read and write on this repo.';
    if (res.status === 404) return 'Repo or branch not found. Check owner, repo and branch — and that the token can see it.';
    if (res.status === 409) return 'Conflict — another device wrote first. Retrying.';
    if (res.status === 422) return 'GitHub rejected the write. Check the branch name.';
    return 'GitHub returned ' + res.status + '.';
  }

  function pull() {
    var u = url() + '?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now();
    return fetch(u, { headers: headers(), cache: 'no-store' }).then(function (res) {
      if (res.status === 404) { sha = null; return null; }        // first run
      if (!res.ok) throw new Error(explain(res));
      return res.json().then(function (j) {
        sha = j.sha;
        try { return JSON.parse(dec(j.content)); }
        catch (e) { throw new Error('The remote file is not valid JSON. Fix or delete it in GitHub.'); }
      });
    });
  }

  function push(state) {
    var body = {
      message: 'logbook ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
      content: enc(JSON.stringify(state, null, 1)),
      branch: cfg.branch
    };
    if (sha) body.sha = sha;
    return fetch(url(), { method: 'PUT', headers: headers(), body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) throw new Error(explain(res));
        return res.json().then(function (j) { sha = j.content && j.content.sha; return true; });
      });
  }

  /* ---------- the one operation: pull, merge, push ---------- */
  function run() {
    if (!cfg) return Promise.resolve();
    if (busy) { pending = true; return Promise.resolve(); }
    busy = true; setStatus('syncing');
    return pull()
      .then(function (remote) {
        var merged = remote ? merge(host.get(), remote) : host.get();
        host.set(merged);
        host.saveLocal();
        return push(merged);
      })
      .then(function () {
        lastAt = Date.now(); busy = false;
        setStatus('idle');
        if (pending) { pending = false; return run(); }
      })
      .catch(function (err) {
        busy = false; pending = false;
        var offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        setStatus(offline ? 'offline' : 'error',
          offline ? 'No connection. Changes are saved here and will sync later.' : err.message);
      });
  }

  function schedule() {
    if (!cfg) return;
    clearTimeout(timer);
    setStatus('pending');
    timer = setTimeout(run, 2500);
  }

  return {
    init: function (h) {
      host = h; cfg = readCfg();
      if (cfg) { setStatus('idle'); run(); } else setStatus('off');
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', function () { if (cfg) run(); });
      }
    },
    config: function () { return cfg ? JSON.parse(JSON.stringify(cfg)) : null; },
    connect: function (c) {
      writeCfg({
        owner: c.owner.trim(), repo: c.repo.trim(),
        path: (c.path || 'logbook.json').trim().replace(/^\/+/, ''),
        branch: (c.branch || 'main').trim(), token: c.token.trim()
      });
      return run();
    },
    disconnect: function () { clearTimeout(timer); writeCfg(null); setStatus('off'); },
    now: run,
    schedule: schedule,
    isOn: function () { return !!cfg; },
    status: function () { return { state: status, msg: statusMsg, at: lastAt }; },
    onStatus: function (fn) { listeners.push(fn); },
    merge: merge
  };
})();
