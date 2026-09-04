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

  if (isSimulation || !pageToken || !pageId) {
    const simulatedId = `sim_fb_${Date.now()}`;
    const simulatedUrl = `https://facebook.com/reel/${simulatedId}`;
    addLog('info', `[SIMULATION MODE] Facebook Reels publish simulated`, {
      title: seoData.title,
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
    addLog('info', `Uploading video to Facebook Reels for Page: ${pageId}`);

    const fileSize = fs.statSync(videoPath).size;
    const caption = `${seoData.title}\n\n${seoData.description || ''}`.trim();

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
    const videoStream = fs.createReadStream(videoPath);
    await axios.post(uploadUrl, videoStream, {
      headers: {
        'Authorization': `OAuth ${pageToken}`,
        'offset': '0',
        'file_size': String(fileSize),
        'Content-Type': 'application/octet-stream'
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
