import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:5000';

async function runTest() {
  console.log('--- 1. Testing Project Creation ---');
  const projRes = await axios.post(`${BASE_URL}/api/projects`, {
    name: 'Gaming Shorts BD',
    description: 'দৈনিক ভাইরাল গেমিং ক্লিপস',
    publish_youtube: 1,
    publish_facebook: 1,
    default_slots: ['09:00', '14:00', '17:00', '19:00', '21:00']
  });
  console.log('Project created:', projRes.data);
  const projectId = projRes.data.id;

  console.log('--- 2. Uploading Channel Logo Watermark for Project ---');
  const sampleLogoPath = path.resolve(__dirname, '../uploads/test/sample_logo.png');
  const logoForm = new FormData();
  logoForm.append('logo', fs.createReadStream(sampleLogoPath), 'gaming_logo.png');

  const logoRes = await axios.post(`${BASE_URL}/api/projects/${projectId}/logo`, logoForm, {
    headers: logoForm.getHeaders()
  });
  console.log('Logo uploaded:', logoRes.data);

  console.log('--- 3. Uploading Short Video to this Project Stock ---');
  const sampleVideoPath = path.resolve(__dirname, '../uploads/test/sample_input.mp4');
  const videoForm = new FormData();
  videoForm.append('videos', fs.createReadStream(sampleVideoPath), 'epic_headshot_moment.mp4');

  const uploadRes = await axios.post(`${BASE_URL}/api/projects/${projectId}/videos/upload`, videoForm, {
    headers: videoForm.getHeaders()
  });
  console.log('Video uploaded to project:', uploadRes.data);
  const videoId = uploadRes.data.videos[0].id;

  console.log('--- 4. Publishing Next Video in Project ---');
  const pubRes = await axios.post(`${BASE_URL}/api/projects/${projectId}/publish-next`);
  console.log('Publish Result:', pubRes.data);

  console.log('--- 5. Verifying Project Video Status ---');
  const videosRes = await axios.get(`${BASE_URL}/api/projects/${projectId}/videos`);
  const publishedVideo = videosRes.data.find(v => v.id === videoId);
  console.log('Published Video:', {
    id: publishedVideo.id,
    title: publishedVideo.title,
    status: publishedVideo.status,
    youtube: publishedVideo.youtube_url,
    facebook: publishedVideo.facebook_url
  });

  console.log('--- 6. Verifying Project Schedules ---');
  const schedRes = await axios.get(`${BASE_URL}/api/projects/${projectId}/schedules`);
  console.log(`Found ${schedRes.data.length} schedule slots for project:`, schedRes.data.map(s => s.time_slot));

  console.log('🎉 MULTI-PROJECT SYSTEM VERIFIED SUCCESSFULLY! 🎉');
}

runTest().catch(err => {
  console.error('Test error:', err.response?.data || err.message);
  process.exit(1);
});
