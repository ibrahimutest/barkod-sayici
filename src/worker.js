/**
 * Barkod Sayıcı v2 — TEK Worker: statik assets (public/) + JSON API (/api/*, D1)
 *
 * Tasarım ilkeleri (ticari devralma sayımı):
 *  - Olay kaydı: her okutma ayrı satır, id istemcide üretilen UUID → INSERT OR IGNORE (aynı olay iki kez gelse tek yazılır).
 *  - Toplam = SUM(miktar) WHERE iptal=0. Oku-sonra-yaz YOK → eşzamanlı telefonlarda artış kaybolmaz.
 *  - Fiziksel silme yok; iptal = soft-delete (kim + ne zaman).
 *  - Yetki sunucuda: Authorization: Bearer <token>. Yazma token'ı (PIN ile alınır) / izleme token'ı (salt-okunur → yazarsa 403).
 *
 * Uçlar:
 *   POST /api/sayim                 {ad, pin, kisi}            → {sayim, token, izle_token}
 *   GET  /api/sayim/:id/bilgi                                  → {ad, durum}            (oturumsuz; katılma ekranı için)
 *   POST /api/sayim/:id/katil       {pin, kisi}                → {token}                (IP başına deneme limiti)
 *   GET  /api/ben                                              → {rol, sayim, izle_token?}
 *   POST /api/sayim/:id/olay        {ops:[{tip:'ekle'|'iptal', ...}]} → {sonuc:[{id, durum:'ok'|'red'|'yok', hata?}], surum}
 *   GET  /api/sayim/:id/ozet?surum=N                           → {surum, durum, satirlar} | {surum, degismedi:true}
 *   GET  /api/sayim/:id/gecmis?g=&u=                           → {olaylar}
 *   GET  /api/sayim/:id/csv?tur=ozet|detay                     → text/csv (UTF-8 BOM, ';')
 *   POST /api/sayim/:id/durum       {durum:'kapali'|'acik', pin}  (yazma + PIN)
 */

const PBKDF2_ITER = 100000;
const FAIL_LIMIT = 8;            // 8 yanlış PIN...
const FAIL_WINDOW_MS = 10 * 60 * 1000;  // ...10 dk içinde → 429
const SESSION_MS = 14 * 86400000;
const MAX_OPS = 200;
const MAX_MIKTAR = 100000;
const BIRIMLER = ['adet', 'kg'];
const KAYNAKLAR = ['kamera', 'okuyucu', 'elle', 'manuel'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('api hata:', e && e.stack ? e.stack : e);
      return json({ error: 'sunucu hatası' }, 500);
    }
  },
};

// ---------- yardımcılar ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS } });
}
async function readBody(request) {
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) fail(415, 'Content-Type application/json olmalı');
  let b;
  try { b = await request.json(); } catch { fail(400, 'geçersiz JSON'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'geçersiz gövde');
  return b;
}
// Metin temizliği: kontrol karakterleri at, boşlukları sadeleştir, uzunluk sınırı.
function cleanText(v, max) {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? null : s;
}
function reqText(v, name, max) {
  const s = cleanText(v, max);
  if (!s) fail(400, name + ' gerekli (en fazla ' + max + ' karakter)');
  return s;
}
function checkPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) fail(400, 'PIN 4-12 haneli rakam olmalı');
  return pin;
}

// ---------- kripto ----------
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
const randHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2Hex(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITER }, key, 256);
  return toHex(bits);
}
async function sha256Hex(s) { return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function safeEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string' || aHex.length !== bHex.length) return false;
  const a = fromHex(aHex), b = fromHex(bHex);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- deneme limiti (IP başına) ----------
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';
async function assertNotLocked(request, env) {
  const row = await env.DB.prepare('SELECT sayac, son FROM deneme WHERE ip = ?').bind(clientIp(request)).first();
  if (row && row.sayac >= FAIL_LIMIT && Date.now() - row.son < FAIL_WINDOW_MS) fail(429, 'Çok fazla yanlış PIN. 10 dakika sonra tekrar deneyin.');
}
async function recordFail(request, env) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO deneme(ip, sayac, son) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET ' +
    'sayac = CASE WHEN ? - son >= ? THEN 1 ELSE sayac + 1 END, son = ?'
  ).bind(clientIp(request), now, now, FAIL_WINDOW_MS, now).run();
}
const clearFail = (request, env) => env.DB.prepare('DELETE FROM deneme WHERE ip = ?').bind(clientIp(request)).run();

