import { spawn, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { addLog } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get video metadata (duration, width, height, hasAudio) using ffprobe or ffmpeg
 */
export const getVideoMetadata = (filePath) => {
  return new Promise((resolve, reject) => {
    // We run ffprobe command to get json metadata
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=width,height,codec_type',
      '-of', 'json',
      filePath
    ], (err, stdout, stderr) => {
      if (err) {
        // Fallback: try parsing ffmpeg -i
        execFile('ffmpeg', ['-i', filePath], (fErr, fOut, fStderr) => {
          const combined = (fStderr || '') + (fOut || '');
          const durMatch = combined.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
          let duration = 0;
          if (durMatch) {
            duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
          }
          const resMatch = combined.match(/(\d{3,4})x(\d{3,4})/);
          const width = resMatch ? parseInt(resMatch[1]) : 1080;
          const height = resMatch ? parseInt(resMatch[2]) : 1920;
          const hasAudio = combined.includes('Audio:');
          resolve({ duration, width, height, hasAudio });
        });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format?.duration || 0);
        const videoStream = data.streams?.find(s => s.codec_type === 'video');
        const audioStream = data.streams?.find(s => s.codec_type === 'audio');
        const width = videoStream ? videoStream.width : 1080;
        const height = videoStream ? videoStream.height : 1920;
        const hasAudio = !!audioStream;

        resolve({ duration, width, height, hasAudio });
      } catch (parseErr) {
        resolve({ duration: 30, width: 1080, height: 1920, hasAudio: true });
      }
    });
  });
};

/**
 * Process a short video: apply watermark and sound modifications
 */
export const processVideo = async (inputPath, outputPath, options = {}) => {
  const {
    watermarkEnabled = true,
    watermarkPath = '',
    watermarkPosition = 'top-right',
    watermarkScale = 0.16, // 16% of video width
    watermarkOpacity = 0.85,
    soundNormalizeEnabled = true,
    soundTweakEnabled = true,
  } = options;

  addLog('info', `Starting video processing: ${path.basename(inputPath)}`, {
    watermarkEnabled,
    watermarkPosition,
    soundNormalizeEnabled,
    soundTweakEnabled
  });

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Get video metadata first
  const meta = await getVideoMetadata(inputPath);

  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath];
    const hasWatermark = watermarkEnabled && watermarkPath && fs.existsSync(watermarkPath);

    if (hasWatermark) {
      args.push('-i', watermarkPath);
    }

    // Filter complex setup
    const filterComplexParts = [];
    let currentVideoStream = '[0:v]';

    // 1. Ensure vertical orientation / standard dimensions if needed
    // Scale or pad to 1080x1920 if not vertical
    const isVertical = meta.height >= meta.width;
    if (!isVertical) {
      // Create vertical canvas with blurred background or centered pad
      filterComplexParts.push(
        `${currentVideoStream}scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[v_sized]`
      );
      currentVideoStream = '[v_sized]';
    }

    // 2. Watermark overlay filter
    if (hasWatermark) {
      // Calculate position
      let overlayPos = 'main_w-overlay_w-24:24'; // top-right default
      switch (watermarkPosition) {
        case 'top-left':
          overlayPos = '24:24';
          break;
        case 'top-right':
          overlayPos = 'main_w-overlay_w-24:24';
          break;
        case 'bottom-left':
          overlayPos = '24:main_h-overlay_h-36';
          break;
        case 'bottom-right':
          overlayPos = 'main_w-overlay_w-24:main_h-overlay_h-36';
          break;
        case 'center':
          overlayPos = '(main_w-overlay_w)/2:(main_h-overlay_h)/2';
          break;
      }

      // Watermark sizing & opacity
      // Watermark width relative to main video (e.g. 15%-20%)
      const scalePercent = Math.max(0.05, Math.min(0.5, parseFloat(watermarkScale) || 0.16));
      const opacity = Math.max(0.1, Math.min(1.0, parseFloat(watermarkOpacity) || 0.85));

      filterComplexParts.push(
        `[1:v]scale=iw*${scalePercent * 2}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`
      );
      filterComplexParts.push(
        `${currentVideoStream}[wm]overlay=${overlayPos}[v_out]`
      );
      currentVideoStream = '[v_out]';
    }

    // 3. Audio filters
    const audioFilters = [];
    if (meta.hasAudio) {
      if (soundTweakEnabled) {
        // Shift tempo subtly by 2% (1.02) to change acoustic fingerprint
        audioFilters.push('atempo=1.02');
      }
      if (soundNormalizeEnabled) {
        // EBU R128 standard audio loudness normalization for Shorts & Reels
        audioFilters.push('loudnorm=I=-15:TP=-1.5:LRA=11');
      }
    }

    // Assemble FFmpeg arguments
    if (filterComplexParts.length > 0) {
      args.push('-filter_complex', filterComplexParts.join(';'));
      args.push('-map', currentVideoStream);
    } else {
      args.push('-map', '0:v');
    }

    if (meta.hasAudio) {
      if (audioFilters.length > 0) {
        args.push('-af', audioFilters.join(','));
      }
      args.push('-map', '0:a');
      args.push('-c:a', 'aac', '-b:a', '192k');
    }

    // Video codec & output flags
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    );

    const ffmpegProc = spawn('ffmpeg', args);
    let stderrOutput = '';

    ffmpegProc.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        addLog('success', `Video processing complete: ${path.basename(outputPath)}`);
        resolve(outputPath);
      } else {
        const errMsg = `FFmpeg exited with code ${code}. Error: ${stderrOutput.slice(-300)}`;
        addLog('error', `FFmpeg error processing ${path.basename(inputPath)}`, errMsg);
        reject(new Error(errMsg));
      }
    });

    ffmpegProc.on('error', (err) => {
      addLog('error', `Failed to launch FFmpeg: ${err.message}`);
      reject(err);
    });
  });
};
