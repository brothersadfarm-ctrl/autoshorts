import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Parses Google Drive links to extract file or folder IDs
 */
export function parseDriveLink(link) {
  if (!link || typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed) return null;

  // Folder link
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return { type: 'folder', id: folderMatch[1], originalLink: trimmed };
  }

  // File link: /file/d/ID or ?id=ID
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
                    trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
                    trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return { type: 'file', id: fileMatch[1], originalLink: trimmed };
  }

  // Raw file ID
  if (/^[a-zA-Z0-9_-]{25,45}$/.test(trimmed)) {
    return { type: 'file', id: trimmed, originalLink: trimmed };
  }

  return null;
}

/**
 * Extracts video files (IDs and names) from a public Google Drive folder page
 */
export async function extractFilesFromFolder(folderId) {
  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }
  });

  const html = res.data;
  const items = [];
  const seen = new Set();

  // Pattern 1: JSON-like unescaped or escaped with \x22
  // Format: "FILE_ID\x22,\x5b\x22FOLDER_ID\x22\x5d,\x22FILE_NAME.mp4\x22,\x22video\/mp4\x22"
  const unescaped = html.replace(/\\x22/g, '"').replace(/\\x5b/g, '[').replace(/\\x5d/g, ']');
  const reg = /"([a-zA-Z0-9_-]{25,45})",\["[a-zA-Z0-9_-]+"\],"([^"]+\.(?:mp4|mov|mkv|webm|avi|m4v))"/gi;
  let match;
  while ((match = reg.exec(unescaped)) !== null) {
    const id = match[1].replace(/-[0-9]+-[0-9]+$/, '').replace(/-0-\d+$/, '');
    const name = match[2];
    if (!seen.has(id)) {
      seen.add(id);
      items.push({ id, name });
    }
  }

  // Fallback: match ssk entries if regex above matched nothing
  if (items.length === 0) {
    const sskMatches = [...html.matchAll(/ssk='5:auSv138:([a-zA-Z0-9_-]{25,45})/g)].map(m => m[1]);
    for (const rawId of sskMatches) {
      const cleanId = rawId.replace(/-[0-9]+-[0-9]+$/, '').replace(/-0-\d+$/, '');
      if (!seen.has(cleanId)) {
        seen.add(cleanId);
        items.push({ id: cleanId, name: `GDrive_${cleanId.slice(0, 8)}.mp4` });
      }
    }
  }

  return items;
}

/**
 * Downloads a public Google Drive video file by ID
 */
export async function downloadDriveVideo(fileId, targetPath) {
  // Strip any unexpected suffixes
  const cleanId = String(fileId).replace(/-[0-9]+-[0-9]+$/, '').replace(/-0-\d+$/, '').trim();

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };

  // Try direct usercontent download first
  try {
    const directUrl = `https://drive.usercontent.google.com/download?id=${cleanId}&export=download&confirm=t`;
    const res = await axios.get(directUrl, {
      responseType: 'stream',
      headers,
      validateStatus: (status) => status >= 200 && status < 300
    });

    const contentType = res.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      await pipeStreamToFile(res.data, targetPath);
      return true;
    }
  } catch (err) {
    // Fall back to uc?export=download flow
  }

  // Fallback: standard uc?export=download flow
  const ucUrl = `https://drive.google.com/uc?export=download&id=${cleanId}`;
  const initialRes = await axios.get(ucUrl, {
    responseType: 'stream',
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    headers
  });

  const contentType = initialRes.headers['content-type'] || '';

  // If Google returned HTML (virus warning / confirm page for larger files)
  if (contentType.includes('text/html')) {
    const chunks = [];
    for await (const chunk of initialRes.data) {
      chunks.push(chunk);
    }
    const html = Buffer.concat(chunks).toString('utf-8');

    // Look for confirm token
    const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/) ||
                         html.match(/name="confirm"\s+value="([^"]+)"/);

    if (confirmMatch) {
      const confirmToken = confirmMatch[1];
      const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${confirmToken}&id=${cleanId}`;
      const cookies = initialRes.headers['set-cookie'] ? initialRes.headers['set-cookie'].join('; ') : '';

      const streamRes = await axios.get(confirmUrl, {
        responseType: 'stream',
        maxRedirects: 5,
        headers: {
          ...headers,
          'Cookie': cookies
        }
      });

      await pipeStreamToFile(streamRes.data, targetPath);
      return true;
    } else {
      throw new Error('Google Drive ফাইলটি পাবলিক নয়। ফাইলে Share -> "Anyone with the link can view" নিশ্চিত করুন।');
    }
  } else {
    await pipeStreamToFile(initialRes.data, targetPath);
    return true;
  }
}

function pipeStreamToFile(stream, dest) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    stream.pipe(writer);
    writer.on('finish', () => {
      writer.close();
      resolve();
    });
    writer.on('error', (err) => {
      writer.close();
      reject(err);
    });
  });
}
