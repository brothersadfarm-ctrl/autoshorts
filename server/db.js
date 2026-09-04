import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbDir = path.resolve(__dirname, '../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode & foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    logo_path TEXT, -- Watermark logo
    niche TEXT DEFAULT 'Viral Facts & Entertainment',
    content_language TEXT DEFAULT 'Bangla & English',
    default_hashtags TEXT DEFAULT '#Shorts #Reels #Viral #Trending #Bangla',
    publish_youtube INTEGER DEFAULT 1,
    publish_facebook INTEGER DEFAULT 1,
    youtube_client_id TEXT DEFAULT '',
    youtube_client_secret TEXT DEFAULT '',
    youtube_refresh_token TEXT DEFAULT '',
    youtube_privacy TEXT DEFAULT 'public',
    facebook_access_token TEXT DEFAULT '',
    facebook_page_id TEXT DEFAULT '',
    watermark_enabled INTEGER DEFAULT 1,
    watermark_position TEXT DEFAULT 'top-right',
    watermark_scale REAL DEFAULT 0.16,
    watermark_opacity REAL DEFAULT 0.85,
    sound_normalize_enabled INTEGER DEFAULT 1,
    sound_tweak_pitch_tempo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    processed_path TEXT,
    file_size INTEGER DEFAULT 0,
    duration REAL DEFAULT 0,
    status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'published', 'failed'
    priority_order INTEGER DEFAULT 0,
    title TEXT,
    description TEXT,
    tags TEXT,
    youtube_video_id TEXT,
    youtube_url TEXT,
    facebook_post_id TEXT,
    facebook_url TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    time_slot TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    label TEXT,
    last_run_date TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    level TEXT DEFAULT 'info',
    message TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

try {
  const projectCols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name);
  if (!projectCols.includes('gdrive_folder_url')) {
    db.exec(`ALTER TABLE projects ADD COLUMN gdrive_folder_url TEXT DEFAULT ''`);
  }
  if (!projectCols.includes('gdrive_auto_sync')) {
    db.exec(`ALTER TABLE projects ADD COLUMN gdrive_auto_sync INTEGER DEFAULT 1`);
  }
} catch (e) {
  console.log('Migration notice (projects):', e.message);
}

try {
  const videoCols = db.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
  if (!videoCols.includes('project_id')) {
    db.exec(`ALTER TABLE videos ADD COLUMN project_id INTEGER DEFAULT 1 REFERENCES projects(id) ON DELETE CASCADE`);
  }
  if (!videoCols.includes('gdrive_file_id')) {
    db.exec(`ALTER TABLE videos ADD COLUMN gdrive_file_id TEXT DEFAULT ''`);
  }
} catch (e) {
  console.log('Migration notice (videos):', e.message);
}

try {
  const schedCols = db.prepare(`PRAGMA table_info(schedules)`).all().map(c => c.name);
  if (!schedCols.includes('project_id')) {
    db.exec(`ALTER TABLE schedules ADD COLUMN project_id INTEGER DEFAULT 1 REFERENCES projects(id) ON DELETE CASCADE`);
  }
} catch (e) {
  console.log('Migration notice (schedules):', e.message);
}

try {
  const logCols = db.prepare(`PRAGMA table_info(logs)`).all().map(c => c.name);
  if (!logCols.includes('project_id')) {
    db.exec(`ALTER TABLE logs ADD COLUMN project_id INTEGER`);
  }
} catch (e) {
  console.log('Migration notice (logs):', e.message);
}

// Global default settings
const defaultSettings = {
  timezone: 'Asia/Dhaka',
  simulation_mode: '1',
  gemini_api_key: ''
};

const insertSettingStmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSettingStmt.run(key, value);
}

// Create initial default project if none exist
const projectCount = db.prepare(`SELECT COUNT(*) as count FROM projects`).get().count;
if (projectCount === 0) {
  const createProjectStmt = db.prepare(`
    INSERT INTO projects (name, description, niche, publish_youtube, publish_facebook)
    VALUES (?, ?, ?, ?, ?)
  `);
  const initialProject = createProjectStmt.run(
    'My First Channel (চ্যানেল ১)',
    'ডিফল্ট শর্ট ভিডিও চ্যানেল ও ফেসবুক পেজ',
    'Viral Facts & Entertainment',
    1,
    1
  );

  const initialProjectId = initialProject.lastInsertRowid;

  // Add default schedule slots for this project
  const insertSchedule = db.prepare(`
    INSERT INTO schedules (project_id, time_slot, is_enabled, label) VALUES (?, ?, ?, ?)
  `);
  insertSchedule.run(initialProjectId, '09:00', 1, 'সকাল ৯টা (Morning)');
  insertSchedule.run(initialProjectId, '14:00', 1, 'দুপুর ২টা (Noon)');
  insertSchedule.run(initialProjectId, '17:00', 1, 'বিকাল ৫টা (Afternoon)');
  insertSchedule.run(initialProjectId, '19:00', 1, 'সন্ধ্যা ৭টা (Evening)');
  insertSchedule.run(initialProjectId, '21:00', 1, 'রাত ৯টা (Night)');

  // Update existing videos to belong to this project
  db.prepare(`UPDATE videos SET project_id = ? WHERE project_id IS NULL OR project_id = 0`).run(initialProjectId);
}

export const getSettings = () => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const settingsObj = { ...defaultSettings };
  for (const row of rows) {
    settingsObj[row.key] = row.value;
  }
  return settingsObj;
};

export const updateSettings = (newSettings) => {
  const updateStmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  const updateMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      updateStmt.run(key, String(value ?? ''));
    }
  });
  updateMany(Object.entries(newSettings));
  return getSettings();
};

export const addLog = (level, message, details = '', projectId = null) => {
  try {
    const stmt = db.prepare(`
      INSERT INTO logs (project_id, level, message, details, created_at)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    stmt.run(projectId, level, message, typeof details === 'object' ? JSON.stringify(details) : String(details));
  } catch (err) {
    console.error('Failed to write log:', err);
  }
};

export const getLogs = (projectId = null, limit = 100) => {
  if (projectId) {
    return db.prepare(`SELECT * FROM logs WHERE project_id = ? OR project_id IS NULL ORDER BY id DESC LIMIT ?`).all(projectId, limit);
  }
  return db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`).all(limit);
};

export const clearLogs = (projectId = null) => {
  if (projectId) {
    db.prepare(`DELETE FROM logs WHERE project_id = ?`).run(projectId);
  } else {
    db.prepare(`DELETE FROM logs`).run();
  }
};

export default db;
