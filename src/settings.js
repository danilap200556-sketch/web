'use strict';
// Настройки магазина: каждая лежит строкой в webshop.settings (JSON). Читаются с кэшем на 10 секунд.
const TTL = 10_000;

function defaults(cfg) {
  return {
    shopName: cfg.shopName,
    phone: '+7 (495) 000-00-00',
    email: 'hello@example.ru',
    address: 'Москва, ул. Примерная, 1',
    hours: 'Ежедневно 11:00-21:00',
    telegram: '',
    seasonMode: 'auto',           // auto | winter | spring | summer | autumn
    heroOverrides: {},            // { autumn: { eyebrow, title, text } }
    requirePhoto: true,           // не показывать модели без фото
    electronicsTeaser: true,      // плашка «скоро электроника» на главной
    freeShippingNote: true,       // показывать порог бесплатной доставки в шапке
    notifyEmail: '',
  };
}

function createSettings(db, cfg) {
  let cache = null;
  let at = 0;
  const base = defaults(cfg);

  async function get() {
    if (cache && Date.now() - at < TTL) return cache;
    const { rows } = await db.query('SELECT key, value FROM webshop.settings');
    const out = { ...base };
    for (const r of rows) if (r.key in base) out[r.key] = r.value;
    cache = out;
    at = Date.now();
    return out;
  }

  async function set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in base)) continue;
      await db.query(
        `INSERT INTO webshop.settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, JSON.stringify(v)]);
    }
    cache = null;
  }

  return { get, set, defaults: base, invalidate: () => { cache = null; } };
}

module.exports = { createSettings };
