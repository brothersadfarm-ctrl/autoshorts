// AutoShorts Multi-Channel Client Application

let activeTab = 'stock';
let projects = [];
let currentProjectId = null;
let currentProject = null;

// ======================== INITIALIZATION ========================
document.addEventListener('DOMContentLoaded', async () => {
  initDropzone();
  initChangeLogoInput();
  await loadProjects();
  loadStatus();

  setInterval(loadStatus, 3000);
});

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');

  let bgClass = 'bg-slate-900 text-slate-100 border-slate-700';
  let icon = 'fa-circle-info text-indigo-400';

  if (type === 'success') {
    bgClass = 'bg-emerald-950/90 text-emerald-200 border-emerald-500/40';
    icon = 'fa-circle-check text-emerald-400';
  } else if (type === 'error') {
    bgClass = 'bg-rose-950/90 text-rose-200 border-rose-500/40';
    icon = 'fa-triangle-exclamation text-rose-400';
  } else if (type === 'warn') {
    bgClass = 'bg-amber-950/90 text-amber-200 border-amber-500/40';
    icon = 'fa-bell text-amber-400';
  }

  toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl transition-all duration-300 transform translate-y-2 opacity-0 pointer-events-auto max-w-sm ${bgClass}`;
  toast.innerHTML = `
    <i class="fa-solid ${icon} text-base flex-shrink-0"></i>
    <span class="text-xs font-medium">${message}</span>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Tab Switcher
function switchTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active-tab');
    btn.classList.add('text-slate-400');
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });

  const btn = document.getElementById(`tab-btn-${tabName}`);
  const content = document.getElementById(`tab-${tabName}`);
  if (btn) btn.classList.add('active-tab');
  if (content) content.classList.remove('hidden');

  if (tabName === 'history') {
    loadCurrentProjectHistory();
    loadActivityLogs();
  }
}