async function verifyPin(request, env, sayim, pin) {
  await assertNotLocked(request, env);
  const ok = typeof pin === 'string' && /^\d{4,12}$/.test(pin) && safeEqual(await pbkdf2Hex(pin, sayim.pin_salt), sayim.pin_hash);
  if (!ok) { await recordFail(request, env); fail(401, 'PIN yanlış'); }
  await clearFail(request, env);
}

// ---------- kimlik ----------
// Dönen: {rol:'yaz'|'izle', sayim_id, kisi} | null
async function auth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const tok = m[1];
  if (tok.startsWith('y')) {
    const row = await env.DB.prepare('SELECT sayim_id, kisi, bitis FROM oturum WHERE token_hash = ?').bind(await sha256Hex(tok)).first();
    if (!row || row.bitis < Date.now()) return null;
    return { rol: 'yaz', sayim_id: row.sayim_id, kisi: row.kisi };
  }
  if (tok.startsWith('i')) {
    const row = await env.DB.prepare('SELECT id FROM sayim WHERE izle_token = ?').bind(tok).first();
    if (!row) return null;
    return { rol: 'izle', sayim_id: row.id };
  }
  return null;
}
function requireAccess(a, sayimId) {
  if (!a) fail(401, 'oturum gerekli');
  if (a.sayim_id !== sayimId) fail(403, 'bu sayıma yetkiniz yok');
  return a;
}
function requireWrite(a, sayimId) {
  requireAccess(a, sayimId);
  if (a.rol !== 'yaz') fail(403, 'izleme linki salt-okunurdur');
  return a;
}
async function newSession(env, sayimId, kisi) {
  const token = 'y' + randHex(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO oturum(token_hash, sayim_id, kisi, olusturma, bitis) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), sayimId, kisi, now, now + SESSION_MS).run();
  return token;
}
const getSayim = (env, id) => env.DB.prepare('SELECT * FROM sayim WHERE id = ?').bind(id).first();
const pubSayim = (s) => ({ id: s.id, ad: s.ad, durum: s.durum, olusturma: s.olusturma, kapanis: s.kapanis || null });

// Gruplama anahtarı: barkod varsa barkod; yoksa normalize edilmiş ad (TR küçük harf).
function grupOf(barkod, ad) {
  if (barkod) return 'b:' + barkod;
  return 'a:' + ad.toLocaleLowerCase('tr-TR');
}

// ---------- yönlendirme ----------
async function handleApi(request, env, url) {
  const method = request.method.toUpperCase();
  const parts = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
  const [res, id, sub] = parts;

  if (res === 'sayim' && !id && method === 'POST') return createSayim(request, env);
  if (res === 'ben' && method === 'GET') {
    const a = await auth(request, env);
    if (!a) fail(401, 'oturum geçersiz');
    const s = await getSayim(env, a.sayim_id);
    if (!s) fail(404, 'sayım bulunamadı');
    const out = { rol: a.rol, sayim: pubSayim(s) };
    if (a.rol === 'yaz') out.izle_token = s.izle_token;
    return json(out);
  }
  if (res === 'sayim' && id) {
    if (!/^[0-9a-f]{12}$/.test(id)) fail(404, 'sayım bulunamadı');
    if (sub === 'bilgi' && method === 'GET') {
      const s = await getSayim(env, id);
      if (!s) fail(404, 'sayım bulunamadı');
      return json({ ad: s.ad, durum: s.durum });
    }
    if (sub === 'katil' && method === 'POST') return joinSayim(request, env, id);
    const a = await auth(request, env);
    if (sub === 'olay' && method === 'POST') return postOlay(request, env, requireWrite(a, id), id);
    if (sub === 'ozet' && method === 'GET') { requireAccess(a, id); return getOzet(env, id, url); }
    if (sub === 'gecmis' && method === 'GET') { requireAccess(a, id); return getGecmis(env, id, url); }
    if (sub === 'csv' && method === 'GET') { requireAccess(a, id); return getCsv(env, id, url); }
    if (sub === 'durum' && method === 'POST') return setDurum(request, env, requireWrite(a, id), id);
  }
  fail(404, 'bulunamadı');
}

