'use strict';
// Проверка вёрстки: ищет текст, который вылезает за свой блок, обрезается или даёт горизонтальную прокрутку страницы,
// на 8 ширинах экрана (телефон ... 1920). Нужен Playwright (npm i -D playwright && npx playwright install chromium) и запущенный сайт:
//   node scripts/overflow-scan.js http://localhost:3000 [/,/catalog,...]
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:3100';
const WIDTHS = [360, 390, 768, 1024, 1180, 1280, 1440, 1920];
const PAGES = (process.argv[3] || '/,/catalog,/catalog?dept=elektronika,/brands,/contacts,/delivery,/cart,/checkout,/login?tab=sms,/privacy,/favorites,/info/about').split(',');

const detect = () => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push({ kind: 'page-scroll', sel: 'html', text: `scrollWidth ${document.documentElement.scrollWidth} > ${vw}` });
  const desc = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const path = (el) => { const p = []; for (let e = el; e && e !== document.body && p.length < 4; e = e.parentElement) p.unshift(desc(e)); return p.join(' > '); };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TITLE'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (el.closest('[hidden], .sr, .sprite, [aria-hidden="true"], .marquee')) continue;   // бегущая лента брендов обрезается по краям намеренно
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // строки, ограниченные намеренно (многоточие, line-clamp), не считаем
    let clamped = false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.textOverflow === 'ellipsis' || c.webkitLineClamp !== 'none' && c.webkitLineClamp) { clamped = true; break; }
    }
    if (clamped) continue;
    // 1) текст шире своего элемента
    let problem = '';
    if (right > box.right + 2 || left < box.left - 2) problem = 'over-box';
    // 2) обрезан предком с overflow != visible
    for (let e = el; e && e !== document.body && !problem; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (['hidden', 'clip'].includes(c.overflowX)) {
        const b = e.getBoundingClientRect();
        if (right > b.right + 2 || left < b.left - 2) problem = 'clipped';
      }
      if (['auto', 'scroll'].includes(c.overflowX)) break; // лента с прокруткой: так задумано
    }
    // 3) вылез за экран вне прокручиваемой ленты
    if (!problem && (right > vw + 2 || left < -2)) {
      let scroller = false;
      for (let e = el; e && e !== document.body; e = e.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(e).overflowX)) { scroller = true; break; }
      if (!scroller) problem = 'off-screen';
    }
    if (problem) { seen.add(el); out.push({ kind: problem, sel: path(el), text: t.slice(0, 50), w: Math.round(right - left), box: Math.round(box.width) }); }
  }
  return out;
};

(async () => {
  const browser = await chromium.launch();
  const found = new Map();
  let slug = null;
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cookie-ok', '1'); } catch (e) { /* без хранилища */ } });
    if (!slug) {
      await page.goto(`${BASE}/catalog`);
      slug = await page.$eval('a.card', (a) => a.getAttribute('href')).catch(() => null);
    }
    for (const p of [...PAGES, ...(slug ? [slug] : [])]) {
      try {
        await page.goto(BASE + p, { waitUntil: 'load', timeout: 20000 });
        await page.evaluate(() => document.fonts.ready);   // шрифты загружены: Unbounded заметно шире запасного
        await page.waitForTimeout(500);
        // дать «проявиться» блокам, которые появляются при прокрутке
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        for (const r of await page.evaluate(detect)) {
          const key = `${r.kind}|${r.sel}|${r.text}`;
          if (!found.has(key)) found.set(key, { ...r, pages: new Set(), widths: new Set() });
          found.get(key).pages.add(p); found.get(key).widths.add(width);
        }
      } catch (e) { console.log('не открылось', p, width, e.message.split('\n')[0]); }
    }
    await ctx.close();
  }
  await browser.close();
  if (!found.size) { console.log('Вылезающего текста не найдено'); return; }
  for (const r of found.values()) console.log(`${r.kind.padEnd(11)} ${r.sel}  «${r.text}»  текст ${r.w}px в блоке ${r.box}px  ширины: ${[...r.widths].join(',')}  страницы: ${[...r.pages].slice(0, 3).join(' ')}`);
  console.log(`всего: ${found.size}`);
})();
