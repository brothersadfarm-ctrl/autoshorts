import fs from 'fs';
import { google } from 'googleapis';
import { addLog } from '../db.js';

/**
 * Publish video to YouTube Shorts via YouTube Data API v3
 */
export const publishToYouTube = async (videoPath, seoData, settings) => {
  const isSimulation = settings.simulation_mode === '1';
  const clientId = settings.youtube_client_id?.trim();
  const clientSecret = settings.youtube_client_secret?.trim();
  const refreshToken = settings.youtube_refresh_token?.trim();
  const privacy = settings.youtube_privacy || 'public';

  const ytData = seoData.youtube || seoData;
  const rawTitle = ytData.title || seoData.title || 'Viral Short Video';
  const rawDescription = ytData.description || seoData.description || '';
  const rawTags = ytData.tags || seoData.tags || '';

  if (isSimulation || !clientId || !clientSecret || !refreshToken) {
    const simulatedId = `sim_yt_${Date.now()}`;
    const simulatedUrl = `https://youtube.com/shorts/${simulatedId}`;
    addLog('info', `[SIMULATION MODE] YouTube Shorts publish simulated`, {
      title: rawTitle,
      url: simulatedUrl
    });
    return {
      success: true,
      simulated: true,
      videoId: simulatedId,
      url: simulatedUrl
    };
  }

  try {
    // Make sure title has #Shorts
    let title = rawTitle;
    if (!title.toLowerCase().includes('#shorts')) {
      title = `${title.slice(0, 90)} #Shorts`;
    }

    addLog('info', `Uploading video to YouTube Shorts with optimized SEO: "${title}"`);

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'https://developers.google.com/oauthplayground');
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    // Format tags into an array
    const tagArray = (Array.isArray(rawTags) ? rawTags.join(', ') : rawTags)
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .slice(0, 15);

    const fileSize = fs.statSync(videoPath).size;

    const res = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: title.slice(0, 100),
            description: rawDescription.toLowerCase().includes('#shorts') ? rawDescription : `${rawDescription}\n\n#Shorts`,
            tags: tagArray,
            categoryId: '24', // Entertainment
            defaultLanguage: 'bn'
          },
          status: {
            privacyStatus: privacy,
            selfDeclaredMadeForKids: false
          }
        },
        media: {
          body: fs.createReadStream(videoPath)
        }
      },
      {
        // Max upload chunk size support
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    const videoId = res.data.id;
    const url = `https://youtube.com/shorts/${videoId}`;

    addLog('success', `YouTube Shorts published successfully! URL: ${url}`, { videoId });

    return {
      success: true,
      simulated: false,
      videoId,
      url
    };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    addLog('error', `Failed to publish to YouTube Shorts: ${errorMsg}`, err.response?.data || err.stack);
    throw new Error(`YouTube API Error: ${errorMsg}`);
  }
};