async function createSayim(request, env) {
  const b = await readBody(request);
  const ad = reqText(b.ad, 'Sayım adı', 80);
  const pin = checkPin(b.pin);
  const kisi = reqText(b.kisi, 'Adınız', 40);
  const id = randHex(6);
  const salt = randHex(16);
  const izle = 'i' + randHex(20);
  await env.DB.prepare('INSERT INTO sayim(id, ad, pin_salt, pin_hash, izle_token, durum, surum, olusturan, olusturma) VALUES (?, ?, ?, ?, ?, \'acik\', 0, ?, ?)')
    .bind(id, ad, salt, await pbkdf2Hex(pin, salt), izle, kisi, Date.now()).run();
  const token = await newSession(env, id, kisi);
  const s = await getSayim(env, id);
  return json({ sayim: pubSayim(s), token, izle_token: izle }, 201);
}

async function joinSayim(request, env, id) {
  const b = await readBody(request);
  const s = await getSayim(env, id);
  if (!s) fail(404, 'sayım bulunamadı');
  const kisi = reqText(b.kisi, 'Adınız', 40);
  await verifyPin(request, env, s, b.pin);
  const token = await newSession(env, id, kisi);
  return json({ token, sayim: pubSayim(s), izle_token: s.izle_token });
}

async function setDurum(request, env, a, id) {
  const b = await readBody(request);
  const s = await getSayim(env, id);
  if (!s) fail(404, 'sayım bulunamadı');
  if (b.durum !== 'kapali' && b.durum !== 'acik') fail(400, 'durum geçersiz');
  await verifyPin(request, env, s, b.pin);
  await env.DB.prepare('UPDATE sayim SET durum = ?, kapanis = ?, surum = surum + 1 WHERE id = ?')
    .bind(b.durum, b.durum === 'kapali' ? Date.now() : null, id).run();
  return json({ sayim: pubSayim(await getSayim(env, id)) });
}

// Bir "ekle" op'unu doğrula → satır ya da hata metni
function validateEkle(op, a) {
  if (typeof op.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(op.id)) return { hata: 'id geçersiz' };
  let barkod = null;
  if (op.barkod != null && op.barkod !== '') {
    barkod = String(op.barkod).replace(/\s+/g, '');
    if (!barkod || barkod.length > 64 || /[\u0000-\u001f\u007f]/.test(barkod)) return { hata: 'barkod geçersiz' };
  }
  const ad = cleanText(op.ad, 120);
  if (op.ad != null && op.ad !== '' && !ad) return { hata: 'ad çok uzun' };
  if (!barkod && !ad) return { hata: 'barkod veya ad gerekli' };
  const miktar = Number(op.miktar);
  if (!Number.isFinite(miktar) || miktar === 0 || Math.abs(miktar) > MAX_MIKTAR) return { hata: 'miktar geçersiz' };
  const birim = BIRIMLER.includes(op.birim) ? op.birim : null;
  if (!birim) return { hata: 'birim geçersiz' };
  const bolge = cleanText(op.bolge, 60);
  const kisi = cleanText(op.kisi, 40) || a.kisi || null;
  const kaynak = KAYNAKLAR.includes(op.kaynak) ? op.kaynak : null;
  let ts = Number(op.ts);
  if (!Number.isFinite(ts) || ts < 1.7e12 || ts > Date.now() + 86400000) ts = Date.now();
  return { row: { id: op.id.toLowerCase(), grup: grupOf(barkod, ad), barkod, ad, miktar: Math.round(miktar * 1000) / 1000, birim, bolge, kisi, kaynak, ts: Math.round(ts) } };
}

