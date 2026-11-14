// Renders the Chrome Web Store promo tiles into store/.
// Usage: npm install && npm run promo
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { iconSvg, SIZES, COLOR } = require('./make-icons.cjs');

const OUT = path.join(__dirname, '..', 'store');
const BG = '#0f0f0f';
const FONT = "'Segoe UI', 'DejaVu Sans', sans-serif";
const TAGLINE = ['Take back control', 'of your YouTube history'];

// Segoe UI looks closest to YouTube's UI; other systems fall back to their own fonts.
const WINDOWS_FONTS = ['/mnt/c/Windows/Fonts', 'C:\\Windows\\Fonts'];
const fontFiles = WINDOWS_FONTS.flatMap((dir) => ['segoeui.ttf', 'segoeuib.ttf'].map((f) => path.join(dir, f)))
  .filter((file) => fs.existsSync(file));

const icon = (x, y, size) => {
  const data = Buffer.from(iconSvg({ ...SIZES[48] })).toString('base64');
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/svg+xml;base64,${data}"/>`;
};

const glow = (id, cx, cy, r) => `
  <defs><radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${COLOR}" stop-opacity="0.28"/>
    <stop offset="1" stop-color="${COLOR}" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#${id})"/>`;

function small() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <rect width="440" height="280" fill="${BG}"/>${glow('g', 92, 140, 230)}
  ${icon(36, 88, 104)}
  <text x="164" y="134" font-family="${FONT}" font-weight="700" font-size="44" fill="#ffffff">YT Regret</text>
  <text x="166" y="170" font-family="${FONT}" font-size="20" fill="#c9c9c9">${TAGLINE[0]}</text>
  <text x="166" y="197" font-family="${FONT}" font-size="20" fill="#c9c9c9">${TAGLINE[1]}</text>
</svg>`;
}

// A drawn history card: placeholder entries, one being regretted, one already removed.
function historyCard(x, y) {
  const rows = [
    { thumb: '#4a3a5c', state: 'target' },
    { thumb: '#2f4757', state: 'removed' },
    { thumb: '#5c4433', state: 'idle' },
  ];
  let out = `<rect x="${x}" y="${y}" width="470" height="360" rx="28" fill="#1a1a1a" stroke="#2c2c2c"/>
  <text x="${x + 36}" y="${y + 56}" font-family="${FONT}" font-weight="700" font-size="24" fill="#f1f1f1">Watch history</text>`;
  rows.forEach((row, i) => {
    const ry = y + 86 + i * 88;
    const fade = row.state === 'removed' ? ' opacity="0.35"' : '';
    out += `<g${fade}>
    <rect x="${x + 36}" y="${ry}" width="128" height="72" rx="10" fill="${row.thumb}"/>
    <rect x="${x + 182}" y="${ry + 6}" width="230" height="13" rx="6.5" fill="#3d3d3d"/>
    <rect x="${x + 182}" y="${ry + 28}" width="140" height="10" rx="5" fill="#2f2f2f"/>
  </g>`;
    const px = x + 182, py = ry + 46;
    if (row.state === 'removed') {
      out += `<rect x="${px}" y="${py}" width="96" height="26" rx="13" fill="#1d3a26"/>
    <text x="${px + 48}" y="${py + 18}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="14" fill="#3ec46d">Removed</text>`;
    } else {
      out += `<rect x="${px}" y="${py}" width="76" height="26" rx="13" fill="#333333"/>
    <text x="${px + 38}" y="${py + 18}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="14" fill="#ffffff">Regret</text>`;
      if (row.state === 'target') {
        out += `<rect x="${px - 8}" y="${py - 8}" width="92" height="42" fill="none" stroke="${COLOR}" stroke-width="3"/>`;
      }
    }
  });
  return out;
}

function marquee() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560" viewBox="0 0 1400 560">
  <rect width="1400" height="560" fill="${BG}"/>${glow('g', 260, 250, 520)}
  ${icon(110, 96, 132)}
  <text x="106" y="340" font-family="${FONT}" font-weight="700" font-size="92" fill="#ffffff">YT Regret</text>
  <text x="112" y="400" font-family="${FONT}" font-size="36" fill="#c9c9c9">${TAGLINE[0]}</text>
  <text x="112" y="446" font-family="${FONT}" font-size="36" fill="#c9c9c9">${TAGLINE[1]}</text>
  ${historyCard(820, 100)}
</svg>`;
}

const render = (svg) => new Resvg(svg, {
  font: { fontFiles, loadSystemFonts: true, defaultFontFamily: fontFiles.length ? 'Segoe UI' : 'DejaVu Sans' },
}).render().asPng();

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'promo-small-440x280.png'), render(small()));
fs.writeFileSync(path.join(OUT, 'promo-marquee-1400x560.png'), render(marquee()));
console.log(`promo tiles written to ${OUT}${fontFiles.length ? '' : ' (Segoe UI not found, used fallback fonts)'}`);
