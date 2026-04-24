'use strict';

const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const Database   = require('better-sqlite3');
const { marked } = require('marked');
// Tillåt råa HTML-taggar (bilder etc.) i markdown-innehåll
marked.setOptions({ mangle: false, headerIds: false });
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Databas ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    slug       TEXT    UNIQUE,
    published  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    slug       TEXT    UNIQUE NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    parent     TEXT    DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Standardinställningar om de saknas
const defaults = {
  site_title:    'BRF Sofia Strand',
  site_subtitle: 'Tegelviksgatan 37–39',
  admin_password: bcrypt.hashSync('brf2024', 10),
  contact_email: '',
  contact_text:  ''
};
const insertSetting = db.prepare(
  `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
);
for (const [k, v] of Object.entries(defaults)) {
  insertSetting.run(k, v);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sofiastrand-hemlig-nyckel-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 timmar
}));

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/admin/login');
}

// ─── URL-normalisering ───────────────────────────────────────────────────────
// Hanterar gamla Hemsida24-URL:er, t.ex. /föreningen/styrelsen-15453177
// → /foreningen/styrelsen
function normalizeSlug(s) {
  return s
    .replace(/å/gi, 'a').replace(/ä/gi, 'a').replace(/ö/gi, 'o')
    .replace(/-\d+$/, '')          // ta bort trailing id (-15453177)
    .replace(/[^a-z0-9-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

app.use((req, res, next) => {
  const orig = req.path;
  // Skippa admin, statiska filer och nyheter
  if (orig.startsWith('/admin') || orig.startsWith('/nyheter') || orig.includes('.')) return next();

  // Avkoda percent-kodade tecken (t.ex. %C3%A5 → å) innan normalisering
  let decoded = orig;
  try { decoded = decodeURIComponent(orig); } catch {}

  const parts = decoded.split('/').filter(Boolean);
  if (parts.length === 0) return next();

  const normalized = parts.map(normalizeSlug);
  const newPath    = '/' + normalized.join('/');

  if (newPath !== orig) return res.redirect(301, newPath);
  next();
});

// ─── Hjälpfunktioner för HTML ────────────────────────────────────────────────
function navLinks(currentSlug = '') {
  const pages = db.prepare(
    `SELECT title, slug FROM pages WHERE parent IS NULL ORDER BY sort_order`
  ).all();

  return pages.map(p => {
    const active = currentSlug === p.slug ? ' class="active"' : '';
    const href = p.slug === 'hem' ? '/' : `/${p.slug}`;
    return `<a href="${href}"${active}>${p.title.toUpperCase()}</a>`;
  }).join('\n        ');
}

function layout({ title, slug = '', content, extraHead = '' }) {
  const siteTitle    = getSetting('site_title');
  const siteSubtitle = getSetting('site_subtitle');
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)} – ${escHtml(siteTitle)}</title>
  <link rel="stylesheet" href="/style.css">
  ${extraHead}
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="site-name">
        <a href="/">${escHtml(siteTitle)}</a>
        <span class="site-sub">${escHtml(siteSubtitle)}</span>
      </div>
    </div>
  </header>
  <nav>
    <div class="nav-inner">
      ${navLinks(slug)}
    </div>
  </nav>
  <main>
    ${content}
  </main>
  <footer>
    <span class="footer-copy">© ${new Date().getFullYear()} ${escHtml(siteTitle)} · ${escHtml(siteSubtitle)} · Stockholm</span>
    <div class="footer-links">
      <a href="/kontakt">Kontakt</a>
      <a href="/admin">Admin</a>
    </div>
  </footer>
</body>
</html>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Publika routes ──────────────────────────────────────────────────────────

// Startsida
app.get('/', (req, res) => {
  const hemPage   = db.prepare(`SELECT content FROM pages WHERE slug = 'hem'`).get();
  const posts     = db.prepare(
    `SELECT id, title, slug, created_at FROM posts
     WHERE published = 1 ORDER BY created_at DESC LIMIT 10`
  ).all();
  const heroSetting = getSetting('hero_images');
  const heroImgs    = heroSetting ? JSON.parse(heroSetting) : [];

  const newsHtml = posts.length === 0
    ? '<p class="empty">Inga nyheter ännu.</p>'
    : posts.map(p => `
      <article class="news-item">
        <h3><a href="/nyheter/${escHtml(p.slug)}">${escHtml(p.title)}</a></h3>
        <time>${fmtDate(p.created_at)}</time>
      </article>`).join('');

  // Bildspel – visas bara om det finns bilder
  const slideshowHtml = heroImgs.length > 0 ? `
    <div class="slideshow" id="slideshow" aria-label="Bildspel">
      ${heroImgs.map((src, i) =>
        `<img src="${escHtml(src)}" class="slide${i === 0 ? ' active' : ''}" alt="BRF Sofia Strand bild ${i+1}" loading="${i === 0 ? 'eager' : 'lazy'}">`
      ).join('\n      ')}
      ${heroImgs.length > 1 ? `
      <button class="slide-btn prev" onclick="moveSlide(-1)" aria-label="Föregående">&#8249;</button>
      <button class="slide-btn next" onclick="moveSlide(1)" aria-label="Nästa">&#8250;</button>
      <div class="slide-dots">
        ${heroImgs.map((_, i) =>
          `<button class="dot${i === 0 ? ' active' : ''}" onclick="goToSlide(${i})" aria-label="Bild ${i+1}"></button>`
        ).join('')}
      </div>` : ''}
    </div>
    <script>
      (function() {
        var idx = 0;
        var slides = document.querySelectorAll('.slide');
        var dots   = document.querySelectorAll('.slide-dots .dot');
        var timer;
        function show(n) {
          slides[idx].classList.remove('active');
          if (dots[idx]) dots[idx].classList.remove('active');
          idx = (n + slides.length) % slides.length;
          slides[idx].classList.add('active');
          if (dots[idx]) dots[idx].classList.add('active');
          clearInterval(timer);
          timer = setInterval(function(){ show(idx + 1); }, 5000);
        }
        window.moveSlide = function(d){ show(idx + d); };
        window.goToSlide = function(n){ show(n); };
        timer = setInterval(function(){ show(idx + 1); }, 5000);
      })();
    </script>` : '';

  const content = `
    ${slideshowHtml}
    <div class="two-col" style="margin-top:28px">
      <section class="col-main">
        <h1>Välkommen till BRF Sofia Strand</h1>
        <div class="page-content">${hemPage ? marked(hemPage.content) : ''}</div>
      </section>
      <aside class="col-side">
        <div class="news-section">
          <h2>Aktuellt</h2>
          ${newsHtml}
          ${posts.length === 10 ? '<p style="padding:10px 0;font-size:.82rem"><a href="/nyheter">Äldre nyheter »</a></p>' : ''}
        </div>
        <div class="emergency-card">
          <div class="emergency-card-title">Felanmälan</div>
          <p>Fastighetshälpen AB<br>08-602 84 00<br>Vardagar 09–11</p>
        </div>
      </aside>
    </div>`;

  res.send(layout({ title: 'Hem', slug: 'hem', content }));
});

// Nyhetsarkiv
app.get('/nyheter', (req, res) => {
  const posts = db.prepare(
    `SELECT id, title, slug, created_at FROM posts
     WHERE published = 1 ORDER BY created_at DESC`
  ).all();

  const list = posts.map(p => `
    <article class="news-item">
      <h3><a href="/nyheter/${escHtml(p.slug)}">${escHtml(p.title)}</a></h3>
      <time>${fmtDate(p.created_at)}</time>
    </article>`).join('');

  res.send(layout({
    title: 'Nyhetsarkiv',
    content: `<h1>Nyhetsarkiv</h1>${list || '<p>Inga nyheter ännu.</p>'}`
  }));
});

// Enskild nyhet
app.get('/nyheter/:slug', (req, res) => {
  const post = db.prepare(
    `SELECT * FROM posts WHERE slug = ? AND published = 1`
  ).get(req.params.slug);

  if (!post) return res.status(404).send(layout({
    title: '404',
    content: '<h1>Sidan hittades inte</h1><p><a href="/">Till startsidan</a></p>'
  }));

  res.send(layout({
    title: post.title,
    content: `
      <article class="single-post">
        <h1>${escHtml(post.title)}</h1>
        <time class="post-date">${fmtDate(post.created_at)}</time>
        <div class="page-content">${marked(post.content)}</div>
        <p class="back-link"><a href="/">← Tillbaka</a></p>
      </article>`
  }));
});

// Statiska undersidor  /fastigheten/tvattstugan
app.get('/:parent/:child', (req, res, next) => {
  if (req.params.parent === 'admin') return next();
  const page = db.prepare(
    `SELECT * FROM pages WHERE slug = ? AND parent = ?`
  ).get(req.params.child, req.params.parent);

  if (!page) return res.status(404).send(layout({
    title: '404',
    content: '<h1>Sidan hittades inte</h1><p><a href="/">Till startsidan</a></p>'
  }));

  const subpages = db.prepare(
    `SELECT title, slug, parent FROM pages WHERE parent = ? ORDER BY sort_order`
  ).all(req.params.parent);

  const parentTitle = req.params.parent.charAt(0).toUpperCase() + req.params.parent.slice(1);
  const sidebar = subpages.length > 1 ? `
    <aside class="col-side">
      <div class="sidebar-card">
        <div class="sidebar-card-title">${escHtml(parentTitle)}</div>
        <ul class="sub-nav">
          ${subpages.map(s =>
            `<li><a href="/${s.parent}/${s.slug}"${s.slug === page.slug ? ' class="active"' : ''}>${escHtml(s.title)}</a></li>`
          ).join('')}
        </ul>
      </div>
    </aside>` : '';

  const content = `
    <div class="${sidebar ? 'two-col' : ''}">
      <section class="col-main">
        <h1>${escHtml(page.title)}</h1>
        <div class="page-content">${marked(page.content)}</div>
      </section>
      ${sidebar}
    </div>`;

  res.send(layout({ title: page.title, slug: req.params.parent, content }));
});

// Statiska toppnivåsidor  /fastigheten  /foreningen  etc.
app.get('/:slug', (req, res, next) => {
  if (req.params.slug === 'admin') return next();
  const page = db.prepare(
    `SELECT * FROM pages WHERE slug = ? AND parent IS NULL`
  ).get(req.params.slug);

  if (!page) return res.status(404).send(layout({
    title: '404',
    content: '<h1>Sidan hittades inte</h1><p><a href="/">Till startsidan</a></p>'
  }));

  const subpages = db.prepare(
    `SELECT title, slug, parent FROM pages WHERE parent = ? ORDER BY sort_order`
  ).all(req.params.slug);

  const sidebar = subpages.length > 0 ? `
    <aside class="col-side">
      <div class="sidebar-card">
        <div class="sidebar-card-title">${escHtml(page.title)}</div>
        <ul class="sub-nav">
          ${subpages.map(s =>
            `<li><a href="/${s.parent}/${s.slug}">${escHtml(s.title)}</a></li>`
          ).join('')}
        </ul>
      </div>
    </aside>` : '';

  // Kontaktsidan renderas som rå HTML (innehåller iframe-karta)
  const pageHtml = page.slug === 'kontakt'
    ? page.content
    : marked(page.content);

  const content = `
    <div class="${sidebar ? 'two-col' : ''}">
      <section class="col-main">
        <h1>${escHtml(page.title)}</h1>
        <div class="page-content">${pageHtml}</div>
      </section>
      ${sidebar}
    </div>`;

  res.send(layout({ title: page.title, slug: req.params.slug, content }));
});

// ─── Admin routes ────────────────────────────────────────────────────────────

function adminLayout({ title, content, req: r }) {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)} – Admin</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="admin-body">
  <div class="admin-shell">
    <nav class="admin-nav">
      <div class="admin-logo">BRF Sofia Strand<span>Admin</span></div>
      <a href="/admin">Nyheter</a>
      <a href="/admin/sidor">Sidor</a>
      <a href="/admin/installningar">Inställningar</a>
      <a href="/" target="_blank">← Visa sidan</a>
      <a href="/admin/logout" class="logout">Logga ut</a>
    </nav>
    <div class="admin-content">
      <h1>${escHtml(title)}</h1>
      ${content}
    </div>
  </div>
</body>
</html>`;
}