async function postOlay(request, env, a, id) {
  const b = await readBody(request);
  const ops = b.ops;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) fail(400, 'ops 1-' + MAX_OPS + ' öğe olmalı');
  const s = await getSayim(env, id);
  if (!s) fail(404, 'sayım bulunamadı');
  if (s.durum !== 'acik') fail(409, 'Sayım kapalı — yeni kayıt alınmıyor');

  const now = Date.now();
  const sonuc = [];
  const stmts = [];
  const idx = []; // stmts[i] → sonuc index
  for (const op of ops) {
    const oid = op && typeof op.id === 'string' ? op.id.toLowerCase() : null;
    if (!op || typeof op !== 'object') { sonuc.push({ id: null, durum: 'red', hata: 'geçersiz op' }); continue; }
    if (op.tip === 'ekle') {
      const v = validateEkle(op, a);
      if (v.hata) { sonuc.push({ id: oid, durum: 'red', hata: v.hata }); continue; }
      const r = v.row;
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO olay(id, sayim_id, grup, barkod, ad, miktar, birim, bolge, kisi, kaynak, ts, sunucu_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(r.id, id, r.grup, r.barkod, r.ad, r.miktar, r.birim, r.bolge, r.kisi, r.kaynak, r.ts, now));
      idx.push(sonuc.length); sonuc.push({ id: r.id, durum: 'ok', tip: 'ekle' });
    } else if (op.tip === 'iptal') {
      if (!oid || !/^[0-9a-f-]{36}$/.test(oid)) { sonuc.push({ id: oid, durum: 'red', hata: 'id geçersiz' }); continue; }
      const kisi = cleanText(op.kisi, 40) || a.kisi || null;
      stmts.push(env.DB.prepare('UPDATE olay SET iptal = 1, iptal_eden = ?, iptal_ts = ? WHERE id = ? AND sayim_id = ? AND iptal = 0')
        .bind(kisi, now, oid, id));
      idx.push(sonuc.length); sonuc.push({ id: oid, durum: 'ok', tip: 'iptal' });
    } else {
      sonuc.push({ id: oid, durum: 'red', hata: 'tip geçersiz' });
    }
  }
  if (stmts.length) {
    // Tek batch = tek işlem (atomik). Sıra korunur: aynı istekte önce ekle sonra iptal gelirse iptal geçerli olur.
    stmts.push(env.DB.prepare('UPDATE sayim SET surum = surum + 1 WHERE id = ?').bind(id));
    const results = await env.DB.batch(stmts);
    // changes=0 olan iptaller: zaten iptal mi, hiç yok mu?
    const bak = [];
    for (let i = 0; i < idx.length; i++) {
      const so = sonuc[idx[i]];
      if (so.tip === 'iptal' && !(results[i].meta && results[i].meta.changes)) bak.push(so);
    }
    for (const so of bak) {
      const ex = await env.DB.prepare('SELECT 1 FROM olay WHERE id = ? AND sayim_id = ?').bind(so.id, id).first();
      if (!ex) { so.durum = 'yok'; so.hata = 'iptal edilecek kayıt bulunamadı'; }
    }
  }
  for (const so of sonuc) delete so.tip;
  const sv = await env.DB.prepare('SELECT surum FROM sayim WHERE id = ?').bind(id).first();
  return json({ sonuc, surum: sv ? sv.surum : null });
}

async function getOzet(env, id, url) {
  const s = await env.DB.prepare('SELECT surum, durum, ad, kapanis FROM sayim WHERE id = ?').bind(id).first();
  if (!s) fail(404, 'sayım bulunamadı');
  const bilinen = url.searchParams.get('surum');
  if (bilinen != null && Number(bilinen) === s.surum) return json({ surum: s.surum, durum: s.durum, degismedi: true });
  const r = await env.DB.prepare(
    'SELECT grup AS g, birim AS u, MAX(barkod) AS b, MIN(ad) AS a, ROUND(SUM(miktar), 3) AS t, COUNT(*) AS n, MAX(ts) AS s ' +
    'FROM olay WHERE sayim_id = ? AND iptal = 0 GROUP BY grup, birim ORDER BY s DESC'
  ).bind(id).all();
  return json({ surum: s.surum, durum: s.durum, ad: s.ad, kapanis: s.kapanis || null, satirlar: r.results || [] });
}

