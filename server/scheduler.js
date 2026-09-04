import cron from 'node-cron';
import { DateTime } from 'luxon';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db, { getSettings, addLog, isAlreadyPublished, recordPublishedVideo } from './db.js';
import { processVideo, getVideoMetadata } from './processor.js';
import { generateSeo } from './seo.js';
import { publishToYouTube } from './publishers/youtube.js';
import { publishToFacebook } from './publishers/facebook.js';
import { parseDriveLink, extractFilesFromFolder, downloadDriveVideo } from './gdrive.js';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isCurrentlyProcessing = false;
let cronTask = null;

/**
 * Calculate the next scheduled publish slot and time remaining
 */
export const getNextScheduledRun = (projectId = null) => {
  const settings = getSettings();
  const timezone = settings.timezone || 'Asia/Dhaka';
  const now = DateTime.now().setZone(timezone);

  let query = `SELECT s.*, p.name as project_name FROM schedules s JOIN projects p ON s.project_id = p.id WHERE s.is_enabled = 1`;
  const params = [];
  if (projectId) {
    query += ` AND s.project_id = ?`;
    params.push(projectId);
  }
  query += ` ORDER BY s.time_slot ASC`;

  const activeSchedules = db.prepare(query).all(...params);

  if (activeSchedules.length === 0) {
    return {
      nextSlot: null,
      nextDateTime: null,
      minutesRemaining: null,
      countdownText: 'কোনো সক্রিয় স্লট নেই'
    };
  }

  const currentTimeStr = now.toFormat('HH:mm');

  let targetDateTime = null;
  let targetSlot = null;

  // Find first slot today that is strictly after now
  for (const s of activeSchedules) {
    if (s.time_slot > currentTimeStr) {
      const [h, m] = s.time_slot.split(':').map(Number);
      targetDateTime = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      targetSlot = s;
      break;
    }
  }

  // If no slot left today, take the earliest slot tomorrow
  if (!targetDateTime) {
    const firstSlot = activeSchedules[0];
    const [h, m] = firstSlot.time_slot.split(':').map(Number);
    targetDateTime = now.plus({ days: 1 }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    targetSlot = firstSlot;
  }

  const diffMinutes = Math.max(0, Math.round(targetDateTime.diff(now, 'minutes').minutes));
  const hours = Math.floor(diffMinutes / 60);
  const mins = diffMinutes % 60;
  const countdownText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return {
    nextSlot: targetSlot.time_slot,
    label: targetSlot.label,
    projectName: targetSlot.project_name,
    nextDateTime: targetDateTime.toISO(),
    minutesRemaining: diffMinutes,
    countdownText
  };
};

/**
 * Automatically fetches the next unposted video from the project's connected Google Drive folder
 */
export const fetchNextVideoFromDrive = async (project) => {
  if (!project || !project.gdrive_folder_url) return null;

  try {
    const parsed = parseDriveLink(project.gdrive_folder_url);
    if (!parsed || parsed.type !== 'folder') {
      addLog('warn', `কানেক্টেড Google Drive লিংকটি সঠিক ফোল্ডার লিঙ্ক নয়`, project.gdrive_folder_url, project.id);
      return null;
    }

    addLog('info', `কানেক্টেড Google Drive ফোল্ডার স্ক্যান করা হচ্ছে... (ID: ${parsed.id})`, '', project.id);
    const files = await extractFilesFromFolder(parsed.id);
    if (!files || files.length === 0) {
      addLog('warn', `কানেক্টেড Google Drive ফোল্ডারে কোনো ভিডিও পাওয়া যায়নি`, '', project.id);
      return null;
    }

    // Get list of all file IDs or original names already recorded or published for this project
    const existingVideos = db.prepare(`SELECT gdrive_file_id, original_name FROM videos WHERE project_id = ?`).all(project.id);
    const trackedPublished = db.prepare(`SELECT gdrive_file_id, original_name FROM published_tracker WHERE project_id = ?`).all(project.id);

    const existingIds = new Set([
      '1QjVX5Ol2_TH8dWnqdppX_y4u_MbEJhOt', // Permanently mark test video ai cat (1).mp4 as already published
      '1XJEdRqcAhnXD0qoN4AlocRzG9Q4vtgdT', // Permanently mark ai cat (153).mp4 as already published
      '19IMMFPnq9RznYxdliVRQXhbZC4mejkWn', // Permanently mark ai cat (154).mp4 as already published
      ...existingVideos.map(v => v.gdrive_file_id).filter(Boolean),
      ...trackedPublished.map(v => v.gdrive_file_id).filter(Boolean)
    ]);
    const existingNames = new Set([
      'ai cat (1).mp4',
      'ai cat (153).mp4',
      'ai cat (154).mp4',
      ...existingVideos.map(v => v.original_name).filter(Boolean),
      ...trackedPublished.map(v => v.original_name).filter(Boolean)
    ]);

    // Find first file not yet posted or queued
    const nextFile = files.find(f => !existingIds.has(f.id) && !existingNames.has(f.name));

    if (!nextFile) {
      addLog('warn', `Google Drive ফোল্ডারের সব ভিডিও (${files.length}টি) ইতিমধ্যে পোস্ট করা হয়ে গেছে! নতুন ভিডিও ফোল্ডারে যুক্ত করুন।`, '', project.id);
      return null;
    }

    addLog('info', `Google Drive থেকে পরবর্তী নতুন ভিডিও পাওয়া গেছে: "${nextFile.name}"। ডাউনলোড শুরু হচ্ছে...`, '', project.id);

    const queueDir = path.resolve(__dirname, '../uploads/queue');
    if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });

    const filename = `${Date.now()}_gdrive_${nextFile.id}.mp4`;
    const targetPath = path.join(queueDir, filename);

    await downloadDriveVideo(nextFile.id, targetPath);

    const meta = await getVideoMetadata(targetPath);
    const stats = fs.statSync(targetPath);
    const originalName = nextFile.name || `GDrive_${nextFile.id.slice(0, 8)}.mp4`;

    const maxOrderRow = db.prepare(`SELECT MAX(priority_order) as max_order FROM videos WHERE project_id = ? AND status = 'pending'`).get(project.id);
    const currentOrder = (maxOrderRow?.max_order || 0) + 1;

    const result = db.prepare(`
      INSERT INTO videos (project_id, filename, original_name, file_path, file_size, duration, status, priority_order, gdrive_file_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      project.id,
      filename,
      originalName,
      targetPath,
      stats.size,
      meta.duration,
      currentOrder,
      nextFile.id
    );

    addLog('success', `Google Drive থেকে "${originalName}" সফলভাবে স্টকে জমা হয়েছে এবং পাবলিশের জন্য প্রস্তুত!`, '', project.id);

    return db.prepare(`SELECT * FROM videos WHERE id = ?`).get(result.lastInsertRowid);
  } catch (err) {
    addLog('error', `Google Drive অটো-সিঙ্ক ব্যর্থ: ${err.message}`, '', project.id);
    return null;
  }
};

/**
 * Core Automation Pipeline for a Project Video
 */
export const executeVideoPublish = async ({ videoId = null, projectId = null, triggerSource = 'scheduler' } = {}) => {
  if (isCurrentlyProcessing) {
    addLog('warn', `Video publishing is already in progress. Skipping trigger.`, '', projectId);
    return { success: false, message: 'Already processing a video' };
  }

  isCurrentlyProcessing = true;

  try {
    const globalSettings = getSettings();

    // Select video: specific id or next pending in stock queue for project
    let video;
    if (videoId) {
      video = db.prepare(`SELECT * FROM videos WHERE id = ?`).get(videoId);
    } else if (projectId) {
      video = db
        .prepare(`SELECT * FROM videos WHERE project_id = ? AND status = 'pending' ORDER BY priority_order ASC, id ASC LIMIT 1`)
        .get(projectId);
    } else {
      video = db
        .prepare(`SELECT * FROM videos WHERE status = 'pending' ORDER BY priority_order ASC, id ASC LIMIT 1`)
        .get();
    }

    // If no video in local stock, check if project has connected Google Drive folder for auto-sync!
    if (!video && projectId) {
      const proj = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
      if (proj && proj.gdrive_folder_url && proj.gdrive_auto_sync === 1) {
        addLog('info', `স্টক খালি থাকায় অটো-সিঙ্ক ড্রাইভ ফোল্ডার থেকে নতুন ভিডিও আনা হচ্ছে...`, proj.gdrive_folder_url, projectId);
        video = await fetchNextVideoFromDrive(proj);
      }
    }

    if (!video) {
      addLog('warn', `Schedule slot triggered (${triggerSource}), but no pending video found in stock or Google Drive!`, '', projectId);
      return { success: false, message: 'No pending videos in stock queue or Google Drive' };
    }

    // Load project configuration
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(video.project_id);
    if (!project) {
      throw new Error(`Project #${video.project_id} not found`);
    }

    // STRICT DUPLICATE PREVENTION:
    // Check if this video was EVER published on this channel
    if (isAlreadyPublished({
      projectId: video.project_id,
      gdriveFileId: video.gdrive_file_id,
      originalName: video.original_name,
      fileSize: video.file_size
    })) {
      addLog('warn', `⚠️ ডুপ্লিকেট রোধ: "${video.original_name}" ইতিমধ্যে পূর্বে পাবলিশ করা হয়েছে! এটি বাদ দিয়ে পরবর্তী নতুন ভিডিও খোঁজা হচ্ছে...`, '', video.project_id);
      db.prepare(`UPDATE videos SET status = 'duplicate_skipped', error_message = 'Already published previously' WHERE id = ?`).run(video.id);
      try {
        if (video.file_path && fs.existsSync(video.file_path)) fs.unlinkSync(video.file_path);
      } catch (e) {}

      // Automatically advance to the next unposted video
      isCurrentlyProcessing = false;
      return executeVideoPublish({ projectId: video.project_id, triggerSource: `${triggerSource} (Duplicate Skipped)` });
    }

    addLog('info', `🚀 Starting auto-publish pipeline for project "${project.name}" on video #${video.id} ("${video.original_name}")`, { triggerSource }, project.id);

    // Mark status as processing
    db.prepare(`UPDATE videos SET status = 'processing', error_message = NULL WHERE id = ?`).run(video.id);

    // 1. Video & Audio Modification with FFmpeg using Project Logo
    const processedFilename = `processed_${Date.now()}_${video.filename}`;
    const processedPath = path.resolve(__dirname, '../uploads/processed', processedFilename);

    // Ensure watermark file exists on disk, or restore from database base64 / auto-fetch from channel avatar
    let watermarkPath = project.logo_path;
    if ((!watermarkPath || !fs.existsSync(watermarkPath)) && project.logo_data_url) {
      try {
        const matches = project.logo_data_url.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : 'png';
          const watermarkDir = path.resolve(__dirname, '../uploads/watermark');
          if (!fs.existsSync(watermarkDir)) fs.mkdirSync(watermarkDir, { recursive: true });
          const reFilePath = path.join(watermarkDir, `logo_proj_${project.id}_restored.${ext}`);
          fs.writeFileSync(reFilePath, Buffer.from(matches[2], 'base64'));
          watermarkPath = reFilePath;
          db.prepare(`UPDATE projects SET logo_path = ? WHERE id = ?`).run(reFilePath, project.id);
        }
      } catch(e) {}
    }

    // If no watermark uploaded yet, auto-fetch the channel's official logo from YouTube!
    if ((!watermarkPath || !fs.existsSync(watermarkPath)) && project.youtube_refresh_token && project.youtube_client_id) {
      try {
        const oauth2Client = new google.auth.OAuth2(project.youtube_client_id, project.youtube_client_secret, 'https://developers.google.com/oauthplayground');
        oauth2Client.setCredentials({ refresh_token: project.youtube_refresh_token });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const chRes = await youtube.channels.list({ part: ['snippet'], mine: true });
        const avatarUrl = chRes.data?.items?.[0]?.snippet?.thumbnails?.high?.url || chRes.data?.items?.[0]?.snippet?.thumbnails?.default?.url;
        if (avatarUrl) {
          const aRes = await fetch(avatarUrl);
          const buf = Buffer.from(await aRes.arrayBuffer());
          const watermarkDir = path.resolve(__dirname, '../uploads/watermark');
          if (!fs.existsSync(watermarkDir)) fs.mkdirSync(watermarkDir, { recursive: true });
          const autoLogoPath = path.join(watermarkDir, `logo_proj_${project.id}_autofetched.png`);
          fs.writeFileSync(autoLogoPath, buf);
          const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
          watermarkPath = autoLogoPath;
          db.prepare(`UPDATE projects SET logo_path = ?, logo_data_url = ? WHERE id = ?`).run(autoLogoPath, dataUrl, project.id);
          addLog('info', `চ্যানেলের অফিশিয়াল ইউটিউব লোগো স্বয়ংক্রিয়ভাবে ওয়াটারমার্ক হিসেবে সেট করা হয়েছে!`, '', project.id);
        }
      } catch (autoLogoErr) {
        console.log('Auto-fetch logo error:', autoLogoErr.message);
      }
    }

    await processVideo(video.file_path, processedPath, {
      watermarkEnabled: project.watermark_enabled === 1 && !!watermarkPath,
      watermarkPath,
      watermarkPosition: project.watermark_position || 'top-right',
      watermarkScale: project.watermark_scale || 0.16,
      watermarkOpacity: project.watermark_opacity || 0.85,
      soundNormalizeEnabled: project.sound_normalize_enabled === 1,
      soundTweakEnabled: project.sound_tweak_pitch_tempo === 1
    });

    // 2. AI SEO Generation with Visual Frame Analysis & 100% English Setting
    const seoSettings = {
      gemini_api_key: globalSettings.gemini_api_key,
      channel_niche: project.niche || 'Viral Facts & Entertainment',
      content_language: 'English',
      default_hashtags: (project.default_hashtags || '#Shorts #Reels #Viral #Trending #Cute').replace(/#Bangla\b/gi, '').trim(),
      seo_prompt_custom: ''
    };

    const seoData = await generateSeo(
      {
        originalName: video.original_name,
        customNotes: video.title || '',
        videoPath: processedPath || video.file_path
      },
      seoSettings
    );

    // 3. Multi-Platform Publishing (YouTube & Facebook)
    let ytResult = { success: false, url: null, videoId: null };
    let fbResult = { success: false, url: null, postId: null };

    const platformSettings = {
      simulation_mode: globalSettings.simulation_mode,
      youtube_client_id: project.youtube_client_id,
      youtube_client_secret: project.youtube_client_secret,
      youtube_refresh_token: project.youtube_refresh_token,
      youtube_privacy: project.youtube_privacy || 'public',
      facebook_access_token: project.facebook_access_token,
      facebook_page_id: project.facebook_page_id,
      gdrive_file_id: video.gdrive_file_id
    };

    // YouTube Shorts (with YouTube-optimized CTR title, search description, and tags)
    if (project.publish_youtube === 1) {
      try {
        ytResult = await publishToYouTube(processedPath, seoData.youtube || seoData, platformSettings);
      } catch (ytErr) {
        addLog('error', `YouTube upload failed: ${ytErr.message}`, '', project.id);
      }
    }

    // Facebook Reels (with viral scroll-stopping hook, engagement CTA, and FB hashtags)
    if (project.publish_facebook === 1) {
      try {
        fbResult = await publishToFacebook(processedPath, seoData.facebook || seoData, platformSettings);
      } catch (fbErr) {
        addLog('error', `Facebook upload failed: ${fbErr.message}`, '', project.id);
      }
    }

    // 4. Update Database Record
    const isSuccess = (project.publish_youtube === 1 ? ytResult.success : true) &&
                      (project.publish_facebook === 1 ? fbResult.success : true);

    const status = isSuccess ? 'published' : 'failed';
    const errorMsg = !isSuccess ? 'One or more platform uploads failed' : null;

    const savedTitle = seoData.youtube?.title || seoData.title;
    const savedDesc = seoData.youtube?.description || seoData.description;
    const savedTags = seoData.youtube?.tags || seoData.tags;

    db.prepare(`
      UPDATE videos
      SET status = ?,
          processed_path = ?,
          title = ?,
          description = ?,
          tags = ?,
          youtube_video_id = ?,
          youtube_url = ?,
          facebook_post_id = ?,
          facebook_url = ?,
          error_message = ?,
          published_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      status,
      processedPath,
      savedTitle,
      savedDesc,
      savedTags,
      ytResult.videoId || null,
      ytResult.url || null,
      fbResult.postId || null,
      fbResult.url || null,
      errorMsg,
      video.id
    );

    if (status === 'published') {
      recordPublishedVideo({
        projectId: project.id,
        gdriveFileId: video.gdrive_file_id,
        originalName: video.original_name,
        fileSize: video.file_size,
        youtubeVideoId: ytResult.videoId || null,
        facebookPostId: fbResult.postId || null
      });
    }

    addLog('success', `🎉 Video #${video.id} workflow completed for "${project.name}"! Status: ${status}`, {
      aiAnalysis: seoData.analysis || '',
      youtubeTitle: savedTitle,
      facebookCaptionHook: (seoData.facebook?.caption || seoData.description || '').slice(0, 85) + '...',
      youtubeUrl: ytResult.url,
      facebookUrl: fbResult.url
    }, project.id);

    return {
      success: true,
      status,
      video: {
        id: video.id,
        title: seoData.title,
        youtubeUrl: ytResult.url,
        facebookUrl: fbResult.url
      }
    };
  } catch (error) {
    addLog('error', `Error executing video publish pipeline: ${error.message}`, error.stack, projectId);
    if (videoId) {
      db.prepare(`UPDATE videos SET status = 'failed', error_message = ? WHERE id = ?`).run(error.message, videoId);
    }
    return { success: false, error: error.message };
  } finally {
    isCurrentlyProcessing = false;
  }
};

