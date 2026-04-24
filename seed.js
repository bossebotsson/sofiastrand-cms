'use strict';
/**
 * Populerar databasen med innehåll från sofiastrand-download/.
 * Kör: node seed.js
 * OBS: Raderar all befintlig data och börjar om.
 */

const Database   = require('better-sqlite3');
const { marked } = require('marked');
const path       = require('path');
const fs         = require('fs');

// Ladda bildmappning om den finns (skapad av download-images.js)
const MAP_FILE  = path.join(__dirname, 'image-map.json');
const IMAGE_MAP = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};

function localizeImages(html) {
  return html.replace(/src="(https?:\/\/[^"]+)"/gi, (match, url) => {
    const clean = url.split('?')[0];
    return IMAGE_MAP[clean] ? `src="${IMAGE_MAP[clean]}"` : match;
  });
}

// ── Hjälpfunktioner ───────────────────────────────────────────────────────────
function resolveImg(url) {
  const clean = url.split('?')[0];
  return IMAGE_MAP[clean] || clean;
}

function htmlToMd(inner) {
  inner = inner.replace(/<br\s*\/?>/gi, '\n');
  inner = inner.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  inner = inner.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    (_, t) => '\n## ' + t.replace(/<[^>]+>/g,'').trim() + '\n');
  inner = inner.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  inner = inner.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  inner = inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  inner = inner.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, txt) => `[${txt.replace(/<[^>]+>/g,'').trim()}](${href})`);
  inner = inner.replace(/<[^>]+>/g, '');
  inner = inner.replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
               .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#8203;/g,'');
  return inner.replace(/\n{3,}/g, '\n\n').trim();
}