// Login
app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Logga in – BRF Sofia Strand Admin</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="admin-body login-page">
  <div class="login-box">
    <h1>BRF Sofia Strand</h1>
    <h2>Admin</h2>
    ${req.session.loginError ? `<p class="error">${escHtml(req.session.loginError)}</p>` : ''}
    <form method="POST" action="/admin/login">
      <label>Lösenord</label>
      <input type="password" name="password" autofocus required>
      <button type="submit">Logga in</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/admin/login', (req, res) => {
  const hash = getSetting('admin_password');
  if (bcrypt.compareSync(req.body.password || '', hash)) {
    req.session.loggedIn = true;
    delete req.session.loginError;
    res.redirect('/admin');
  } else {
    req.session.loginError = 'Fel lösenord, försök igen.';
    res.redirect('/admin/login');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Dashboard – lista nyheter
app.get('/admin', requireAuth, (req, res) => {
  const posts = db.prepare(
    `SELECT id, title, slug, published, created_at FROM posts ORDER BY created_at DESC`
  ).all();

  const rows = posts.map(p => `
    <tr>
      <td><a href="/admin/nyheter/${p.id}">${escHtml(p.title)}</a></td>
      <td>${fmtDate(p.created_at)}</td>
      <td><span class="badge ${p.published ? 'pub' : 'draft'}">${p.published ? 'Publicerad' : 'Utkast'}</span></td>
      <td class="actions">
        <a href="/admin/nyheter/${p.id}" class="btn-sm">Redigera</a>
        <form method="POST" action="/admin/nyheter/${p.id}/radera" style="display:inline"
              onsubmit="return confirm('Radera inlägget?')">
          <button class="btn-sm danger">Radera</button>
        </form>
      </td>
    </tr>`).join('');

  res.send(adminLayout({
    title: 'Nyheter',
    req,
    content: `
      <div class="admin-toolbar">
        <a href="/admin/nyheter/ny" class="btn">+ Ny nyhet</a>
      </div>
      <table class="admin-table">
        <thead><tr><th>Rubrik</th><th>Datum</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Inga nyheter ännu.</td></tr>'}</tbody>
      </table>`
  }));
});

// Ny nyhet – formulär
app.get('/admin/nyheter/ny', requireAuth, (req, res) => {
  res.send(adminLayout({
    title: 'Ny nyhet',
    req,
    content: postForm({})
  }));
});

// Spara ny nyhet
app.post('/admin/nyheter/ny', requireAuth, (req, res) => {
  const { title, content, published } = req.body;
  const slug = makeSlug(title) + '-' + Date.now();
  db.prepare(
    `INSERT INTO posts (title, content, slug, published) VALUES (?, ?, ?, ?)`
  ).run(title, content, slug, published === 'on' ? 1 : 0);
  res.redirect('/admin');
});

// Redigera nyhet
app.get('/admin/nyheter/:id', requireAuth, (req, res) => {
  const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(req.params.id);
  if (!post) return res.redirect('/admin');
  res.send(adminLayout({ title: 'Redigera nyhet', req, content: postForm(post) }));
});

// Spara redigerad nyhet
app.post('/admin/nyheter/:id', requireAuth, (req, res) => {
  const { title, content, published } = req.body;
  db.prepare(
    `UPDATE posts SET title = ?, content = ?, published = ? WHERE id = ?`
  ).run(title, content, published === 'on' ? 1 : 0, req.params.id);
  res.redirect('/admin');
});

// Radera nyhet
app.post('/admin/nyheter/:id/radera', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(req.params.id);
  res.redirect('/admin');
});

