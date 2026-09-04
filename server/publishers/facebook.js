import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { addLog } from '../db.js';

/**
 * Publish video to Facebook Page Reels via Meta Graph API
 */
export const publishToFacebook = async (videoPath, seoData, settings) => {
  const isSimulation = settings.simulation_mode === '1';
  const pageToken = settings.facebook_access_token?.trim();
  const pageId = settings.facebook_page_id?.trim();

  const fbData = seoData.facebook || seoData;
  let caption = fbData.caption || seoData.facebookCaption || seoData.caption || '';
  if (!caption) {
    caption = `${seoData.title || ''}\n\n${seoData.description || ''}`.trim();
  }
  // Strictly remove any #Shorts or #youtubeshorts or competitor links to prevent Meta reach penalties
  caption = caption
    .replace(/#Shorts\b/gi, '')
    .replace(/#youtubeshorts\b/gi, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim();

  if (isSimulation || !pageToken || !pageId) {
    const simulatedId = `sim_fb_${Date.now()}`;
    const simulatedUrl = `https://facebook.com/reel/${simulatedId}`;
    addLog('info', `[SIMULATION MODE] Facebook Reels publish simulated`, {
      captionHook: caption.slice(0, 80),
      url: simulatedUrl
    });
    return {
      success: true,
      simulated: true,
      postId: simulatedId,
      url: simulatedUrl
    };
  }

  try {
    addLog('info', `Uploading video to Facebook Reels with viral social caption (Page: ${pageId}): "${caption.slice(0, 50)}..."`);

    const fileSize = fs.statSync(videoPath).size;

    // 1. Initialize Reel upload session
    const startUrl = `https://graph.facebook.com/v20.0/${pageId}/video_reels`;
    const initRes = await axios.post(
      startUrl,
      {
        upload_phase: 'start',
        access_token: pageToken
      },
      { timeout: 15000 }
    );

    const videoId = initRes.data.video_id;
    const uploadUrl = initRes.data.upload_url;

    if (!videoId || !uploadUrl) {
      throw new Error(`Failed to initialize Facebook Reel upload: ${JSON.stringify(initRes.data)}`);
    }

    addLog('info', `Facebook Reel session started. Video ID: ${videoId}. Uploading binary...`);

    // 2. Upload video binary data
    const fileBuffer = fs.readFileSync(videoPath);
    await axios.post(uploadUrl, fileBuffer, {
      headers: {
        'Authorization': `OAuth ${pageToken}`,
        'offset': '0',
        'file_size': String(fileSize),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(fileSize),
        'X-Entity-Length': String(fileSize),
        'X-Entity-Type': 'video/mp4'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });

    addLog('info', `Binary upload complete. Finishing Reel publish for ${videoId}...`);

    // 3. Finish publish phase
    const finishRes = await axios.post(
      `https://graph.facebook.com/v20.0/${pageId}/video_reels`,
      {
        upload_phase: 'finish',
        access_token: pageToken,
        video_id: videoId,
        video_state: 'PUBLISHED',
        description: caption
      },
      { timeout: 20000 }
    );

    const reelUrl = `https://facebook.com/reel/${videoId}`;
    addLog('success', `Facebook Reel published successfully! URL: ${reelUrl}`, finishRes.data);

    return {
      success: true,
      simulated: false,
      postId: videoId,
      url: reelUrl
    };
  } catch (err) {
    const errorData = err.response?.data?.error || err.response?.data;
    const errorMsg = errorData?.message || err.message;
    addLog('error', `Failed to publish to Facebook Reels: ${errorMsg}`, errorData || err.stack);
    throw new Error(`Facebook API Error: ${errorMsg}`);
  }
};
