// Key one exact color by distance, then feather the alpha. Other greens stay.

let keyInner = 18;
let keyOuter = 46;

export function parseKeyColor(color) {
  let text = String(color || '').trim();
  let hex = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  let rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  throw new Error('color must be #rrggbb');
}

export function keyImageData(pixels, width, height, color) {
  let key = typeof color === 'string' ? parseKeyColor(color) : color;
  if (key == null || key.r == null) throw new Error('color must be #rrggbb');
  let data = new Uint8ClampedArray(pixels);
  let alpha = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    let r = data[p];
    let g = data[p + 1];
    let b = data[p + 2];
    let dist = Math.hypot(r - key.r, g - key.g, b - key.b);
    let keyed = alphaFromDistance(dist);
    if (keyed > 0 && keyed < 255) {
      let t = 1 - keyed / 255;
      data[p] = clampByte(r + (r - key.r) * t);
      data[p + 1] = clampByte(g + (g - key.g) * t);
      data[p + 2] = clampByte(b + (b - key.b) * t);
    }
    alpha[i] = data[p + 3] * (keyed / 255);
  }
  let feathered = blurAlpha(alpha, width, height, 2);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    data[p + 3] = clampByte(feathered[i]);
  }
  return data;
}

function alphaFromDistance(dist) {
  if (dist <= keyInner) return 0;
  if (dist >= keyOuter) return 255;
  return 255 * (dist - keyInner) / (keyOuter - keyInner);
}

function blurAlpha(alpha, width, height, radius) {
  let tmp = new Float32Array(alpha.length);
  let out = new Float32Array(alpha.length);
  let win = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    let row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += alpha[row + clampIndex(x, width)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / win;
      sum += alpha[row + clampIndex(x + radius + 1, width)];
      sum -= alpha[row + clampIndex(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clampIndex(y, height) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / win;
      sum += tmp[clampIndex(y + radius + 1, height) * width + x];
      sum -= tmp[clampIndex(y - radius, height) * width + x];
    }
  }
  return out;
}

function clampIndex(value, limit) {
  if (value < 0) return 0;
  if (value >= limit) return limit - 1;
  return value;
}

function clampByte(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}
