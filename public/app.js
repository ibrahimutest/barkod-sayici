/* Barkod Sayıcı v2 — istemci
 * Veri akışı: okutma → localStorage giden kutusu (anında, senkron) → arka planda POST /olay (UUID ile idempotent)
 * → sunucu onaylayınca kutudan silinir. Yanıt kaybolursa aynı UUID tekrar gider, sunucu INSERT OR IGNORE ile tek yazar.
 * İptal de kutudan sırayla gider (önce ekle, sonra iptal) → kuyruktaki bir kaydın iptali de doğru işlenir.
 * Liste = sunucu özeti + bu cihazın henüz gönderilmemiş kayıtları (bekleyen olarak işaretli).
 * Not: HTML üretilen her yerde kullanıcı/sunucu verisi esc() ile kaçışlanır.
 */
'use strict';
(function () {
  const VER = '2.0.0';
  const POLL_MS = 3000;
  const CAM_LOCK_MS = 1500;     // kameradan aynı barkod: son görülmeden 1.5 sn geçmeden tekrar sayılmaz
  const FAST_GAP_MS = 700;      // hızlı modda herhangi iki kamera kaydı arası en az
  const BATCH = 100;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setHtml = (el, html) => { el.innerHTML = html; }; // yalnız esc() ile üretilmiş metin

  // ---------- güvenli depolama (localStorage + bellek yedeği) ----------
  const mem = new Map();
  let lsBroken = false;
  const LS = {
    get(k, d) {
      if (mem.has(k)) return mem.get(k);
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); mem.delete(k); return true; }
      catch (e) { mem.set(k, v); if (!lsBroken) { lsBroken = true; updateBanner(); } return false; }
    },
    del(k) { mem.delete(k); try { localStorage.removeItem(k); } catch (e) { /* yok say */ } },
  };
  try { const t = '__bs2t'; localStorage.setItem(t, '1'); localStorage.removeItem(t); } catch (e) { lsBroken = true; }

  // ---------- durum ----------
  const S = {
    view: null, tab: 'okut', sayimId: null, token: null, rol: null, ad: '', durum: 'acik', izle: null,
    kisi: LS.get('bs2_kisi', ''), bolge: null, rows: [], surum: null, online: navigator.onLine !== false,
    lastOk: 0, acked: [], closedBlock: false, authBad: false, rejected: 0,
  };
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
  const cleanText = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const normCode = (v) => String(v == null ? '' : v).replace(/[\s\u0000-\u001f\u007f]/g, '').slice(0, 64);
  const grupOf = (barkod, ad) => (barkod ? 'b:' + barkod : 'a:' + cleanText(ad).toLocaleLowerCase('tr-TR'));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 });
  const fmtNum = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : nf.format(Number(x)));
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms)); const n = new Date();
    const t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return d.toDateString() === n.toDateString() ? t : pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + t;
  }
  function parseQty(s) {
    const v = String(s == null ? '' : s).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d{1,3})?$/.test(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100000) return null;
    return n;
  }

  // ---------- API ----------
  async function api(method, path, body, opt) {
    opt = opt || {};
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), opt.timeout || 15000);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const tok = opt.token === undefined ? S.token : opt.token;
    if (tok) headers.Authorization = 'Bearer ' + tok;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      const er = new Error('Bağlantı yok'); er.status = 0; throw er;
    } finally { clearTimeout(tm); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* boş */ }
    if (!res.ok) { const er = new Error((data && data.error) || ('Hata ' + res.status)); er.status = res.status; throw er; }
    return data;
  }

  // ---------- oturumlar ----------
  const sessions = () => LS.get('bs2_oturumlar', {}) || {};
  function saveSession(id, data) { const all = sessions(); all[id] = Object.assign({}, all[id], data, { t: Date.now() }); LS.set('bs2_oturumlar', all); }
  function dropSessionToken(id) { const all = sessions(); if (all[id]) { delete all[id].token; LS.set('bs2_oturumlar', all); } }
  function removeSession(id) { const all = sessions(); delete all[id]; LS.set('bs2_oturumlar', all); }

  // ---------- giden kutusu ----------
  const obKey = (id) => 'bs2_ob_' + (id || S.sayimId);
  const obLoad = (id) => LS.get(obKey(id), []) || [];
  const opKey = (op) => op.tip + ':' + op.id;
  function obPush(op) { const a = obLoad(); a.push(op); LS.set(obKey(), a); }
  function obRemove(keys) { const a = obLoad().filter((op) => !keys.has(opKey(op))); LS.set(obKey(), a); }
  const recKey = () => 'bs2_son_' + S.sayimId;

  function enqueue(op) {
    obPush(op);
    updateSync();
    renderAll();
    scheduleFlush(0);
  }

  let flushing = false, backoff = 0, flushTimer = null;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
  async function flush() {
    if (flushing || S.rol !== 'yaz' || !S.token || S.closedBlock || S.authBad) { updateSync(); return; }
    const box = obLoad();
    if (!box.length) { updateSync(); return; }
    flushing = true; updateSync();
    const batch = box.slice(0, BATCH);
    const send = batch.map((op) => op.tip === 'iptal'
      ? { tip: 'iptal', id: op.id, kisi: op.kisi }
      : { tip: 'ekle', id: op.id, barkod: op.barkod || null, ad: op.ad || null, miktar: op.miktar, birim: op.birim, bolge: op.bolge || null, kisi: op.kisi, kaynak: op.kaynak, ts: op.ts });
    let again = false;
    try {
      const r = await api('POST', '/api/sayim/' + S.sayimId + '/olay', { ops: send }, { timeout: 20000 });
      if (!r || !Array.isArray(r.sonuc) || r.sonuc.length !== batch.length) throw Object.assign(new Error('beklenmeyen yanıt'), { status: 500 });
      const done = new Set();
      let red = 0;
      r.sonuc.forEach((so, i) => {
        done.add(opKey(batch[i]));
        if (so.durum === 'ok') S.acked.push({ op: batch[i], surum: r.surum });
        else { red++; console.warn('reddedildi', so, batch[i]); }
      });
      obRemove(done);
      if (red) { S.rejected += red; toast(red + ' kayıt sunucu tarafından reddedildi', 'bad'); }
      backoff = 0; S.online = true; S.lastOk = Date.now();
      again = obLoad().length > 0;
    } catch (e) {
      if (e.status === 409) { S.closedBlock = true; S.durum = 'kapali'; }
      else if (e.status === 401) { S.authBad = true; dropSessionToken(S.sayimId); }
      else {
        if (e.status === 0) S.online = false;
        backoff = Math.min(backoff ? backoff * 2 : 2000, 30000);
        scheduleFlush(backoff);
      }
    } finally {
      flushing = false;
      updateSync(); updateBanner();
    }
    await poll();
    if (again) scheduleFlush(0);
  }

  // ---------- canlı liste (polling) ----------
  let polling = false, pollTimer = null;
  async function poll() {
    if (!S.sayimId || !S.token || polling || S.authBad) return;
    polling = true;
    try {
      const q = S.surum != null ? '?surum=' + S.surum : '';
      const r = await api('GET', '/api/sayim/' + S.sayimId + '/ozet' + q, null, { timeout: 12000 });
      S.online = true; S.lastOk = Date.now();
      setDurum(r.durum);
      if (!r.degismedi) {
        S.rows = Array.isArray(r.satirlar) ? r.satirlar : [];
        S.surum = r.surum;
        if (r.ad) S.ad = r.ad;
        S.acked = S.acked.filter((a) => a.surum > S.surum);
        LS.set('bs2_oz_' + S.sayimId, { surum: S.surum, rows: S.rows, t: Date.now() });
        renderAll();
      } else {
        S.acked = S.acked.filter((a) => a.surum > S.surum);
      }
    } catch (e) {
      if (e.status === 0) S.online = false;
      if (e.status === 401 || e.status === 403) { S.authBad = true; if (S.rol === 'yaz') dropSessionToken(S.sayimId); }
    } finally {
      polling = false;
      updateSync(); updateBanner(); renderListNote();
    }
  }
  function startLoop() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || S.view !== 'sayim') return;
      poll();
      if (S.rol === 'yaz' && !flushing && obLoad().length && !backoff) scheduleFlush(0);
    }, POLL_MS);
  }
  function setDurum(d) {
    if (!d || d === S.durum) { if (d === 'acik' && S.closedBlock) { S.closedBlock = false; scheduleFlush(0); } return; }
    S.durum = d;
    if (d === 'acik') { S.closedBlock = false; scheduleFlush(0); }
    renderMenu(); updateBanner(); renderScanState();
  }

  // ---------- birleşik görünüm ----------
  function merged() {
    const map = new Map();
    for (const r of S.rows) map.set(r.g + '|' + r.u, { g: r.g, u: r.u, b: r.b, a: r.a, t: Number(r.t) || 0, n: Number(r.n) || 0, s: Number(r.s) || 0, p: 0 });
    const box = S.rol === 'yaz' ? obLoad() : [];
    const extra = S.acked.filter((a) => S.surum == null || a.surum > S.surum).map((a) => ({ op: a.op, p: 0 }))
      .concat(box.map((op) => ({ op, p: 1 })));
    for (const { op, p } of extra) {
      if (op.tip === 'ekle') {
        const g = grupOf(op.barkod, op.ad), k = g + '|' + op.birim;
        let row = map.get(k);
        if (!row) { row = { g, u: op.birim, b: op.barkod || null, a: op.ad || null, t: 0, n: 0, s: 0, p: 0 }; map.set(k, row); }
        row.t = r3(row.t + op.miktar); row.n += 1; row.s = Math.max(row.s, op.ts); row.p += p;
      } else if (op.tip === 'iptal' && op.g) {
        const row = map.get(op.g + '|' + op.u);
        if (row) { row.t = r3(row.t - op.m); row.n -= 1; row.p += p; }
      }
    }
    return [...map.values()].filter((r) => r.n > 0).sort((a, b) => b.s - a.s);
  }

  // ---------- görünüm yönetimi ----------
  function show(view) {
    S.view = view;
    for (const v of ['home', 'join', 'sayim']) $('#v-' + v).hidden = v !== view;
    if (view !== 'sayim') { camStop(true); clearInterval(pollTimer); }
    window.scrollTo(0, 0);
  }
  function setTab(t) {
    S.tab = t;
    for (const x of ['okut', 'liste', 'menu']) {
      $('#p-' + x).hidden = x !== t;
      $('#tab-' + x).classList.toggle('on', x === t);
    }
    if (t !== 'okut') camStop(false); else if (camWanted) camStart();
    if (t === 'liste') renderList();
    if (t === 'menu') renderMenu();
    window.scrollTo(0, 0);
  }

  function route() {
    closeSheet();
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const izle = p.get('izle');
    const sid = (p.get('s') || '').toLowerCase();
    if (izle && /^i[0-9a-f]{40}$/.test(izle)) return openViewer(izle);
    if (sid && /^[0-9a-f]{12}$/.test(sid)) {
      const ss = sessions()[sid];
      if (ss && ss.token) return openSayim(sid);
      return openJoin(sid);
    }
    openHome();
  }

  // ---------- ana sayfa ----------
  function openHome() {
    show('home');
    const all = sessions();
    const ids = Object.keys(all).sort((a, b) => (all[b].t || 0) - (all[a].t || 0));
    $('#home-devam').hidden = !ids.length;
    setHtml($('#home-list'), ids.map((id) => {
      const n = obLoad(id).length;
      return '<a class="home-item" href="#s=' + esc(id) + '"><div style="min-width:0"><b>' + esc(all[id].ad || id) + '</b><div class="muted">' +
        esc(fmtKod(id)) + (n ? ' · <span class="tag wait">' + n + ' gönderilmedi</span>' : '') + (all[id].token ? '' : ' · PIN gerekli') + '</div></div><span class="go">Devam ›</span></a>';
    }).join(''));
    const f = $('#f-create');
    if (!f.kisi.value) f.kisi.value = S.kisi || '';
  }
  const fmtKod = (id) => id.slice(0, 4) + '-' + id.slice(4, 8) + '-' + id.slice(8);

  $('#f-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f);
    err.textContent = '';
    const ad = cleanText(f.ad.value), pin = f.pin.value.trim(), kisi = cleanText(f.kisi.value);
    if (!ad) return (err.textContent = 'Sayım adı gerekli.');
    if (!/^\d{4,12}$/.test(pin)) return (err.textContent = 'PIN 4-12 haneli rakam olmalı.');
    if (pin !== f.pin2.value.trim()) return (err.textContent = 'PIN tekrarı uyuşmuyor.');
    if (!kisi) return (err.textContent = 'Adınızı yazın.');
    const btn = $('button[type=submit]', f); btn.disabled = true;
    try {
      const r = await api('POST', '/api/sayim', { ad, pin, kisi }, { token: null });
      setKisi(kisi);
      saveSession(r.sayim.id, { token: r.token, ad: r.sayim.ad, izle: r.izle_token });
      f.reset();
      S.tab = 'menu';
      location.hash = '#s=' + r.sayim.id;
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });
  $('#f-kod').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.kod.value.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (v.length !== 12) { $('[data-err]', e.target).textContent = 'Kod 12 karakter olmalı.'; return; }
    location.hash = '#s=' + v;
  });

  // ---------- katıl ----------
  let joinId = null;
  async function openJoin(id) {
    show('join'); joinId = id;
    const f = $('#f-join');
    $('[data-err]', f).textContent = '';
    f.pin.value = ''; f.kisi.value = S.kisi || '';
    const ss = sessions()[id];
    $('#join-ad').textContent = (ss && ss.ad) || 'Sayım';
    const nb = obLoad(id).length;
    $('#join-durum').textContent = 'Kod: ' + fmtKod(id) + (nb ? ' · bu cihazda ' + nb + ' gönderilmemiş kayıt var (katılınca gönderilir)' : '');
    try {
      const r = await api('GET', '/api/sayim/' + id + '/bilgi', null, { token: null });
      $('#join-ad').textContent = r.ad;
      if (r.durum === 'kapali') $('#join-durum').textContent += ' · Sayım KAPALI';
    } catch (e) {
      if (e.status === 404) $('#join-ad').textContent = 'Sayım bulunamadı';
      else $('#join-durum').textContent += ' · bağlantı yok';
    }
  }
  $('#f-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f);
    err.textContent = '';
    const pin = f.pin.value.trim(), kisi = cleanText(f.kisi.value);
    if (!/^\d{4,12}$/.test(pin)) return (err.textContent = 'PIN 4-12 haneli rakam.');
    if (!kisi) return (err.textContent = 'Adınızı yazın.');
    const btn = $('button[type=submit]', f); btn.disabled = true;
    try {
      const r = await api('POST', '/api/sayim/' + joinId + '/katil', { pin, kisi }, { token: null });
      setKisi(kisi);
      saveSession(joinId, { token: r.token, ad: r.sayim.ad, izle: r.izle_token });
      route();
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });

  // ---------- sayım ekranı ----------
  function resetSayimState(id) {
    S.sayimId = id; S.surum = null; S.rows = []; S.acked = []; S.closedBlock = false; S.authBad = false; S.rejected = 0; S.durum = 'acik';
    const cache = id ? LS.get('bs2_oz_' + id, null) : null;
    if (cache && Array.isArray(cache.rows)) S.rows = cache.rows;
    backoff = 0;
  }
  async function openSayim(id) {
    const ss = sessions()[id];
    resetSayimState(id);
    S.token = ss.token; S.rol = 'yaz'; S.ad = ss.ad || ''; S.izle = ss.izle || null;
    S.bolge = LS.get('bs2_bolge_' + id, null);
    show('sayim');
    document.body.classList.remove('izle');
    $('#tab-okut').hidden = false;
    $('#tab-menu').lastChild.textContent = 'Paylaş / Aktar';
    for (const x of ['m-paylas', 'm-izle', 'm-yonet', 'm-cihaz']) $('#' + x).hidden = false;
    $('#hizli').checked = !!LS.get('bs2_hizli', false);
    renderHeader(); renderBolge(); clearScanCard(); renderAll(); updateBanner(); updateSync();
    setTab(S.tab === 'menu' ? 'menu' : 'okut');
    startLoop();
    try {
      const r = await api('GET', '/api/ben');
      S.ad = r.sayim.ad; S.izle = r.izle_token || S.izle;
      saveSession(id, { ad: S.ad, izle: S.izle });
      setDurum(r.sayim.durum);
      renderHeader(); renderMenu(); renderScanState();
    } catch (e) {
      if (e.status === 401 || e.status === 403) { dropSessionToken(id); return openJoin(id); }
    }
    poll(); scheduleFlush(0);
  }
  async function openViewer(tok) {
    resetSayimState(null);
    S.token = tok; S.rol = 'izle';
    show('sayim');
    document.body.classList.add('izle');
    $('#tab-okut').hidden = true;
    $('#tab-menu').lastChild.textContent = 'Excel / CSV';
    for (const x of ['m-paylas', 'm-izle', 'm-yonet', 'm-cihaz']) $('#' + x).hidden = true;
    $('#s-ad').textContent = 'Yükleniyor…';
    setTab('liste');
    try {
      const r = await api('GET', '/api/ben');
      resetSayimState(r.sayim.id);
      S.ad = r.sayim.ad; S.durum = r.sayim.durum;
    } catch (e) {
      $('#s-ad').textContent = e.status === 401 ? 'Link geçersiz' : 'Bağlantı yok — yenileyin';
      S.authBad = e.status === 401; updateBanner();
      if (e.status !== 401) setTimeout(() => { if (S.view === 'sayim' && S.rol === 'izle' && !S.sayimId) openViewer(tok); }, 4000);
      return;
    }
    renderHeader(); renderAll(); updateBanner(); updateSync();
    startLoop(); poll();
  }

  function renderHeader() {
    $('#s-ad').textContent = S.ad || '—';
    $('#s-rol').textContent = S.rol === 'izle' ? 'Canlı izleme · salt-okunur' : 'Sayıcı';
    $('#s-kisi').textContent = S.rol === 'yaz' ? (S.kisi || '—') : '';
    $('#s-kisi').hidden = S.rol !== 'yaz';
    document.title = (S.ad ? S.ad + ' — ' : '') + 'Barkod Sayıcı';
  }

  function updateSync() {
    const el = $('#sync'); if (!el) return;
    let cls = 'ok', t;
    if (S.rol === 'yaz') {
      const n = obLoad().length;
      if (n) { cls = S.online ? 'wait' : 'off'; t = 'Bekleyen: ' + n; }
      else if (!S.online) { cls = 'off'; t = 'Çevrimdışı'; }
      else t = 'Gönderildi ✓';
    } else {
      cls = S.online ? 'ok' : 'off'; t = S.online ? 'Canlı' : 'Bağlantı yok';
    }
    el.className = 'sync ' + cls;
    $('#sync-t').textContent = t;
  }
  $('#sync').addEventListener('click', () => { backoff = 0; scheduleFlush(0); poll(); toast('Yenileniyor…'); });

  function updateBanner() {
    const b = $('#banner'); if (!b || S.view !== 'sayim') return;
    let msg = '', bad = false;
    const n = S.rol === 'yaz' ? obLoad().length : 0;
    if (lsBroken && S.rol === 'yaz') { msg = 'Cihaz hafızası kullanılamıyor (gizli sekme?). Kayıtlar yalnız bu sayfa açıkken korunur — sayfayı KAPATMAYIN, normal sekmede açın.'; bad = true; }
    else if (S.authBad) { msg = S.rol === 'izle' ? 'İzleme linki geçersiz.' : 'Oturum geçersiz. Ana sayfadan sayıma PIN ile yeniden katılın — gönderilmemiş kayıtlar saklanıyor.'; bad = true; }
    else if (S.durum === 'kapali') { msg = 'Sayım KAPALI — yeni kayıt alınmıyor.' + (n ? ' Bu cihazda gönderilemeyen ' + n + ' kayıt var; sayımı yeniden açın.' : ''); bad = !!n; }
    else if (!S.online && S.rol === 'yaz') msg = 'Çevrimdışı — okutmalar bu cihazda saklanıyor, bağlantı gelince otomatik gönderilecek.';
    else if (!S.online) msg = 'Bağlantı yok — liste en son alınan hâliyle gösteriliyor.';
    b.hidden = !msg; b.textContent = msg; b.classList.toggle('bad', bad);
  }

  function renderAll() {
    if (S.view !== 'sayim') return;
    if (S.tab === 'liste') renderList();
    renderRecent(); updateSync();
  }

  // ---------- liste ----------
  let listView = [];
  function renderList() {
    const all = merged();
    let adet = 0, kg = 0, ok = 0;
    for (const r of all) { if (r.u === 'kg') kg += r.t; else adet += r.t; ok += r.n; }
    $('#st-kalem').textContent = fmtNum(all.length);
    $('#st-adet').textContent = fmtNum(r3(adet));
    $('#st-kg').textContent = fmtNum(r3(kg));
    $('#st-okutma').textContent = fmtNum(ok);
    const q = cleanText($('#ara').value).toLocaleLowerCase('tr-TR');
    const rows = q ? all.filter((r) => (r.b && r.b.toLocaleLowerCase('tr-TR').includes(q)) || (r.a && r.a.toLocaleLowerCase('tr-TR').includes(q))) : all;
    const MAX = 400;
    setHtml($('#liste'), rows.slice(0, MAX).map((r, i) => {
      const main = r.b ? '<div class="l-c">' + esc(r.b) + '</div>' : '<div class="l-c txt">' + esc(r.a || '—') + '</div>';
      const sub = (r.b && r.a ? esc(r.a) + ' · ' : '') + fmtNum(r.n) + ' okutma · son ' + fmtTime(r.s) + (r.p ? ' · <span class="tag wait">gönderilmedi</span>' : '');
      return '<button type="button" class="l-item" data-i="' + i + '"><div class="l-l">' + main + '<div class="l-s">' + sub + '</div></div><div class="l-q"><b>' + fmtNum(r.t) + '</b><span>' + esc(r.u) + '</span></div><span class="chev">›</span></button>';
    }).join('') || '<p class="muted center empty">' + (q ? 'Eşleşen kayıt yok.' : 'Henüz kayıt yok.') + '</p>');
    listView = rows;
    renderListNote(rows.length > MAX ? rows.length - MAX : 0);
  }
  function renderListNote(hiddenN) {
    const el = $('#liste-not'); if (!el) return;
    const parts = [];
    if (hiddenN) parts.push(hiddenN + ' satır daha var — aramayla daraltın.');
    if (S.lastOk) parts.push('Son güncelleme ' + fmtTime(S.lastOk));
    el.textContent = parts.join(' ');
  }
  $('#ara').addEventListener('input', () => renderList());
  $('#liste').addEventListener('click', (e) => {
    const b = e.target.closest('.l-item'); if (!b) return;
    const r = listView[Number(b.dataset.i)]; if (r) openGecmis(r);
  });

  // ---------- geçmiş ----------
  let gRow = null, gServer = [], gOffline = false;
  async function openGecmis(r) {
    gRow = r;
    $('#g-t').textContent = r.b || r.a || '—';
    $('#g-t').style.fontFamily = r.b ? 'var(--mono)' : '';
    $('#g-sub').textContent = 'Toplam ' + fmtNum(r.t) + ' ' + r.u + ' · ' + fmtNum(r.n) + ' okutma';
    setHtml($('#g-list'), '<p class="muted small">Yükleniyor…</p>');
    openSheet('sh-gecmis');
    let server = [], offline = false;
    try {
      const x = await api('GET', '/api/sayim/' + S.sayimId + '/gecmis?g=' + encodeURIComponent(r.g) + '&u=' + encodeURIComponent(r.u));
      server = x.olaylar || [];
    } catch (e) { offline = true; }
    if (gRow !== r) return;
    gServer = server; gOffline = offline;
    renderGecmis();
  }
  function renderGecmis() {
    const r = gRow; if (!r) return;
    const box = S.rol === 'yaz' ? obLoad() : [];
    const pendIptal = new Set(box.filter((o) => o.tip === 'iptal').map((o) => o.id));
    const pendEkle = box.filter((o) => o.tip === 'ekle' && grupOf(o.barkod, o.ad) === r.g && o.birim === r.u);
    const seen = new Set(gServer.map((o) => o.id));
    const items = pendEkle.filter((o) => !seen.has(o.id)).map((o) => Object.assign({}, o, { _p: true })).concat(gServer)
      .sort((a, b) => b.ts - a.ts);
    const canCancel = S.rol === 'yaz' && S.durum === 'acik';
    const html = items.map((o) => {
      const ipt = o.iptal || pendIptal.has(o.id);
      const tags = (o._p ? ' <span class="tag wait">gönderilmedi</span>' : '') +
        (o.iptal ? ' <span class="tag bad">iptal · ' + esc(o.iptal_eden || '—') + ' ' + fmtTime(o.iptal_ts) + '</span>' : (pendIptal.has(o.id) ? ' <span class="tag wait">iptal bekliyor</span>' : ''));
      const neg = Number(o.miktar) < 0;
      return '<div class="g-item' + (ipt ? ' iptal' : '') + '"><div class="g-l"><div class="g-a">' + esc(o.kisi || '—') + ' · ' + fmtTime(o.ts) + tags + '</div>' +
        '<div class="g-s">Raf: ' + esc(o.bolge || '—') + ' · ' + esc(kaynakAd(o.kaynak)) + '</div></div>' +
        '<div class="g-q"' + (neg ? ' style="color:var(--bad)"' : '') + '>' + (neg ? '' : '+') + fmtNum(o.miktar) + '</div>' +
        (canCancel && !ipt ? '<button type="button" class="undo" data-iptal="' + esc(o.id) + '" data-m="' + esc(o.miktar) + '" data-t="' + esc(o.ts) + '" data-k="' + esc(o.kisi || '') + '">İptal</button>' : '') + '</div>';
    }).join('');
    setHtml($('#g-list'), (gOffline ? '<p class="small tag wait" style="display:block;padding:8px 10px;border-radius:10px;margin-bottom:8px">Bağlantı yok — yalnız bu cihazın gönderilmemiş kayıtları görünüyor.</p>' : '') +
      (html || '<p class="muted small">Kayıt yok.</p>') + (items.length >= 1000 ? '<p class="muted small">İlk 1000 kayıt gösteriliyor.</p>' : ''));
  }
  const kaynakAd = (k) => ({ kamera: 'kamera', okuyucu: 'okuyucu', elle: 'barkodsuz', manuel: 'elle yazıldı' }[k] || '—');
  $('#g-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-iptal]'); if (!b || !gRow) return;
    const m = Number(b.dataset.m);
    if (!confirm('Bu okutma iptal edilsin mi?\n\n' + (gRow.b || gRow.a) + '\n' + fmtNum(m) + ' ' + gRow.u + ' · ' + (b.dataset.k || '—') + ' · ' + fmtTime(Number(b.dataset.t)) + '\n\nKayıt silinmez, "iptal" olarak işaretlenir.')) return;
    cancelEvent(b.dataset.iptal, gRow.g, gRow.u, m);
    renderGecmis();
    toast('İptal edildi', 'ok');
  });
  function cancelEvent(id, g, u, m) {
    const box = obLoad();
    if (box.some((o) => o.tip === 'iptal' && o.id === id)) return;
    enqueue({ tip: 'iptal', id, kisi: S.kisi || null, ts: Date.now(), g, u, m });
    const rec = LS.get(recKey(), []) || [];
    const it = rec.find((x) => x.id === id); if (it) { it.iptal = true; LS.set(recKey(), rec); }
    renderAll();
  }

  // ---------- son kayıtlarım ----------
  function addRecent(op) {
    const rec = LS.get(recKey(), []) || [];
    rec.unshift({ id: op.id, barkod: op.barkod || null, ad: op.ad || null, miktar: op.miktar, birim: op.birim, bolge: op.bolge || null, ts: op.ts });
    LS.set(recKey(), rec.slice(0, 40));
  }
  function renderRecent() {
    if (S.rol !== 'yaz' || !S.sayimId) return;
    const rec = (LS.get(recKey(), []) || []).slice(0, 15);
    const pend = new Set(obLoad().filter((o) => o.tip === 'ekle').map((o) => o.id));
    const canCancel = S.durum === 'acik';
    setHtml($('#recent-list'), rec.map((x) => {
      const c = x.barkod ? '<div class="r-c">' + esc(x.barkod) + '</div>' : '<div class="r-c txt">' + esc(x.ad || '—') + '</div>';
      const st = x.iptal ? '<span class="tag bad">iptal</span>' : (pend.has(x.id) ? '<span class="tag wait">gönderilmedi</span>' : '<span class="tag ok">kayıtlı</span>');
      return '<div class="r-item' + (x.iptal ? ' iptal' : '') + '"><div class="r-l">' + c + '<div class="r-s">' + fmtTime(x.ts) + ' · Raf: ' + esc(x.bolge || '—') + ' · ' + st + '</div></div>' +
        '<div class="r-q">' + (x.miktar > 0 ? '+' : '') + fmtNum(x.miktar) + ' <small class="muted">' + esc(x.birim) + '</small></div>' +
        (!x.iptal && canCancel ? '<button type="button" class="undo" data-geri="' + esc(x.id) + '">Geri al</button>' : '') + '</div>';
    }).join('') || '<p class="muted small empty">Henüz kayıt yok.</p>');
  }
  $('#recent-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-geri]'); if (!b) return;
    undoRecent(b.dataset.geri, true);
  });
  function undoRecent(id, ask) {
    const rec = LS.get(recKey(), []) || [];
    const x = rec.find((r) => r.id === id); if (!x || x.iptal) return;
    if (ask && !confirm('Geri alınsın mı?\n\n' + (x.barkod || x.ad) + '  ' + fmtNum(x.miktar) + ' ' + x.birim + ' · ' + fmtTime(x.ts))) return;
    cancelEvent(id, grupOf(x.barkod, x.ad), x.birim, x.miktar);
    toast('Geri alındı', 'ok');
    if (lastAdded && lastAdded.id === id) clearScanCard();
  }

  // ---------- okutma akışı ----------
  let pending = null;       // {code, kaynak}
  let lastAdded = null;     // son eklenen op
  let birimSel = 'adet';
  const isFast = () => $('#hizli').checked;
  $('#hizli').addEventListener('change', () => {
    LS.set('bs2_hizli', isFast());
    if (isFast() && pending) clearScanCard();
    toast(isFast() ? 'Hızlı mod: her okutma = 1 adet. Aynı barkod 1,5 sn kilitli.' : 'Normal mod: okut → miktar → Ekle');
  });

  function addEvent(f) {
    const op = { tip: 'ekle', id: uuid(), barkod: f.barkod || null, ad: f.ad || null, miktar: f.miktar, birim: f.birim, bolge: S.bolge || null, kisi: S.kisi || null, kaynak: f.kaynak, ts: Date.now() };
    enqueue(op);
    addRecent(op);
    renderRecent();
    return op;
  }

  function onCode(raw, kaynak) {
    const code = normCode(raw);
    if (!code || S.rol !== 'yaz' || S.view !== 'sayim') return;
    if (S.durum !== 'acik') { feedback(false); toast('Sayım kapalı', 'bad'); return; }
    if (sheetOpen) { if (kaynak !== 'kamera') { feedback(false); toast('Önce açık pencereyi kapatın', 'bad'); } return; }
    if (S.tab !== 'okut') setTab('okut');
    if (isFast()) {
      const op = addEvent({ barkod: code, miktar: 1, birim: 'adet', kaynak });
      showAdded(op);
      feedback(true);
      return;
    }
    if (pending) {
      if (kaynak === 'kamera') return; // kamera beklerken her şeyi yok sayar (raftaki komşu barkodlar)
      if (pending.code === code) { setQty((parseQty($('#sc-miktar').value) || 0) + 1); feedback(true); return; }
      feedback(false); toast('Önce bekleyen ürünü ekleyin ya da vazgeçin', 'bad'); return;
    }
    openPending(code, kaynak);
    feedback(true);
  }

  function openPending(code, kaynak) {
    pending = { code, kaynak };
    lastAdded = null;
    const card = $('#scan-card');
    card.hidden = false; card.classList.remove('added');
    $('#sc-code').textContent = code;
    $('#sc-code').style.fontFamily = '';
    const ex = merged().find((r) => r.g === 'b:' + code && r.u === 'adet');
    setHtml($('#sc-meta'), 'Miktarı girin, <b>Ekle</b>\'ye basın.' + (ex ? ' Şu ana kadar: <b>' + fmtNum(ex.t) + ' adet</b>' : ' <b>Yeni ürün</b>'));
    $('#sc-pending').hidden = false; $('#sc-fast').hidden = true;
    setBirim('adet');
    setQty(1);
  }
  function setQty(n) {
    const inp = $('#sc-miktar');
    inp.value = n == null ? '' : String(r3(n)).replace('.', ',');
    inp.classList.toggle('neg', Number(n) < 0);
  }
  function setBirim(b) {
    birimSel = b;
    $$('#sc-birim button').forEach((x) => x.classList.toggle('on', x.dataset.b === b));
  }
  $('#sc-birim').addEventListener('click', (e) => { const b = e.target.closest('[data-b]'); if (b) setBirim(b.dataset.b); });
  $$('.qbtn').forEach((b) => b.addEventListener('click', () => {
    const cur = parseQty($('#sc-miktar').value) || 0;
    let n = r3(cur + Number(b.dataset.q));
    if (n === 0) n = Number(b.dataset.q) > 0 ? 1 : -1;
    setQty(n);
  }));
  $('#sc-miktar').addEventListener('input', (e) => e.target.classList.toggle('neg', /^\s*-/.test(e.target.value)));
  $('#sc-miktar').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitPending(); } });
  $('#sc-isaret').addEventListener('click', () => { const n = parseQty($('#sc-miktar').value) || 1; setQty(-n); });
  $('#sc-ekle').addEventListener('click', commitPending);
  $('#sc-vazgec').addEventListener('click', () => { clearScanCard(); toast('Vazgeçildi'); });
  function commitPending() {
    if (!pending) return;
    const n = parseQty($('#sc-miktar').value);
    if (n == null) { feedback(false); toast('Miktar geçersiz (0 olamaz, en fazla 100.000, en çok 3 ondalık)', 'bad'); return; }
    if (S.durum !== 'acik') { feedback(false); toast('Sayım kapalı', 'bad'); return; }
    const op = addEvent({ barkod: pending.code, miktar: n, birim: birimSel, kaynak: pending.kaynak });
    pending = null;
    $('#sc-miktar').blur();
    showAdded(op);
  }
  function showAdded(op) {
    pending = null; lastAdded = op;
    const card = $('#scan-card');
    card.hidden = false; card.classList.add('added');
    $('#sc-code').textContent = op.barkod || op.ad;
    $('#sc-code').style.fontFamily = op.barkod ? '' : 'inherit';
    const row = merged().find((r) => r.g === grupOf(op.barkod, op.ad) && r.u === op.birim);
    setHtml($('#sc-meta'), '<b>' + (op.miktar > 0 ? '+' : '') + fmtNum(op.miktar) + ' ' + esc(op.birim) + '</b> eklendi · bu üründen toplam <b>' + fmtNum(row ? row.t : op.miktar) + ' ' + esc(op.birim) + '</b>');
    $('#sc-pending').hidden = true;
    $('#sc-fast').hidden = false;
    $('#sc-tekrar').hidden = !op.barkod;
    flashCam(true);
  }
  function clearScanCard() {
    pending = null; lastAdded = null;
    $('#scan-card').hidden = true;
    $('#sc-code').style.fontFamily = '';
  }
  $('#sc-tekrar').addEventListener('click', () => {
    if (!lastAdded || !lastAdded.barkod || S.durum !== 'acik') return;
    const op = addEvent({ barkod: lastAdded.barkod, miktar: 1, birim: lastAdded.birim, kaynak: lastAdded.kaynak });
    showAdded(op); feedback(true);
  });
  $('#sc-geri').addEventListener('click', () => { if (lastAdded) undoRecent(lastAdded.id, true); });
  function renderScanState() {
    const closed = S.durum !== 'acik';
    $('#btn-elle').disabled = closed;
    $$('#f-manual input, #f-manual button').forEach((x) => (x.disabled = closed));
    if (closed) clearScanCard();
    renderRecent();
  }

  let manualSrc = null;
  $('#f-manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#manual-in');
    const v = normCode(inp.value);
    if (!v) return;
    inp.value = '';
    onCode(v, manualSrc || 'manuel');
    manualSrc = null;
  });

  // ---------- USB / Bluetooth okuyucu (klavye gibi yazar + Enter) ----------
  // Hızlı karakter dizisi (+Enter) → okuyucu. Odak bir giriş alanındaysa o alana yazılanlar geri alınır.
  // Odak yoksa karakterler barkod alanına yönlendirilir (yavaş okuyucular da çalışsın).
  const KB = { buf: '', t0: 0, last: 0, target: null, startVal: null };
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'sayim' || S.rol !== 'yaz' || S.tab !== 'okut' || sheetOpen) return;
    const now = performance.now();
    const t = e.target;
    const isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Enter') {
      const len = KB.buf.length;
      const fast = len >= 4 && (KB.last - KB.t0) / (len - 1) < 45 && now - KB.last < 150;
      if (fast) {
        e.preventDefault(); e.stopPropagation();
        const code = KB.buf;
        if (KB.target && KB.startVal != null && 'value' in KB.target) KB.target.value = KB.startVal;   // alana yazılanı geri al
        else { const mi = $('#manual-in'); mi.value = mi.value.slice(0, Math.max(0, mi.value.length - len)); } // yönlendirileni geri al
        KB.buf = '';
        onCode(code, 'okuyucu');
        return;
      }
      KB.buf = '';
      if (!isInput && $('#manual-in').value) { e.preventDefault(); manualSrc = 'okuyucu'; $('#f-manual').requestSubmit(); }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (now - KB.last > 80) { KB.buf = ''; KB.t0 = now; KB.target = t; KB.startVal = isInput ? t.value : null; }
      KB.buf += e.key; KB.last = now;
      if (!isInput) { e.preventDefault(); $('#manual-in').value += e.key; }
    }
  }, true);

  // ---------- geri bildirim ----------
  let ac = null;
  function audio() {
    try {
      if (!ac) { const C = window.AudioContext || window.webkitAudioContext; if (C) ac = new C(); }
      if (ac && ac.state === 'suspended') ac.resume();
    } catch (e) { ac = null; }
    return ac;
  }
  document.addEventListener('pointerdown', audio, { passive: true });
  function feedback(ok) {
    try {
      const a = audio();
      if (a) {
        const o = a.createOscillator(), g = a.createGain();
        o.type = ok ? 'square' : 'sawtooth';
        o.frequency.value = ok ? 1760 : 220;
        const d = ok ? 0.09 : 0.35, t0 = a.currentTime;
        g.gain.setValueAtTime(0.15, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + d + 0.02);
      }
    } catch (e) { /* ses yok */ }
    try { if (navigator.vibrate) navigator.vibrate(ok ? 60 : [90, 60, 90]); } catch (e) { /* yok */ }
    flashCam(ok);
  }
  function flashCam(ok) {
    const f = $('#flash'); f.className = 'flash'; void f.offsetWidth; f.className = 'flash ' + (ok ? 'ok' : 'bad');
  }
  let toastT = null;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast'), kind === 'bad' ? 3200 : 1900);
  }

  // ---------- kamera ----------
  let qr = null, camOn = false, camWanted = false, camBusy = false;
  let camLast = { code: null, seen: 0 }, camLastAdd = 0;
  async function camStart() {
    if (camOn || camBusy || S.view !== 'sayim' || S.tab !== 'okut') return;
    if (!window.Html5Qrcode) { toast('Kamera bileşeni yüklenemedi — sayfayı yenileyin. Okuyucu/elle giriş çalışır.', 'bad'); return; }
    camBusy = true;
    try {
      if (!qr) {
        const F = window.Html5QrcodeSupportedFormats;
        qr = new window.Html5Qrcode('reader', {
          verbose: false,
          formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF],
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        });
      }
      await qr.start({ facingMode: 'environment' }, {
        fps: 12,
        qrbox: (w, h) => ({ width: Math.max(120, Math.floor(w * 0.86)), height: Math.max(60, Math.floor(Math.min(h * 0.55, w * 0.42))) }),
        disableFlip: true,
      }, onCam, () => {});
      camOn = true; camWanted = true;
      $('#cam-off').hidden = true; $('#btn-cam-stop').hidden = false;
    } catch (e) {
      camWanted = false;
      toast('Kamera açılamadı. Tarayıcıya kamera izni verin (iPhone: Ayarlar › Safari › Kamera › İzin Ver).', 'bad');
    } finally { camBusy = false; }
  }
  async function camStop(forget) {
    if (forget) camWanted = false;
    if (qr && camOn) { camOn = false; try { await qr.stop(); } catch (e) { /* zaten durmuş */ } }
    $('#cam-off').hidden = false; $('#btn-cam-stop').hidden = true;
  }
  function onCam(text, result) {
    let code = normCode(text);
    const fmt = result && result.result && result.result.format && result.result.format.formatName;
    if (fmt === 'UPC_A' && /^\d{12}$/.test(code)) code = '0' + code; // UPC-A = başında 0 olan EAN-13
    const now = Date.now();
    if (code === camLast.code && now - camLast.seen < CAM_LOCK_MS) {
      camLast.seen = now;
      if (isFast() && lastAdded && lastAdded.barkod === code) showLock();
      return;
    }
    if (pending) { camLast = { code, seen: now }; return; }
    if (isFast() && now - camLastAdd < FAST_GAP_MS) return;
    camLast = { code, seen: now };
    camLastAdd = now;
    onCode(code, 'kamera');
  }
  let lockT = null;
  function showLock() {
    const m = $('#sc-meta');
    if (!m || m.querySelector('.lock')) return;
    const s = document.createElement('span'); s.className = 'lock'; s.textContent = 'kilitli · aynı barkod 1,5 sn sayılmaz';
    m.appendChild(s);
    clearTimeout(lockT); lockT = setTimeout(() => { const l = m.querySelector('.lock'); if (l) l.remove(); }, 1600);
  }
  $('#btn-cam').addEventListener('click', () => { audio(); camStart(); });
  $('#btn-cam-stop').addEventListener('click', () => camStop(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (camOn) { const w = camWanted; camStop(false); camWanted = w; } }
    else if (S.view === 'sayim') { if (camWanted && S.tab === 'okut') camStart(); poll(); if (S.rol === 'yaz') { backoff = 0; scheduleFlush(0); } }
  });

  // ---------- sheet'ler ----------
  let sheetOpen = null;
  function openSheet(id) {
    closeSheet();
    sheetOpen = id;
    $('#sheet-bg').hidden = false; $('#' + id).hidden = false;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    const el = $('#' + sheetOpen); if (el) el.hidden = true;
    $('#sheet-bg').hidden = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (sheetOpen === 'sh-gecmis') gRow = null;
    sheetOpen = null;
  }
  $('#sheet-bg').addEventListener('click', closeSheet);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // elle (barkodsuz) ekleme
  let elleBirim = 'adet';
  $('#btn-elle').addEventListener('click', () => {
    if (S.durum !== 'acik') return;
    const f = $('#f-elle');
    f.ad.value = ''; f.miktar.value = '1'; $('[data-err]', f).textContent = '';
    elleBirim = 'adet'; $$('#elle-birim button').forEach((x) => x.classList.toggle('on', x.dataset.b === 'adet'));
    $('[data-bolge]', f).textContent = S.bolge || '—';
    const adlar = [...new Set(merged().filter((r) => !r.b && r.a).map((r) => r.a))].slice(0, 300);
    setHtml($('#dl-adlar'), adlar.map((a) => '<option value="' + esc(a) + '">').join(''));
    openSheet('sh-elle');
  });
  $('#elle-birim').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]'); if (!b) return;
    elleBirim = b.dataset.b; $$('#elle-birim button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#f-elle').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f);
    const ad = cleanText(f.ad.value);
    const n = parseQty(f.miktar.value);
    if (!ad) return (err.textContent = 'Ürün adı gerekli.');
    if (ad.length > 120) return (err.textContent = 'Ad en fazla 120 karakter.');
    if (n == null) return (err.textContent = 'Miktar geçersiz (0 olamaz, en çok 3 ondalık, örn. 2,5).');
    if (S.durum !== 'acik') return (err.textContent = 'Sayım kapalı.');
    const op = addEvent({ ad, miktar: n, birim: elleBirim, kaynak: 'elle' });
    closeSheet();
    showAdded(op); feedback(true);
  });

  // bölge
  function renderBolge() { $('#bolge-v').textContent = S.bolge || 'Seçilmedi'; }
  $('#btn-bolge').addEventListener('click', () => {
    const f = $('#f-bolge');
    f.bolge.value = S.bolge || '';
    const list = LS.get('bs2_bolgeler_' + S.sayimId, []) || [];
    setHtml($('#bolge-chips'), list.map((b) => '<button type="button" data-bv="' + esc(b) + '">' + esc(b) + '</button>').join(''));
    openSheet('sh-bolge');
  });
  function setBolge(v) {
    S.bolge = v ? cleanText(v).slice(0, 60) || null : null;
    LS.set('bs2_bolge_' + S.sayimId, S.bolge);
    if (S.bolge) {
      const list = (LS.get('bs2_bolgeler_' + S.sayimId, []) || []).filter((x) => x !== S.bolge);
      list.unshift(S.bolge); LS.set('bs2_bolgeler_' + S.sayimId, list.slice(0, 16));
    }
    renderBolge(); closeSheet();
    toast('Raf: ' + (S.bolge || 'bölgesiz'));
  }
  $('#bolge-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-bv]'); if (b) setBolge(b.dataset.bv); });
  $('#bolge-temizle').addEventListener('click', () => setBolge(null));
  $('#f-bolge').addEventListener('submit', (e) => { e.preventDefault(); setBolge(e.target.bolge.value); });

  // kişi
  function setKisi(k) { S.kisi = k; LS.set('bs2_kisi', k); }
  $('#btn-kisi').addEventListener('click', () => { const f = $('#f-kisi'); f.kisi.value = S.kisi || ''; $('[data-err]', f).textContent = ''; openSheet('sh-kisi'); });
  $('#f-kisi').addEventListener('submit', (e) => {
    e.preventDefault();
    const k = cleanText(e.target.kisi.value);
    if (!k) { $('[data-err]', e.target).textContent = 'Ad gerekli.'; return; }
    setKisi(k.slice(0, 40)); closeSheet(); renderHeader(); renderMenu(); toast('Kaydedildi', 'ok');
  });

  // ---------- menü ----------
  const davetUrl = () => location.origin + '/#s=' + S.sayimId;
  const izleUrl = () => (S.izle ? location.origin + '/#izle=' + S.izle : null);
  function renderMenu() {
    if (S.view !== 'sayim') return;
    if (S.sayimId) $('#m-kod').textContent = fmtKod(S.sayimId);
    $('#m-durum').textContent = S.durum === 'kapali' ? 'KAPALI' : 'açık';
    $('#btn-kapat').hidden = S.durum === 'kapali';
    $('#btn-ac').hidden = S.durum !== 'kapali';
    $('#m-kisi').textContent = S.kisi || '—';
    $('#m-ver').textContent = 'Sürüm ' + VER;
    const n = S.rol === 'yaz' ? obLoad().length : 0;
    $('#m-csv-not').textContent = n ? 'Dikkat: bu cihazda henüz gönderilmemiş ' + n + ' kayıt var; CSV yalnız sunucudaki kayıtları içerir.' : '';
  }
  async function shareOrCopy(kind, share) {
    const url = kind === 'izle' ? izleUrl() : davetUrl();
    if (!url) { toast('Link henüz alınamadı — bağlantıyı kontrol edin', 'bad'); return; }
    const text = kind === 'izle' ? S.ad + ' — canlı sayım listesi (salt-okunur)' : S.ad + ' sayımına katıl (PIN ayrıca verilecek)';
    if (share && navigator.share) { try { await navigator.share({ title: S.ad, text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); toast('Link kopyalandı', 'ok'); }
    catch (e) { window.prompt('Linki kopyalayın:', url); }
  }
  $$('[data-share]').forEach((b) => b.addEventListener('click', () => shareOrCopy(b.dataset.share, true)));
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => shareOrCopy(b.dataset.copy, false)));
  $$('[data-csv]').forEach((b) => b.addEventListener('click', async () => {
    const tur = b.dataset.csv;
    b.disabled = true;
    try {
      let res;
      try { res = await fetch('/api/sayim/' + S.sayimId + '/csv?tur=' + tur, { headers: { Authorization: 'Bearer ' + S.token }, cache: 'no-store' }); }
      catch (e) { throw new Error('Bağlantı yok — CSV indirilemedi'); }
      if (!res.ok) { let m = 'Hata ' + res.status; try { m = (await res.json()).error || m; } catch (e) { /* */ } throw new Error(m); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const mm = cd.match(/filename="([^"]+)"/);
      const name = mm ? mm[1] : 'sayim-' + tur + '.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
      toast('İndirildi: ' + name, 'ok');
    } catch (e) { toast(e.message, 'bad'); }
    finally { b.disabled = false; }
  }));

  // PIN onaylı işlemler
  let pinAction = null;
  function askPin(title, msg, action) {
    pinAction = action;
    $('#pin-t').textContent = title; $('#pin-msg').textContent = msg;
    const f = $('#f-pin'); f.pin.value = ''; $('[data-err]', f).textContent = '';
    openSheet('sh-pin');
  }
  $('#f-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, err = $('[data-err]', f), pin = f.pin.value.trim();
    if (!/^\d{4,12}$/.test(pin)) { err.textContent = 'PIN 4-12 haneli rakam.'; return; }
    const btn = $('#pin-ok'); btn.disabled = true;
    try { await pinAction(pin); closeSheet(); }
    catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });
  $('#btn-kapat').addEventListener('click', () => {
    const n = obLoad().length;
    askPin('Sayımı kapat', (n ? 'UYARI: bu cihazda gönderilmemiş ' + n + ' kayıt var. ' : '') + 'Kapatınca hiçbir telefon yeni kayıt giremez. Diğer telefonların "Gönderildi ✓" gösterdiğinden emin olun.', async (pin) => {
      const r = await api('POST', '/api/sayim/' + S.sayimId + '/durum', { durum: 'kapali', pin });
      setDurum(r.sayim.durum); poll(); toast('Sayım kapatıldı', 'ok');
    });
  });
  $('#btn-ac').addEventListener('click', () => {
    askPin('Sayımı yeniden aç', 'Açılınca kayıt girişi tekrar başlar.', async (pin) => {
      const r = await api('POST', '/api/sayim/' + S.sayimId + '/durum', { durum: 'acik', pin });
      setDurum(r.sayim.durum); S.closedBlock = false; scheduleFlush(0); poll(); toast('Sayım açıldı', 'ok');
    });
  });
  $('#btn-cik').addEventListener('click', () => {
    const n = obLoad().length;
    if (n) { toast('Önce gönderilmemiş ' + n + ' kaydın gitmesini bekleyin', 'bad'); return; }
    if (!confirm('Bu cihaz sayımdan çıksın mı? Tekrar katılmak için link + PIN gerekir. Kayıtlar silinmez.')) return;
    removeSession(S.sayimId);
    LS.del('bs2_son_' + S.sayimId);
    location.hash = '';
  });

  // sekmeler
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });

  // ağ olayları
  window.addEventListener('online', () => { S.online = true; backoff = 0; scheduleFlush(0); poll(); updateSync(); updateBanner(); });
  window.addEventListener('offline', () => { S.online = false; updateSync(); updateBanner(); });
  window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('bs2_ob_')) { updateSync(); renderAll(); } });
  window.addEventListener('hashchange', route);

  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch (e) { /* yok */ } }

  // test kancası: yalnız istemci içi (kod enjekte / durum okuma); sunucu yetkisini aşmaz
  window.__bs = { onCode, state: S, outbox: () => obLoad(), merged, flush, poll };

  route();
})();
