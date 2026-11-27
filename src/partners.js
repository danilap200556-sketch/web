'use strict';
// Источники электроники: Sergeev Electronics и bazaplay.ru. Каждый - отдельный сервис обхода (partner.js со своим профилем),
// здесь они собраны в один объект, чтобы каталог, заказы, фото и админка не зависели от числа источников.
// Методы без указания источника (syncListings, syncDetails, status, tick, source, base) работают с первым источником - Sergeev.
const { createPartner, SERGEEV } = require('./partner');
const { BAZA } = require('./baza');

function createPartners(deps) {
  const list = [createPartner(deps, SERGEEV), createPartner(deps, BAZA)];
  const primary = list[0];
  const get = (source) => list.find((p) => p.source === source) || null;
  // Номер строки ext_products -> её источник (фото и карточки открывает сервис того сайта, откуда товар)
  const ownerOf = async (id) => {
    const { rows } = await deps.db.query('SELECT source FROM webshop.ext_products WHERE id = $1', [id]);
    return rows[0] ? get(rows[0].source) : null;
  };
  return {
    list, get, primary,
    source: primary.source, base: primary.base,
    sources: list.map((p) => p.source),
    bases: Object.fromEntries(list.map((p) => [p.source, p.base])),
    enabled: () => list.some((p) => p.enabled()),
    rows: async () => (await Promise.all(list.map((p) => p.rows()))).flat(),
    description: (id) => primary.description(id),
    status: () => primary.status(),
    syncListings: (...a) => primary.syncListings(...a),
    syncDetails: (...a) => primary.syncDetails(...a),
    tick: () => primary.tick(),
    verify: (path, source = primary.source) => (get(source) || primary).verify(path),
    fetchImage: async (id, idx) => { const p = await ownerOf(id); return p ? p.fetchImage(id, idx) : null; },
    imageUrl: async (id, idx) => { const p = await ownerOf(id); return p ? p.imageUrl(id, idx) : ''; },
    refreshDetail: async (id) => { const p = await ownerOf(id); if (p) await p.refreshDetail(id); },
    // Запускает обход каталога: у одного источника или у всех включённых. true - хотя бы один запущен.
    syncNow(source) {
      let started = false;
      for (const p of list) if ((!source || p.source === source) && p.syncNow()) started = true;
      return started;
    },
    start(opts) { for (const p of list) p.start(opts); },
    async stop() { await Promise.all(list.map((p) => p.stop())); },
  };
}

module.exports = { createPartners };
