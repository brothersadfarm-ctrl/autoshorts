import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import axios from 'axios';
import { addLog } from './db.js';

/**
 * Helper to guarantee no Bengali script appears in titles/descriptions/captions
 */
export const stripBangla = (text) => {
  if (!text) return '';
  return text.replace(/[\u0980-\u09FF]+/g, '').replace(/\s{2,}/g, ' ').trim();
};

/**
 * Generate SEO metadata (Title, Description, Tags, Hashtags)
 * using Google Gemini API with smart fallback and visual frame analysis
 */
export const generateSeo = async (videoInfo, settings) => {
  const { originalName, customNotes, videoPath } = videoInfo;
  const apiKey = settings.gemini_api_key?.trim();
  const niche = settings.channel_niche || 'Viral Entertainment & Facts';
  const language = '100% English (Global / USA Audience - No Bengali)';
  const defaultHashtags = (settings.default_hashtags || '#Shorts #Reels #Viral #Trending')
    .replace(/#Bangla\b/gi, '')
    .trim();
  const customPrompt = settings.seo_prompt_custom || '';

  // Clean filename for context
  const cleanName = (originalName || 'viral_short')
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/[_-]+/g, ' ')   // replace dashes/underscores with space
    .trim();

  // 1. Extract visual frame from video for deep multi-modal content understanding
  let frameBase64 = null;
  if (videoPath && fs.existsSync(videoPath)) {
    try {
      const tempFramePath = path.join(os.tmpdir(), `seo_thumb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`);
      await new Promise((resolve) => {
        execFile('ffmpeg', ['-y', '-ss', '00:00:02', '-i', videoPath, '-vframes', '1', '-q:v', '2', tempFramePath], (err) => {
          if (err || !fs.existsSync(tempFramePath)) {
            execFile('ffmpeg', ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', tempFramePath], () => resolve());
          } else {
            resolve();
          }
        });
      });

      if (fs.existsSync(tempFramePath) && fs.statSync(tempFramePath).size > 0) {
        frameBase64 = fs.readFileSync(tempFramePath).toString('base64');
        try { fs.unlinkSync(tempFramePath); } catch (e) {}
        addLog('info', `Video frame extracted successfully for Gemini Vision analysis (${cleanName})`);
      }
    } catch (frameErr) {
      console.log('Frame extraction notice:', frameErr.message);
    }
  }

  // If Gemini API Key is available, call Gemini API
  if (apiKey) {
    try {
      addLog('info', `Calling Gemini AI for SEO optimization on: "${cleanName}" ${frameBase64 ? '(with visual frame analysis)' : ''}`);

      const prompt = `
You are an elite YouTube Shorts & Facebook Reels growth hacker, viral algorithm expert, and content strategist.

${frameBase64 ? `
VISUAL ANALYSIS TASK:
Look closely at the attached video frame:
1. Identify the exact character / animal / subject, clothing, tools/props, facial expression, and what they are doing.
2. Identify the setting, environment, background, and mood.
3. Formulate the title, hook, and caption to match PRECISELY what is visually happening in the video!
` : `
CONTENT CONTEXT:
- Video Topic: "${cleanName}"
${customNotes ? `- Creator Notes: "${customNotes}"` : ''}
`}
- Channel Niche: ${niche}
${customPrompt ? `- Additional Guidance: "${customPrompt}"` : ''}

STRICT LANGUAGE REQUIREMENT:
- 100% ENGLISH ONLY.
- DO NOT use ANY Bengali (বাংলা) characters, words, letters, or translations anywhere in titles, descriptions, captions, tags, or hashtags!
- Write in ultra-viral, natural, native American/Global English designed for maximum reach, shares, and comments.

GENERATE TWO SEPARATE PLATFORM PROFILES IN 100% ENGLISH:

=== PLATFORM 1: YOUTUBE SHORTS (100% ENGLISH) ===
- Algorithm goal: Extremely high Click-Through Rate (CTR) + Search SEO ranking.
- Title: Under 85 characters. Irresistible curiosity loop or emotional hook directly describing the visual action (e.g. "Hardest Working Cat in the World! 😼🏍️ #Shorts"). 1-2 emojis. MUST end with #Shorts.
- Description:
  1. Compelling 2-3 line story hook summarizing what happens in the video in fluent English.
  2. Call to Action (CTA) to Subscribe & turn on notifications.
  3. "Search Keywords:" section containing 6-8 high-volume, highly relevant English search queries.
  4. 3-5 YouTube hashtags (including #Shorts, #YouTubeShorts).
- Tags: 12-15 specific keyword phrases for backend search ranking (English only).

=== PLATFORM 2: FACEBOOK REELS (100% ENGLISH) ===
- Algorithm goal: Immediate scroll-stop within 1.5 seconds + Maximum comments and shares (Meta algorithm heavily favors posts with active comment sections).
- STRICT POLICY: NEVER include "#Shorts", "#youtubeshorts", or YouTube links! Meta algorithm penalizes competitor branding.
- Caption (Facebook Reels only has a Caption, not a separate title):
  1. Hook Line (Above the fold): Catchy, emotional question or hilarious observation directly related to the visual action in the video.
  2. Relatable Body: 1-2 short sentences making the viewer laugh, smile, or feel amazed.
  3. Viral Engagement Trigger: Ask viewers a compelling question or tell them to comment/tag a friend (e.g. "What do you think he is delivering? Let me know below! 👇🐾 Share this with a cat lover!").
  4. Facebook Hashtags: 4-6 targeted Facebook hashtags (e.g. #reels #reelsfb #facebookreels #viralreels #catlovers #reelsvideo).

Respond ONLY with a valid JSON object matching this exact schema:
{
  "visual_breakdown": "1-2 sentence description of the character, action, and setting",
  "youtube": {
    "title": "Viral YouTube Shorts Title in English (<85 chars, with emojis and #Shorts)",
    "description": "Algorithmic YouTube description in English with scene story, CTA, keywords, and hashtags",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "hashtags": "#Shorts #YouTubeShorts #viral #trending"
  },
  "facebook": {
    "caption": "Viral Facebook Reels caption in English with hook, relatable body, engagement question/share CTA, and FB hashtags (NO #Shorts)",
    "hashtags": "#reels #reelsfb #facebookreels #viralreels"
  }
}
`;

      const modelsToTry = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];
      let candidateText = '';

      for (const model of modelsToTry) {
        try {
          const parts = [{ text: prompt }];
          if (frameBase64) {
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: frameBase64 } });
          }

          const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              contents: [{ parts }],
              generationConfig: {
                temperature: 0.7,
                responseMimeType: "application/json",
                maxOutputTokens: 2500
              }
            },
            { timeout: 25000 }
          );
          candidateText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (candidateText) {
            addLog('info', `Gemini AI SEO generated using model: ${model} ${frameBase64 ? '(Visual Frame Analyzed)' : ''}`);
            break;
          }
        } catch (mErr) {
          console.log(`Model ${model} failed, trying next fallback:`, mErr.response?.data || mErr.message);
        }
      }

      // Parse JSON from text
      if (candidateText) {
        let jsonStr = candidateText.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
        try {
          const parsed = JSON.parse(jsonStr);
          const ytTitle = parsed.youtube?.title || parsed.title;
          const fbCaption = parsed.facebook?.caption || parsed.caption;

          if (ytTitle || fbCaption) {
            const finalYtTitle = stripBangla(ytTitle || cleanName);
            const finalYtDesc = stripBangla(parsed.youtube?.description || parsed.description || '');
            const rawTags = Array.isArray(parsed.youtube?.tags) ? parsed.youtube.tags.join(', ') : (parsed.youtube?.tags || parsed.tags || 'shorts, reels, viral');
            const finalYtTags = stripBangla(rawTags);
            const finalYtHashtags = stripBangla(parsed.youtube?.hashtags || parsed.hashtags || defaultHashtags);
            
            // Clean facebook caption to strictly remove any accidental #Shorts and strip any Bengali characters
            let rawFbCaption = fbCaption || `${finalYtTitle.replace(/#Shorts/gi, '').trim()}\n\n${finalYtDesc.replace(/#Shorts/gi, '').trim()}`;
            rawFbCaption = rawFbCaption.replace(/#Shorts/gi, '').replace(/#youtubeshorts/gi, '').trim();
            const finalFbCaption = stripBangla(rawFbCaption);
            const finalFbHashtags = stripBangla(parsed.facebook?.hashtags || '#reels #reelsfb #viralreels #facebookreels');

            addLog('success', `Gemini AI generated dual-platform viral SEO (100% English): [YT] "${finalYtTitle}" | [FB] Hook: "${finalFbCaption.slice(0, 45)}..."`);
            return {
              title: finalYtTitle,
              description: finalYtDesc,
              tags: finalYtTags,
              hashtags: finalYtHashtags,
              facebookCaption: finalFbCaption,
              analysis: stripBangla(parsed.analysis) || 'Optimized for high YouTube CTR and Facebook viral social sharing (English only).',
              youtube: {
                title: finalYtTitle,
                description: finalYtDesc,
                tags: finalYtTags,
                hashtags: finalYtHashtags
              },
              facebook: {
                caption: finalFbCaption,
                hashtags: finalFbHashtags
              },
              aiGenerated: true
            };
          }
        } catch (jsonErr) {
          console.log('JSON parse error from Gemini text:', jsonErr.message);
        }
      }
    } catch (err) {
      addLog('warn', `Gemini AI call failed (${err.message}). Using intelligent fallback SEO.`);
    }
  } else {
    addLog('info', `Gemini API key not configured. Using intelligent template SEO engine.`);
  }

  // Fallback intelligent SEO generator
  return generateFallbackSeo(cleanName, niche, defaultHashtags);
};

