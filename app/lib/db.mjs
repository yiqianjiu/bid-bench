import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS projects (' +
  'id TEXT PRIMARY KEY, code TEXT, name TEXT, owner TEXT, agency TEXT, budget TEXT, ' +
  'bidDeadline TEXT, openTime TEXT, openPlace TEXT, deposit TEXT, purchaseMethod TEXT, ' +
  'packageNo TEXT, company TEXT, notes TEXT, status TEXT DEFAULT \'active\', dir TEXT, ' +
  'createdAt TEXT, updatedAt TEXT)',

  'CREATE TABLE IF NOT EXISTS files (' +
  'id TEXT PRIMARY KEY, projectId TEXT, stage TEXT, role TEXT, originalName TEXT, ' +
  'storedName TEXT, relPath TEXT, size INTEGER, sha256 TEXT, pages INTEGER, ' +
  'textChars INTEGER, extracted INTEGER DEFAULT 0, uploadedAt TEXT)',

  'CREATE TABLE IF NOT EXISTS events (' +
  'id TEXT PRIMARY KEY, projectId TEXT, kind TEXT, message TEXT, createdAt TEXT)',

  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',

  'CREATE INDEX IF NOT EXISTS idx_files_project ON files(projectId)',
  'CREATE INDEX IF NOT EXISTS idx_events_project ON events(projectId)'
];

export const STAGE_DIRS = [
  ['tender', '01招标文件'],
  ['analysis', '02分析'],
  ['draft', '03制作'],
  ['check', '04核查'],
  ['submit', '05递交']
];

// 新增列用「缺就补」的方式，避免老数据库打不开
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!cols.some((c) => c.name === column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + decl);
  }
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of SCHEMA) db.exec(sql);
  ensureColumn(db, 'projects', 'autoCode', 'TEXT');
  ensureColumn(db, 'projects', 'closedAt', 'TEXT');
  ensureColumn(db, 'projects', 'archiveNote', 'TEXT');
  ensureColumn(db, 'files', 'note', 'TEXT');
  ensureColumn(db, 'projects', 'analysisAt', 'TEXT');
  ensureColumn(db, 'projects', 'analysisStat', 'TEXT');
  // v1.1.2：补录项目（已过投标截止时间后补录的历史项目，不受"截止前不能关闭归档"限制）
  ensureColumn(db, 'projects', 'isBackfill', 'TEXT');
  ensureColumn(db, 'projects', 'abandonReason', 'TEXT');
  ensureColumn(db, 'projects', 'closedBy', 'TEXT');
  return db;
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function addEvent(db, projectId, kind, message) {
  const id = 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  run(db, 'INSERT INTO events (id, projectId, kind, message, createdAt) VALUES (?,?,?,?,?)',
    id, projectId, kind, message, new Date().toISOString());
}
