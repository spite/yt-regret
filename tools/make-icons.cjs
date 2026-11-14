// Renders extension/icons/icon{16,32,48,128}.png and the source SVG.
// Usage: npm install && npm run icons
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const COLOR = '#E5483D';
const OUT = path.join(__dirname, '..', 'extension', 'icons');

// Detail drops with size: hands go below 48px, the arrowhead and slash cut-out below 32px.
const SIZES = {
  128: { pad: 16, sw: 2.4, fill: 0.72, hands: true, arrow: true, gap: true },
  48: { pad: 0, sw: 2.4, fill: 0.72, hands: true, arrow: true, gap: true },
  32: { pad: 0, sw: 2.8, fill: 0.76, hands: false, arrow: true, gap: true },
  16: { pad: 0, sw: 3.4, fill: 0.82, hands: false, arrow: false, gap: false },
};

function iconSvg({ pad, sw, fill, hands, arrow, gap }) {
  const box = 128 - pad * 2;
  const glyph = box * fill;
  const scale = glyph / 24;
  const offset = pad + (box - glyph) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="${pad}" y="${pad}" width="${box}" height="${box}" rx="${(box * 0.23).toFixed(1)}" fill="${COLOR}"/>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="#ffffff" stroke-width="${sw}">
      <path d="M4 12a8 8 0 1 0 2.3-5.6"/>${arrow ? '\n      <path d="M4 4v4h4"/>' : ''}${hands ? '\n      <path d="M12 7.5V12h4"/>' : ''}
    </g>${gap ? `\n    <path d="M4.5 19.5 19.5 4.5" stroke="${COLOR}" stroke-width="${(sw * 2.1).toFixed(2)}"/>` : ''}
    <path d="M4.5 19.5 19.5 4.5" stroke="#ffffff" stroke-width="${sw}"/>
  </g>
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [size, opts] of Object.entries(SIZES)) {
  const png = new Resvg(iconSvg(opts), { fitTo: { mode: 'width', value: Number(size) } }).render().asPng();
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
}
fs.writeFileSync(path.join(__dirname, 'icon.svg'), iconSvg(SIZES[48]));
console.log(`icons written to ${OUT}`);
