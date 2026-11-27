'use strict';
// Поиск логотипа магазина BAZA на фото. Собственные компьютеры BAZA сняты с вывеской на корпусе: синий значок-«плей» (контур
// треугольника с засечками и маленький сплошной треугольник внутри) и буквы BAZA. Такие снимки на нашем сайте не нужны: вместо них
// показываются другие снимки того же товара.
//
// Метод без нейросетей и внешних сервисов. Снимок уменьшается до 480 px, находятся пятна цвета значка (оттенок около 212°), и логотип
// найден, когда есть пара вложенных пятен: большой контур (доля заливки в рамке 0,17-0,36) и внутри его рамки маленькое сплошное пятно
// (доля заливки 0,38-0,78). Эта пара не зависит ни от цвета корпуса (на белых буквы бледные, а значок остаётся синим), ни от ракурса
// и размера. Проверено на реальных снимках: все снимки с вывеской найдены, на 260 снимках других товаров ложных срабатываний нет.
// Одинокая синяя деталь (кабель, подсветка вентилятора, синий экран) логотипом не считается: у неё нет вложенного пятна.
const sharp = require('sharp');

const SIDE = 480;

// Пятна пикселей цвета значка: синий, насыщенный, зелёного заметно больше красного (оттенок около 212°, а не фиолетовый 240°)
function bluePixels(raw, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const r = raw[p]; const g = raw[p + 1]; const b = raw[p + 2];
    if (b < 128 || b < r || b < g) continue;
    const d = b - Math.min(r, g);
    if (d < 0.55 * b) continue;
    const k = (g - r) / d;
    if (k > 0.2 && k < 0.8 && g > 60 && g < 200) mask[i] = 1;
  }
  return mask;
}

// Связные пятна (по 4 соседям): рамка и площадь
function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let x0 = w; let x1 = 0; let y0 = h; let y1 = 0; let area = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w; const y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || !mask[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    out.push({ x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

// Есть ли большое пятно-контур с маленьким сплошным пятном внутри его рамки
function hasNestedPair(blobs) {
  for (const big of blobs) {
    const fill = big.area / (big.w * big.h);
    const ratio = big.h / big.w;
    if (big.area < 120 || big.area > 6000 || big.h < 14 || big.h > 220 || fill < 0.17 || fill > 0.36 || ratio < 0.9 || ratio > 1.9) continue;
    for (const s of blobs) {
      if (s === big || s.area < 25 || s.area > big.area * 0.45) continue;
      const sf = s.area / (s.w * s.h);
      if (sf < 0.38 || sf > 0.78) continue;
      if (s.x0 >= big.x0 && s.x1 <= big.x1 && s.y0 >= big.y0 && s.y1 <= big.y1) return true;
    }
  }
  return false;
}

// true - на снимке есть логотип BAZA. Нечитаемый файл логотипом не считается (false).
async function hasBazaLogo(input) {
  let img;
  try {
    img = await sharp(input, { limitInputPixels: 80_000_000, failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .resize({ width: SIDE, height: SIDE, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch { return false; }
  const { data, info } = img;
  return hasNestedPair(components(bluePixels(data, info.width, info.height), info.width, info.height));
}

module.exports = { hasBazaLogo };
