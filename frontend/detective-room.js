/* detective-room.js — interrogation room, corkboard, and evidence system */

const DR = (() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let _evidence    = [];      // [{key, label, description, source, suspect, boardX, boardY}]
  let _connections = [];      // [{from, to}]
  let _mode        = null;    // "interrogation" | "board"
  let _suspect     = null;
  let _askedKeys   = new Set();
  let _dragging    = null;
  let _dragOffX    = 0, _dragOffY = 0;
  let _connecting  = null;
  let _onAdvance   = null;
  let _currentAudio = null;
  let _pendingAudioDone = null;
  let _currentQuestions = null;
  let _currentReactions = null;
  let _replyInProgress = false;
  let _seSpeaking = false;
  const _interviewLog = { SARA: [], MAYA: [], COLE: [] };

  function isInterviewBusy() {
    return _replyInProgress || _seSpeaking;
  }

  function syncInterviewControls() {
    const busy = isInterviewBusy();
    const done = $('dr-done-btn');
    if (done) done.disabled = busy;
    document.querySelectorAll('.dr-q-hint').forEach(el => {
      el.classList.toggle('dr-q-hint-busy', busy);
    });
  }

  function setReplyBusy(busy) {
    _replyInProgress = busy;
    syncInterviewControls();
  }

  function stopCurrentAudio() {
    _lineAbort = true;
    if (_pendingAudioDone) {
      const done = _pendingAudioDone;
      _pendingAudioDone = null;
      done();
    }
    if (_currentAudio) {
      try {
        _currentAudio.pause();
        _currentAudio.currentTime = 0;
      } catch (e) {}
      _currentAudio = null;
    }
    pauseInterviewVideo();
    window.duckBgMusic?.(false);
  }

  function stopInterviewMedia() {
    stopCurrentAudio();
    _replyInProgress = false;
    _seSpeaking = false;
    syncInterviewControls();
  }

  function recordInterviewReply(suspect, text) {
    const name = (suspect || '').toUpperCase();
    const line = cleanSpokenReply(text);
    if (!line || !_interviewLog[name]) return;
    if (_interviewLog[name][_interviewLog[name].length - 1] === line) return;
    _interviewLog[name].push(line);
    if (_interviewLog[name].length > 12) _interviewLog[name] = _interviewLog[name].slice(-12);
  }

  function getInterviewLog() {
    return { SARA: [..._interviewLog.SARA], MAYA: [..._interviewLog.MAYA], COLE: [..._interviewLog.COLE] };
  }

  function clearInterviewLog() {
    _interviewLog.SARA = [];
    _interviewLog.MAYA = [];
    _interviewLog.COLE = [];
  }
  const $ = id => document.getElementById(id);

  // ── Show / hide ────────────────────────────────────────────────────────────
  function show() {
    $('dr-room').classList.remove('dr-hidden');
    // Dim the cinematic video layers so only the room is visible
    document.querySelectorAll('.scene-video').forEach(el => el.style.opacity = '0');
    document.getElementById('vignette').style.opacity = '0';
    document.getElementById('scene-canvas').style.opacity = '0';
    document.querySelectorAll('.cinema-bar').forEach(el => el.style.opacity = '0');
  }

  function hide() {
    stopSpeechEngine();
    stopInterviewMedia();
    _mode = null;
    $('dr-room').classList.add('dr-hidden');
    document.querySelectorAll('.scene-video').forEach(el => el.style.opacity = '');
    document.getElementById('vignette').style.opacity = '';
    document.getElementById('scene-canvas').style.opacity = '';
    document.querySelectorAll('.cinema-bar').forEach(el => el.style.opacity = '');
  }

  function reset() {
    _evidence    = [];
    _connections = [];
    _askedKeys   = new Set();
    _connecting  = null;
    $('dr-board-cards').innerHTML  = '';
    $('dr-board-strings').innerHTML = '';
    if ($('dr-casefile-count')) $('dr-casefile-count').textContent = '0';
    setSuspectStatus('SARA', 'UNCONFIRMED');
    setSuspectStatus('MAYA', 'UNCONFIRMED');
    setSuspectStatus('COLE', 'SECURITY');
    setRosterVisible(false);
    clearLine();
    clearInterviewLog();
    _replyInProgress = false;
    _seSpeaking = false;
  }

  function setRosterVisible(visible) {
    document.querySelectorAll('.dr-portrait').forEach(card => {
      card.classList.toggle('dr-roster-hidden', !visible);
    });
  }

  // ── Mode switching ─────────────────────────────────────────────────────────
  function setMode(mode) {
    if (_mode === 'interrogation' && mode !== 'interrogation') {
      stopSpeechEngine();
      stopInterviewMedia();
    }
    _mode = mode;
    $('dr-intg-section').classList.toggle('dr-active', mode === 'interrogation');
    $('dr-controls').classList.toggle('dr-active', mode === 'interrogation');
    $('dr-room')?.classList.toggle('dr-interview-mode', mode === 'interrogation');
    $('dr-interview-tabs')?.classList.toggle('dr-visible', mode === 'interrogation');
    document.body.classList.toggle('dr-interview', mode === 'interrogation');
    if (mode !== 'interrogation') pauseInterviewVideo();
  }

  // ── Progress label ─────────────────────────────────────────────────────────
  const PROGRESS_LABELS = {
    sara_interview_1: 'WITNESS INTERVIEWS — 1 OF 3',
    maya_interview_1: 'WITNESS INTERVIEWS — 2 OF 3',
    cole_interview_1: 'WITNESS INTERVIEWS — 3 OF 3',
  };

  const INTERVIEW_ORDER = ['SARA', 'MAYA', 'COLE'];

  function updateInterviewTabs(activeSuspect) {
    const activeIdx = INTERVIEW_ORDER.indexOf(activeSuspect);
    document.querySelectorAll('.dr-interview-tab').forEach(tab => {
      const idx = INTERVIEW_ORDER.indexOf(tab.dataset.suspect);
      tab.classList.remove('is-active', 'is-done', 'is-pending', 'is-next');
      tab.setAttribute('aria-current', idx === activeIdx ? 'step' : 'false');
      if (idx < activeIdx) tab.classList.add('is-done');
      else if (idx === activeIdx) tab.classList.add('is-active');
      else if (idx === activeIdx + 1) tab.classList.add('is-next');
      else tab.classList.add('is-pending');
    });
  }

  function setProgress(sceneId) {
    const el = document.getElementById('dr-progress');
    if (el) el.textContent = PROGRESS_LABELS[sceneId] || '';
  }

  function setFeedStatus(state) {
    const statusEl = $('dr-intg-status');
    if (!statusEl) return;
    if ($('dr-intg-section')?.classList.contains('dr-video-disabled')) {
      statusEl.textContent = 'AUDIO CALL';
      return;
    }
    statusEl.textContent = state === 'live' ? 'LIVE' : 'STANDBY';
  }

  function pauseInterviewVideo() {
    const vid = $('dr-intg-video');
    if (vid && !vid.paused) vid.pause();
    setFeedStatus('idle');
  }

  function playInterviewVideo() {
    const intgSection = $('dr-intg-section');
    if (intgSection?.classList.contains('dr-video-disabled')) return;
    const vid = $('dr-intg-video');
    if (!vid?.src) return;
    vid.play().catch(() => {});
    setFeedStatus('live');
  }

  function loadSuspectVideo(sceneData) {
    const vid = $('dr-intg-video');
    const intgSection = $('dr-intg-section');

    pauseInterviewVideo();
    intgSection.classList.toggle('dr-video-disabled', Boolean(sceneData.video_disabled));
    setFeedStatus('idle');

    if (sceneData.video_disabled) {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
      return;
    }

    const url = sceneData.suspect_video || `/static/scenes/${sceneData.atmosphere}.mp4?v=6`;
    vid.muted = true;
    vid.defaultMuted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.autoplay = false;
    vid.setAttribute('playsinline', '');
    vid.setAttribute('muted', '');
    vid.removeAttribute('autoplay');
    const base = url.split('?')[0];
    if (!vid.src || !vid.src.includes(base)) {
      vid.src = url;
      vid.load();
    }
    const freezeFirstFrame = () => {
      vid.pause();
      try { vid.currentTime = 0; } catch (e) {}
    };
    if (vid.readyState >= 2) freezeFirstFrame();
    else vid.addEventListener('canplay', freezeFirstFrame, { once: true });
  }

  // ── Interrogation ──────────────────────────────────────────────────────────
  function startInterrogation(sceneData, onAdvance) {
    stopInterviewMedia();
    stopSpeechEngine();
    _onAdvance     = onAdvance;
    _suspect       = sceneData.suspect;
    _askedKeys     = new Set();
    _currentQuestions = sceneData.questions || [];
    _currentReactions = sceneData.evidence_reactions || {};

    show();
    setMode('interrogation');
    setProgress(sceneData.id || '');
    updateInterviewTabs(_suspect);
    setRosterVisible(false);
    clearLine();

    const suspectColor = getSuspectColor(_suspect);
    const nameEl = $('dr-intg-name');
    nameEl.textContent = _suspect;
    nameEl.style.color = suspectColor;

    loadSuspectVideo(sceneData);
    renderQuestions();
  }

  function renderQuestions() {
    const c = $('dr-question-btns');
    c.innerHTML = '';
    const suspectColor = getSuspectColor(_suspect);

    // Suspect context header for right panel
    if (_suspect) {
      const header = document.createElement('div');
      header.className = 'dr-intg-header';
      header.innerHTML =
        `<span class="dr-intg-hname" style="color:${suspectColor}">${_suspect}</span>` +
        `<span class="dr-intg-hstatus">&#9679; ${$('dr-intg-section')?.classList.contains('dr-video-disabled') ? 'AUDIO' : 'LIVE'}</span>`;
      c.appendChild(header);
    }

    // Live voice — ElevenLabs Speech Engine (WebRTC + Groq on server)
    const seWrap = document.createElement('div');
    seWrap.className = 'dr-se-wrap';
    const seBtn = document.createElement('button');
    seBtn.className = 'dr-se-btn';
    seBtn.id = 'dr-se-btn';
    seBtn.textContent = '🎙 LIVE VOICE — SPEAK TO ' + _suspect;
    seBtn.addEventListener('click', () => toggleSpeechEngine(_suspect));
    const seNote = document.createElement('p');
    seNote.className = 'dr-se-note';
    seNote.textContent = 'ElevenLabs Speech Engine · mic in, Groq character reply, voice out';
    seWrap.appendChild(seBtn);
    seWrap.appendChild(seNote);
    c.appendChild(seWrap);

    const available = _currentQuestions.filter(q =>
      !_askedKeys.has(q.key) && hasRequiredEvidence(q.requires_evidence)
    );
    if (available.length) {
      const hintsWrap = document.createElement('div');
      hintsWrap.className = 'dr-q-hints';
      const hintsLabel = document.createElement('div');
      hintsLabel.className = 'dr-q-hints-label';
      hintsLabel.textContent = 'Quick question hints';
      hintsWrap.appendChild(hintsLabel);
      const hintsList = document.createElement('ul');
      hintsList.className = 'dr-q-hints-list';
      available.forEach(q => {
        const li = document.createElement('li');
        li.className = 'dr-q-hint';
        li.textContent = q.cole_asks;
        li.title = 'Tap to ask this';
        li.addEventListener('click', () => askQuestion(q));
        hintsList.appendChild(li);
      });
      hintsWrap.appendChild(hintsList);
      c.appendChild(hintsWrap);
    }

    // Done — advance to next witness or next story beat after Cole
    const doneBtn = document.createElement('button');
    doneBtn.className = 'dr-q-btn dr-q-done';
    doneBtn.id = 'dr-done-btn';
    doneBtn.disabled = isInterviewBusy();
    const isLastInterview = _suspect === 'COLE';
    doneBtn.textContent = isLastInterview
      ? 'Continue investigation →'
      : `Next witness → ${INTERVIEW_ORDER[INTERVIEW_ORDER.indexOf(_suspect) + 1]}`;
    doneBtn.addEventListener('click', () => {
      if (isInterviewBusy()) return;
      stopInterviewMedia();
      closeEvidencePanel();
      stopSpeechEngine();
      if (_onAdvance) _onAdvance();
    });
    c.appendChild(doneBtn);
    syncInterviewControls();
  }

  function askQuestion(q) {
    if (_askedKeys.has(q.key) || isInterviewBusy()) return;
    stopCurrentAudio();
    _askedKeys.add(q.key);
    setReplyBusy(true);
    renderQuestions();

    if (window.DR_ask) {
      window.DR_ask(q.key, async data => {
        try {
          const text = data?.text || '';
          if (text) {
            await showSuspectReply(_suspect, text, data.audio_b64);
            await applyQuestionMeta(data, text);
          }
        } finally {
          closeEvidencePanel();
          setReplyBusy(false);
          renderQuestions();
        }
      });
    } else {
      showLine(_suspect, 'Connection lost. Refresh and try again.');
      closeEvidencePanel();
      setReplyBusy(false);
      renderQuestions();
    }
  }

  function toggleEvidencePanel() {
    const panel = $('dr-ev-panel');
    if (!panel.classList.contains('dr-hidden')) { panel.classList.add('dr-hidden'); return; }
    renderEvidencePanel();
    panel.classList.remove('dr-hidden');
  }

  function closeEvidencePanel() {
    $('dr-ev-panel').classList.add('dr-hidden');
  }

  function renderEvidencePanel() {
    const panel = $('dr-ev-panel');
    panel.innerHTML = '';

    _evidence.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'dr-ev-card-small';
      card.innerHTML = `<div class="decs-label">${ev.label}</div><div class="decs-text">${ev.description.substring(0, 80)}…</div>`;
      card.addEventListener('click', () => presentEvidence(ev));
      panel.appendChild(card);
    });

    const close = document.createElement('button');
    close.className = 'dr-ev-close';
    close.textContent = '✕ CLOSE';
    close.addEventListener('click', closeEvidencePanel);
    panel.appendChild(close);
  }

  function presentEvidence(ev) {
    if (isInterviewBusy()) return;
    stopCurrentAudio();
    closeEvidencePanel();
    setReplyBusy(true);
    renderQuestions();
    if (window.DR_evidence) {
      window.DR_evidence(ev.key, async data => {
        try {
          const text = data?.text || '';
          if (text) {
            await showSuspectReply(_suspect, text, data.audio_b64);
          }
        } finally {
          setReplyBusy(false);
          renderQuestions();
        }
      });
    } else {
      showLine(_suspect, 'Connection lost. Refresh and try again.');
      setReplyBusy(false);
      renderQuestions();
    }
  }

  // ── Evidence board (corkboard) ─────────────────────────────────────────────
  function addEvidence(clue) {
    if (_evidence.find(e => e.key === clue.key)) return;
    _evidence.push(clue);
    renderCard(clue);
    if (clue.suspect) {
      const portrait = document.querySelector(`[data-board-suspect="${clue.suspect}"]`);
      portrait?.classList.add('dr-flash');
      setTimeout(() => portrait?.classList.remove('dr-flash'), 1000);
    }
    if (clue.key === 'camera_panel') setSuspectStatus('COLE', 'OVERRIDE LOGGED');
    if (clue.key === 'unknown_man') setSuspectStatus('COLE', 'ON CCTV');
    if ($('dr-casefile-count')) $('dr-casefile-count').textContent = _evidence.length;
  }

  function renderCard(clue) {
    const tilt = (Math.random() * 10 - 5).toFixed(1);
    const card = document.createElement('div');
    card.className = 'dr-ev-card';
    card.dataset.key = clue.key;
    card.style.setProperty('--tilt', `${tilt}deg`);
    card.style.left = `${8 + Math.random() * 55}%`;
    card.style.top  = `${38 + Math.random() * 42}%`;
    card.innerHTML = `
      <div class="dr-pin"></div>
      <div class="dec-label">${clue.label}</div>
      <div class="dec-text">${clue.description.substring(0, 90)}${clue.description.length > 90 ? '…' : ''}</div>
      <div class="dec-src">${clue.source}</div>`;
    makeDraggable(card);
    card.addEventListener('click', onCardClick);
    $('dr-board-cards').appendChild(card);
  }

  // Drag
  function makeDraggable(el) {
    const start = (cx, cy) => {
      _dragging = el;
      const r = el.getBoundingClientRect();
      _dragOffX = cx - r.left;
      _dragOffY = cy - r.top;
      el.style.zIndex = 50;
      el.style.cursor = 'grabbing';
    };
    el.addEventListener('mousedown', e => { if (!e.target.classList.contains('dr-pin')) { start(e.clientX, e.clientY); e.preventDefault(); } });
    el.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
  }

  function moveDragging(cx, cy) {
    const board = $('dr-corkboard');
    if (!board) return;
    const br = board.getBoundingClientRect();
    const x = Math.max(0, Math.min(85, (cx - _dragOffX - br.left) / br.width * 100));
    const y = Math.max(5, Math.min(88, (cy - _dragOffY - br.top)  / br.height * 100));
    _dragging.style.left = `${x.toFixed(1)}%`;
    _dragging.style.top  = `${y.toFixed(1)}%`;
    updateStrings();
  }

  function stopDragging() {
    if (!_dragging) return;
    _dragging.style.zIndex = '';
    _dragging.style.cursor = 'grab';
    _dragging = null;
  }

  // String connections (click two cards / portraits to link with red string)
  function onCardClick(e) {
    if (_dragging) return;
    const key = e.currentTarget.dataset.key;
    handleConnect(key, e.currentTarget);
  }

  function onPortraitClick(e) {
    const key = e.currentTarget.dataset.boardSuspect;
    handleConnect(key, e.currentTarget);
  }

  function handleConnect(key, el) {
    if (!_connecting) {
      _connecting = key;
      el.classList.add('dr-connecting');
    } else if (_connecting === key) {
      _connecting = null;
      el.classList.remove('dr-connecting');
    } else {
      const exists = _connections.find(c =>
        (c.from === _connecting && c.to === key) || (c.from === key && c.to === _connecting));
      if (!exists) { _connections.push({ from: _connecting, to: key }); updateStrings(); }
      // Clear connecting state from old element
      document.querySelector('.dr-connecting')?.classList.remove('dr-connecting');
      _connecting = null;
    }
  }

  function getCenter(key) {
    const board = $('dr-corkboard');
    if (!board) return null;
    const br = board.getBoundingClientRect();
    const el = board.querySelector(`[data-key="${key}"]`) || board.querySelector(`[data-board-suspect="${key}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - br.left, y: r.top + r.height / 2 - br.top };
  }

  function updateStrings() {
    const svg = $('dr-board-strings');
    if (!svg) return;
    svg.innerHTML = '';
    _connections.forEach(({ from, to }) => {
      const a = getCenter(from), b = getCenter(to);
      if (!a || !b) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('stroke', 'rgba(190, 45, 35, 0.8)');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    });
  }

  // ── Case file panel ────────────────────────────────────────────────────────
  function openCaseFile() {
    const panel = $('dr-casefile-panel');
    const list  = $('dr-cf-list');
    list.innerHTML = '';
    if (_evidence.length === 0) {
      list.innerHTML = '<div class="dr-cf-empty">No evidence collected yet. Review the CCTV footage.</div>';
    } else {
      _evidence.forEach(ev => {
        const item = document.createElement('div');
        item.className = 'dr-cf-item';
        item.innerHTML = `<div class="dr-cf-label">${ev.label}</div><div class="dr-cf-desc">${ev.description}</div><div class="dr-cf-src">${ev.source}</div>`;
        list.appendChild(item);
      });
    }
    panel.classList.remove('dr-hidden');
  }

  // ── Subtitle ───────────────────────────────────────────────────────────────
  const CHAR_COLOR = { SARA: '#f472b6', COLE: '#94a3b8', MAYA: '#a78bfa', DETECTIVE: '#d2ab4a', NARRATOR: 'rgba(255,255,255,0.35)' };
  let _lineAbort = false;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function showLine(speaker, text) {
    if (_mode === 'interrogation') return;
    $('dr-speaker').textContent  = speaker;
    $('dr-speaker').style.color  = CHAR_COLOR[speaker] || 'rgba(255,255,255,0.35)';
    $('dr-dialogue').textContent = text;
    $('dr-dialogue').classList.remove('typing');
  }

  function clearLine() {
    _lineAbort = true;
    $('dr-speaker').textContent = '';
    $('dr-dialogue').textContent = '';
    $('dr-dialogue').classList.remove('typing');
    if (_mode === 'interrogation') pauseInterviewVideo();
  }

  function estimateSpeechMs(text, audio_b64) {
    if (audio_b64) return (audio_b64.length * 0.75 / 16000) * 1000;
    const len = (text || '').trim().length;
    return Math.max(1800, len * 38);
  }

  async function typewriterDialogue(text, durationMs) {
    const el = $('dr-dialogue');
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    el.textContent = '';
    if (!clean) return;
    el.classList.add('typing');
    const delay = Math.max(14, Math.min(52, durationMs / clean.length));
    for (const ch of clean) {
      if (_lineAbort) break;
      el.textContent += ch;
      await sleep(delay);
    }
    el.classList.remove('typing');
  }

  function cleanSpokenReply(text) {
    let out = (text || '')
      .replace(/\*+[^*]*\*+/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\([^)]{1,48}\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[,.\s\-–—]+/, '')
      .trim();
    const parts = out.split(/(?<=[.!?])\s+/).filter(Boolean);
    const kept = parts.filter(p => !p.trim().endsWith('?'));
    if (kept.length) out = kept.join(' ').trim();
    else out = out.replace(/\?+\s*$/, '.');
    return out;
  }

  function playAudioAsync(b64) {
    return new Promise(resolve => playAudio(b64, resolve));
  }

  async function showSuspectReply(speaker, text, audio_b64) {
    _lineAbort = false;
    const spoken = cleanSpokenReply(text);
    if (_mode !== 'interrogation') {
      $('dr-speaker').textContent = speaker;
      $('dr-speaker').style.color = CHAR_COLOR[speaker] || 'rgba(255,255,255,0.35)';
      if (audio_b64) await playAudioAsync(audio_b64);
      else await typewriterDialogue(spoken, estimateSpeechMs(spoken, null) * 0.9);
      return;
    }
    clearLine();
    if (audio_b64) await playAudioAsync(audio_b64);
    else if (_lineAbort) return;
    if (_mode === 'interrogation' && speaker) recordInterviewReply(speaker, spoken);
  }

  async function applyQuestionMeta(data, text) {
    if (data?.cracks && data.cracks_status) setSuspectStatus(_suspect, data.cracks_status);
    if (data?.unlocks_evidence) {
      addEvidence({
        key: data.unlocks_evidence,
        label: data.unlocks_evidence.replace(/_/g, ' ').toUpperCase(),
        description: (text || '').substring(0, 120),
        source: `${_suspect} — Interview`,
        suspect: _suspect,
      });
      flashCaseBtn();
    }
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  function playAudio(b64, onEnded) {
    if (window.isSoundMuted?.()) {
      pauseInterviewVideo();
      window.duckBgMusic?.(false);
      if (onEnded) onEnded();
      return;
    }
    try {
      stopCurrentAudio();
      _lineAbort = false;
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const url   = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.volume = 1;
      _currentAudio = audio;
      if (_mode === 'interrogation') window.duckBgMusic?.(true);
      if (_mode === 'interrogation') playInterviewVideo();
      const finish = () => {
        URL.revokeObjectURL(url);
        if (_currentAudio === audio) _currentAudio = null;
        if (_pendingAudioDone === finish) _pendingAudioDone = null;
        if (_mode === 'interrogation') window.duckBgMusic?.(false);
        if (_mode === 'interrogation') pauseInterviewVideo();
        if (onEnded) onEnded();
      };
      _pendingAudioDone = finish;
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    } catch (e) { if (onEnded) onEnded(); }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getSuspectColor(suspect) {
    return { SARA: '#f472b6', MAYA: '#a78bfa', COLE: '#94a3b8' }[suspect] || '#d2ab4a';
  }

  function setSuspectStatus(suspect, status) {
    const el = document.querySelector(`[data-board-suspect="${suspect}"] .dr-portrait-status`);
    if (el) el.textContent = status;
    if (['ADMITTED', 'MOTIVE CONFIRMED', 'WITNESS', 'INCONSISTENT', 'COLE IDENTIFIED', 'COLE MOTIVE', 'OVERRIDE LOGGED', 'ON CCTV'].includes(status)) {
      document.querySelector(`[data-board-suspect="${suspect}"]`)?.classList.add('dr-cracked');
    }
  }

  function flashCaseBtn() {
    const btn = $('dr-casefile-btn');
    btn?.classList.add('dr-flash');
    setTimeout(() => btn?.classList.remove('dr-flash'), 700);
  }

  function getEvidence() { return [..._evidence]; }
  function hasEvidence(key) { return _evidence.some(evidence => evidence.key === key); }
  function hasRequiredEvidence(required) {
    if (!required) return true;
    const keys = Array.isArray(required) ? required : [required];
    return keys.every(hasEvidence);
  }
  function returnToCCTV() {
    show();
    setMode('board');
  }

  // ── ElevenLabs Speech Engine (Groq-powered live conversation) ────────────
  let _seConversation = null;   // active ElevenLabs Conversation instance
  let _seActive       = false;
  let _seCharacter    = null;

  async function startSpeechEngine(character) {
    if (_seActive || _seConversation) return;
    _seCharacter = character || _suspect || "SARA";
    const Conversation = window.ElevenLabsConversation ||
      window.ElevenLabsClient?.Conversation ||
      window["@11labs/client"]?.Conversation;
    if (!Conversation?.startSession) {
      console.error("[Speech Engine] ElevenLabs browser SDK not loaded");
      _setSEStatus("error");
      showLine("DETECTIVE", "Live voice is still loading. Try again in a moment.");
      return;
    }

    _setSEStatus("connecting");
    try {
      stopCurrentAudio();
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach(track => track.stop());
      const response = await fetch(`/api/speech-engine/token?character=${encodeURIComponent(_seCharacter)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Speech Engine token request failed.");
      _seConversation = await Conversation.startSession({
        conversationToken: data.conversation_token,
        connectionType: "webrtc",
        onConnect: () => {
          _seActive = true;
          _setSEStatus("live");
          showLine("DETECTIVE", `Speech Engine live — ask ${_seCharacter} anything.`);
        },
        onDisconnect: () => {
          _seActive = false;
          _seConversation = null;
          _seSpeaking = false;
          pauseInterviewVideo();
          _setSEStatus("idle");
          syncInterviewControls();
        },
        onError: error => {
          console.error("[Speech Engine]", error);
          _seActive = false;
          _seConversation = null;
          _setSEStatus("error");
          showLine("DETECTIVE", "Speech Engine connection failed. Check ELEVENLABS_API_KEY and Speech Engine IDs.");
        },
        onMessage: (message) => {
          const role = message?.source || message?.role || message?.type || "";
          const text = (message?.message || message?.text || "").trim();
          if (!text) return;
          const isAgent = role === "ai" || role === "agent" || role === "assistant";
          if (isAgent) recordInterviewReply(_suspect, text);
        },
        onModeChange: mode => {
          const speaking = mode.mode === "speaking";
          _seSpeaking = speaking;
          _setSEStatus(speaking ? "speaking" : "live");
          syncInterviewControls();
          if (speaking) playInterviewVideo();
          else pauseInterviewVideo();
        },
      });
    } catch (e) {
      console.error("[Speech Engine] Could not begin session:", e);
      _seConversation = null;
      _setSEStatus("error");
      const reason = e?.message?.includes("Permission") ? "Microphone permission is required for a live interview." : e.message;
      showLine("DETECTIVE", reason || "Live interview is unavailable.");
    }
  }

  async function stopSpeechEngine() {
    if (_seConversation) {
      await _seConversation.endSession().catch(() => {});
      _seConversation = null;
    }
    _seActive = false;
    _seSpeaking = false;
    _setSEStatus("idle");
    syncInterviewControls();
  }

  function _setSEStatus(status) {
    const btn = $('dr-se-btn');
    if (!btn) return;
    const name = _seCharacter || _suspect || "SARA";
    const labels = {
      idle: `LIVE VOICE — ${name}`,
      connecting: "CONNECTING SPEECH ENGINE…",
      live: `LIVE WITH ${name} — END CALL`,
      speaking: `${name} SPEAKING — END CALL`,
      error: `RETRY SPEECH ENGINE`,
    };
    btn.textContent  = labels[status] || status;
    btn.dataset.status = status;
    btn.disabled     = status === "connecting";
  }

  function toggleSpeechEngine(character) {
    if (_seActive || _seConversation) stopSpeechEngine();
    else {
      stopCurrentAudio();
      startSpeechEngine(character);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    // Drag listeners
    document.addEventListener('mousemove', e => { if (_dragging) moveDragging(e.clientX, e.clientY); });
    document.addEventListener('mouseup',   () => stopDragging());
    document.addEventListener('touchmove', e => { if (_dragging) { const t = e.touches[0]; moveDragging(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
    document.addEventListener('touchend',  () => stopDragging());

    // Portrait click handlers
    document.querySelectorAll('[data-board-suspect]').forEach(el => el.addEventListener('click', onPortraitClick));

    // Case file
    $('dr-casefile-btn')?.addEventListener('click', openCaseFile);
    $('dr-cf-close')?.addEventListener('click', () => $('dr-casefile-panel').classList.add('dr-hidden'));

  }

  return { show, hide, reset, startInterrogation, addEvidence, getEvidence, hasEvidence, returnToCCTV, startSpeechEngine, stopSpeechEngine, stopInterviewMedia, stopCurrentAudio, getInterviewLog, init };
})();

window.DR = DR;
document.addEventListener('DOMContentLoaded', DR.init);