// ======================== PROJECT MANAGEMENT ========================
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    projects = await res.json();

    const selector = document.getElementById('project-selector');
    if (projects.length === 0) {
      selector.innerHTML = `<option value="">কোনো প্রজেক্ট নেই</option>`;
      openNewProjectModal();
      return;
    }

    selector.innerHTML = projects.map(p => `
      <option value="${p.id}" ${p.id === currentProjectId ? 'selected' : ''}>
        📂 ${escapeQuotes(p.name)} (${p.pending_videos} queued)
      </option>
    `).join('');

    // Restore saved project or pick first
    const savedId = localStorage.getItem('autoshorts_active_project');
    const match = projects.find(p => p.id === parseInt(savedId));
    if (match) {
      switchProject(match.id);
    } else {
      switchProject(projects[0].id);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

async function switchProject(projectId) {
  currentProjectId = parseInt(projectId);
  localStorage.setItem('autoshorts_active_project', currentProjectId);
  document.getElementById('project-selector').value = currentProjectId;

  currentProject = projects.find(p => p.id === currentProjectId);
  if (!currentProject) {
    const res = await fetch(`/api/projects/${currentProjectId}`);
    currentProject = await res.json();
  }

  // Update Project Header
  document.getElementById('current-project-name').textContent = currentProject.name;
  document.getElementById('current-project-desc').textContent = currentProject.description || `চ্যানেল নিশ: ${currentProject.niche || 'General'}`;

  // Logo
  const logoBox = document.getElementById('channel-logo-container');
  const settingsLogoBox = document.getElementById('settings-logo-preview');
  if (currentProject.logo_path) {
    const logoUrl = `/media/watermark/${pathBasename(currentProject.logo_path)}?t=${Date.now()}`;
    logoBox.innerHTML = `<img src="${logoUrl}" class="w-full h-full object-cover">`;
    settingsLogoBox.innerHTML = `<img src="${logoUrl}" class="w-full h-full object-contain">`;
  } else {
    logoBox.innerHTML = `<i class="fa-solid fa-tv"></i>`;
    settingsLogoBox.innerHTML = `<i class="fa-solid fa-image"></i>`;
  }

  // Platform Badges
  const badgesContainer = document.getElementById('project-platform-badges');
  badgesContainer.innerHTML = '';
  if (currentProject.publish_youtube) {
    badgesContainer.innerHTML += `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600/20 text-red-400 border border-red-500/30"><i class="fa-brands fa-youtube mr-1"></i>YouTube Shorts</span>`;
  }
  if (currentProject.publish_facebook) {
    badgesContainer.innerHTML += `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-600/20 text-blue-400 border border-blue-500/30"><i class="fa-brands fa-facebook mr-1"></i>Facebook Reels</span>`;
  }

  // Populate Channel Settings Form
  document.getElementById('setting-wm-position').value = currentProject.watermark_position || 'top-right';
  document.getElementById('setting-wm-opacity').value = String(currentProject.watermark_opacity || 0.85);
  document.getElementById('setting-sound-norm').checked = currentProject.sound_normalize_enabled === 1;
  document.getElementById('setting-sound-tweak').checked = currentProject.sound_tweak_pitch_tempo === 1;
  document.getElementById('setting-pub-yt').checked = currentProject.publish_youtube === 1;
  document.getElementById('setting-pub-fb').checked = currentProject.publish_facebook === 1;
  document.getElementById('setting-yt-client-id').value = currentProject.youtube_client_id || '';
  document.getElementById('setting-yt-client-secret').value = currentProject.youtube_client_secret || '';
  document.getElementById('setting-yt-refresh-token').value = currentProject.youtube_refresh_token || '';
  document.getElementById('setting-fb-page-id').value = currentProject.facebook_page_id || '';
  document.getElementById('setting-fb-token').value = currentProject.facebook_access_token || '';

  // Channel Niche & AI SEO
  const nicheInput = document.getElementById('setting-project-niche');
  if (nicheInput) nicheInput.value = currentProject.niche || '';

  const hashtagsInput = document.getElementById('setting-default-hashtags');
  if (hashtagsInput) hashtagsInput.value = currentProject.default_hashtags || '#Shorts #Reels #Viral #Trending #Bangla';

  // Load global Gemini key and simulation mode
  try {
    const sRes = await fetch('/api/settings');
    const sData = await sRes.json();
    const geminiInput = document.getElementById('setting-gemini-key');
    if (geminiInput) geminiInput.value = sData.gemini_api_key || '';
    updateSimModeUI(sData.simulation_mode === '1');
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Load this project's videos & schedules
  loadCurrentProjectVideos();
  loadCurrentProjectSchedules();
  loadStatus();
}

// Modal open / close
function openNewProjectModal() {
  document.getElementById('new-project-modal').classList.remove('hidden');
  document.getElementById('modal-project-name').focus();
}

function closeNewProjectModal() {
  document.getElementById('new-project-modal').classList.add('hidden');
}

async function handleCreateNewProject(e) {
  e.preventDefault();
  const name = document.getElementById('modal-project-name').value;
  const pubYt = document.getElementById('modal-pub-yt').checked ? 1 : 0;
  const pubFb = document.getElementById('modal-pub-fb').checked ? 1 : 0;

  // Gather checked times
  const timeCheckboxes = document.querySelectorAll('input[name="modal_times"]:checked');
  const times = Array.from(timeCheckboxes).map(cb => cb.value);

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        publish_youtube: pubYt,
        publish_facebook: pubFb,
        default_slots: times
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const newProjectId = data.id;

    // Check if logo was selected
    const logoFile = document.getElementById('modal-project-logo').files[0];
    if (logoFile) {
      const form = new FormData();
      form.append('logo', logoFile);
      await fetch(`/api/projects/${newProjectId}/logo`, {
        method: 'POST',
        body: form
      });
    }

    showToast(`অভিনন্দন! "${name}" চ্যানেল প্রজেক্ট তৈরি হয়েছে!`, 'success');
    closeNewProjectModal();
    document.getElementById('new-project-form').reset();

    // Reload projects and switch to new
    await loadProjects();
    switchProject(newProjectId);
  } catch (err) {
    showToast(`প্রজেক্ট তৈরিতে সমস্যা: ${err.message}`, 'error');
  }
}

// ======================== TAB 1: VIDEO STOCK QUEUE ========================
function initDropzone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('video-file-input');

  dropZone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('border-indigo-500', 'bg-slate-950');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-indigo-500', 'bg-slate-950');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) handleVideoUpload(files);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleVideoUpload(e.target.files);
  });
}

