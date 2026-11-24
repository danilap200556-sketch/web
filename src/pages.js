'use strict';
// Текстовые страницы магазина из админки: «О нас», «Пользовательское соглашение», «Политика конфиденциальности», FAQ и любые свои.
// Адрес страницы - /info/<slug>. Опубликованные с галочкой «в подвале» стоят в колонке «Информация»,
// «terms» и «privacy» - ещё и в нижней строке подвала, как у больших магазинов.
const TTL = 30_000;

// Заготовки: кнопка в админке создаёт черновик с готовым адресом и заголовком (текст пишет магазин)
const PRESETS = [
  { slug: 'about', title: 'О нас', sort: 10 },
  { slug: 'terms', title: 'Пользовательское соглашение', sort: 80 },
  { slug: 'privacy', title: 'Политика конфиденциальности', sort: 90 },
  { slug: 'faq', title: 'Вопросы и ответы', sort: 40 },
  { slug: 'service', title: 'Условия обслуживания', sort: 50 },
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Адреса, которые заняты разделами сайта: страницу с таким адресом не создать (её всё равно не открыть по /info, но путает)
const RESERVED = new Set(['contacts', 'delivery', 'brands', 'catalog', 'cart', 'checkout', 'favorites', 'account', 'login', 'admin']);

function createPages(db) {
  let cache = null;
  let at = 0;

  async function all() {
    if (cache && Date.now() - at < TTL) return cache;
    const { rows } = await db.query('SELECT id, slug, title, body, published, in_footer, sort, updated_at FROM webshop.pages ORDER BY sort, title');
    cache = rows;
    at = Date.now();
    return rows;
  }
  const invalidate = () => { cache = null; };

  async function footer() {
    const list = (await all()).filter((p) => p.published && p.body.trim());
    return {
      info: list.filter((p) => p.in_footer).map((p) => ({ slug: p.slug, title: p.title })),
      terms: list.some((p) => p.slug === 'terms'),
      privacy: list.some((p) => p.slug === 'privacy'),
    };
  }

  async function bySlug(slug) {
    return (await all()).find((p) => p.slug === slug) || null;
  }

  function validate(v) {
    const slug = String(v.slug || '').trim().toLowerCase();
    const title = String(v.title || '').trim().slice(0, 120);
    if (!SLUG_RE.test(slug)) return { error: 'Адрес страницы: латиница, цифры и дефис, например about или dostavka-v-regiony' };
    if (RESERVED.has(slug)) return { error: `Адрес «${slug}» занят разделом сайта, выберите другой` };
    if (!title) return { error: 'Нужен заголовок страницы' };
    const sort = Math.max(0, Math.min(9999, parseInt(v.sort, 10) || 100));
    return { value: { slug, title, body: String(v.body || '').replace(/\r/g, '').slice(0, 60000), published: Boolean(v.published), in_footer: Boolean(v.in_footer), sort } };
  }

  async function save(id, v) {
    const r = validate(v);
    if (r.error) return r;
    const x = r.value;
    try {
      if (id) {
        const u = await db.query(`UPDATE webshop.pages SET slug = $2, title = $3, body = $4, published = $5, in_footer = $6, sort = $7, updated_at = NOW() WHERE id = $1 RETURNING id`,
          [id, x.slug, x.title, x.body, x.published, x.in_footer, x.sort]);
        if (!u.rowCount) return { error: 'Страница не найдена' };
      } else {
        const ins = await db.query('INSERT INTO webshop.pages (slug, title, body, published, in_footer, sort) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [x.slug, x.title, x.body, x.published, x.in_footer, x.sort]);
        id = ins.rows[0].id;
      }
    } catch (e) {
      if (e.code === '23505') return { error: `Страница с адресом «${x.slug}» уже есть` };
      throw e;
    }
    invalidate();
    return { id };
  }

  async function remove(id) {
    await db.query('DELETE FROM webshop.pages WHERE id = $1', [id]);
    invalidate();
  }

  return { all, footer, bySlug, save, remove, invalidate, PRESETS };
}

module.exports = { createPages, PRESETS, SLUG_RE };
