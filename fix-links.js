'use strict';
/**
 * Ersätter alla absoluta sofiastrand.se-länkar i databasen
 * med relativa, normaliserade sökvägar.
 *
 * Kör: node fix-links.js
 */

const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

// Samma normalisering som i server.js
function normalizeSlug(s) {
  return s
    .replace(/å/gi, 'a').replace(/ä/gi, 'a').replace(/ö/gi, 'o')
    .replace(/-\d+$/, '')               // ta bort trailing id  -16647068
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function sofiastrandToRelative(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('sofiastrand')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return '/';
    const normalized = parts.map(normalizeSlug).filter(Boolean);
    return '/' + normalized.join('/');
  } catch {
    return null;
  }
}

function fixContent(content) {
  if (!content) return content;

  // HTML:  href="http://www.sofiastrand.se/..."
  //        src="http://www.sofiastrand.se/..."
  content = content.replace(
    /(href|src)="(https?:\/\/(?:www\.)?sofiastrand\.se\/[^"]*)"/gi,
    (match, attr, url) => {
      const rel = sofiastrandToRelative(url);
      return rel ? `${attr}="${rel}"` : match;
    }
  );

  // Markdown:  [text](http://www.sofiastrand.se/...)
  content = content.replace(
    /\]\((https?:\/\/(?:www\.)?sofiastrand\.se\/[^)]*)\)/gi,
    (match, url) => {
      const rel = sofiastrandToRelative(url);
      return rel ? `](${rel})` : match;
    }
  );

  return content;
}

let pagesFixed = 0;
let postsFixed = 0;

// ── Sidor ────────────────────────────────────────────────────────────────────
const pages = db.prepare('SELECT id, title, content FROM pages').all();
for (const page of pages) {
  const fixed = fixContent(page.content);
  if (fixed !== page.content) {
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(fixed, page.id);
    console.log(`  ✓ Sida fixad: "${page.title}" (id ${page.id})`);
    pagesFixed++;
  }
}

// ── Nyheter ──────────────────────────────────────────────────────────────────
const posts = db.prepare('SELECT id, title, content FROM posts').all();
for (const post of posts) {
  const fixed = fixContent(post.content);
  if (fixed !== post.content) {
    db.prepare('UPDATE posts SET content = ? WHERE id = ?').run(fixed, post.id);
    console.log(`  ✓ Nyhet fixad: "${post.title}" (id ${post.id})`);
    postsFixed++;
  }
}

console.log(`\n✅  Klar! ${pagesFixed} sidor och ${postsFixed} nyheter uppdaterade.`);
if (pagesFixed + postsFixed === 0) {
  console.log('   Inga sofiastrand.se-länkar hittades (kanske redan fixade).');
}
