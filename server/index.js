import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import db, { getSettings, updateSettings, addLog, getLogs, clearLogs, isAlreadyPublished, recordPublishedVideo } from './db.js';
import { getVideoMetadata, processVideo } from './processor.js';
import { generateSeo } from './seo.js';
import { startScheduler, getNextScheduledRun, executeVideoPublish, fetchNextVideoFromDrive } from './scheduler.js';
import { parseDriveLink, downloadDriveVideo, extractFilesFromFolder } from './gdrive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.enable('trust proxy');
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage folders
const queueDir = path.resolve(__dirname, '../uploads/queue');
const processedDir = path.resolve(__dirname, '../uploads/processed');
const watermarkDir = path.resolve(__dirname, '../uploads/watermark');

[queueDir, processedDir, watermarkDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Serve static frontend & media
app.use(express.static(path.resolve(__dirname, '../public')));
app.use('/media', express.static(path.resolve(__dirname, '../uploads')));

// Video upload configuration
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, queueDir),
  filename: (req, file, cb) => {
    const cleanOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${cleanOriginal}`);
  }
});

const uploadVideos = multer({
  storage: videoStorage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Project Logo / Watermark upload configuration
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, watermarkDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `logo_proj_${req.params.id || 'new'}_${Date.now()}${ext}`);
  }
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ======================== API ROUTES ========================

// 1. Status & Overview
app.get('/api/status', (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId) : null;
  const settings = getSettings();
  const timezone = settings.timezone || 'Asia/Dhaka';
  const now = DateTime.now().setZone(timezone);

  const nextRun = getNextScheduledRun(projectId);

  let stockCountQuery = `SELECT 
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    COUNT(*) as total
    FROM videos`;
  const params = [];
  if (projectId) {
    stockCountQuery += ` WHERE project_id = ?`;
    params.push(projectId);
  }

  const counts = db.prepare(stockCountQuery).get(...params);

  res.json({
    currentTime: now.toFormat('hh:mm:ss a'),
    currentDate: now.toFormat('yyyy-MM-dd (cccc)'),
    currentTime24: now.toFormat('HH:mm'),
    timezone,
    simulationMode: settings.simulation_mode === '1',
    nextRun,
    stockStats: {
      pending: counts.pending || 0,
      published: counts.published || 0,
      failed: counts.failed || 0,
      total: counts.total || 0
    }
  });
});

// 2. Projects Management
app.get('/api/projects', (req, res) => {
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM videos v WHERE v.project_id = p.id AND v.status = 'pending') as pending_videos,
      (SELECT COUNT(*) FROM videos v WHERE v.project_id = p.id AND v.status = 'published') as published_videos,
      (SELECT COUNT(*) FROM schedules s WHERE s.project_id = p.id AND s.is_enabled = 1) as active_schedules
    FROM projects p
    ORDER BY p.id ASC
  `).all();
  res.json(projects);
});

