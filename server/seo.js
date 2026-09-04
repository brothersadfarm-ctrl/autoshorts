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
You are a world-class YouTube Shorts and Facebook Reels viral SEO expert.
Task: Create the most engaging, high-CTR, algorithm-optimized title, description, and hashtags for a short video.

Context & Video Details:
- Raw Video Topic / File Title: "${cleanName}"
${customNotes ? `- Creator Notes: "${customNotes}"` : ''}
- Channel Niche: ${niche}
- Preferred Language: ${language}
- Additional Guidance: ${customPrompt}

Respond ONLY with a valid JSON object matching this exact schema (no markdown, no backticks, no code blocks):
{
  "title": "Viral Click-worthy Title (max 85 characters, with 1-2 emojis and #Shorts at the end)",
  "description": "Engaging 2-3 paragraph description explaining the video hook, asking viewers to subscribe/follow, and listing 5-8 related keywords for YouTube & Facebook search SEO.",
  "hashtags": "${defaultHashtags} #viralvideo #trending",
  "tags": ["shorts", "reels", "viral", "trending", "youtube shorts", "facebook reels"]
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
          if (parsed && parsed.title) {
            addLog('success', `Gemini AI generated viral SEO title: "${parsed.title}"`);
            return {
              title: parsed.title,
              description: `${parsed.description || ''}\n\n${parsed.hashtags || defaultHashtags}`.trim(),
              tags: Array.isArray(parsed.tags) ? parsed.tags.join(', ') : (parsed.tags || 'shorts, reels, viral'),
              hashtags: parsed.hashtags || defaultHashtags,
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

  const titleTemplates = [
    `🔥 ${titleWords} | You Won't Believe This! #Shorts`,
    `😱 ${titleWords} | Shocking Truth! #Shorts`,
    `✨ ${titleWords} | Best Viral Moments #Shorts`,
    `🚀 ${titleWords} (Wait For The End!) #Shorts`
  ];

  const randomTitle = titleTemplates[Math.floor(Math.random() * titleTemplates.length)];

  const description = `
${titleWords} - Watch till the end! 

Don't forget to Like, Share and Subscribe / Follow our page for more daily viral ${niche} shorts! 🚀
🔔 Turn on notifications so you never miss an update.

${defaultHashtags} #Shorts #Reels #Viral #Trending
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

  return {
    title: randomTitle,
    description: description,
    tags: tags,
    hashtags: defaultHashtags,
    aiGenerated: false
  };
};