function handleVideoUpload(files) {
  if (!currentProjectId) {
    showToast('দয়া করে প্রথমে একটি চ্যানেল প্রজেক্ট সিলেক্ট বা তৈরি করুন!', 'warn');
    return;
  }

  const formData = new FormData();
  let count = 0;
  for (const file of files) {
    formData.append('videos', file);
    count++;
  }

  const progressContainer = document.getElementById('upload-progress-container');
  const progressBar = document.getElementById('upload-progress-bar');
  const progressPercent = document.getElementById('upload-progress-percent');
  const progressStatus = document.getElementById('upload-progress-status');

  progressContainer.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';
  progressStatus.textContent = `${count}টি ভিডিও স্টকে জমা হচ্ছে...`;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/projects/${currentProjectId}/videos/upload`, true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;
    }
  };

  xhr.onload = () => {
    progressContainer.classList.add('hidden');
    if (xhr.status === 200) {
      showToast(`${count}টি শর্ট ভিডিও সফলভাবে স্টকে জমা হয়েছে!`, 'success');
      loadCurrentProjectVideos();
      loadStatus();
    } else {
      showToast(`আপলোড ব্যর্থ: ${xhr.responseText}`, 'error');
    }
    document.getElementById('video-file-input').value = '';
  };

  xhr.onerror = () => {
    progressContainer.classList.add('hidden');
    showToast('সার্ভার সংযোগ বিচ্ছিন্ন', 'error');
  };

  xhr.send(formData);
}

async function loadCurrentProjectVideos() {
  if (!currentProjectId) return;
  const container = document.getElementById('video-list-container');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/videos`);
    const videos = await res.json();

    const pendingCount = videos.filter(v => v.status === 'pending').length;
    document.getElementById('nav-stock-badge').textContent = pendingCount;

    if (videos.length === 0) {
      container.innerHTML = `
        <div class="text-center py-10 border border-slate-800 rounded-xl bg-slate-950/40">
          <i class="fa-solid fa-inbox text-3xl text-slate-600 mb-2"></i>
          <p class="text-sm font-semibold text-slate-300">স্টকে কোনো ভিডিও নেই</p>
          <p class="text-xs text-slate-500 mt-0.5">উপরের বক্সে আপনার তৈরি করা শর্ট ভিডিওগুলো টেনে এনে ছেড়ে দিন।</p>
        </div>
      `;
      return;
    }

    container.innerHTML = videos.map((v, i) => {
      let statusBadge = '';
      if (v.status === 'pending') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">Queued</span>';
      } else if (v.status === 'processing') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Processing</span>';
      } else if (v.status === 'published') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Published</span>';
      } else if (v.status === 'failed') {
        statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">Failed</span>';
      }

      const previewSrc = v.processed_path ? `/media/processed/${pathBasename(v.processed_path)}` : `/media/queue/${v.filename}`;
      const sizeMb = (v.file_size / (1024 * 1024)).toFixed(1);
      const durationSec = Math.round(v.duration || 0);

      return `
        <div class="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 transition-all">
          <div class="flex items-center gap-3 min-w-0">
            <span class="text-xs font-mono font-bold text-slate-500 w-6 text-center">#${i + 1}</span>
            <button onclick="openVideoModal('${previewSrc}', '${escapeQuotes(v.original_name)}')" class="w-10 h-10 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-indigo-400 hover:text-indigo-300 hover:border-indigo-500 transition-all flex-shrink-0">
              <i class="fa-solid fa-play text-xs"></i>
            </button>
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2">
                <span class="text-xs font-bold text-slate-200 truncate max-w-sm">${escapeQuotes(v.original_name)}</span>
                ${statusBadge}
              </div>
              <div class="flex items-center gap-3 text-[11px] text-slate-500">
                <span><i class="fa-regular fa-clock mr-1"></i>${durationSec}s</span>
                <span><i class="fa-solid fa-hard-drive mr-1"></i>${sizeMb} MB</span>
                ${v.title ? `<span class="text-indigo-400 font-medium truncate max-w-xs">${escapeQuotes(v.title)}</span>` : ''}
              </div>
              ${v.error_message ? `<p class="text-[10px] text-rose-400">${escapeQuotes(v.error_message)}</p>` : ''}
            </div>
          </div>

          <div class="flex items-center gap-2">
            ${v.status === 'pending' ? `
              <button onclick="publishSpecificVideo(${v.id})" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition-all">
                <i class="fa-solid fa-rocket text-[10px]"></i>
                <span>Publish Now</span>
              </button>
            ` : ''}

            ${v.youtube_url ? `<a href="${v.youtube_url}" target="_blank" class="p-2 rounded-lg bg-red-600/20 text-red-400 text-xs" title="YouTube Shorts Link"><i class="fa-brands fa-youtube"></i></a>` : ''}
            ${v.facebook_url ? `<a href="${v.facebook_url}" target="_blank" class="p-2 rounded-lg bg-blue-600/20 text-blue-400 text-xs" title="Facebook Reel Link"><i class="fa-brands fa-facebook"></i></a>` : ''}

            <button onclick="deleteVideo(${v.id})" class="p-2 rounded-lg bg-slate-800 hover:text-rose-400 text-slate-400 text-xs transition-all">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-xs text-rose-400">ভিডিও লোড ব্যর্থ: ${err.message}</p>`;
  }
}