app.get('/api/projects/:id', (req, res) => {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// Create New Project with initial schedules
app.post('/api/projects', (req, res) => {
  try {
    const {
      name,
      description,
      niche,
      publish_youtube = 1,
      publish_facebook = 1,
      default_slots = ['09:00', '14:00', '17:00', '19:00', '21:00']
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const stmt = db.prepare(`
      INSERT INTO projects (name, description, niche, publish_youtube, publish_facebook)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name.trim(),
      description || '',
      niche || 'Viral Facts & Entertainment',
      publish_youtube ? 1 : 0,
      publish_facebook ? 1 : 0
    );

    const newProjectId = result.lastInsertRowid;

    // Add initial schedules
    const insertSchedule = db.prepare(`
      INSERT INTO schedules (project_id, time_slot, is_enabled, label) VALUES (?, ?, 1, ?)
    `);

    const defaultLabels = {
      '09:00': 'সকাল ৯টা (Morning)',
      '14:00': 'দুপুর ২টা (Noon)',
      '17:00': 'বিকাল ৫টা (Afternoon)',
      '19:00': 'সন্ধ্যা ৭টা (Evening)',
      '21:00': 'রাত ৯টা (Night)'
    };

    if (Array.isArray(default_slots)) {
      for (const slot of default_slots) {
        insertSchedule.run(newProjectId, slot, defaultLabels[slot] || `${slot} Slot`);
      }
    }

    addLog('success', `Created new channel project: "${name.trim()}"`, '', newProjectId);
    res.json({ success: true, id: newProjectId, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Project
app.put('/api/projects/:id', (req, res) => {
  try {
    const p = req.body;
    const existing = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        niche = COALESCE(?, niche),
        content_language = COALESCE(?, content_language),
        default_hashtags = COALESCE(?, default_hashtags),
        publish_youtube = COALESCE(?, publish_youtube),
        publish_facebook = COALESCE(?, publish_facebook),
        youtube_client_id = COALESCE(?, youtube_client_id),
        youtube_client_secret = COALESCE(?, youtube_client_secret),
        youtube_refresh_token = COALESCE(?, youtube_refresh_token),
        youtube_privacy = COALESCE(?, youtube_privacy),
        facebook_access_token = COALESCE(?, facebook_access_token),
        facebook_page_id = COALESCE(?, facebook_page_id),
        watermark_enabled = COALESCE(?, watermark_enabled),
        watermark_position = COALESCE(?, watermark_position),
        watermark_scale = COALESCE(?, watermark_scale),
        watermark_opacity = COALESCE(?, watermark_opacity),
        sound_normalize_enabled = COALESCE(?, sound_normalize_enabled),
        sound_tweak_pitch_tempo = COALESCE(?, sound_tweak_pitch_tempo),
        gdrive_folder_url = COALESCE(?, gdrive_folder_url),
        gdrive_auto_sync = COALESCE(?, gdrive_auto_sync)
      WHERE id = ?
    `).run(
      p.name, p.description, p.niche, p.content_language, p.default_hashtags,
      p.publish_youtube, p.publish_facebook,
      p.youtube_client_id, p.youtube_client_secret, p.youtube_refresh_token, p.youtube_privacy,
      p.facebook_access_token, p.facebook_page_id,
      p.watermark_enabled, p.watermark_position, p.watermark_scale, p.watermark_opacity,
      p.sound_normalize_enabled, p.sound_tweak_pitch_tempo,
      p.gdrive_folder_url, p.gdrive_auto_sync,
      req.params.id
    );

    addLog('info', `Updated settings for project "${p.name || existing.name}"`, '', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync Next Video from Google Drive On-Demand
app.post('/api/projects/:id/sync-drive-next', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.gdrive_folder_url) {
      return res.status(400).json({ error: 'এই চ্যানেলে কোনো Google Drive ফোল্ডার লিঙ্ক কানেক্ট করা নেই' });
    }

    const video = await fetchNextVideoFromDrive(project);
    if (!video) {
      return res.status(404).json({ error: 'ড্রাইভ ফোল্ডারে আর কোনো নতুন বা অপ্রকাশিত ভিডিও পাওয়া যায়নি' });
    }

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Channel Logo (Watermark) for Project
app.post('/api/projects/:id/logo', uploadLogo.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No logo uploaded' });

    const buffer = fs.readFileSync(req.file.path);
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '') || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    db.prepare(`UPDATE projects SET logo_path = ?, logo_data_url = ?, watermark_enabled = 1 WHERE id = ?`).run(req.file.path, dataUrl, req.params.id);
    addLog('success', `Uploaded permanent channel logo for project #${req.params.id}`, req.file.originalname, req.params.id);

    res.json({
      success: true,
      logoPath: req.file.path,
      logoUrl: `/media/watermark/${req.file.filename}`,
      logoDataUrl: dataUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Logo via Base64 (Permanent browser-server auto-sync)
app.post('/api/projects/:id/logo-base64', (req, res) => {
  try {
    const { logoDataUrl } = req.body;
    if (!logoDataUrl || !logoDataUrl.startsWith('data:image')) {
      return res.status(400).json({ error: 'Valid image DataURL required' });
    }
    const projectId = parseInt(req.params.id);
    const matches = logoDataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Malformed DataURL' });

    const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : 'png';
    const filename = `logo_proj_${projectId}_permanent.${ext}`;
    const filePath = path.join(watermarkDir, filename);

    fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));

    db.prepare(`UPDATE projects SET logo_path = ?, logo_data_url = ?, watermark_enabled = 1 WHERE id = ?`).run(filePath, logoDataUrl, projectId);
    addLog('info', `Saved permanent logo backup for project #${projectId}`, filename, projectId);

    res.json({ success: true, logoUrl: `/media/watermark/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Project
app.delete('/api/projects/:id', (req, res) => {
  const count = db.prepare(`SELECT COUNT(*) as count FROM projects`).get().count;
  if (count <= 1) {
    return res.status(400).json({ error: 'Cannot delete the only remaining project! Please create another project first.' });
  }

  db.prepare(`DELETE FROM projects WHERE id = ?`).run(req.params.id);
  addLog('info', `Deleted project #${req.params.id}`);
  res.json({ success: true });
});

// 3. Videos in Project
app.get('/api/projects/:id/videos', (req, res) => {
  const statusFilter = req.query.status;
  let query = `SELECT * FROM videos WHERE project_id = ?`;
  const params = [req.params.id];

  if (statusFilter) {
    query += ` AND status = ?`;
    params.push(statusFilter);
  }

  query += ` ORDER BY 
    CASE status 
      WHEN 'processing' THEN 1 
      WHEN 'pending' THEN 2 
      WHEN 'failed' THEN 3 
      ELSE 4 
    END, 
    priority_order ASC, id DESC`;

  const videos = db.prepare(query).all(...params);
  res.json(videos);
});

// Upload Videos to Project Stock
app.post('/api/projects/:id/videos/upload', uploadVideos.array('videos', 50), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No videos uploaded' });
    }

    const insertedVideos = [];
    const insertStmt = db.prepare(`
      INSERT INTO videos (project_id, filename, original_name, file_path, file_size, duration, status, priority_order)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    const maxOrderRow = db.prepare(`SELECT MAX(priority_order) as max_order FROM videos WHERE project_id = ? AND status = 'pending'`).get(projectId);
    let currentOrder = (maxOrderRow?.max_order || 0) + 1;

    for (const file of req.files) {
      if (isAlreadyPublished({ projectId, originalName: file.originalname, fileSize: file.size })) {
        try { fs.unlinkSync(file.path); } catch (e) {}
        addLog('warn', `⚠️ ডুপ্লিকেট রোধ: "${file.originalname}" ইতিমধ্যে আগে পাবলিশ করা হয়েছে, আপলোড বাদ দেওয়া হলো!`, '', projectId);
        continue;
      }

      const meta = await getVideoMetadata(file.path);
      const result = insertStmt.run(
        projectId,
        file.filename,
        file.originalname,
        file.path,
        file.size,
        meta.duration,
        currentOrder++
      );

      insertedVideos.push({
        id: result.lastInsertRowid,
        filename: file.filename,
        originalName: file.originalname,
        duration: meta.duration,
        size: file.size
      });
    }

    addLog('success', `Uploaded ${insertedVideos.length} video(s) into project #${projectId} stock queue`, '', projectId);
    res.json({ success: true, count: insertedVideos.length, videos: insertedVideos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import video(s) from Google Drive
app.post('/api/projects/:id/videos/import-gdrive', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { links } = req.body;
    if (!links) {
      return res.status(400).json({ error: 'দয়া করে Google Drive ভিডিও লিঙ্ক দিন' });
    }

    let rawLinks = Array.isArray(links) ? links : String(links).split(/[\r\n,]+/);
    rawLinks = rawLinks.map(l => l.trim()).filter(l => l.length > 0);

    if (rawLinks.length === 0) {
      return res.status(400).json({ error: 'কোনো বৈধ লিঙ্ক পাওয়া যায়নি' });
    }

    const maxOrderRow = db.prepare(`SELECT MAX(priority_order) as max_order FROM videos WHERE project_id = ? AND status = 'pending'`).get(projectId);
    let currentOrder = (maxOrderRow?.max_order || 0) + 1;

    const inserted = [];
    const errors = [];

    const insertStmt = db.prepare(`
      INSERT INTO videos (project_id, filename, original_name, file_path, file_size, duration, status, priority_order)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    // Expand folder links or collect file IDs
    const fileItems = [];
    for (const link of rawLinks) {
      const parsed = parseDriveLink(link);
      if (!parsed) {
        errors.push({ link, error: 'সঠিক Google Drive লিঙ্ক নয়' });
        continue;
      }

      if (parsed.type === 'folder') {
        try {
          addLog('info', `Google Drive ফোল্ডার থেকে ফাইল খোঁজা হচ্ছে... (ID: ${parsed.id})`, link, projectId);
          const folderFiles = await extractFilesFromFolder(parsed.id);
          if (folderFiles.length === 0) {
            errors.push({ link, error: 'ফোল্ডারে কোনো ভিডিও ফাইল পাওয়া যায়নি অথবা ফোল্ডারটি পাবলিক নয়' });
          } else {
            addLog('info', `Google Drive ফোল্ডারে ${folderFiles.length}টি ভিডিও পাওয়া গেছে!`, '', projectId);
            for (const f of folderFiles) {
              fileItems.push({ id: f.id, name: f.name, link: `https://drive.google.com/file/d/${f.id}/view` });
            }
          }
        } catch (fErr) {
          errors.push({ link, error: `ফোল্ডার রিড করতে ব্যর্থ: ${fErr.message}` });
        }
      } else {
        fileItems.push({ id: parsed.id, name: `GDrive_${parsed.id.slice(0, 8)}.mp4`, link });
      }
    }

    if (fileItems.length === 0) {
      const errMsg = errors[0]?.error || 'কোনো ভিডিও ফাইল পাওয়া যায়নি';
      return res.status(400).json({ success: false, error: errMsg, errors });
    }

    // Respond immediately so user UI doesn't freeze or timeout
    res.json({
      success: true,
      totalDetected: fileItems.length,
      message: `${fileItems.length}টি ভিডিও পাওয়া গেছে! ব্যাকগ্রাউন্ডে স্টকে এক এক করে জমা হচ্ছে...`
    });

    // Background download processing
    (async () => {
      const maxOrderRow = db.prepare(`SELECT MAX(priority_order) as max_order FROM videos WHERE project_id = ? AND status = 'pending'`).get(projectId);
      let currentOrder = (maxOrderRow?.max_order || 0) + 1;

      const insertStmt = db.prepare(`
        INSERT INTO videos (project_id, filename, original_name, file_path, file_size, duration, status, priority_order, gdrive_file_id)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);

      for (const item of fileItems) {
        if (isAlreadyPublished({ projectId, gdriveFileId: item.id, originalName: item.name })) {
          addLog('warn', `⚠️ ডুপ্লিকেট রোধ: "${item.name || item.id}" ইতিমধ্যে পূর্বে পাবলিশ করা হয়েছে, ডাউনলোড বাদ দেওয়া হলো!`, item.link, projectId);
          continue;
        }

        const filename = `${Date.now()}_gdrive_${item.id}.mp4`;
        const targetPath = path.join(queueDir, filename);

        try {
          addLog('info', `Google Drive থেকে ডাউনলোড হচ্ছে: ${item.name || item.id}`, `Link: ${item.link}`, projectId);
          await downloadDriveVideo(item.id, targetPath);

          const meta = await getVideoMetadata(targetPath);
          const stats = fs.statSync(targetPath);
          const originalName = item.name || `GDrive_${item.id.slice(0, 8)}.mp4`;

          insertStmt.run(
            projectId,
            filename,
            originalName,
            targetPath,
            stats.size,
            meta.duration,
            currentOrder++,
            item.id
          );

          addLog('success', `Google Drive থেকে ভিডিও সফলভাবে স্টকে জমা হয়েছে! (${originalName})`, '', projectId);
        } catch (dlErr) {
          if (fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (e) {}
          }
          addLog('error', `Google Drive ডাউনলোড ব্যর্থ (${item.name || item.id}): ${dlErr.message}`, item.link, projectId);
        }
      }
    })().catch(bgErr => {
      console.error('Background gdrive download error:', bgErr);
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Publish Next Video in Project
app.post('/api/projects/:id/publish-next', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const result = await executeVideoPublish({ projectId, triggerSource: 'Manual "Publish Next" Button' });
  res.json(result);
});

// Publish Specific Video
app.post('/api/videos/:id/publish-now', async (req, res) => {
  const videoId = parseInt(req.params.id);
  const result = await executeVideoPublish({ videoId, triggerSource: 'Manual Instant Trigger' });
  res.json(result);
});

// Sync or Update Video Publish Status
app.post('/api/videos/:id/sync-published', (req, res) => {
  try {
    const videoId = parseInt(req.params.id);
    const { status, facebook_post_id, facebook_url, youtube_video_id, youtube_url } = req.body;
    const video = db.prepare(`SELECT * FROM videos WHERE id = ?`).get(videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    db.prepare(`
      UPDATE videos
      SET status = COALESCE(?, status),
          facebook_post_id = COALESCE(?, facebook_post_id),
          facebook_url = COALESCE(?, facebook_url),
          youtube_video_id = COALESCE(?, youtube_video_id),
          youtube_url = COALESCE(?, youtube_url),
          error_message = NULL,
          published_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, facebook_post_id, facebook_url, youtube_video_id, youtube_url, videoId);

    const isDone = status === 'published' || ((facebook_post_id || video.facebook_post_id) && (youtube_video_id || video.youtube_video_id));
    if (isDone) {
      db.prepare(`UPDATE videos SET status = 'published', error_message = NULL WHERE id = ?`).run(videoId);
      recordPublishedVideo({
        projectId: video.project_id,
        gdriveFileId: video.gdrive_file_id,
        originalName: video.original_name,
        fileSize: video.file_size,
        youtubeVideoId: youtube_video_id || video.youtube_video_id,
        facebookPostId: facebook_post_id || video.facebook_post_id
      });
    }

    addLog('success', `Video #${videoId} synced to published state`, '', video.project_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Video
app.delete('/api/videos/:id', (req, res) => {
  const video = db.prepare(`SELECT * FROM videos WHERE id = ?`).get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  try {
    if (fs.existsSync(video.file_path)) fs.unlinkSync(video.file_path);
    if (video.processed_path && fs.existsSync(video.processed_path)) fs.unlinkSync(video.processed_path);
  } catch (e) {
    console.error('File cleanup error:', e);
  }

  db.prepare(`DELETE FROM videos WHERE id = ?`).run(req.params.id);
  addLog('info', `Deleted video #${video.id} ("${video.original_name}")`, '', video.project_id);
  res.json({ success: true });
});

// Bulk Delete Videos
app.post('/api/projects/:id/videos/bulk-delete', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'কোনো ভিডিও সিলেক্ট করা হয়নি' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const videos = db.prepare(`SELECT * FROM videos WHERE project_id = ? AND id IN (${placeholders})`).all(projectId, ...ids);

    for (const v of videos) {
      try {
        if (v.file_path && fs.existsSync(v.file_path)) fs.unlinkSync(v.file_path);
        if (v.processed_path && fs.existsSync(v.processed_path)) fs.unlinkSync(v.processed_path);
      } catch (e) {}
    }

    db.prepare(`DELETE FROM videos WHERE project_id = ? AND id IN (${placeholders})`).run(projectId, ...ids);
    addLog('info', `স্টক থেকে ${videos.length}টি সিলেক্ট করা ভিডিও মুছে ফেলা হয়েছে`, '', projectId);
    res.json({ success: true, deletedCount: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear All Queued (Pending) Videos in Project
app.delete('/api/projects/:id/videos/clear-queue', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const videos = db.prepare(`SELECT * FROM videos WHERE project_id = ? AND status = 'pending'`).all(projectId);

    for (const v of videos) {
      try {
        if (v.file_path && fs.existsSync(v.file_path)) fs.unlinkSync(v.file_path);
        if (v.processed_path && fs.existsSync(v.processed_path)) fs.unlinkSync(v.processed_path);
      } catch (e) {}
    }

    db.prepare(`DELETE FROM videos WHERE project_id = ? AND status = 'pending'`).run(projectId);
    addLog('info', `স্টকের সমস্ত পেন্ডিং ভিডিও (${videos.length}টি) মুছে ফেলা হয়েছে`, '', projectId);
    res.json({ success: true, deletedCount: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset published tracker (useful to retry/re-publish videos)
app.post('/api/projects/:id/reset-tracker', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const { gdriveFileId, originalName } = req.body || {};
    if (gdriveFileId) {
      db.prepare(`DELETE FROM published_tracker WHERE project_id = ? AND gdrive_file_id = ?`).run(projectId, gdriveFileId);
      db.prepare(`DELETE FROM videos WHERE project_id = ? AND gdrive_file_id = ?`).run(projectId, gdriveFileId);
    } else if (originalName) {
      db.prepare(`DELETE FROM published_tracker WHERE project_id = ? AND original_name = ?`).run(projectId, originalName);
      db.prepare(`DELETE FROM videos WHERE project_id = ? AND original_name = ?`).run(projectId, originalName);
    } else {
      db.prepare(`DELETE FROM published_tracker WHERE project_id = ?`).run(projectId);
      db.prepare(`DELETE FROM videos WHERE project_id = ?`).run(projectId);
    }
    addLog('info', `Reset published tracker for project #${projectId}`, '', projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove Duplicate Videos from Queue
app.post('/api/projects/:id/videos/remove-duplicates', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const videos = db.prepare(`SELECT * FROM videos WHERE project_id = ? AND status = 'pending' ORDER BY priority_order ASC, id ASC`).all(projectId);

    const seen = new Set();
    const duplicateIds = [];

    for (const v of videos) {
      // Key can be original_name or file_size + duration
      const key = `${v.original_name}_${v.file_size}_${Math.round(v.duration || 0)}`;
      if (seen.has(key)) {
        duplicateIds.push(v.id);
        try {
          if (v.file_path && fs.existsSync(v.file_path)) fs.unlinkSync(v.file_path);
          if (v.processed_path && fs.existsSync(v.processed_path)) fs.unlinkSync(v.processed_path);
        } catch (e) {}
      } else {
        seen.add(key);
      }
    }

    if (duplicateIds.length > 0) {
      const placeholders = duplicateIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM videos WHERE id IN (${placeholders})`).run(...duplicateIds);
      addLog('info', `স্টক থেকে ${duplicateIds.length}টি ডুপ্লিকেট ভিডিও অপসারণ করা হয়েছে`, '', projectId);
    }

    res.json({ success: true, removedCount: duplicateIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Schedules in Project
app.get('/api/projects/:id/schedules', (req, res) => {
  const schedules = db.prepare(`SELECT * FROM schedules WHERE project_id = ? ORDER BY time_slot ASC`).all(req.params.id);
  res.json(schedules);
});

app.post('/api/projects/:id/schedules', (req, res) => {
  const { time_slot, label } = req.body;
  const projectId = parseInt(req.params.id);

  if (!time_slot || !/^\d{2}:\d{2}$/.test(time_slot)) {
    return res.status(400).json({ error: 'Invalid time format. Please use HH:mm' });
  }

  try {
    const existing = db.prepare(`SELECT id FROM schedules WHERE project_id = ? AND time_slot = ?`).get(projectId, time_slot);
    if (existing) {
      return res.status(400).json({ error: 'This time slot already exists for this channel!' });
    }

    const stmt = db.prepare(`INSERT INTO schedules (project_id, time_slot, is_enabled, label) VALUES (?, ?, 1, ?)`);
    const result = stmt.run(projectId, time_slot, label || `${time_slot} Slot`);
    addLog('info', `Added schedule slot: ${time_slot}`, '', projectId);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id/schedules/:schedId', (req, res) => {
  const { is_enabled, label } = req.body;
  db.prepare(`
    UPDATE schedules 
    SET is_enabled = COALESCE(?, is_enabled),
        label = COALESCE(?, label)
    WHERE id = ? AND project_id = ?
  `).run(
    is_enabled !== undefined ? (is_enabled ? 1 : 0) : null,
    label !== undefined ? label : null,
    req.params.schedId,
    req.params.id
  );
  res.json({ success: true });
});

app.delete('/api/projects/:id/schedules/:schedId', (req, res) => {
  db.prepare(`DELETE FROM schedules WHERE id = ? AND project_id = ?`).run(req.params.schedId, req.params.id);
  res.json({ success: true });
});

// 4b. Apply Schedule Preset (e.g. 4-slots BD + USA target)
app.post('/api/projects/:id/schedules/preset', (req, res) => {
  const projectId = parseInt(req.params.id);
  const { slots } = req.body;
  if (!slots || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Slots array is required' });
  }

  try {
    const deleteExisting = db.prepare(`DELETE FROM schedules WHERE project_id = ?`);
    const insert = db.prepare(`INSERT INTO schedules (project_id, time_slot, is_enabled, label) VALUES (?, ?, 1, ?)`);

    const runBatch = db.transaction(() => {
      deleteExisting.run(projectId);
      for (const s of slots) {
        insert.run(projectId, s.time_slot, s.label || `${s.time_slot} Slot`);
      }
    });

    runBatch();
    addLog('success', `Applied ${slots.length}-slot schedule preset for project`, '', projectId);
    res.json({ success: true, message: 'Preset applied successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Global Settings
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
  const updated = updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

// 1-Click Google OAuth Login URL
app.get('/api/auth/google/login', async (req, res) => {
  try {
    const projectId = parseInt(req.query.projectId) || 1;
    let project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) return res.status(404).send('Project not found');

    const clientId = (req.query.clientId || project.youtube_client_id || '').trim();
    const clientSecret = (req.query.clientSecret || project.youtube_client_secret || '').trim();

    if (!clientId || !clientSecret) {
      return res.status(400).send('YouTube Client ID এবং Client Secret আগে সেভ করুন!');
    }

    // Immediately save to DB
    db.prepare(`UPDATE projects SET youtube_client_id = ?, youtube_client_secret = ? WHERE id = ?`).run(clientId, clientSecret, projectId);

    const { google } = await import('googleapis');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const redirectUri = `${proto}://${req.get('host')}/api/auth/google/callback`;

    // Encode state with projectId, clientId, clientSecret to survive any container restarts
    const statePayload = Buffer.from(JSON.stringify({ projectId, clientId, clientSecret })).toString('base64');

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Guarantees a permanent Refresh Token
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly'
      ],
      state: statePayload
    });

    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth Error: ${err.message}`);
  }
});

// Google OAuth Callback Handler
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`Google Login Error: ${error} - ${error_description || ''}`);
    }

    if (!code) return res.status(400).send('Authorization code not provided');

    // Decode state
    let projectId = 1;
    let clientId = '';
    let clientSecret = '';

    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        projectId = parseInt(decoded.projectId) || 1;
        clientId = (decoded.clientId || '').trim();
        clientSecret = (decoded.clientSecret || '').trim();
      } catch (e) {
        projectId = parseInt(state) || 1;
      }
    }

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!clientId && project) clientId = project.youtube_client_id?.trim();
    if (!clientSecret && project) clientSecret = project.youtube_client_secret?.trim();

    if (!clientId || !clientSecret) {
      return res.status(400).send('OAuth Callback Error: Client ID বা Client Secret পাওয়া যায়নি।');
    }

    const { google } = await import('googleapis');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const redirectUri = `${proto}://${req.get('host')}/api/auth/google/callback`;

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    if (tokens.refresh_token) {
      db.prepare(`
        UPDATE projects 
        SET youtube_refresh_token = ?,
            youtube_client_id = ?,
            youtube_client_secret = ?
        WHERE id = ?
      `).run(tokens.refresh_token, clientId, clientSecret, projectId);
      addLog('success', `YouTube 1-Click OAuth completed for project "${project?.name || projectId}"! Refresh token saved.`, '', projectId);
    } else {
      addLog('warn', `OAuth completed but Google did not return a new refresh token (already authorized).`, '', projectId);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>YouTube Connected</title>
        <meta charset="UTF-8">
        <style>
          body { background: #0b0f19; color: #fff; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #111827; border: 1px solid #1f2937; padding: 40px; border-radius: 24px; max-width: 440px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
          .icon { font-size: 48px; margin-bottom: 16px; color: #10b981; }
          h2 { margin: 0 0 8px 0; font-size: 20px; font-weight: bold; }
          p { color: #9ca3af; font-size: 14px; margin: 0 0 20px 0; }
          button { background: #4f46e5; color: white; border: none; padding: 10px 24px; border-radius: 12px; font-weight: 600; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h2>YouTube চ্যানেল সফলভাবে কানেক্ট হয়েছে!</h2>
          <p>আপনার Refresh Token স্বয়ংক্রিয়ভাবে ডাটাবেসে সেভ করা হয়েছে।</p>
          <button onclick="window.close(); if(window.opener) { window.opener.location.reload(); }">ড্যাশবোর্ডে ফিরে যান</button>
        </div>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage({
                type: 'YOUTUBE_OAUTH_TOKEN',
                projectId: ${projectId},
                refreshToken: '${tokens.refresh_token || ""}'
              }, '*');
            }
          } catch(e) {}
          setTimeout(() => {
            if (window.opener) {
              window.opener.location.reload();
              window.close();
            } else {
              window.location.href = '/';
            }
          }, 1800);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`OAuth Callback Error: ${err.message}`);
  }
});

// Test YouTube API Connection
app.post('/api/projects/:id/test-youtube', async (req, res) => {
  try {
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const clientId = project.youtube_client_id?.trim();
    const clientSecret = project.youtube_client_secret?.trim();
    const refreshToken = project.youtube_refresh_token?.trim();

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({ error: 'YouTube Client ID, Secret, এবং Refresh Token দিন!' });
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'https://developers.google.com/oauthplayground');
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const response = await youtube.channels.list({
      part: ['snippet'],
      mine: true
    });

    const channel = response.data.items?.[0];
    if (!channel) {
      return res.status(400).json({ error: 'কোনো YouTube চ্যানেল পাওয়া যায়নি। সঠিক একাউন্ট সিলেক্ট করেছেন কিনা দেখুন।' });
    }

    addLog('success', `YouTube connection verified: "${channel.snippet.title}"`, '', project.id);
    res.json({
      success: true,
      channelName: channel.snippet.title,
      channelDescription: channel.snippet.description,
      channelThumbnail: channel.snippet.thumbnails?.default?.url
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: `YouTube API Error: ${msg}` });
  }
});

// Test Facebook Graph API Connection
app.post('/api/projects/:id/test-facebook', async (req, res) => {
  try {
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const pageToken = project.facebook_access_token?.trim();
    const pageId = project.facebook_page_id?.trim();

    if (!pageToken || !pageId) {
      return res.status(400).json({ error: 'Facebook Page ID এবং Access Token দিন!' });
    }

    const { default: axios } = await import('axios');
    const fbRes = await axios.get(`https://graph.facebook.com/v20.0/${pageId}`, {
      params: {
        fields: 'id,name,link,picture',
        access_token: pageToken
      },
      timeout: 10000
    });

    addLog('success', `Facebook Page connection verified: "${fbRes.data.name}"`, '', project.id);
    res.json({
      success: true,
      pageName: fbRes.data.name,
      pageId: fbRes.data.id,
      pagePicture: fbRes.data.picture?.data?.url
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: `Facebook API Error: ${msg}` });
  }
});

// Preview project watermark on sample video
app.post('/api/projects/:id/preview-watermark', async (req, res) => {
  try {
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Find input video: first pending video in project or test sample
    let inputVideo = db.prepare(`SELECT file_path FROM videos WHERE project_id = ? ORDER BY id DESC LIMIT 1`).get(req.params.id)?.file_path;
    if (!inputVideo || !fs.existsSync(inputVideo)) {
      inputVideo = path.resolve(__dirname, '../uploads/test/sample_input.mp4');
    }

    if (!fs.existsSync(inputVideo)) {
      return res.status(400).json({ error: 'কোনো ভিডিও পাওয়া যায়নি। অনুগ্রহ করে স্টকে একটি ভিডিও আপলোড করুন।' });
    }

    const outPath = path.resolve(__dirname, `../uploads/processed/preview_proj_${project.id}.mp4`);

    await processVideo(inputVideo, outPath, {
      watermarkEnabled: project.watermark_enabled === 1 && !!project.logo_path,
      watermarkPath: project.logo_path,
      watermarkPosition: project.watermark_position || 'top-right',
      watermarkScale: project.watermark_scale || 0.16,
      watermarkOpacity: project.watermark_opacity || 0.85,
      soundNormalizeEnabled: project.sound_normalize_enabled === 1,
      soundTweakEnabled: project.sound_tweak_pitch_tempo === 1
    });

    res.json({
      success: true,
      previewUrl: `/media/processed/preview_proj_${project.id}.mp4?t=${Date.now()}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Test AI SEO
app.post('/api/test/seo', async (req, res) => {
  try {
    const { topic, projectId } = req.body;
    const globalSettings = getSettings();
    let project = null;
    if (projectId) {
      project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    }

    const seoSettings = {
      gemini_api_key: globalSettings.gemini_api_key,
      channel_niche: project?.niche || 'Viral Facts & Entertainment',
      content_language: project?.content_language || 'Bangla & English',
      default_hashtags: project?.default_hashtags || '#Shorts #Reels #Viral #Trending #Bangla'
    };

    const result = await generateSeo(
      { originalName: topic || 'top_viral_tips.mp4' },
      seoSettings
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Activity Logs
app.get('/api/logs', (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId) : null;
  const limit = parseInt(req.query.limit) || 100;
  res.json(getLogs(projectId, limit));
});

app.delete('/api/logs', (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId) : null;
  clearLogs(projectId);
  res.json({ success: true });
});

// SPA Fallback for client-side navigation
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Start scheduler and web server
startScheduler();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 AutoShorts Multi-Channel Platform is running!`);
  console.log(`🌐 Web Dashboard: http://localhost:${PORT}`);
  console.log(`⏰ Multi-Project Scheduler Daemon: ACTIVE`);
  console.log(`====================================================`);
  addLog('success', `AutoShorts multi-channel system started on port ${PORT}`);
});