function extractContent(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Hitta hela h24_content_container
  const mContainer = html.match(/id=["']h24_content_container["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*style="clear/i);
  const container = mContainer ? mContainer[1] : html;

  // Dela upp i individuella collections
  const colParts = container.split(/(?=id="collection\d+")/);

  const parts = [];

  for (const col of colParts) {
    // Hoppa över sidospalt med nyhetsarkiv
    if (/blog_archive_block/i.test(col)) continue;

    // Dela upp i block_container-delar och bearbeta i dokumentordning
    const blockParts = col.split(/(?=class="block_container )/);

    for (const block of blockParts) {
      // ── Toppbild / presentation_image_block ──
      if (/presentation_image_block/.test(block)) {
        const mImg = block.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp))[^"]*"/i);
        if (mImg) {
          const local = resolveImg(mImg[1]);
          const mCap  = block.match(/class="h24_caption[^"]*"[^>]*>([^<]+)/i);
          const cap   = mCap ? mCap[1].trim() : '';
          parts.push(`<img src="${local}" alt="${cap}" class="page-img">`);
        }
        continue;
      }

      // ── Rubrik ──
      if (/h24_block_heading/.test(block)) {
        const mh = block.match(/id="block_\d+_text_content"[^>]*>([\s\S]*?)<\/div>/i);
        if (mh) {
          const text = mh[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
          if (text) parts.push('## ' + text);
        }
        continue;
      }

      // ── Textblock ──
      if (/standard_text_block/.test(block)) {
        const mt = block.match(/class="text_content"[^>]*>([\s\S]*?)<\/div>\s*\n?\s*<\/div>/i);
        if (mt) {
          const md = htmlToMd(mt[1]);
          if (md) parts.push(md);
        }
        continue;
      }

      // ── Fillänkar ──
      if (/user_file_block/.test(block)) {
        const fileRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<em>([^<]*)<\/em>/gi;
        let mf;
        while ((mf = fileRe.exec(block)) !== null) {
          const name = mf[2].replace(/<[^>]+>/g,'').trim();
          if (name) parts.push(`📄 [${name}](${mf[1]}) (${mf[3].trim()})`);
        }
        continue;
      }
    }
  }

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html, fallback) {
  // Försök h1 inside blog_post_header_block eller heading-block
  const m1 = html.match(/class="[^"]*(?:blog_post_header_block|h24_block_heading)[^"]*"[\s\S]{0,400}?<(?:h[1-6]|span)[^>]*>\s*([\s\S]*?)\s*<\/(?:h[1-6]|span)>/i);
  if (m1) {
    const t = m1[1].replace(/<[^>]+>/g,'').replace(/«\s*Tillbaka/i,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
    if (t) return t;
  }
  // Fallback: första h1/h2 på sidan
  const m2 = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (m2) return m2[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
  return fallback;
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');
}

function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function makeSlug(str) {
  return String(str).toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const DOWNLOAD = path.resolve(__dirname, '..');   // sofiastrand-download/
const DB_PATH  = path.join(__dirname, 'data.db');

// ── Databas ───────────────────────────────────────────────────────────────────
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    slug TEXT UNIQUE,
    published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    parent TEXT DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Inställningar ─────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const ins = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
ins.run('site_title',    'BRF Sofia Strand');
ins.run('site_subtitle', 'Tegelviksgatan 37–39');
ins.run('admin_password', bcrypt.hashSync('brf2024', 10));

// ── Extrahera hero-bilder från startsidan ─────────────────────────────────────
console.log('🖼   Extraherar hero-bilder från startsidan...');
const hemHtml = readFile(path.join(DOWNLOAD, 'hem-15453053.html')) || '';
const heroImgRe = /src="(https?:\/\/(?:dst15js82dk7j\.cloudfront\.net|h24-original\.s3\.amazonaws\.com)\/[^"]+\.(?:jpg|jpeg|png))[^"]*"/gi;
const heroImgs = [];
const heroSeen = new Set();
let hm;
while ((hm = heroImgRe.exec(hemHtml)) !== null) {
  const url   = hm[1].split('?')[0];
  const local = IMAGE_MAP[url] || url;
  if (!heroSeen.has(local)) {
    heroSeen.add(local);
    heroImgs.push(local);
  }
}
ins.run('hero_images', JSON.stringify(heroImgs));
console.log(`   ${heroImgs.length} hero-bilder: ${heroImgs.map(u => u.split('/').pop()).join(', ')}`);

// ── Statiska sidor ────────────────────────────────────────────────────────────
const STATIC_PAGES = [
  { file: 'hem-15453053.html',            title: 'Hem',        slug: 'hem',        order: 0 },
  { file: 'omr%C3%A5det-16008708.html',   title: 'Området',    slug: 'omradet',    order: 1 },
  { file: 'f%C3%B6reningen-15453499.html',title: 'Föreningen', slug: 'foreningen', order: 2 },
  { file: 'medlem-15453223.html',         title: 'Medlem',     slug: 'medlem',     order: 3 },
  { file: 'fastigheten-15453175.html',    title: 'Fastigheten',slug: 'fastigheten',order: 4 },
  { file: 'felanm%C3%A4lan-15453249.html',title: 'Felanmälan', slug: 'felanmalan', order: 5 },
  { file: 'kontakt-15476323.html',        title: 'Kontakt',    slug: 'kontakt',    order: 6 },
];

// Kontaktsidans innehåll byggs manuellt med karta + formulär
const KONTAKT_CONTENT = `
<div class="kontakt-grid">
  <div class="kontakt-col">
    <h2>Kontakta oss</h2>
    <p>Frågor och synpunkter skickas till styrelsen via e-post:</p>
    <p><a href="mailto:brf@sofiastrand.se">brf@sofiastrand.se</a></p>
    <p>Styrelsen svarar normalt inom några dagar.</p>
    <h2>Felanmälan</h2>
    <p>Vid fel i fastigheten, kontakta Fastighetshälpen AB:</p>
    <p><strong>08-602 84 00</strong><br>Vardagar kl. 09–11<br>Jour: 0709-203 090</p>
    <p><a href="mailto:info@fastighetshjalpen.se">info@fastighetshjalpen.se</a></p>
  </div>
  <div class="kontakt-col">
    <h2>Hitta till oss</h2>
    <p>Tegelviksgatan 37–39, 116 41 Stockholm</p>
    <div class="map-wrap">
      <iframe
        src="https://www.openstreetmap.org/export/embed.html?bbox=18.0889%2C59.3087%2C18.1089%2C59.3147&amp;layer=mapnik&amp;marker=59.3117085%2C18.0989045"
        width="100%" height="320" style="border:0;border-radius:6px" loading="lazy"
        title="Karta över Tegelviksgatan 37-39"></iframe>
    </div>
    <p style="font-size:.82rem;margin-top:8px">
      <a href="https://www.openstreetmap.org/?mlat=59.3117085&mlon=18.0989045#map=16/59.3117/18.0989" target="_blank" rel="noopener">
        Öppna i OpenStreetMap ↗
      </a>
    </p>
  </div>
</div>
`.trim();

const insPage = db.prepare(
  `INSERT OR IGNORE INTO pages (title, slug, content, parent, sort_order) VALUES (?, ?, ?, NULL, ?)`
);

for (const p of STATIC_PAGES) {
  const isKontakt = p.slug === 'kontakt';
  const html      = readFile(path.join(DOWNLOAD, p.file));
  const content   = isKontakt ? KONTAKT_CONTENT : (html ? extractContent(html) : '');
  insPage.run(p.title, p.slug, content, p.order);
  console.log(`  ✓ Sida: ${p.title}`);
}

// ── Undersidor ────────────────────────────────────────────────────────────────
const SUBPAGE_DIRS = [
  { dir: 'fastigheten', parent: 'fastigheten' },
  { dir: 'omr%C3%A5det', parent: 'omradet' },
  { dir: 'f%C3%B6reningen', parent: 'foreningen' },
  { dir: 'medlem', parent: 'medlem' },
];

const insSubPage = db.prepare(
  `INSERT OR IGNORE INTO pages (title, slug, content, parent, sort_order) VALUES (?, ?, ?, ?, ?)`
);

for (const { dir, parent } of SUBPAGE_DIRS) {
  const dirPath = path.join(DOWNLOAD, dir);
  if (!fs.existsSync(dirPath)) continue;
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.html')).sort();
  files.forEach((f, i) => {
    const html    = readFile(path.join(dirPath, f));
    if (!html) return;
    const rawName = decodeURIComponent(f).replace('.html', '').replace(/-\d+$/, '');
    const title   = capitalizeFirst(extractTitle(html, rawName.replace(/-/g, ' ')));
    const content = extractContent(html);
    const slug    = makeSlug(rawName);
    insSubPage.run(title, slug, content, parent, i);
    console.log(`  ✓ Undersida: ${title} (${parent})`);
  });
}

// ── Nyhetsinnlägg ─────────────────────────────────────────────────────────────
const YEAR_RE = /^\d{4}$/;
const insPost = db.prepare(
  `INSERT OR IGNORE INTO posts (title, content, slug, published, created_at) VALUES (?, ?, ?, 1, ?)`
);

let postCount = 0;
const slugsSeen = new Set();

function processYear(yearDir) {
  if (!fs.existsSync(yearDir)) return;
  const year = path.basename(yearDir);

  // Hitta alla html-filer rekursivt
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.html')) {
        const html    = readFile(full);
        if (!html) continue;

        // Bygg datum från sökvägen: year/month/day/
        const parts   = path.relative(DOWNLOAD, full).split(path.sep);
        const y = parseInt(parts[0]) || 2013;
        const m = parseInt(parts[1]) || 1;
        const d = parseInt(parts[2]) || 1;
        const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} 12:00:00`;

        const rawName = decodeURIComponent(entry.name).replace('.html', '').replace(/-\d+$/, '');
        const title   = capitalizeFirst(extractTitle(html, rawName.replace(/-/g, ' ')));
        const content = extractContent(html);
        let slug      = makeSlug(rawName);
        // Undvik duplikat-slugs
        let finalSlug = slug;
        let i = 2;
        while (slugsSeen.has(finalSlug)) { finalSlug = `${slug}-${i++}`; }
        slugsSeen.add(finalSlug);

        insPost.run(title, content, finalSlug, dateStr);
        postCount++;
      }
    }
  }
  walk(yearDir);
}

for (const entry of fs.readdirSync(DOWNLOAD, { withFileTypes: true })) {
  if (entry.isDirectory() && YEAR_RE.test(entry.name)) {
    processYear(path.join(DOWNLOAD, entry.name));
  }
}

console.log(`  ✓ ${postCount} nyhetsinnlägg importerade`);
console.log('\n✅  Databas skapad! Starta servern med: node server.js');
console.log('   Lösenord: brf2024');