async function getGecmis(env, id, url) {
  const g = url.searchParams.get('g') || '';
  const u = url.searchParams.get('u') || '';
  if (!g || g.length > 200 || !BIRIMLER.includes(u)) fail(400, 'g ve u gerekli');
  const r = await env.DB.prepare(
    'SELECT id, barkod, ad, miktar, birim, bolge, kisi, kaynak, ts, iptal, iptal_eden, iptal_ts FROM olay ' +
    'WHERE sayim_id = ? AND grup = ? AND birim = ? ORDER BY ts DESC LIMIT 1000'
  ).bind(id, g, u).all();
  return json({ olaylar: r.results || [] });
}

// ---------- CSV (Excel TR) ----------
// ';' ayırıcı, UTF-8 BOM, CRLF. Sayı: binlik ayırıcı yok, ondalık virgül (TR Excel "1.5"i tarih/metin sanar).
// Barkod: ="0123..." → Excel metin olarak gösterir: baştaki sıfır ve 13 hane bilimsel gösterime (8,69E+12) düşmez.
// Ad metinleri: formül enjeksiyonuna karşı = + - @ ile başlıyorsa başına ' eklenir.
function csvNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const r = Math.round(Number(n) * 1000) / 1000;
  return String(r).replace('.', ',');
}
function csvText(s) {
  if (s == null) return '';
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[;"\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function csvBarkod(b) {
  if (!b) return '';
  return '"=""' + String(b).replace(/"/g, '') + '"""';
}
function trTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + 3 * 3600000); // Türkiye UTC+3 (yaz saati yok)
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
async function getCsv(env, id, url) {
  const tur = url.searchParams.get('tur') === 'detay' ? 'detay' : 'ozet';
  const s = await getSayim(env, id);
  if (!s) fail(404, 'sayım bulunamadı');
  const lines = [];
  if (tur === 'ozet') {
    lines.push('barkod;ad;birim;toplam_miktar;okutma_sayisi');
    const r = await env.DB.prepare(
      'SELECT MAX(barkod) AS b, MIN(ad) AS a, birim AS u, ROUND(SUM(miktar), 3) AS t, COUNT(*) AS n FROM olay ' +
      'WHERE sayim_id = ? AND iptal = 0 GROUP BY grup, birim ORDER BY (MAX(barkod) IS NULL), MAX(barkod), MIN(ad)'
    ).bind(id).all();
    for (const x of r.results || []) lines.push([csvBarkod(x.b), csvText(x.a), x.u, csvNum(x.t), x.n].join(';'));
  } else {
    lines.push('olay_id;zaman;barkod;ad;miktar;birim;bolge;kisi;kaynak;durum;iptal_eden;iptal_zamani;sunucu_zamani');
    const r = await env.DB.prepare(
      'SELECT id, ts, barkod, ad, miktar, birim, bolge, kisi, kaynak, iptal, iptal_eden, iptal_ts, sunucu_ts FROM olay WHERE sayim_id = ? ORDER BY ts, sunucu_ts'
    ).bind(id).all();
    for (const x of r.results || []) {
      lines.push([x.id, trTime(x.ts), csvBarkod(x.barkod), csvText(x.ad), csvNum(x.miktar), x.birim, csvText(x.bolge), csvText(x.kisi), x.kaynak || '',
        x.iptal ? 'iptal' : 'gecerli', csvText(x.iptal_eden), trTime(x.iptal_ts), trTime(x.sunucu_ts)].join(';'));
    }
  }
  const slug = s.ad.toLocaleLowerCase('tr-TR').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sayim';
  const stamp = trTime(Date.now()).replace(/[-: ]/g, '').slice(0, 12);
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  return new Response(body, {
    headers: {
      ...SEC_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sayim-' + slug + '-' + tur + '-' + stamp + '.csv"',
    },
  });
}