/**
 * Start the Background Cron Scheduler Daemon
 */
export const startScheduler = () => {
  if (cronTask) {
    cronTask.stop();
  }

  addLog('info', 'Starting background scheduler daemon (checking project slots every minute)');

  cronTask = cron.schedule('* * * * *', async () => {
    try {
      const settings = getSettings();
      const timezone = settings.timezone || 'Asia/Dhaka';
      const now = DateTime.now().setZone(timezone);

      const currentTimeStr = now.toFormat('HH:mm');
      const currentDateStr = now.toFormat('yyyy-MM-dd');

      // Check all matching slots across active projects
      const matchingSlots = db
        .prepare(`
          SELECT s.*, p.name as project_name 
          FROM schedules s
          JOIN projects p ON s.project_id = p.id
          WHERE s.is_enabled = 1 
            AND s.time_slot = ? 
            AND (s.last_run_date IS NULL OR s.last_run_date != ?)
        `)
        .all(currentTimeStr, currentDateStr);

      for (const slot of matchingSlots) {
        addLog('info', `⏰ Scheduled time matched for project "${slot.project_name}"! Slot: ${slot.time_slot} (${slot.label || 'Daily'}) at ${currentTimeStr}`, '', slot.project_id);

        // Prevent duplicate trigger today
        db.prepare(`UPDATE schedules SET last_run_date = ? WHERE id = ?`).run(currentDateStr, slot.id);

        // Execute publish for this project
        await executeVideoPublish({ projectId: slot.project_id, triggerSource: `Project "${slot.project_name}" Slot: ${slot.time_slot}` });
      }
    } catch (err) {
      console.error('Scheduler check error:', err);
    }
  });

  return cronTask;
};

export const stopScheduler = () => {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    addLog('info', 'Scheduler daemon stopped');
  }
};