/**
 * Intelligent Fallback SEO when Gemini is offline or not configured
 */
export const generateFallbackSeo = (cleanName, niche, defaultHashtags) => {
  // Capitalize words
  const titleWords = cleanName
    .split(' ')
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  const ytTitleTemplates = [
    `🔥 ${titleWords} | You Won't Believe This! #Shorts`,
    `😱 ${titleWords} | Cutest Moment Ever! #Shorts`,
    `✨ ${titleWords} | Best Viral Moments #Shorts`,
    `🚀 ${titleWords} (Wait For The End!) #Shorts`
  ];

  const randomYtTitle = ytTitleTemplates[Math.floor(Math.random() * ytTitleTemplates.length)];

  const ytDescription = `
${titleWords} - Watch till the end! 

Don't forget to Like, Share and Subscribe to our channel for more daily viral ${niche} videos! 🚀
🔔 Turn on notifications so you never miss an update.

Search Keywords:
- ${cleanName.toLowerCase()}
- viral ${niche.toLowerCase()}
- cute ${cleanName.toLowerCase()}
- trending viral shorts

${defaultHashtags} #Shorts #YouTubeShorts #Trending
`.trim();

  const tags = [
    'shorts',
    'youtube shorts',
    'reels',
    'facebook reels',
    'viral',
    'trending',
    cleanName.toLowerCase(),
    niche.toLowerCase(),
    'viral short video',
    'fyp'
  ].join(', ');

  const fbCaption = `✨ ${titleWords.replace(/#Shorts/gi, '').trim()}!

Wait for the cutest moment! 😻 If this made you smile, share it with your friends and drop a comment below! 👇

#reels #reelsfb #facebookreels #viralreels #trendingreels`;

  return {
    title: randomYtTitle,
    description: ytDescription,
    tags: tags,
    hashtags: defaultHashtags,
    facebookCaption: fbCaption,
    analysis: 'Intelligent fallback template customized for YouTube Shorts and Facebook Reels algorithms.',
    youtube: {
      title: randomYtTitle,
      description: ytDescription,
      tags: tags,
      hashtags: `${defaultHashtags} #Shorts`
    },
    facebook: {
      caption: fbCaption,
      hashtags: '#reels #reelsfb #facebookreels #viralreels'
    },
    aiGenerated: false
  };
};
