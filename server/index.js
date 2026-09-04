import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import db, { getSettings, updateSettings, addLog, getLogs, clearLogs } from './db.js';
import { getVideoMetadata, processVideo } from './processor.js';
import { generateSeo } from './seo.js';
import { startScheduler, getNextScheduledRun, executeVideoPublish } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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
        sound_tweak_pitch_tempo = COALESCE(?, sound_tweak_pitch_tempo)
      WHERE id = ?
    `).run(
      p.name, p.description, p.niche, p.content_language, p.default_hashtags,
      p.publish_youtube, p.publish_facebook,
      p.youtube_client_id, p.youtube_client_secret, p.youtube_refresh_token, p.youtube_privacy,
      p.facebook_access_token, p.facebook_page_id,
      p.watermark_enabled, p.watermark_position, p.watermark_scale, p.watermark_opacity,
      p.sound_normalize_enabled, p.sound_tweak_pitch_tempo,
      req.params.id
    );

    addLog('info', `Updated settings for project "${p.name || existing.name}"`, '', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Channel Logo (Watermark) for Project
app.post('/api/projects/:id/logo', uploadLogo.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No logo uploaded' });

    db.prepare(`UPDATE projects SET logo_path = ?, watermark_enabled = 1 WHERE id = ?`).run(req.file.path, req.params.id);
    addLog('success', `Uploaded channel logo / watermark for project #${req.params.id}`, req.file.originalname, req.params.id);

    res.json({
      success: true,
      logoPath: req.file.path,
      logoUrl: `/media/watermark/${req.file.filename}`
    });
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
    const projectId = parseInt(req.query.projectId);
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) return res.status(404).send('Project not found');

    const clientId = project.youtube_client_id?.trim();
    const clientSecret = project.youtube_client_secret?.trim();

    if (!clientId || !clientSecret) {
      return res.status(400).send('YouTube Client ID এবং Client Secret আগে সেভ করুন!');
    }

    const { google } = await import('googleapis');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Guarantees a permanent Refresh Token
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly'
      ],
      state: String(projectId)
    });

    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`OAuth Error: ${err.message}`);
  }
});

// Google OAuth Callback Handler
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state: projectId } = req.query;
    if (!code) return res.status(400).send('Authorization code not provided');

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) return res.status(404).send('Project not found');

    const { google } = await import('googleapis');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

    const oauth2Client = new google.auth.OAuth2(
      project.youtube_client_id.trim(),
      project.youtube_client_secret.trim(),
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    if (tokens.refresh_token) {
      db.prepare(`UPDATE projects SET youtube_refresh_token = ? WHERE id = ?`).run(tokens.refresh_token, projectId);
      addLog('success', `YouTube 1-Click OAuth completed for project "${project.name}"! Refresh token saved.`, '', projectId);
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
          setTimeout(() => {
            if (window.opener) {
              window.opener.location.reload();
              window.close();
            } else {
              window.location.href = '/';
            }
          }, 2500);
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
