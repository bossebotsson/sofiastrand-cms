'use strict';
/**
 * Laddar ner alla bilder från sofiastrand.se till public/images/
 * och skapar en mappningsfil (image-map.json) för seed.js.
 *
 * Kör: node download-images.js
 */

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');
const { URL } = require('url');

const DOWNLOAD_DIR = path.resolve(__dirname, '..');
const IMAGES_DIR   = path.join(__dirname, 'public', 'images');
const MAP_FILE     = path.join(__dirname, 'image-map.json');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── Samla alla bild-URLs från HTML-filerna ───────────────────────────────────
const IMAGE_RE = /(?:src|href)="(https?:\/\/(?:dst15js82dk7j\.cloudfront\.net|h24-original\.s3\.amazonaws\.com)\/[^"]+)"/gi;

const urlSet = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(full, 'utf8');
      let m;
      IMAGE_RE.lastIndex = 0;
      while ((m = IMAGE_RE.exec(html)) !== null) {
        urlSet.add(m[1].split('?')[0]); // ta bort query-params
      }
    }
  }
}

console.log('🔍  Skannar HTML-filer...');
walk(DOWNLOAD_DIR);
console.log(`   Hittade ${urlSet.size} unika bild-URLs\n`);

// ── Ladda ner bilderna ───────────────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve) => {
    if (fs.existsSync(dest)) return resolve(true); // redan nedladdad

    const file  = fs.createWriteStream(dest);
    const proto = url.startsWith('https') ? https : http;

    const req = proto.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return resolve(false);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(true)));
    });

    req.on('error', () => {
      try { fs.unlinkSync(dest); } catch {}
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function localName(url) {
  try {
    const u    = new URL(url);
    const base = path.basename(u.pathname);
    // Lägg till en hash för att undvika krockar med samma filnamn
    const hash = Buffer.from(url).toString('base64').slice(0, 8).replace(/[^a-zA-Z0-9]/g, '');
    const ext  = path.extname(base) || '.jpg';
    const name = base.replace(ext, '');
    return `${name}_${hash}${ext}`;
  } catch {
    return `img_${Date.now()}.jpg`;
  }
}

async function main() {
  const imageMap = {};
  const urls = [...urlSet];

  let ok = 0, fail = 0;

  for (let i = 0; i < urls.length; i++) {
    const url  = urls[i];
    const name = localName(url);
    const dest = path.join(IMAGES_DIR, name);
    const localPath = `/images/${name}`;

    process.stdout.write(`  [${i+1}/${urls.length}] ${name.slice(0, 40).padEnd(40)} `);

    const success = await download(url, dest);
    imageMap[url] = localPath;

    if (success) {
      console.log('✓');
      ok++;
    } else {
      console.log('✗ (hoppades över)');
      fail++;
    }

    // Var snäll mot servern
    await new Promise(r => setTimeout(r, 100));
  }

  fs.writeFileSync(MAP_FILE, JSON.stringify(imageMap, null, 2));

  console.log(`\n✅  Klar! ${ok} nedladdade, ${fail} misslyckades`);
  console.log(`   Bilder sparade i: ${IMAGES_DIR}`);
  console.log(`   Mappning sparad i: ${MAP_FILE}`);
  console.log('\n📌  Kör nu: node seed.js  (använder automatiskt de lokala bilderna)');
}

main();