async function publishNextVideoNow() {
  if (!currentProjectId) return;
  if (!confirm(`আপনি কি "${currentProject.name}" চ্যানেলের পরবর্তী ভিডিওটি এখনই পোস্ট করতে চান?`)) return;

  showToast('ভিডিওতে লোগো ওয়াটারমার্ক ও সাউন্ড মডিফাই করে পাবলিশ করা হচ্ছে...', 'info');
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/publish-next`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('ভিডিও সফলভাবে পাবলিশ হয়েছে!', 'success');
    } else {
      showToast(`ব্যর্থ: ${data.message || data.error}`, 'error');
    }
    loadCurrentProjectVideos();
    loadStatus();
  } catch (err) {
    showToast(`ত্রুটি: ${err.message}`, 'error');
  }
}

async function publishSpecificVideo(id) {
  if (!confirm('আপনি কি এই নির্দিষ্ট ভিডিওটি এখনই পোস্ট করতে চান?')) return;
  showToast('প্রসেসিং ও পাবলিশিং শুরু হচ্ছে...', 'info');

  try {
    const res = await fetch(`/api/videos/${id}/publish-now`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('ভিডিও সফলভাবে পাবলিশ হয়েছে!', 'success');
    } else {
      showToast(`ব্যর্থ: ${data.error || data.message}`, 'error');
    }
    loadCurrentProjectVideos();
    loadStatus();
  } catch (err) {
    showToast(`ত্রুটি: ${err.message}`, 'error');
  }
}

async function deleteVideo(id) {
  if (!confirm('ভিডিওটি ডিলিট করতে চান?')) return;
  try {
    await fetch(`/api/videos/${id}`, { method: 'DELETE' });
    showToast('ভিডিও মুছে ফেলা হয়েছে', 'info');
    loadCurrentProjectVideos();
    loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ======================== TAB 2: SCHEDULES ========================
async function loadCurrentProjectSchedules() {
  if (!currentProjectId) return;
  const container = document.getElementById('schedules-list-container');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/schedules`);
    const schedules = await res.json();

    if (schedules.length === 0) {
      container.innerHTML = `<p class="col-span-full text-xs text-slate-500 py-4">কোনো সময় সেট করা নেই। নিচে থেকে সময় যোগ করুন।</p>`;
      return;
    }

    container.innerHTML = schedules.map(s => `
      <div class="flex items-center justify-between p-3.5 rounded-2xl bg-slate-950 border border-slate-800 ${s.is_enabled ? 'border-l-4 border-l-indigo-500' : 'opacity-60'}">
        <div class="flex items-center gap-3">
          <span class="font-mono text-base font-bold text-white px-2.5 py-1 rounded-lg bg-slate-800">${s.time_slot}</span>
          <div>
            <span class="text-xs font-bold text-slate-200 block">${escapeQuotes(s.label || 'Daily Slot')}</span>
            <span class="text-[10px] text-slate-500">প্রতিদিন অটো পোস্ট</span>
          </div>
        </div>

        <div class="flex items-center gap-2.5">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" class="sr-only peer" ${s.is_enabled ? 'checked' : ''} onchange="toggleScheduleSlot(${s.id}, this.checked)">
            <div class="w-8 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-600"></div>
          </label>

          <button onclick="deleteScheduleSlot(${s.id})" class="text-slate-500 hover:text-rose-400 p-1 text-xs">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load schedules:', err);
  }
}

async function handleAddScheduleSlot() {
  const time = document.getElementById('new-slot-input').value;
  const label = document.getElementById('new-slot-label-input').value;

  if (!time) {
    showToast('দয়া করে একটি সময় নির্বাচন করুন', 'warn');
    return;
  }

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time_slot: time, label })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`সময় ${time} সফলভাবে যুক্ত হয়েছে!`, 'success');
      document.getElementById('new-slot-label-input').value = '';
      loadCurrentProjectSchedules();
      loadStatus();
    } else {
      showToast(data.error || 'যুক্ত করা যায়নি', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleScheduleSlot(schedId, isEnabled) {
  try {
    await fetch(`/api/projects/${currentProjectId}/schedules/${schedId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: isEnabled })
    });
    loadCurrentProjectSchedules();
    loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteScheduleSlot(schedId) {
  if (!confirm('এই সময়টি বাদ দিতে চান?')) return;
  try {
    await fetch(`/api/projects/${currentProjectId}/schedules/${schedId}`, { method: 'DELETE' });
    loadCurrentProjectSchedules();
    loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ======================== TAB 3: CHANNEL SETTINGS & LOGO ========================
function initChangeLogoInput() {
  const input = document.getElementById('change-logo-input');
  input.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    const form = new FormData();
    form.append('logo', file);

    try {
      showToast('লোগো আপলোড হচ্ছে...', 'info');
      const res = await fetch(`/api/projects/${currentProjectId}/logo`, {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (data.success) {
        showToast('চ্যানেলের লোগো ও ওয়াটারমার্ক সফলভাবে আপডেট হয়েছে!', 'success');
        await loadProjects();
        switchProject(currentProjectId);
      }
    } catch (err) {
      showToast('লোগো সেভ ব্যর্থ: ' + err.message, 'error');
    }
  });
}

async function autoSaveCurrentProject() {
  if (!currentProjectId) return;

  const updated = {
    watermark_position: document.getElementById('setting-wm-position').value,
    watermark_opacity: parseFloat(document.getElementById('setting-wm-opacity').value),
    sound_normalize_enabled: document.getElementById('setting-sound-norm').checked ? 1 : 0,
    sound_tweak_pitch_tempo: document.getElementById('setting-sound-tweak').checked ? 1 : 0,
    publish_youtube: document.getElementById('setting-pub-yt').checked ? 1 : 0,
    publish_facebook: document.getElementById('setting-pub-fb').checked ? 1 : 0,
    niche: document.getElementById('setting-project-niche')?.value || '',
    default_hashtags: document.getElementById('setting-default-hashtags')?.value || ''
  };

  try {
    await fetch(`/api/projects/${currentProjectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
  } catch (err) {
    console.error('Auto save error:', err);
  }
}

async function saveProjectSettingsFull() {
  if (!currentProjectId) return;

  const updated = {
    watermark_position: document.getElementById('setting-wm-position').value,
    watermark_opacity: parseFloat(document.getElementById('setting-wm-opacity').value),
    sound_normalize_enabled: document.getElementById('setting-sound-norm').checked ? 1 : 0,
    sound_tweak_pitch_tempo: document.getElementById('setting-sound-tweak').checked ? 1 : 0,
    publish_youtube: document.getElementById('setting-pub-yt').checked ? 1 : 0,
    publish_facebook: document.getElementById('setting-pub-fb').checked ? 1 : 0,
    niche: document.getElementById('setting-project-niche')?.value || '',
    default_hashtags: document.getElementById('setting-default-hashtags')?.value || '',
    youtube_client_id: document.getElementById('setting-yt-client-id').value,
    youtube_client_secret: document.getElementById('setting-yt-client-secret').value,
    youtube_refresh_token: document.getElementById('setting-yt-refresh-token').value,
    facebook_page_id: document.getElementById('setting-fb-page-id').value,
    facebook_access_token: document.getElementById('setting-fb-token').value
  };

  try {
    const res = await fetch(`/api/projects/${currentProjectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
    const data = await res.json();
    if (data.success) {
      showToast('চ্যানেল ও প্ল্যাটফর্ম সেটিংস সফলভাবে সংরক্ষিত হয়েছে!', 'success');
      await loadProjects();
      switchProject(currentProjectId);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteCurrentProject() {
  if (projects.length <= 1) {
    alert('এটি আপনার একমাত্র চ্যানেল প্রজেক্ট! এটি ডিলিট করার আগে আরেকটি প্রজেক্ট তৈরি করুন।');
    return;
  }

  if (!confirm(`আপনি কি সত্যিই "${currentProject.name}" চ্যানেল প্রজেক্টটি ডিলিট করতে চান? এর সমস্ত ভিডিও এবং শিডিউল মুছে যাবে।`)) return;

  try {
    const res = await fetch(`/api/projects/${currentProjectId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('চ্যানেল প্রজেক্ট ডিলিট করা হয়েছে', 'info');
      currentProjectId = null;
      await loadProjects();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ======================== TAB 4: PUBLISHED HISTORY ========================
async function loadCurrentProjectHistory() {
  if (!currentProjectId) return;
  const tbody = document.getElementById('history-table-body');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/videos?status=published`);
    const videos = await res.json();

    if (videos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500">এখনো কোনো ভিডিও পোস্ট হয়নি</td></tr>`;
      return;
    }

    tbody.innerHTML = videos.map(v => `
      <tr class="hover:bg-slate-900/50">
        <td class="px-4 py-3 font-semibold text-white truncate max-w-xs">${escapeQuotes(v.title || v.original_name)}</td>
        <td class="px-4 py-3 text-slate-400 text-[11px]">${v.published_at || v.created_at}</td>
        <td class="px-4 py-3">
          ${v.youtube_url ? `<a href="${v.youtube_url}" target="_blank" class="text-red-400 hover:underline flex items-center gap-1"><i class="fa-brands fa-youtube"></i><span>Shorts</span></a>` : '<span class="text-slate-600">-</span>'}
        </td>
        <td class="px-4 py-3">
          ${v.facebook_url ? `<a href="${v.facebook_url}" target="_blank" class="text-blue-400 hover:underline flex items-center gap-1"><i class="fa-brands fa-facebook"></i><span>Reels</span></a>` : '<span class="text-slate-600">-</span>'}
        </td>
        <td class="px-4 py-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">Live</span>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

// ======================== STATUS & CLOCK ========================
async function loadStatus() {
  try {
    const url = currentProjectId ? `/api/status?projectId=${currentProjectId}` : '/api/status';
    const res = await fetch(url);
    const data = await res.json();

    document.getElementById('header-clock').textContent = data.currentTime;

    const simPill = document.getElementById('simulation-pill');
    if (data.simulationMode) {
      simPill.classList.remove('hidden');
    } else {
      simPill.classList.add('hidden');
    }

    if (data.nextRun && data.nextRun.nextSlot) {
      document.getElementById('header-countdown').textContent = data.nextRun.countdownText;
      document.getElementById('header-next-slot').textContent = `(${data.nextRun.nextSlot})`;
    } else {
      document.getElementById('header-countdown').textContent = 'স্লট নেই';
      document.getElementById('header-next-slot').textContent = '';
    }
  } catch (err) {
    console.error('Status fetch error:', err);
  }
}

// Video Player Modal
function openVideoModal(videoSrc, title) {
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-element');
  document.getElementById('modal-video-title').textContent = title;
  player.src = videoSrc;
  modal.classList.remove('hidden');
  player.play();
}

function closeVideoModal() {
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-element');
  player.pause();
  player.src = '';
  modal.classList.add('hidden');
}

// Helpers
function escapeQuotes(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pathBasename(p) {
  if (!p) return '';
  return p.split(/(\\|\/)/g).pop();
}

// ======================== CONNECTION TESTERS & SIMULATION TOGGLE ========================
let isSimulationMode = true;

async function toggleGlobalSimulationMode() {
  isSimulationMode = !isSimulationMode;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulation_mode: isSimulationMode ? '1' : '0' })
    });
    const data = await res.json();
    updateSimModeUI(isSimulationMode);
    if (!isSimulationMode) {
      showToast('🔴 LIVE PUBLISHING MODE সক্রিয়! এখন নির্ধারিত সময়ে ভিডিও সরাসরি আসল YouTube ও Facebook-এ আপলোড হবে।', 'warn');
    } else {
      showToast('🟡 SIMULATION MODE সক্রিয়! নিরাপদ টেস্ট মোড চালু রয়েছে।', 'info');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function updateSimModeUI(simMode) {
  isSimulationMode = simMode;
  const btn = document.getElementById('btn-toggle-sim-mode');
  const icon = document.getElementById('sim-mode-icon');
  const text = document.getElementById('sim-mode-text');
  const simPill = document.getElementById('simulation-pill');

  if (!btn || !icon || !text) return;

  if (simMode) {
    btn.className = 'px-3 py-1.5 rounded-xl border text-xs font-bold transition-all flex items-center gap-1.5 bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20';
    icon.textContent = '🟡';
    text.textContent = 'Test Mode (Simulation)';
    if (simPill) {
      simPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30';
      simPill.innerHTML = '<i class="fa-solid fa-flask-vial"></i><span>Simulation Mode</span>';
    }
  } else {
    btn.className = 'px-3 py-1.5 rounded-xl border text-xs font-bold transition-all flex items-center gap-1.5 bg-emerald-500/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 animate-pulse';
    icon.textContent = '🔴';
    text.textContent = 'Live Publishing (Active)';
    if (simPill) {
      simPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      simPill.innerHTML = '<i class="fa-solid fa-signal text-emerald-400"></i><span>Live Publishing</span>';
    }
  }
}

async function loginWithGoogleOAuth() {
  if (!currentProjectId) return;
  await saveProjectSettingsFull(); // save input values first
  const clientId = document.getElementById('setting-yt-client-id').value.trim();
  const clientSecret = document.getElementById('setting-yt-client-secret').value.trim();
  if (!clientId || !clientSecret) {
    showToast('দয়া করে প্রথমে Client ID এবং Client Secret বক্সে লিখুন!', 'warn');
    return;
  }
  // Open OAuth popup
  window.open(`/api/auth/google/login?projectId=${currentProjectId}`, '_blank', 'width=600,height=700');
}

async function testYouTubeConnection() {
  if (!currentProjectId) return;
  await saveProjectSettingsFull(); // auto save current values first

  const btn = document.getElementById('btn-test-yt');
  const resBox = document.getElementById('yt-test-result');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i>টেস্ট করা হচ্ছে...`;
  resBox.classList.add('hidden');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/test-youtube`, { method: 'POST' });
    const data = await res.json();
    resBox.classList.remove('hidden');

    if (data.success) {
      resBox.className = 'p-3 rounded-xl bg-emerald-950/70 border border-emerald-500/40 text-emerald-200 text-xs flex items-center gap-3';
      resBox.innerHTML = `
        <img src="${data.channelThumbnail || ''}" class="w-10 h-10 rounded-full border border-emerald-500/40">
        <div>
          <span class="font-bold text-white block">✅ YouTube চ্যানেল সফলভাবে কানেক্ট হয়েছে!</span>
          <span class="text-[11px] text-emerald-300">${escapeQuotes(data.channelName)}</span>
        </div>
      `;
      showToast(`YouTube চ্যানেল কানেক্টেড: ${data.channelName}`, 'success');
    } else {
      resBox.className = 'p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs';
      resBox.innerHTML = `<b>❌ কানেকশন ব্যর্থ:</b> ${data.error}`;
      showToast(data.error, 'error');
    }
  } catch (err) {
    resBox.classList.remove('hidden');
    resBox.className = 'p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs';
    resBox.innerHTML = `<b>❌ কানেকশন ব্যর্থ:</b> ${err.message}`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-link"></i><span>Test YouTube Connection</span>`;
  }
}

async function testFacebookConnection() {
  if (!currentProjectId) return;
  await saveProjectSettingsFull(); // auto save current values first

  const btn = document.getElementById('btn-test-fb');
  const resBox = document.getElementById('fb-test-result');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1"></i>টেস্ট করা হচ্ছে...`;
  resBox.classList.add('hidden');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/test-facebook`, { method: 'POST' });
    const data = await res.json();
    resBox.classList.remove('hidden');

    if (data.success) {
      resBox.className = 'p-3 rounded-xl bg-blue-950/70 border border-blue-500/40 text-blue-200 text-xs flex items-center gap-3';
      resBox.innerHTML = `
        <img src="${data.pagePicture || ''}" class="w-10 h-10 rounded-full border border-blue-500/40">
        <div>
          <span class="font-bold text-white block">✅ Facebook পেজ সফলভাবে কানেক্ট হয়েছে!</span>
          <span class="text-[11px] text-blue-300">${escapeQuotes(data.pageName)} (ID: ${data.pageId})</span>
        </div>
      `;
      showToast(`Facebook পেজ কানেক্টেড: ${data.pageName}`, 'success');
    } else {
      resBox.className = 'p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs';
      resBox.innerHTML = `<b>❌ কানেকশন ব্যর্থ:</b> ${data.error}`;
      showToast(data.error, 'error');
    }
  } catch (err) {
    resBox.classList.remove('hidden');
    resBox.className = 'p-3 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs';
    resBox.innerHTML = `<b>❌ কানেকশন ব্যর্থ:</b> ${err.message}`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-link"></i><span>Test Facebook Connection</span>`;
  }
}

// ======================== WATERMARK PREVIEW TESTER ========================
async function previewWatermarkTest() {
  if (!currentProjectId) {
    showToast('দয়া করে প্রথমে একটি চ্যানেল প্রজেক্ট নির্বাচন করুন', 'warn');
    return;
  }

  const btn = document.getElementById('btn-preview-wm');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5 text-indigo-400"></i><span>ওয়াটারমার্ক ও সাউন্ড প্রসেস হচ্ছে...</span>`;

  try {
    // Auto-save latest position and sound settings first
    await saveProjectSettingsFull();

    const res = await fetch(`/api/projects/${currentProjectId}/preview-watermark`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('ওয়াটারমার্ক ও সাউন্ড প্রিভিউ প্রস্তুত!', 'success');
      openVideoModal(data.previewUrl, `প্রিভিউ: ${currentProject.name} (লোগো ও সাউন্ড ইফেক্ট)`);
    } else {
      showToast(data.error || 'প্রিভিউ তৈরিতে সমস্যা হয়েছে', 'error');
    }
  } catch (err) {
    showToast('প্রিভিউ ত্রুটি: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-play text-indigo-400"></i><span>লোগো ওয়াটারমার্ক ও সাউন্ড প্রিভিউ টেস্ট করুন</span>`;
  }
}

// ======================== GEMINI API KEY ========================
async function saveGeminiApiKey() {
  const key = document.getElementById('setting-gemini-key').value.trim();
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gemini_api_key: key })
    });
    const data = await res.json();
    if (data.success) {
      showToast(key ? 'Google Gemini API Key সংরক্ষিত হয়েছে!' : 'Gemini Key মুছে দেওয়া হয়েছে (বিল্ট-ইন এসইও ইঞ্জিন চলবে)', 'success');
    }
  } catch (err) {
    showToast('Gemini Key সেভ ব্যর্থ: ' + err.message, 'error');
  }
}

// ======================== 24/7 CLOUD SETUP MODAL ========================
function openCloudGuideModal() {
  const modal = document.getElementById('cloud-guide-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeCloudGuideModal() {
  const modal = document.getElementById('cloud-guide-modal');
  if (modal) modal.classList.add('hidden');
}

// ======================== LIVE ACTIVITY LOGS ========================
async function loadActivityLogs() {
  const container = document.getElementById('logs-console');
  if (!container) return;

  try {
    const url = currentProjectId ? `/api/logs?projectId=${currentProjectId}&limit=60` : '/api/logs?limit=60';
    const res = await fetch(url);
    const logs = await res.json();

    if (logs.length === 0) {
      container.innerHTML = `<p class="text-slate-600 italic">এখনো কোনো অ্যাক্টিভিটি লগ রেকর্ড হয়নি। ভিডিও পাবলিশ বা শিডিউল টেস্ট করলে এখানে রিয়েল-টাইম তথ্য দেখতে পাবেন।</p>`;
      return;
    }

    container.innerHTML = logs.map(l => {
      let colorClass = 'text-slate-300';
      let tagClass = 'text-slate-400 font-bold';
      let icon = 'fa-info-circle';

      if (l.level === 'success') {
        colorClass = 'text-emerald-300';
        tagClass = 'text-emerald-400 font-bold';
        icon = 'fa-check-circle';
      } else if (l.level === 'error') {
        colorClass = 'text-rose-300';
        tagClass = 'text-rose-400 font-bold';
        icon = 'fa-circle-xmark';
      } else if (l.level === 'warn') {
        colorClass = 'text-amber-300';
        tagClass = 'text-amber-400 font-bold';
        icon = 'fa-triangle-exclamation';
      }

      const time = l.created_at || '';
      return `
        <div class="flex items-start gap-2 border-b border-slate-900/60 pb-1.5 hover:bg-slate-900/40 px-1 rounded transition-colors">
          <span class="text-slate-500 text-[10px] whitespace-nowrap font-mono">[${time}]</span>
          <span class="${tagClass} text-[10px] uppercase whitespace-nowrap"><i class="fa-solid ${icon} mr-1"></i>[${l.level}]</span>
          <span class="${colorClass} flex-1 break-words">${escapeQuotes(l.message)}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-rose-400">লগ লোড ত্রুটি: ${err.message}</p>`;
  }
}

async function clearActivityLogs() {
  if (!confirm('আপনি কি সমস্ত অ্যাক্টিভিটি লগ মুছে ফেলতে চান?')) return;
  try {
    const url = currentProjectId ? `/api/logs?projectId=${currentProjectId}` : '/api/logs';
    await fetch(url, { method: 'DELETE' });
    showToast('অ্যাক্টিভিটি লগ পরিষ্কার করা হয়েছে', 'info');
    loadActivityLogs();
  } catch (err) {
    showToast('লগ মুছতে সমস্যা: ' + err.message, 'error');
  }
}

// ======================== GOOGLE DRIVE VIDEO IMPORT ========================
async function handleImportGoogleDrive() {
  if (!currentProjectId) {
    showToast('দয়া করে প্রথমে একটি চ্যানেল প্রজেক্ট সিলেক্ট করুন!', 'warn');
    return;
  }

  const input = document.getElementById('gdrive-links-input');
  const rawText = input.value.trim();
  if (!rawText) {
    showToast('দয়া করে অন্তত একটি Google Drive ভিডিও লিঙ্ক দিন', 'warn');
    return;
  }

  const btn = document.getElementById('btn-import-gdrive');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Google Drive থেকে ডাউনলোড হচ্ছে...`;

  showToast('Google Drive থেকে ভিডিও ডাউনলোড ও স্টকে যুক্ত করা শুরু হয়েছে...', 'info');

  try {
    const res = await fetch(`/api/projects/${currentProjectId}/videos/import-gdrive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: rawText })
    });

    const data = await res.json();
    if (data.success) {
      showToast(`অভিনন্দন! Google Drive থেকে ${data.importedCount}টি ভিডিও স্টকে যুক্ত হয়েছে!`, 'success');
      input.value = '';
      loadCurrentProjectVideos();
      loadStatus();
    } else {
      const errMsg = data.errors && data.errors.length > 0 ? data.errors[0].error : (data.error || 'ইম্পোর্ট করা যায়নি');
      showToast(`ত্রুটি: ${errMsg}`, 'error');
    }
  } catch (err) {
    showToast(`ডাউনলোড ত্রুটি: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-brands fa-google-drive"></i><span>Google Drive থেকে স্টকে যুক্ত করুন</span>`;
  }
}



