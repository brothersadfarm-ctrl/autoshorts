import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:5000';

async function runVerification() {
  console.log('--- Starting System Verification ---');

  // 1. Check Status
  console.log('1. Checking /api/status...');
  const statusRes = await axios.get(`${BASE_URL}/api/status`);
  console.log('Status OK:', {
    time: statusRes.data.currentTime,
    timezone: statusRes.data.timezone,
    nextRun: statusRes.data.nextRun.nextSlot,
    stock: statusRes.data.stockStats
  });

  // 2. Check Schedules
  console.log('2. Checking /api/schedules...');
  const schedRes = await axios.get(`${BASE_URL}/api/schedules`);
  console.log(`Found ${schedRes.data.length} schedule slots:`, schedRes.data.map(s => s.time_slot));

  // 3. Upload Sample Video to Stock Queue
  console.log('3. Uploading sample video to stock queue...');
  const sampleVideoPath = path.resolve(__dirname, '../uploads/test/sample_input.mp4');
  if (!fs.existsSync(sampleVideoPath)) {
    throw new Error('Sample input video does not exist. Run test_pipeline.js first.');
  }

  const form = new FormData();
  form.append('videos', fs.createReadStream(sampleVideoPath), 'top_viral_short_clip.mp4');

  const uploadRes = await axios.post(`${BASE_URL}/api/videos/upload`, form, {
    headers: form.getHeaders()
  });
  console.log('Upload OK:', uploadRes.data);
  const uploadedVideoId = uploadRes.data.videos[0].id;

  // 4. Trigger Instant Publish on Uploaded Video
  console.log(`4. Triggering instant publish on video #${uploadedVideoId}...`);
  const publishRes = await axios.post(`${BASE_URL}/api/videos/${uploadedVideoId}/publish-now`);
  console.log('Publish result:', publishRes.data);

  // 5. Verify Video Status in Database
  console.log('5. Verifying video record in /api/videos...');
  const videosRes = await axios.get(`${BASE_URL}/api/videos`);
  const processedVideo = videosRes.data.find(v => v.id === uploadedVideoId);
  console.log('Processed Video Record:', {
    id: processedVideo.id,
    status: processedVideo.status,
    title: processedVideo.title,
    youtube: processedVideo.youtube_url,
    facebook: processedVideo.facebook_url,
    processedFile: !!processedVideo.processed_path
  });

  // 6. Check Logs
  console.log('6. Checking /api/logs...');
  const logsRes = await axios.get(`${BASE_URL}/api/logs?limit=5`);
  console.log(`Recent activity logs (${logsRes.data.length}):`);
  logsRes.data.forEach(l => console.log(`  [${l.level.toUpperCase()}] ${l.message}`));

  console.log('🎉 ALL SYSTEM CHECKS PASSED! 🎉');
}

runVerification().catch(err => {
  console.error('Verification failed:', err.response?.data || err.message);
  process.exit(1);
});
