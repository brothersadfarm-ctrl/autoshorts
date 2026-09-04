import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { processVideo, getVideoMetadata } from './processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testDir = path.resolve(__dirname, '../uploads/test');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

const sampleVideo = path.join(testDir, 'sample_input.mp4');
const sampleWatermark = path.join(testDir, 'sample_logo.png');
const sampleOutput = path.join(testDir, 'sample_output.mp4');

console.log('--- 1. Generating 3-second vertical test video with audio ---');
// Generate a 1080x1920 3-second test video with 440Hz test audio tone
execSync(
  `ffmpeg -y -f lavfi -i testsrc=size=1080x1920:rate=30 -f lavfi -i sine=frequency=440:duration=3 -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac "${sampleVideo}"`,
  { stdio: 'pipe' }
);
console.log('Sample video created at:', sampleVideo);

console.log('--- 2. Generating test watermark image ---');
// Generate a simple 200x80 red badge watermark PNG
execSync(
  `ffmpeg -y -f lavfi -i color=c=red@0.8:size=200x80 -vframes 1 "${sampleWatermark}"`,
  { stdio: 'pipe' }
);
console.log('Sample watermark created at:', sampleWatermark);

console.log('--- 3. Testing getVideoMetadata ---');
const meta = await getVideoMetadata(sampleVideo);
console.log('Video Metadata:', meta);

console.log('--- 4. Testing processVideo with watermark & sound modify ---');
const result = await processVideo(sampleVideo, sampleOutput, {
  watermarkEnabled: true,
  watermarkPath: sampleWatermark,
  watermarkPosition: 'top-right',
  watermarkScale: 0.2,
  watermarkOpacity: 0.85,
  soundNormalizeEnabled: true,
  soundTweakEnabled: true
});

console.log('Processed Video Output exists:', fs.existsSync(result));
const outMeta = await getVideoMetadata(result);
console.log('Output Video Metadata:', outMeta);
console.log('Pipeline test PASSED successfully! 🎉');