// ─── Admin – Sidor ───────────────────────────────────────────────────────────
app.get('/admin/sidor', requireAuth, (req, res) => {
  const pages = db.prepare(
    `SELECT id, title, slug, parent FROM pages ORDER BY parent NULLS FIRST, sort_order`
  ).all();

  const rows = pages.map(p => `
    <tr>
      <td>${p.parent ? '&nbsp;&nbsp;&nbsp;↳ ' : ''}${escHtml(p.title)}</td>
      <td><code>${p.parent ? `/${p.parent}/` : '/'}${p.slug}</code></td>
      <td class="actions"><a href="/admin/sidor/${p.id}" class="btn-sm">Redigera</a></td>
    </tr>`).join('');

  res.send(adminLayout({
    title: 'Sidor',
    req,
    content: `
      <table class="admin-table">
        <thead><tr><th>Sida</th><th>URL</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }));
});

app.get('/admin/sidor/:id', requireAuth, (req, res) => {
  const page = db.prepare(`SELECT * FROM pages WHERE id = ?`).get(req.params.id);
  if (!page) return res.redirect('/admin/sidor');

  res.send(adminLayout({
    title: `Redigera: ${page.title}`,
    req,
    content: `
      <form method="POST" action="/admin/sidor/${page.id}">
        <div class="form-group">
          <label>Rubrik</label>
          <input type="text" name="title" value="${escHtml(page.title)}" required>
        </div>
        <div class="form-group">
          <label>Innehåll <small>(Markdown stöds)</small></label>
          <textarea name="content" rows="20">${escHtml(page.content)}</textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Spara</button>
          <a href="/admin/sidor" class="btn-link">Avbryt</a>
        </div>
      </form>`
  }));
});

app.post('/admin/sidor/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE pages SET title = ?, content = ? WHERE id = ?`)
    .run(req.body.title, req.body.content, req.params.id);
  res.redirect('/admin/sidor');
});

// ─── Admin – Inställningar ───────────────────────────────────────────────────
app.get('/admin/installningar', requireAuth, (req, res) => {
  const msg = req.session.settingsMsg || '';
  delete req.session.settingsMsg;

  res.send(adminLayout({
    title: 'Inställningar',
    req,
    content: `
      ${msg ? `<p class="success">${escHtml(msg)}</p>` : ''}
      <form method="POST" action="/admin/installningar">
        <div class="form-group">
          <label>Föreningens namn</label>
          <input type="text" name="site_title" value="${escHtml(getSetting('site_title'))}">
        </div>
        <div class="form-group">
          <label>Adress / undertitel</label>
          <input type="text" name="site_subtitle" value="${escHtml(getSetting('site_subtitle'))}">
        </div>
        <hr>
        <h2>Byt lösenord</h2>
        <div class="form-group">
          <label>Nuvarande lösenord</label>
          <input type="password" name="current_password">
        </div>
        <div class="form-group">
          <label>Nytt lösenord</label>
          <input type="password" name="new_password">
        </div>
        <div class="form-group">
          <label>Bekräfta nytt lösenord</label>
          <input type="password" name="confirm_password">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Spara</button>
        </div>
      </form>`
  }));
});

app.post('/admin/installningar', requireAuth, (req, res) => {
  const update = db.prepare(`UPDATE settings SET value = ? WHERE key = ?`);
  update.run(req.body.site_title, 'site_title');
  update.run(req.body.site_subtitle, 'site_subtitle');

  if (req.body.new_password) {
    const hash = getSetting('admin_password');
    if (!bcrypt.compareSync(req.body.current_password || '', hash)) {
      req.session.settingsMsg = 'Fel nuvarande lösenord.';
    } else if (req.body.new_password !== req.body.confirm_password) {
      req.session.settingsMsg = 'Lösenorden matchar inte.';
    } else {
      update.run(bcrypt.hashSync(req.body.new_password, 10), 'admin_password');
      req.session.settingsMsg = 'Inställningar sparade!';
    }
  } else {
    req.session.settingsMsg = 'Inställningar sparade!';
  }
  res.redirect('/admin/installningar');
});

// ─── Hjälpfunktioner ─────────────────────────────────────────────────────────
function postForm(post) {
  const isNew   = !post.id;
  const action  = isNew ? '/admin/nyheter/ny' : `/admin/nyheter/${post.id}`;
  const checked = (!isNew && post.published) || isNew ? 'checked' : '';
  return `
    <form method="POST" action="${action}">
      <div class="form-group">
        <label>Rubrik</label>
        <input type="text" name="title" value="${escHtml(post.title || '')}" required autofocus>
      </div>
      <div class="form-group">
        <label>Innehåll <small>(Markdown stöds – **fet**, *kursiv*, ## rubrik, osv.)</small></label>
        <textarea name="content" rows="18">${escHtml(post.content || '')}</textarea>
      </div>
      <div class="form-group checkbox">
        <label><input type="checkbox" name="published" ${checked}> Publicera direkt</label>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn">${isNew ? 'Publicera' : 'Spara ändringar'}</button>
        <a href="/admin" class="btn-link">Avbryt</a>
      </div>
    </form>`;
}

function makeSlug(str) {
  return String(str)
    .toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  BRF Sofia Strand körs på http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin/login`);
  console.log(`   Lösenord: brf2024`);
});
