'use strict';
// Картинки для тестов проверки логотипа: «снимок с вывеской» (синий значок-«плей» и буквы на тёмном корпусе) и чистые снимки на белом.
const sharp = require('sharp');

const BLUE = '#1e6fd9';
const icon = (x, y, h) => {
  const w = h * 0.67; const t = Math.max(3, h * 0.07);
  return `<polygon points="${x},${y} ${x},${y + h} ${x + w},${y + h / 2}" fill="none" stroke="${BLUE}" stroke-width="${t}" stroke-linejoin="miter"/>
    <polygon points="${x + w * 0.3},${y + h * 0.33} ${x + w * 0.3},${y + h * 0.67} ${x + w * 0.65},${y + h * 0.5}" fill="${BLUE}"/>`;
};
const svg = (inner, bg) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><rect width="900" height="900" fill="${bg}"/>${inner}</svg>`)).jpeg({ quality: 90 }).toBuffer();

// Корпус компьютера с вывеской BAZA
const logoJpeg = () => svg(`<rect x="200" y="200" width="500" height="500" fill="#16181d"/>${icon(260, 520, 110)}${[0, 1, 2, 3].map((i) => `<rect x="${345 + i * 62}" y="${535}" width="42" height="80" fill="#d9d9d9"/>`).join('')}`, '#ffffff');
// Тот же корпус с другой стороны: без вывески, на белом
const cleanJpeg = (shade = '#16181d') => svg(`<rect x="250" y="220" width="400" height="460" fill="${shade}"/><circle cx="450" cy="400" r="90" fill="#ff6a2b"/>`, '#ffffff');

module.exports = { logoJpeg, cleanJpeg };
