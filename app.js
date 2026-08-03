/* ============================================================
   THE 1,000-HOUR YEAR — logbook
   State is kept in localStorage under one namespaced key.
   Every storage call is wrapped: if storage is unavailable the
   page still renders, it just won't remember anything.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'hr936.logbook.v1';
  var M = ROADMAP.meta, T = M.targets, BUCKETS = M.buckets;

  /* ---------- storage ---------- */
  var storageOK = true;
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function blank() {
    return { startDate: today(), planWeek: 1, weeks: {}, entries: [],
             deviceId: uid(), updatedAt: 0 };
  }
  /* older saves used per-device integer ids, which would collide across
     devices once syncing; rewrite them to globally unique ones. */
  function migrate(s) {
    s.deviceId = s.deviceId || uid();
    if (s.updatedAt == null) {
      var hasData = (s.entries && s.entries.length) ||
                    (s.weeks && Object.keys(s.weeks).length);
      s.updatedAt = hasData ? Date.now() : 0;   // empty state must never win a merge
    }
    (s.entries || []).forEach(function (e) {
      if (typeof e.id !== 'string') e.id = 'm' + e.id + '-' + s.deviceId;
      if (!e.updatedAt) e.updatedAt = s.updatedAt;
    });
    Object.keys(s.weeks || {}).forEach(function (k) {
      if (!s.weeks[k].updatedAt) s.weeks[k].updatedAt = s.updatedAt;
    });
    delete s.seq;
    return s;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return blank();
      s.weeks = s.weeks || {}; s.entries = s.entries || [];
      s.planWeek = clamp(s.planWeek || 1, 1, 52);
      s.startDate = s.startDate || today();
      return migrate(s);
    } catch (e) { storageOK = false; return blank(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) {
      if (storageOK) { storageOK = false; note('Storage is unavailable here — this session will not be saved.'); }
    }
  }

  var S = load();
  var view = S.planWeek;          // week currently on screen
  var draft = { bucket: 'build' };

  /* every mutation stamps a time so the merge can resolve it */
  function touch(n) {
    S.updatedAt = Date.now();
    if (n) week(n).updatedAt = S.updatedAt;
    save();
    if (window.Sync) Sync.schedule();
  }
  function live() { return S.entries.filter(function (e) { return !e.del; }); }

  /* ---------- date helpers ---------- */
  function today() { return iso(new Date()); }
  function iso(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dayDiff(a, b) { return Math.round((parse(a) - parse(b)) / 86400000); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function fmtDay(s) {
    var d = parse(s), mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return pad(d.getDate()) + ' ' + mo[d.getMonth()];
  }
  function fmtFull(s) {
    var d = parse(s), mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return pad(d.getDate()) + ' ' + mo[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* ---------- derived ---------- */
  function week(n) {
    var w = S.weeks[n];
    if (!w) { w = { gates: [false, false, false], writeup: '', endorsedAt: null }; S.weeks[n] = w; }
    if (!w.gates) w.gates = [false, false, false];
    return w;
  }
  function isDone(n) { return !!(S.weeks[n] && S.weeks[n].endorsedAt); }
  function calWeek() { return clamp(Math.floor(dayDiff(today(), S.startDate) / 7) + 1, 1, 52); }
  function slackUsed() { return Math.max(0, calWeek() - S.planWeek); }
  function totalHours() {
    return live().reduce(function (s, e) { return s + e.hours; }, 0);
  }
  function weekHours(n) {
    var out = { study: 0, build: 0, drip: 0, consolidate: 0, total: 0 };
    live().forEach(function (e) {
      if (e.week === n) { out[e.bucket] = (out[e.bucket] || 0) + e.hours; out.total += e.hours; }
    });
    return out;
  }
  /* Rest-day-aware: the plan targets 6 days a week, so one gap is fine.
     The streak only breaks on two consecutive empty days. */
  function streak() {
    var days = {};
    live().forEach(function (e) { days[e.date] = true; });
    var d = new Date(), count = 0, gap = 0;
    for (var i = 0; i < 400; i++) {
      var k = iso(d);
      if (days[k]) { count++; gap = 0; }
      else {
        gap++;
        if (gap >= 2) break;
        if (i === 0) gap = 0;           // today not logged yet is not a gap
      }
      d.setDate(d.getDate() - 1);
    }
    return count;
  }
  function writeups() {
    return Object.keys(S.weeks)
      .filter(function (n) { return (S.weeks[n].writeup || '').trim(); })
      .map(Number).sort(function (a, b) { return a - b; });
  }
  function qOf(n) { return ROADMAP.weeks[n - 1].q; }
  function quarter(n) { return ROADMAP.quarters[qOf(n) - 1]; }


  /* ============================================================
     THE SIX-DAY RHYTHM
     Blocks sum to exactly 5 study / 9 build / 2 drip / 2 consolidate.
     Days map onto the week's own gates: read it, build it, prove it.
     ============================================================ */
  var RHYTHM = {
    normal: [
      { label: 'Orient',       gate: 0,
        purpose: 'Read the Learn material and scope what you are going to build. End the day knowing what you will type tomorrow.',
        blocks: [['study', 2], ['build', 1]] },
      { label: 'Go deep',      gate: 0,
        purpose: 'Finish the reading. Take notes you could teach from — if you cannot explain it, you have not read it.',
        blocks: [['study', 2], ['build', 1]] },
      { label: 'Build',        gate: 1,
        purpose: 'Heads down. Get the first version working end to end, however ugly.',
        blocks: [['study', 0.5], ['build', 2.5]] },
      { label: 'Build harder', gate: 1,
        purpose: 'Push it to something you would show a colleague. Then break it on purpose and watch what happens.',
        blocks: [['build', 3]] },
      { label: 'Prove it',     gate: 2,
        purpose: 'Satisfy the Done-when line. Measure it — do not assume it. Numbers before, numbers after.',
        blocks: [['study', 0.5], ['build', 1.5], ['consolidate', 1]] },
      { label: 'Drip & write', gate: null,
        purpose: 'Two hours on the drip below, then write the week up. This is the day that gets skipped. Do not skip it.',
        blocks: [['drip', 2], ['consolidate', 1]] }
    ],
    checkpoint: [
      { label: 'Work it',   gate: 0,
        purpose: 'Start the quarter\u2019s exercises. Timed and written, not in your head.',
        blocks: [['study', 0.5], ['build', 2.5]] },
      { label: 'Work it',   gate: 0,
        purpose: 'Keep going. Volume matters this week — this is where the quarter gets consolidated.',
        blocks: [['build', 3]] },
      { label: 'Work it',   gate: 0,
        purpose: 'Finish the set. Note every question you fumbled.',
        blocks: [['study', 0.5], ['build', 2.5]] },
      { label: 'Assess',    gate: 2,
        purpose: 'The checkpoint question, answered honestly. A failed check ride means a slack week, not a disaster.',
        blocks: [['study', 2], ['consolidate', 1]] },
      { label: 'Publish',   gate: 1,
        purpose: 'Write the quarter up properly and put it somewhere public.',
        blocks: [['build', 1], ['consolidate', 1], ['drip', 1]] },
      { label: 'Reset',     gate: null,
        purpose: 'Mocks, review, and decide what the next quarter needs from you.',
        blocks: [['study', 2], ['drip', 1]] }
    ]
  };

  function dayPlan(n) {
    return RHYTHM[ROADMAP.weeks[n - 1].checkpoint ? 'checkpoint' : 'normal'];
  }
  function blockKey(day, bi) { return day + '.' + bi; }
  function blockDone(n, day, bi) {
    var k = blockKey(day, bi);
    return live().some(function (e) { return e.week === n && e.block === k; });
  }
  function dayLogged(n, day) {
    var plan = dayPlan(n)[day], got = 0;
    plan.blocks.forEach(function (b, i) { if (blockDone(n, day, i)) got += b[1]; });
    return got;
  }
  function dayTotal(n, day) {
    return dayPlan(n)[day].blocks.reduce(function (s, b) { return s + b[1]; }, 0);
  }
  function firstOpenDay(n) {
    for (var d = 0; d < 6; d++) if (dayLogged(n, d) < dayTotal(n, d)) return d;
    return 5;
  }

  /* ---------- tiny DOM helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  /* roadmap text carries **bold** and *italic* from the source markdown */
  function md(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<em>$2</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function note(msg) { var h = $('tripwire'); if (h) h.innerHTML = '<div class="tripwire">' + md(msg) + '</div>'; }

  /* ============================================================
     RENDER
     ============================================================ */
  var dayView = null;   // null = follow the first unfinished day

  function renderAll() { renderHead(); renderRail(); renderEntry(); renderDays(); renderHours(); renderLedger(); renderFoot(); }

  function renderDays() {
    var w = ROADMAP.weeks[view - 1], plan = dayPlan(view);
    var sel = (dayView == null) ? firstOpenDay(view) : dayView;
    var strip = $('dayStrip'); strip.innerHTML = '';
    plan.forEach(function (d, i) {
      var got = dayLogged(view, i), tot = dayTotal(view, i);
      var b = el('button', 'daytab', 'D' + (i + 1));
      b.type = 'button';
      b.dataset.state = got >= tot ? 'done' : (got > 0 ? 'part' : 'open');
      b.dataset.sel = (i === sel) ? '1' : '0';
      b.title = 'Day ' + (i + 1) + ' — ' + d.label + ' (' + got + '/' + tot + ' h)';
      b.onclick = (function (k) { return function () { dayView = k; renderDays(); }; })(i);
      strip.appendChild(b);
    });
    $('dayHint').textContent = dayLogged(view, sel) + ' / ' + dayTotal(view, sel) + ' h logged';

    var d = plan[sel], body = $('dayBody');
    body.innerHTML = '';
    var head = el('div', 'day__head');
    head.appendChild(el('span', 'day__n', 'Day ' + (sel + 1)));
    head.appendChild(el('span', 'day__label', d.label));
    if (d.gate != null && w.gates[d.gate] != null) {
      head.appendChild(el('span', 'day__serves', '→ ' + w.items[w.gates[d.gate]].label));
    }
    body.appendChild(head);
    body.appendChild(el('p', 'day__purpose', d.purpose));

    var row = el('div', 'day__blocks');
    d.blocks.forEach(function (b, i) {
      var done = blockDone(view, sel, i);
      var meta = BUCKETS.filter(function (x) { return x.key === b[0]; })[0] || { label: b[0] };
      var btn = el('button', 'block');
      btn.type = 'button';
      btn.dataset.done = done ? '1' : '0';
      btn.dataset.bucket = b[0];
      btn.appendChild(el('span', 'block__b', meta.label));
      btn.appendChild(el('span', 'block__h num', b[1].toFixed(2).replace(/0$/, '') + ' h'));
      btn.title = done ? 'Logged — remove it from the ledger to undo' : 'Log ' + b[1] + ' h of ' + meta.label;
      if (done) { btn.disabled = true; }
      else btn.onclick = function () {
        S.entries.push({
          id: uid(), date: today(), hours: b[1], bucket: b[0],
          note: 'D' + (sel + 1) + ' ' + d.label, week: view,
          block: blockKey(sel, i), updatedAt: Date.now()
        });
        touch();
        if (dayLogged(view, sel) >= dayTotal(view, sel)) dayView = null;  // roll on
        renderAll();
      };
      row.appendChild(btn);
    });
    body.appendChild(row);
  }

  /* The header pill owns sync status. The footer only speaks up when
     there is something to actually do about it. */
  function renderFoot() {
    var h = $('footHint'); if (!h) return;
    var st = (window.Sync && Sync.isOn()) ? Sync.status() : null;
    if (!st) {
      h.textContent = 'Not synced — data stays in this browser. Export is your backup, or set up sync in the header.';
      return;
    }
    if (st.state === 'error')   { h.textContent = st.msg || 'Sync failed. Open the sync panel in the header.'; return; }
    if (st.state === 'offline') { h.textContent = 'Offline — changes are saved here and will sync when you reconnect.'; return; }
    h.textContent = '';
  }

  function renderHead() {
    var t = totalHours();
    $('roTotal').innerHTML = t.toFixed(1) + '<small>/' + M.totalHours + '</small>';
    $('roPlan').textContent = pad(S.planWeek);
    $('roCal').textContent = pad(calWeek());
    var su = slackUsed();
    $('roSlack').innerHTML = su + '<small>/' + M.slackBudget + '</small>';
    $('roSlackWrap').classList.toggle('readout--over', su > M.slackBudget);
    $('roStreak').innerHTML = streak() + '<small>d</small>';
    $('roWriteupsN').textContent = writeups().length;
    $('startDate').value = S.startDate;
  }

  function renderRail() {
    var rail = $('rail'); rail.innerHTML = '';
    ROADMAP.quarters.forEach(function (q) {
      var g = el('div', 'railq'); g.dataset.q = q.n;
      var ticks = el('div', 'railq__ticks');
      for (var n = q.from; n <= q.to; n++) {
        var b = el('button', 'tick');
        b.type = 'button';
        b.dataset.done = isDone(n) ? '1' : '0';
        b.dataset.now = (n === S.planWeek) ? '1' : '0';
        b.dataset.view = (n === view) ? '1' : '0';
        if (ROADMAP.weeks[n - 1].checkpoint) b.dataset.check = '1';
        b.title = 'Week ' + n + ' — ' + ROADMAP.weeks[n - 1].title;
        b.setAttribute('aria-label', b.title);
        b.onclick = (function (k) { return function () { view = k; dayView = null; renderAll(); }; })(n);
        ticks.appendChild(b);
      }
      g.appendChild(ticks);
      g.appendChild(el('span', 'railq__label', 'Q' + q.n + ' · ' + (q.short || q.name)));
      rail.appendChild(g);
    });
  }

  function renderEntry() {
    var w = ROADMAP.weeks[view - 1], st = week(view), q = quarter(view);
    var sec = $('entry');
    sec.dataset.q = w.q;
    document.body.dataset.q = w.q;
    $('wkNo').textContent = pad(view);
    $('wkTitle').textContent = w.title;
    $('hrsWk').textContent = pad(view);

    var meta = $('wkMeta'); meta.innerHTML = '';
    meta.appendChild(el('span', 'chip chip--lamp', 'Q' + q.n + ' · ' + (q.short || q.name)));
    if (w.checkpoint) meta.appendChild(el('span', 'chip chip--check', 'Check ride'));
    if (view !== S.planWeek) {
      var jump = el('button', 'chip', '↩ Back to week ' + pad(S.planWeek));
      jump.type = 'button'; jump.style.cursor = 'pointer';
      jump.onclick = function () { view = S.planWeek; dayView = null; renderAll(); };
      meta.appendChild(jump);
    }

    var list = $('wkItems'); list.innerHTML = '';
    w.items.forEach(function (it, i) {
      var gi = w.gates.indexOf(i);
      var li = el('li', 'item' + (gi > -1 ? ' item--gate' : ''));
      var boxCell = el('div', 'item__box');
      if (gi > -1) {
        var cb = el('input', 'box'); cb.type = 'checkbox';
        cb.checked = !!st.gates[gi];
        cb.disabled = !!st.endorsedAt;
        cb.setAttribute('aria-label', it.label + ' — week ' + view);
        cb.onchange = function () { st.gates[gi] = cb.checked; touch(view); renderEntry(); };
        boxCell.appendChild(cb);
      }
      li.appendChild(boxCell);
      li.appendChild(el('div', 'item__lab', it.label));
      var tx = el('div', 'item__txt'); tx.innerHTML = md(it.text);
      li.appendChild(tx);
      list.appendChild(li);
    });

    renderDrip(q, view);

    var wu = $('wuInput');
    wu.value = st.writeup || '';
    wu.onchange = function () { st.writeup = wu.value.trim(); touch(view); renderHead(); };

    renderActions(st, w);
  }

  /* Drip is authored per quarter as hour-tagged slots, so it renders as a
     list you can actually follow rather than a run-on sentence. Slots that
     alternate resolve to this week's parity. */
  function renderDrip(q, n) {
    var slots = q.dripSlots || [], notes = q.dripNotes || [];
    var hrs = slots.reduce(function (s, x) { return s + x.hours; }, 0);
    $('dripHd').textContent = 'The drip · ' + hrs + ' hrs on day 6 · Q' + q.n + ' ' + q.short;

    var ul = $('dripList'); ul.innerHTML = '';
    slots.forEach(function (sl) {
      var li = el('li', 'drip__row');
      li.appendChild(el('span', 'drip__h num', sl.hours + ' hr'));
      var body = el('span', 'drip__t');
      body.innerHTML = md(sl.text);
      var alt = /^alternating:/i.test(sl.text);
      if (alt) {
        var odd = (n % 2 === 1);
        var pick = el('span', 'drip__pick', odd ? 'this week: odd' : 'this week: even');
        body.appendChild(document.createTextNode(' '));
        body.appendChild(pick);
      }
      li.appendChild(body);
      ul.appendChild(li);
    });

    var box = $('dripNotes'); box.innerHTML = '';
    notes.forEach(function (t) {
      var p = el('p', 'drip__note');
      p.innerHTML = md(t);
      box.appendChild(p);
    });
  }

  function renderActions(st, w) {
    var box = $('wkActions'); box.innerHTML = '';

    if (st.endorsedAt) {
      var stamp = el('div', 'stamp' + (w.checkpoint ? ' stamp--check' : ''));
      stamp.appendChild(el('span', 'stamp__k', w.checkpoint ? 'Check ride passed' : 'Endorsed'));
      stamp.appendChild(el('span', 'stamp__d', fmtFull(st.endorsedAt) + ' · week ' + pad(view)));
      if (st.fresh) { stamp.classList.add('stamp--fresh'); delete st.fresh; save(); }
      box.appendChild(stamp);

      var undo = el('button', 'btn btn--ghost', 'Reopen');
      undo.type = 'button';
      undo.onclick = function () {
        st.endorsedAt = null;
        if (S.planWeek === view + 1) S.planWeek = view;
        touch(view); renderAll();
      };
      box.appendChild(undo);
      return;
    }

    var ready = w.gates.every(function (_, i) { return st.gates[i]; });
    var labels = w.gates.map(function (i) { return w.items[i].label; });
    var btn = el('button', 'btn', w.checkpoint ? 'Pass the check ride' : 'Endorse the week');
    btn.type = 'button';
    btn.disabled = !ready;
    btn.onclick = function () {
      st.endorsedAt = today(); st.fresh = true;
      if (view === S.planWeek && S.planWeek < 52) S.planWeek = view + 1;
      touch(view); renderAll();
    };
    box.appendChild(btn);

    var left = labels.filter(function (_, i) { return !st.gates[i]; });
    box.appendChild(el('span', 'hint', ready
      ? 'All three signed off. ' + (w.checkpoint
          ? 'Be honest — a failed check ride is a slack week, not a disaster.'
          : 'Endorsing advances the plan week.')
      : 'Still open: ' + left.join(', ') + '.'));
  }

  function renderHours() {
    var h = weekHours(view), bars = $('bars');
    bars.innerHTML = '';
    BUCKETS.forEach(function (b) {
      var got = h[b.key] || 0, tgt = T[b.key], pctv = Math.min(100, (got / tgt) * 100);
      var wrap = el('div', 'bar' + (got >= tgt ? ' bar--met' : ''));
      var hd = el('div', 'bar__hd');
      hd.appendChild(el('span', 'gauge', b.label));
      var n = el('span', 'bar__n'); n.innerHTML = '<b>' + got.toFixed(1) + '</b> / ' + tgt;
      hd.appendChild(n);
      wrap.appendChild(hd);
      var tr = el('div', 'bar__track'), fl = el('div', 'bar__fill');
      fl.style.width = pctv + '%';
      tr.appendChild(fl); wrap.appendChild(tr);
      bars.appendChild(wrap);
    });
    var weekTarget = BUCKETS.reduce(function (s, b) { return s + T[b.key]; }, 0);
    $('wkTotal').textContent = h.total.toFixed(1) + ' / ' + weekTarget;

    /* Failure mode #1 — study outrunning build */
    var tw = $('tripwire'); tw.innerHTML = '';
    if (h.study > h.build && h.total >= 4) {
      tw.innerHTML = '<div class="tripwire">Study is ahead of build this week (' +
        h.study.toFixed(1) + ' vs ' + h.build.toFixed(1) +
        ' hrs). That is failure mode #1 — you are consuming content, not building skill.</div>';
    } else if (h.total >= weekTarget && h.build >= T.build) {
      tw.innerHTML = '<div class="tripwire" style="border-color:var(--lamp);color:var(--muted)">Full week logged, build target met.</div>';
    }
  }

  function renderLedger() {
    var ul = $('ledger'); ul.innerHTML = '';
    var rows = live().slice().sort(function (a, b) {
      return a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1);
    }).slice(0, 60);
    if (!rows.length) {
      ul.appendChild(el('li', 'empty', 'No entries yet. Log today\u2019s three hours and the streak starts.'));
      return;
    }
    rows.forEach(function (e) {
      var li = el('li', 'led');
      li.appendChild(el('span', 'led__d', fmtDay(e.date)));
      li.appendChild(el('span', 'led__h', e.hours.toFixed(2).replace(/0$/, '')));
      var bl = (BUCKETS.filter(function (b) { return b.key === e.bucket; })[0] || {}).label || e.bucket;
      li.appendChild(el('span', 'led__b', bl));
      li.appendChild(el('span', 'led__n', e.note || ('wk ' + pad(e.week))));
      var x = el('button', 'led__x', '\u00d7');
      x.type = 'button'; x.title = 'Delete entry';
      x.onclick = function () {
        e.del = Date.now(); e.updatedAt = e.del;   // tombstone, so the delete syncs
        touch(); renderAll();
      };
      li.appendChild(x);
      ul.appendChild(li);
    });
  }

  /* ============================================================
     WIRING
     ============================================================ */
  function initSegs() {
    var box = $('segs'); box.innerHTML = '';
    BUCKETS.forEach(function (b) {
      var s = el('button', 'seg', b.label);
      s.type = 'button'; s.title = b.desc;
      s.setAttribute('aria-pressed', String(b.key === draft.bucket));
      s.onclick = function () {
        draft.bucket = b.key;
        Array.prototype.forEach.call(box.children, function (c, i) {
          c.setAttribute('aria-pressed', String(BUCKETS[i].key === draft.bucket));
        });
      };
      box.appendChild(s);
    });
  }

  $('logDate').value = today();

  $('logForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var hrs = parseFloat($('logHours').value);
    if (!(hrs > 0)) return;
    S.entries.push({
      id: uid(), date: $('logDate').value || today(),
      hours: Math.round(hrs * 4) / 4, bucket: draft.bucket,
      note: $('logNote').value.trim(), week: view, updatedAt: Date.now()
    });
    $('logNote').value = '';
    touch(); renderAll();
  });

  $('hMinus').onclick = function () {
    var i = $('logHours'); i.value = Math.max(0.25, (parseFloat(i.value) || 0) - 0.25).toFixed(2);
  };
  $('hPlus').onclick = function () {
    var i = $('logHours'); i.value = Math.min(16, (parseFloat(i.value) || 0) + 0.25).toFixed(2);
  };

  $('prevWk').onclick = function () { if (view > 1) { view--; dayView = null; renderAll(); } };
  $('nextWk').onclick = function () { if (view < 52) { view++; dayView = null; renderAll(); } };
  document.addEventListener('keydown', function (e) {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowLeft') $('prevWk').click();
    if (e.key === 'ArrowRight') $('nextWk').click();
  });

  $('startDate').onchange = function () {
    if (this.value) { S.startDate = this.value; touch(); renderHead(); }
  };

  $('roWriteups').onclick = function () {
    var ul = $('wuList'); ul.innerHTML = '';
    var ws = writeups();
    if (!ws.length) {
      ul.appendChild(el('li', '', 'Nothing logged yet. The field sits at the bottom of every week.'));
    } else {
      ws.forEach(function (n) {
        var li = el('li');
        li.appendChild(el('b', '', 'Week ' + pad(n)));
        var v = S.weeks[n].writeup;
        if (/^https?:\/\//i.test(v)) {
          var a = el('a', '', v); a.href = v; a.target = '_blank'; a.rel = 'noopener';
          li.appendChild(a);
        } else li.appendChild(el('span', '', v));
        ul.appendChild(li);
      });
    }
    $('wuDialog').showModal();
  };
  $('wuClose').onclick = function () { $('wuDialog').close(); };

  $('exportBtn').onclick = function () {
    var blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'logbook-' + today() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  $('importBtn').onclick = function () { $('importFile').click(); };
  $('importFile').onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || !d.weeks || !d.entries) throw new Error('shape');
        S = migrate(d);
        view = S.planWeek = clamp(S.planWeek || 1, 1, 52);
        touch(); renderAll();
      } catch (e) {
        note('That file could not be read as a logbook export. Nothing was changed.');
      }
    };
    r.readAsText(f);
    this.value = '';
  };

  /* ---------- sync wiring ---------- */
  if (window.Sync) {
    /* listener first — init fires its first status event synchronously */
    Sync.onStatus(function (state, msg, at) {
      var dot = $('syncDot'), lbl = $('syncLabel');
      var words = { off:'Local only', idle:'Synced', syncing:'Syncing', pending:'Saving',
                    error:'Sync error', offline:'Offline' };
      dot.dataset.state = state;
      lbl.textContent = words[state] || state;
      $('syncBtn').title = msg || (at ? 'Last synced ' + new Date(at).toLocaleTimeString() : 'Set up sync');
      if (state === 'idle' || state === 'error' || state === 'offline') renderAll();
      else renderFoot();
      $('syncMsg').textContent = msg || '';
    });
    Sync.init({
      get: function () { return S; },
      set: function (next) {
        var wasCurrent = (view === S.planWeek);
        S = migrate(next);
        if (wasCurrent) view = S.planWeek;      // follow the plan week in from another device
        view = clamp(view, 1, 52);
      },
      saveLocal: save
    });
  }

  var syncDlg = $('syncDialog');
  $('syncBtn').onclick = function () {
    var c = (window.Sync && Sync.config()) || {};
    $('syOwner').value = c.owner || '';
    $('syRepo').value = c.repo || '';
    $('syPath').value = c.path || 'logbook.json';
    $('syBranch').value = c.branch || 'main';
    $('syToken').value = c.token || '';
    $('syncMsg').textContent = (window.Sync && Sync.status().msg) || '';
    syncDlg.showModal();
  };
  $('syncClose').onclick = function () { syncDlg.close(); };
  $('syncForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('syncMsg').textContent = 'Connecting…';
    Sync.connect({
      owner: $('syOwner').value, repo: $('syRepo').value,
      path: $('syPath').value, branch: $('syBranch').value, token: $('syToken').value
    }).then(function () {
      renderAll();
      if (Sync.status().state === 'idle') syncDlg.close();
    });
  });
  $('syncNow').onclick = function () { if (window.Sync) Sync.now().then(renderAll); };
  $('syncOff').onclick = function () { Sync.disconnect(); syncDlg.close(); renderFoot(); };

  initSegs();
  renderAll();
})();
