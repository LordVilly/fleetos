'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const target = path.join(__dirname, '..', 'icons');
fs.mkdirSync(target, { recursive: true });
const rgba = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).concat(255);
const polygons = [
  { color: rgba('#68e0a6'), points: [[56, 382], [92, 420], [456, 92], [420, 52]] },
  { color: rgba('#263c31'), points: [[82, 379], [105, 404], [430, 96], [407, 70]] }
];
function inside(x, y, points) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1) + xi);
    if (intersect) result = !result;
  }
  return result;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function render(size, filename) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const sx = x * 512 / size, sy = y * 512 / size;
      let color = rgba('#0c1d18');
      const dx = Math.max(30 - sx, 0, sx - 482), dy = Math.max(30 - sy, 0, sy - 482);
      const radius = 30;
      const inRounded = dx * dx + dy * dy <= radius * radius;
      if (sx < 30 && sy < 30 || sx > 482 && sy < 30 || sx < 30 && sy > 482 || sx > 482 && sy > 482) {
        if (!inRounded) color = [0, 0, 0, 0];
      }
      for (const shape of polygons) if (inside(sx, sy, shape.points)) color = shape.color;
      const progress = (sx - sy + 512) % 92;
      const distance = Math.abs(sx + sy - 493);
      if (inside(sx, sy, polygons[1].points) && distance < 7 && progress >= 8 && progress <= 52) color = rgba('#f6c85f');
      const offset = 1 + x * 4;
      row[offset] = color[0]; row[offset + 1] = color[1]; row[offset + 2] = color[2]; row[offset + 3] = color[3];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(target, filename), png);
}

render(192, 'fleetos-192.png');
render(512, 'fleetos-512.png');
render(180, 'apple-touch-icon.png');
console.log('FleetOS PWA icons created.');
