// Generates QR codes for the submit page: full-slide and 200px corner sizes, PNG and SVG.
// Usage: npm run qr [-- --url https://xxxx.cloudfront.net/]
import { mkdirSync, writeFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { argValue, loadOutputs } from './outputs.js';

const url = argValue('url') ?? (await loadOutputs()).submitUrl;
const color = { dark: '#0b0f14', light: '#ffffff' };
mkdirSync('qr', { recursive: true });

const sizes = { slide: 1600, corner: 200 };
for (const [name, width] of Object.entries(sizes)) {
  await QRCode.toFile(`qr/submit-${name}.png`, url, { width, margin: 2, errorCorrectionLevel: 'M', color });
  const svg = await QRCode.toString(url, { type: 'svg', width, margin: 2, errorCorrectionLevel: 'M', color });
  writeFileSync(`qr/submit-${name}.svg`, svg);
}
console.log(`QR codes for ${url} written to qr/ (submit-slide.{png,svg} at 1600px, submit-corner.{png,svg} at 200px)`);
