(() => {
  // Frontend and backend are served from the same origin on Render.
  const API_BASE = '';

  // No sandbox proxy here, so generate our own stable per-browser visitor id.
  function getVisitorId() {
    let id = localStorage.getItem('reflect_visitor_id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `v-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('reflect_visitor_id', id);
    }
    return id;
  }
  const VISITOR_ID = getVisitorId();

  const recordBtn = document.getElementById('recordBtn');
  const micIcon = document.getElementById('micIcon');
  const stopIcon = document.getElementById('stopIcon');
  const pulseRing = document.getElementById('pulseRing');
  const statusEl = document.getElementById('recorderStatus');
  const timerEl = document.getElementById('recorderTimer');

  const resultCard = document.getElementById('resultCard');
  const demoBanner = document.getElementById('demoBanner');
  const resultSummary = document.getElementById('resultSummary');
  const themesList = document.getElementById('themesList');
  const tensionsList = document.getElementById('tensionsList');
  const actionsList = document.getElementById('actionsList');
  const transcriptText = document.getElementById('transcriptText');

  const errorCard = document.getElementById('errorCard');
  const errorText = document.getElementById('errorText');

  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');

  const themeToggle = document.querySelector('[data-theme-toggle]');

  let mediaRecorder = null;
  let chunks = [];
  let timerInterval = null;
  let secondsElapsed = 0;
  let isRecording = false;

  // ---------- Theme ----------
  function initTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
  });
  initTheme();

  // ---------- Timer ----------
  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  function startTimer() {
    secondsElapsed = 0;
    timerEl.textContent = formatTime(0);
    timerEl.hidden = false;
    timerInterval = setInterval(() => {
      secondsElapsed += 1;
      timerEl.textContent = formatTime(secondsElapsed);
    }, 1000);
  }
  function stopTimer() {
    clearInterval(timerInterval);
  }

  // ---------- Recording ----------
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunks = [];

      mediaRecorder.addEventListener('dataavailable', (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        handleRecordingComplete(blob);
      });

      mediaRecorder.start();
      isRecording = true;
      updateRecordingUI(true);
      startTimer();
    } catch (err) {
      showError('Microphone access was blocked or unavailable. Check your browser permissions and try again.');
    }
  }

  function stopRecording() {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
      updateRecordingUI(false);
      stopTimer();
    }
  }

  function updateRecordingUI(recording) {
    recordBtn.classList.toggle('is-recording', recording);
    recordBtn.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
    micIcon.style.display = recording ? 'none' : 'block';
    stopIcon.style.display = recording ? 'block' : 'none';
    pulseRing.hidden = !recording;
    statusEl.textContent = recording ? 'Recording — tap to stop' : 'Processing your note…';
  }

  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      hideError();
      startRecording();
    }
  });

  // ---------- Submit + render ----------
  async function handleRecordingComplete(blob) {
    timerEl.hidden = true;
    try {
      const formData = new FormData();
      formData.append('file', blob, 'note.webm');
      const res = await fetch(`${API_BASE}/api/process`, {
        method: 'POST',
        headers: { 'X-Visitor-Id': VISITOR_ID },
        body: formData,
      });
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      const note = await res.json();
      renderResult(note);
      await refreshHistory();
      statusEl.textContent = 'Tap the mic to record another note';
    } catch (err) {
      showError("Couldn't process that recording. Please try again.");
      statusEl.textContent = 'Tap the mic to record a voice note';
    }
  }

  function fillList(listEl, items, emptyLabel) {
    listEl.innerHTML = '';
    const emptyEl = listEl.parentElement.querySelector(`[data-empty-for="${emptyLabel}"]`);
    if (!items || items.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      listEl.appendChild(li);
    });
  }

  function renderResult(note) {
    resultCard.hidden = false;
    demoBanner.hidden = !note.demo;
    resultSummary.textContent = note.summary || '';
    fillList(themesList, note.themes, 'themes');
    fillList(tensionsList, note.tensions, 'tensions');
    fillList(actionsList, note.next_actions, 'actions');
    transcriptText.textContent = note.transcript || '';
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showError(message) {
    errorText.textContent = message;
    errorCard.hidden = false;
  }
  function hideError() {
    errorCard.hidden = true;
  }

  // ---------- History ----------
  function formatDate(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function refreshHistory() {
    try {
      const res = await fetch(`${API_BASE}/api/notes`, { headers: { 'X-Visitor-Id': VISITOR_ID } });
      if (!res.ok) throw new Error('Failed to load history');
      const notes = await res.json();
      renderHistory(notes);
    } catch (err) {
      // Silent: history is supplementary, don't block the main flow.
    }
  }

  function renderHistory(notes) {
    historyList.innerHTML = '';
    if (!notes || notes.length === 0) {
      historyEmpty.hidden = false;
      return;
    }
    historyEmpty.hidden = true;
    notes.forEach((note) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.dataset.testid = `item-history-${note.id}`;

      const body = document.createElement('div');
      body.className = 'history-item-body';

      const dateEl = document.createElement('span');
      dateEl.className = 'history-item-date';
      dateEl.textContent = formatDate(note.created_at);

      const summaryEl = document.createElement('span');
      summaryEl.className = 'history-item-summary';
      summaryEl.textContent = note.summary || note.transcript || 'Untitled note';

      body.appendChild(dateEl);
      body.appendChild(summaryEl);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'history-item-delete';
      deleteBtn.setAttribute('aria-label', 'Delete this note');
      deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" stroke-linecap="round"/></svg>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch(`${API_BASE}/api/notes/${note.id}`, { method: 'DELETE', headers: { 'X-Visitor-Id': VISITOR_ID } });
          await refreshHistory();
        } catch (err) { /* noop */ }
      });

      li.addEventListener('click', () => renderResult(note));
      li.appendChild(body);
      li.appendChild(deleteBtn);
      historyList.appendChild(li);
    });
  }

  refreshHistory();
})();
