import axios from 'axios';
import { addLog } from './db.js';

/**
 * Generate SEO metadata (Title, Description, Tags, Hashtags)
 * using Google Gemini API with smart fallback
 */
export const generateSeo = async (videoInfo, settings) => {
  const { originalName, customNotes } = videoInfo;
  const apiKey = settings.gemini_api_key?.trim();
  const niche = settings.channel_niche || 'Viral Entertainment & Facts';
  const language = settings.content_language || 'Bangla & English';
  const defaultHashtags = settings.default_hashtags || '#Shorts #Reels #Viral #Trending';
  const customPrompt = settings.seo_prompt_custom || '';

  // Clean filename for context
  const cleanName = (originalName || 'viral_short')
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/[_-]+/g, ' ')   // replace dashes/underscores with space
    .trim();

  // If Gemini API Key is available, call Gemini API
  if (apiKey) {
    try {
      addLog('info', `Calling Gemini AI for SEO optimization on: "${cleanName}"`);

      const prompt = `
You are an elite Social Media Strategist and viral growth hacker specializing in YouTube Shorts and Facebook Reels algorithms.

TASK:
Perform a deep content and audience analysis of the following short video, then generate TWO distinctly different, platform-optimized SEO profiles:
1. One specifically engineered for YouTube Shorts algorithm & search SEO.
2. One specifically engineered for Facebook Reels algorithm & social engagement / sharing.

VIDEO CONTEXT & DETAILS:
- Video Topic / Raw Name: "${cleanName}"
${customNotes ? `- Creator Notes: "${customNotes}"` : ''}
- Channel Niche: ${niche}
- Target Audience & Language: ${language} (Bangladesh & International/USA viewers)
${customPrompt ? `- Additional Creator Guidance: "${customPrompt}"` : ''}

ALGORITHM RULES & POLICIES:
=== PLATFORM 1: YOUTUBE SHORTS ===
- Algorithm goal: High Click-Through Rate (CTR) on Shorts shelf + Long-tail YouTube Search ranking.
- Title: Under 85 characters, irresistible curiosity loop or emotion, 1-2 emojis, MUST end with #Shorts.
- Description: Structured YouTube SEO description:
  1. Compelling 2-3 line hook summarizing the video in Bangla & English.
  2. Call to Action (CTA) to Subscribe & turn on notifications.
  3. "Search Keywords / সম্পর্কিত অনুসন্ধান:" section containing 6-8 relevant search queries in English & Bangla.
  4. 3-5 YouTube hashtags (including #Shorts, #YouTubeShorts).
- Tags: 12-15 specific keyword phrases for backend search ranking (English & Bangla).

=== PLATFORM 2: FACEBOOK REELS ===
- Algorithm goal: Immediate scroll-stop within 1.5 seconds + Maximum Shares & Comments (Meta rewards comment threads & user shares heavily).
- Strict Policy: NEVER include "#Shorts", "#youtubeshorts", or YouTube links! Meta algorithm penalizes competitor branding.
- Caption (Facebook Reels only has a Caption, not a separate title):
  1. Hook Line (Above the fold): Catchy, emotional question or relatable statement in Bangla & English with emojis.
  2. Relatable Body: 1-2 short sentences making the viewer smile, laugh, or feel emotional.
  3. Viral Engagement Trigger: Ask viewers an engaging question or tell them to tag a friend / share (e.g. "আপনারও কি এমন কিউট বিড়াল আছে? কমেন্টে জানান! 🐾 Share with a cat lover! 👇").
  4. Facebook Hashtags: 4-6 targeted Facebook hashtags (e.g. #reels #reelsfb #facebookreels #viralreels #catlovers #reelsvideo).

Respond ONLY with a valid JSON object matching this exact schema:
{
  "analysis": "1-2 sentence deep analysis of the visual/emotional hook and audience trigger",
  "youtube": {
    "title": "Viral YouTube Shorts Title (max 85 chars, with emojis and #Shorts)",
    "description": "Algorithmic YouTube description with keywords and subscribe CTA",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "hashtags": "#Shorts #YouTubeShorts #viral #trending"
  },
  "facebook": {
    "caption": "Viral Facebook Reels caption with hook, engagement question/share CTA, and FB hashtags (NO #Shorts)",
    "hashtags": "#reels #reelsfb #facebookreels #viralreels"
  }
}
`;

      // Try gemini-3.5-flash, gemini-2.5-flash, or gemini-flash-latest
      const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
      let candidateText = '';

      for (const model of modelsToTry) {
        try {
          const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.7,
                responseMimeType: "application/json",
                maxOutputTokens: 2500
              }
            },
            { timeout: 20000 }
          );
          candidateText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (candidateText) {
            addLog('info', `Gemini AI SEO generated using model: ${model}`);
            break;
          }
        } catch (mErr) {
          console.log(`Model ${model} failed, trying next fallback:`, mErr.message);
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
            const finalYtTitle = ytTitle || cleanName;
            const finalYtDesc = parsed.youtube?.description || parsed.description || '';
            const finalYtTags = Array.isArray(parsed.youtube?.tags) ? parsed.youtube.tags.join(', ') : (parsed.youtube?.tags || parsed.tags || 'shorts, reels, viral');
            const finalYtHashtags = parsed.youtube?.hashtags || parsed.hashtags || defaultHashtags;
            
            // Clean facebook caption to strictly remove any accidental #Shorts
            let finalFbCaption = fbCaption || `${finalYtTitle.replace(/#Shorts/gi, '').trim()}\n\n${finalYtDesc.replace(/#Shorts/gi, '').trim()}`;
            finalFbCaption = finalFbCaption.replace(/#Shorts/gi, '').replace(/#youtubeshorts/gi, '').trim();

            addLog('success', `Gemini AI generated dual-platform viral SEO: [YT] "${finalYtTitle}" | [FB] Hook: "${finalFbCaption.slice(0, 45)}..."`);
            return {
              title: finalYtTitle,
              description: finalYtDesc,
              tags: finalYtTags,
              hashtags: finalYtHashtags,
              facebookCaption: finalFbCaption,
              analysis: parsed.analysis || 'Optimized for high YouTube CTR and Facebook viral social sharing.',
              youtube: {
                title: finalYtTitle,
                description: finalYtDesc,
                tags: finalYtTags,
                hashtags: finalYtHashtags
              },
              facebook: {
                caption: finalFbCaption,
                hashtags: parsed.facebook?.hashtags || '#reels #reelsfb #viralreels'
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
    `😱 ${titleWords} | Shocking Truth! #Shorts`,
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

Wait for the cutest moment! 😻 এই মিষ্টি ভিডিওটি ভালো লাগলে বন্ধুদের সাথে শেয়ার করুন এবং কমেন্টে জানান কেমন লাগলো! 👇

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
