-- Barkod Sayıcı v2 — D1 şeması (idempotent; tekrar çalıştırılabilir)
-- Kurulum: wrangler d1 execute barkod-sayici --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS sayim (
  id          TEXT PRIMARY KEY,          -- rastgele 12 hex (link: /#s=<id>)
  ad          TEXT NOT NULL,
  pin_salt    TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,             -- PBKDF2-SHA256 100k
  izle_token  TEXT NOT NULL UNIQUE,      -- salt-okunur izleme linki
  durum       TEXT NOT NULL DEFAULT 'acik',   -- acik | kapali
  surum       INTEGER NOT NULL DEFAULT 0,     -- her değişiklikte +1 (polling "değişti mi?")
  olusturan   TEXT,
  olusturma   INTEGER NOT NULL,          -- ms
  kapanis     INTEGER
);

-- Yazma oturumu (PIN ile katılan cihaz). Token düz saklanmaz: SHA-256.
CREATE TABLE IF NOT EXISTS oturum (
  token_hash  TEXT PRIMARY KEY,
  sayim_id    TEXT NOT NULL,
  kisi        TEXT,
  olusturma   INTEGER NOT NULL,
  bitis       INTEGER NOT NULL
);

-- Olay kaydı: her okutma/ekleme/düzeltme bir satır. Fiziksel silme YOK; iptal = soft-delete.
CREATE TABLE IF NOT EXISTS olay (
  id          TEXT PRIMARY KEY,          -- istemcide üretilen UUID (idempotent INSERT OR IGNORE)
  sayim_id    TEXT NOT NULL,
  grup        TEXT NOT NULL,             -- 'b:<barkod>' veya 'a:<normalize ad>' (gruplama anahtarı)
  barkod      TEXT,
  ad          TEXT,
  miktar      REAL NOT NULL,             -- düzeltmede negatif olabilir
  birim       TEXT NOT NULL,             -- adet | kg
  bolge       TEXT,
  kisi        TEXT,
  kaynak      TEXT,                      -- kamera | okuyucu | elle | manuel
  ts          INTEGER NOT NULL,          -- cihazda okutma anı (ms)
  sunucu_ts   INTEGER NOT NULL,          -- sunucuya ulaştığı an (ms)
  iptal       INTEGER NOT NULL DEFAULT 0,
  iptal_eden  TEXT,
  iptal_ts    INTEGER
);
CREATE INDEX IF NOT EXISTS olay_sayim_grup ON olay(sayim_id, grup, birim);
CREATE INDEX IF NOT EXISTS olay_sayim_ts ON olay(sayim_id, ts);

-- PIN deneme limiti (IP başına)
CREATE TABLE IF NOT EXISTS deneme (
  ip          TEXT PRIMARY KEY,
  sayac       INTEGER NOT NULL,
  son         INTEGER NOT NULL
);
