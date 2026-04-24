'use strict';
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');

const DB_PATH  = path.join(__dirname, 'data.db');
const EXPORT   = path.join(__dirname, 'data-export.json');

if (fs.existsSync(DB_PATH)) {
  console.log('✓ Databas finns redan, hoppar över init.');
  process.exit(0);
}

const db = new Database(DB_PATH);
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

const data = JSON.parse(fs.readFileSync(EXPORT, 'utf8'));

const insertPost = db.prepare(
  'INSERT OR IGNORE INTO posts (id,title,content,slug,published,created_at) VALUES (@id,@title,@content,@slug,@published,@created_at)'
);
const insertPage = db.prepare(
  'INSERT OR IGNORE INTO pages (id,title,slug,content,parent,sort_order) VALUES (@id,@title,@slug,@content,@parent,@sort_order)'
);
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key,value) VALUES (@key,@value)'
);

const runAll = db.transaction(() => {
  for (const p of data.posts) insertPost.run(p);
  for (const p of data.pages) insertPage.run(p);
  for (const s of data.settings) insertSetting.run(s);
  insertSetting.run({ key: 'admin_password', value: bcrypt.hashSync('brf2024', 10) });
});
runAll();

console.log(`✅ Databas initierad: ${data.posts.length} nyheter, ${data.pages.length} sidor.`);
