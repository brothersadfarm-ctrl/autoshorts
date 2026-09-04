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
 * Downloads a public Google Drive video file by ID
 */
export async function downloadDriveVideo(fileId, targetPath) {
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };

  const initialRes = await axios.get(directUrl, {
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
      const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${confirmToken}&id=${fileId}`;
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
      // Permission issue or not public
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
