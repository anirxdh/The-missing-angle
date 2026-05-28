/* The Missing Angle - interactive murder investigation
   The player collects evidence, interrogates suspects, and names the killer. */

const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${WS_PROTO}://${location.host}/ws/game`;
const PREFER_HTTP_GAME = location.hostname.includes("vercel.app");
const PUZZLE_SLUG = (location.pathname.match(/^\/puzzles\/([^/?#]+)/)?.[1] || "").toLowerCase();

const CHAR_COLOR = { SARA: "#f472b6", COLE: "#94a3b8", MAYA: "#a78bfa", DANIEL: "#d6c2a1", DETECTIVE: "#d2ab4a" };

const ENDINGS = {
  accuse_sara:     { name: "THE WRONG THREAD",         desc: "Sara's thread proves contact, not murder. Adrian Cole walks free." },
  accuse_maya:     { name: "THE WRONG MOTIVE",         desc: "Maya chased a recording. Adrian Cole erased the fatal minutes and walks free." },
  killer_revealed: { name: "CASE CLOSED", desc: "COLE BLACKMAILED TENANTS WITH DOCTORED FOOTAGE. DANIEL FOUND OUT. COLE CUT THE FEED AND KILLED HIM." },
  alone:           { name: "CASE UNSOLVED",            desc: "The evidence was not carried through to an accusation." },
};

const SCENE_VIDEO_FILES = {
  intro_party: "intro-party",
  cctv_review: "cctv",
  truth_reveal_cole: "ending",
};

function sceneVideoUrl(atmosphere){
  const file = SCENE_VIDEO_FILES[atmosphere] || atmosphere || "default";
  return `/static/scenes/${file}.mp4?v=5`;
}

// ── Background music ──────────────────────────────────────────────────────
const bgMusic       = new Audio();
bgMusic.loop        = true;
bgMusic.volume      = 0;
let bgMusicAtm      = null;
let bgMusicReady    = false;

const trailerMusic  = new Audio();
trailerMusic.loop   = true;
trailerMusic.volume = 0;

function stopSceneMusic(){
  bgMusicAtm = null;
  return _fadeMusic(0).then(()=>{
    bgMusic.pause();
  }).catch(()=>{
    bgMusic.pause();
  });
}

async function setSceneMusic(atmosphere){
  if(!bgMusicReady || bgMusicAtm === atmosphere) return;
  const url = `/static/music/${atmosphere}.mp3`;
  try {
    const r = await fetch(url, {method:"HEAD"});
    if(!r.ok) return;
    bgMusicAtm = atmosphere;
    await _fadeMusic(0);
    bgMusic.src = url;
    bgMusic.load();
    if(!soundMuted){
      bgMusic.play().catch(()=>{});
      _fadeMusic(0.22);
    }
  } catch(e){}
}

function startSceneMusicFromClick(atmosphere){
  bgMusicAtm = atmosphere;
  bgMusic.src = `/static/music/${atmosphere}.mp3`;
  bgMusic.loop = true;
  bgMusic.muted = false;
  bgMusic.volume = soundMuted ? 0 : 0.22;
  bgMusic.load();
  if(!soundMuted) bgMusic.play().catch(e=> console.error("scene music play:", e));
}

function _fadeMusic(target){
  if(soundMuted) target = 0;
  return new Promise(resolve=>{
    const step = ()=>{
      const diff = target - bgMusic.volume;
      if(Math.abs(diff) < 0.01){ bgMusic.volume = target; return resolve(); }
      bgMusic.volume += diff > 0 ? 0.012 : -0.012;
      setTimeout(step, 40);
    };
    step();
  });
}

// Called by detective-room when a character speaks — ducks music while they talk
const BG_MUSIC_FULL = 0.22;
const BG_MUSIC_DUCK = 0.04;
window.duckBgMusic  = (duck) => _fadeMusic(duck ? BG_MUSIC_DUCK : BG_MUSIC_FULL);

let soundMuted = false;

window.isSoundMuted = () => soundMuted;

function syncSoundToggleUI(){
  const btn = document.getElementById("sound-toggle");
  const label = document.getElementById("sound-toggle-label");
  if(!btn) return;
  btn.setAttribute("aria-pressed", soundMuted ? "true" : "false");
  btn.classList.toggle("is-muted", soundMuted);
  if(label) label.textContent = soundMuted ? "SOUND OFF" : "SOUND ON";
}

function setSoundMuted(muted){
  soundMuted = muted;
  if(soundMuted){
    if(_currentAudio){ _currentAudio.pause(); _currentAudio = null; }
    bgMusic.volume = 0;
    trailerMusic.volume = 0;
    trailerMusic.pause();
    window.DR?.stopCurrentAudio?.();
  } else if(bgMusicAtm && bgMusic.src){
    bgMusic.volume = BG_MUSIC_FULL;
    bgMusic.play().catch(()=>{});
  }
  syncSoundToggleUI();
}

function playTrailerMusic(url){
  if(!url) return Promise.resolve();
  if(soundMuted) return Promise.resolve();
  if(trailerMusic.src.endsWith(url) && !trailerMusic.paused) return Promise.resolve();
  return new Promise(resolve=>{
    trailerMusic.pause();
    trailerMusic.src = url;
    trailerMusic.loop = true;
    trailerMusic.muted = false;
    trailerMusic.volume = 0.45;
    trailerMusic.oncanplay = resolve;
    trailerMusic.onerror = resolve;
    trailerMusic.load();
    trailerMusic.play().then(resolve).catch(resolve);
    setTimeout(resolve, 900);
  });
}

function stopTrailerMusic(){
  trailerMusic.pause();
  trailerMusic.removeAttribute("src");
  trailerMusic.load();
  trailerMusic.volume = 0;
}

// ── State ─────────────────────────────────────────────────────────────────
let ws              = null;
let useHttpGame     = false;
let httpSessionId   = null;
let httpAdvanceTimer = null;
let pendingHttpAutoAdvance = null;
let currentScene    = null;
let pendingQ        = null;
let hasPaused       = false;
let activeSlot      = "a";
let pauseTimer      = null;
let narrationDone   = false;
let sceneStartedAt  = 0;
let sceneVisualReady = false;
let queuedMessages  = [];
let queuedSceneStart = null;
let isRecording     = false;
let mediaRecorder   = null;
let audioChunks     = [];
let audioCtx        = null;   // single persistent AudioContext, unlocked on splash click
let audioUnlocked   = false;
let trailerPlaying  = false;
let _currentAudio   = null;
let drAdvancePending = false;
let rooftopVisitActive = false;
let rooftopScreenOpen = false;
let queuedAfterRooftopScene = null;
let queuedAfterRooftopSetup = null;
let directRooftopStart = false;
let suppressInitialAutoAdvance = false;
let reconstruction = null;
let _wbHeardKeys = new Set();
let activePuzzleSlug = "";
let pendingWhiteboardAccusation = null;

// ── DOM ───────────────────────────────────────────────────────────────────
const sceneBg        = document.getElementById("scene-bg");
const vidA           = document.getElementById("scene-video-a");
const vidB           = document.getElementById("scene-video-b");
const sceneCanvas    = document.getElementById("scene-canvas");
const subtitleText   = document.getElementById("subtitle-text");
const charLabel      = document.getElementById("character-label");
const transOverlay   = document.getElementById("scene-transition");
const sceneLoading   = document.getElementById("scene-loading");
const sceneLoadingTitle = document.getElementById("scene-loading-title");
const sceneLoadingDetail = document.getElementById("scene-loading-detail");
const sceneLoadingFill = document.getElementById("scene-loading-fill");
const sceneLoadingBar = sceneLoading?.querySelector(".scene-loading-bar");
const endingScreen   = document.getElementById("ending-screen");
const storyCard      = document.getElementById("story-card");
const storyCardKicker = document.getElementById("story-card-kicker");
const storyCardTitle = document.getElementById("story-card-title");
const storyCardBeats = document.getElementById("story-card-beats");
const storyCardCta   = document.getElementById("story-card-cta");
const choiceOverlay  = document.getElementById("choice-overlay");
const choiceBtnA     = document.getElementById("choice-a");
const choiceBtnB     = document.getElementById("choice-b");
const choiceBtnC     = document.getElementById("choice-c");
const choiceButtons  = [choiceBtnA, choiceBtnB, choiceBtnC].filter(Boolean);
const voiceChoiceBtn = document.getElementById("voice-choice-btn");
const choiceHint     = document.getElementById("choice-hint");
const splash         = document.getElementById("splash");
const trailerBtn     = document.getElementById("trailer-btn");

const VALID_PUZZLE_SLUGS = new Set(["rooftop", "sara", "maya", "cole", "audio"]);
const trailerVideo   = document.getElementById("trailer-video");
const trailerExitBtn    = document.getElementById("trailer-exit-btn");
const trailerTitleCard  = document.getElementById("trailer-title-card");
const ttcEyebrow        = document.getElementById("ttc-eyebrow");
const ttcTitle          = document.getElementById("ttc-title");
const ttcSub            = document.getElementById("ttc-sub");
const audioScene        = document.getElementById("ar-scene");
const puzzleNav         = document.getElementById("puzzle-nav");
const puzzleRetry       = document.getElementById("puzzle-retry");
const puzzleBack        = document.getElementById("puzzle-back");
const arFragmentList    = document.getElementById("ar-fragment-list");
const arProgress        = document.getElementById("ar-progress");
const arResult          = document.getElementById("ar-result");
const arContinue        = document.getElementById("ar-continue");

// ── Canvas particles ──────────────────────────────────────────────────────
const ctx2d = sceneCanvas.getContext("2d");
function resizeCanvas(){ sceneCanvas.width=innerWidth; sceneCanvas.height=innerHeight; }
window.addEventListener("resize", resizeCanvas); resizeCanvas();
window.addEventListener("resize", () => { if(audioScene && !audioScene.classList.contains("ar-hidden")) _drawWbStrings(); });

let particles=[]; let pfx={ n:20, rgb:"100,100,130" };
class P { constructor(){ this.r(); }
  r(){ this.x=Math.random()*sceneCanvas.width; this.y=Math.random()*sceneCanvas.height;
       this.s=Math.random()*1.2+0.3; this.vx=(Math.random()-.5)*.15;
       this.vy=-(Math.random()*.3+.03); this.a=Math.random()*.4+.06; }
  upd(){ this.x+=this.vx; this.y+=this.vy;
    if(this.y<-4||this.x<-4||this.x>sceneCanvas.width+4) this.r(); } }
function initFx(){ particles=Array.from({length:pfx.n},()=>new P()); }
initFx();
(function loop(){
  ctx2d.clearRect(0,0,sceneCanvas.width,sceneCanvas.height);
  particles.forEach(p=>{ p.upd();
    ctx2d.beginPath(); ctx2d.arc(p.x,p.y,p.s,0,Math.PI*2);
    ctx2d.fillStyle=`rgba(${pfx.rgb},${p.a})`; ctx2d.fill(); });
  requestAnimationFrame(loop);
})();

// ── WebSocket (local) / HTTP batch (Vercel) ─────────────────────────────────
function connect(){
  if(PREFER_HTTP_GAME || useHttpGame){ useHttpGame = true; httpStart(); return; }

  ws = new WebSocket(WS_URL);
  const fallback = setTimeout(()=>{
    if(ws?.readyState !== WebSocket.OPEN){
      useHttpGame = true;
      try{ ws.close(); }catch(e){}
      ws = null;
      httpStart();
    }
  }, 2500);

  ws.onopen = ()=> clearTimeout(fallback);
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onerror = ()=>{};
  ws.onclose = ()=>{
    clearTimeout(fallback);
    if(!useHttpGame) setTimeout(connect, 2000);
  };
}

function scheduleHttpAutoAdvance(){
  if(!pendingHttpAutoAdvance) return;
  if(currentScene?.has_narration && !narrationDone) return;
  if(httpAdvanceTimer){ clearTimeout(httpAdvanceTimer); httpAdvanceTimer = null; }
  const delay = currentScene?.has_narration
    ? 1500
    : (pendingHttpAutoAdvance.delay_ms || 3000);
  httpAdvanceTimer = setTimeout(()=>{
    pendingHttpAutoAdvance = null;
    httpAdvance();
  }, delay);
}

function dispatchHttp(data){
  httpSessionId = data.session_id || httpSessionId;
  (data.messages || []).forEach(handle);
  if(httpAdvanceTimer){ clearTimeout(httpAdvanceTimer); httpAdvanceTimer = null; }
  if(data.auto_advance){
    if(suppressInitialAutoAdvance){
      suppressInitialAutoAdvance = false;
      return;
    }
    pendingHttpAutoAdvance = data.auto_advance;
    scheduleHttpAutoAdvance();
  }
}

async function httpStart(){
  try{
    const r = await fetch("/api/game/session", {method:"POST"});
    if(!r.ok) throw new Error(await r.text());
    dispatchHttp(await r.json());
  }catch(e){
    console.error("http game start:", e);
  }
}

async function httpAdvance(){
  if(!httpSessionId) return;
  try{
    const r = await fetch("/api/game/advance", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({session_id: httpSessionId, scene_id: currentScene?.id || ""}),
    });
    if(!r.ok) throw new Error(await r.text());
    dispatchHttp(await r.json());
  }catch(e){
    console.error("http game advance:", e);
  }
}

function send(obj){
  if(useHttpGame){
    if(obj.type === "text_input" && obj.branch_key){
      fetch("/api/game/choice", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          session_id: httpSessionId,
          branch_key: obj.branch_key,
          text: obj.text || "",
          scene_id: currentScene?.id || "",
        }),
      }).then(r=>r.json()).then(dispatchHttp).catch(e=>console.error(e));
    }else if(obj.type === "restart"){
      fetch("/api/game/restart", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({session_id: httpSessionId}),
      }).then(r=>r.json()).then(dispatchHttp).catch(e=>console.error(e));
    }
    return;
  }
  if(ws?.readyState===1) ws.send(JSON.stringify(obj));
}

function sendBlob(b){
  if(useHttpGame && httpSessionId){
    const fd = new FormData();
    fd.append("session_id", httpSessionId);
    fd.append("scene_id", currentScene?.id || "");
    fd.append("file", b, "choice.webm");
    fetch("/api/game/voice", {method:"POST", body: fd})
      .then(r=>r.json()).then(dispatchHttp).catch(e=>console.error(e));
    return;
  }
  if(ws?.readyState===1) ws.send(b);
}

// ── Message router ────────────────────────────────────────────────────────
function handle(msg){
  switch(msg.type){
    case "scene_start":              onSceneStart(msg.scene);          break;
    case "scene_narration":          runWhenVisualReady(msg);          break;
    case "scene_question":           runWhenVisualReady(msg);          break;
    case "scene_question_audio":     onSceneQuestionAudio(msg);        break;
    case "scene_investigation_setup": onInvestigationSetup(msg);       break;
    case "scene_interrogation_setup": onInterrogationSetup(msg);       break;
    case "scene_audio_reconstruction_setup": onAudioReconstructionSetup(msg); break;
    case "interrogation_answer":     onInterrogationAnswer(msg);       break;
    case "transcript":               showChoiceHint(`heard: ${msg.text}`); break;
    case "voice_no_match":           showChoiceHint("say Sara, Maya, or Cole"); break;
    case "ending":                   triggerEnding(msg.scene);         break;
  }
}

// ── Pending interrogation answer callback ─────────────────────────────────
let _pendingAnswerCb = null;

function onInterrogationAnswer(msg){
  if(_pendingAnswerCb){ _pendingAnswerCb(msg); _pendingAnswerCb = null; }
}

function onInvestigationSetup(msg){
  clearSubtitle();
  window.RI?.showBrief?.(msg.guide_text || "");
}

function onInterrogationSetup(msg){
  if(rooftopVisitActive && msg.id === "sara_interview_1"){
    queuedAfterRooftopSetup = msg;
    return;
  }
  DR.startInterrogation(msg, () => drAdvance());
}

function hideAudioReconstruction(){
  audioScene?.classList.add("ar-hidden");
  audioScene?.setAttribute("aria-hidden", "true");
}

function showPuzzleNav(slug){
  activePuzzleSlug = slug || activePuzzleSlug || "";
  puzzleNav?.classList.toggle("hidden", !activePuzzleSlug);
}

function hidePuzzleNav(){
  activePuzzleSlug = "";
  puzzleNav?.classList.add("hidden");
}

function puzzleSlugForScene(scene){
  if(!scene) return "";
  if(scene.type === "investigation3d" || scene.id === "rooftop_investigation") return "rooftop";
  if(scene.type === "audio_reconstruction" || scene.id === "audio_reconstruction") return "audio";
  if(scene.id?.startsWith("sara_interview")) return "sara";
  if(scene.id?.startsWith("maya_interview")) return "maya";
  if(scene.id?.startsWith("cole_interview")) return "cole";
  return "";
}

function setPuzzleUrl(slug, replace = false){
  if(!slug || !history?.pushState) return;
  const next = `/puzzles/${slug}`;
  if(location.pathname === next) return;
  const action = replace ? "replaceState" : "pushState";
  history[action]({}, "", next);
}

function stopActivePuzzleMedia(){
  if(_currentAudio){ _currentAudio.pause(); _currentAudio = null; }
  bgMusic.pause();
  window.RI?.hide();
  DR.hide();
  hideAudioReconstruction();
  hideChoices();
  clearSubtitle();
  if(pauseTimer){ clearTimeout(pauseTimer); pauseTimer = null; }
  if(httpAdvanceTimer){ clearTimeout(httpAdvanceTimer); httpAdvanceTimer = null; }
  pendingHttpAutoAdvance = null;
  queuedSceneStart = null;
}

function resetPuzzleState(){
  stopActivePuzzleMedia();
  DR.reset();
  window.RI?.reset();
  _wbHeardKeys = new Set();
  pendingWhiteboardAccusation = null;
  queuedAfterRooftopScene = null;
  queuedAfterRooftopSetup = null;
  directRooftopStart = false;
  rooftopVisitActive = false;
  rooftopScreenOpen = false;
  suppressInitialAutoAdvance = false;
  drAdvancePending = false;
}

function backToMenu(){
  resetPuzzleState();
  hidePuzzleNav();
  location.assign("/");
}

async function retryCurrentPuzzle(){
  const slug = activePuzzleSlug || PUZZLE_SLUG;
  if(!slug) return;
  resetPuzzleState();
  await startPuzzle(slug, { replaceUrl: true });
}

async function startPuzzle(slug, options = {}){
  if(!VALID_PUZZLE_SLUGS.has(slug)) return false;
  showPuzzleNav(slug);
  setPuzzleUrl(slug, Boolean(options.replaceUrl));

  if(slug === "rooftop"){
    await startRooftopPuzzle();
    return true;
  }

  const sceneMap = {
    sara:  ["sara_interview_1", "sara_video_call"],
    maya:  ["maya_interview_1", "maya_video_call"],
    cole:  ["cole_interview_1", "cctv_review"],
    audio: ["audio_reconstruction", "cctv_review"],
  };
  const target = sceneMap[slug];
  if(!target) return false;
  await splashJump(target[0], target[1], slug);
  return true;
}

async function startRooftopPuzzle(){
  unlockAudioContext();
  stopTrailerMusic();
  startSceneMusicFromClick("rooftop_establishing");
  directRooftopStart = true;
  suppressInitialAutoAdvance = true;
  rooftopVisitActive = true;
  rooftopScreenOpen = true;
  splash?.classList.add("hidden");
  setTimeout(()=> splash?.remove(), 900);
  onSceneStart(rooftopPlaceholderScene());
  connect();
}

puzzleRetry?.addEventListener("click", retryCurrentPuzzle);
puzzleBack?.addEventListener("click", backToMenu);

document.getElementById("sound-toggle")?.addEventListener("click", () => {
  setSoundMuted(!soundMuted);
});
syncSoundToggleUI();

function onAudioReconstructionSetup(msg){
  if(msg.id && msg.id !== "audio_reconstruction") return;
  if(currentScene?.id && currentScene.id !== "audio_reconstruction") return;
  reconstruction = msg;
  _wbHeardKeys = new Set();
  if(!audioScene) return;
  audioScene.classList.remove("ar-hidden");
  audioScene.setAttribute("aria-hidden", "false");
  if(arResult) { arResult.textContent = ""; arResult.classList.remove("wb-result-revealed"); }
  arContinue?.classList.add("ar-hidden");
  document.querySelector(".wb-choice-panel")?.classList.add("ar-hidden");
  if(arProgress) arProgress.textContent = `WHITEBOARD READY`;
  renderWhiteboardBrief(msg);
  renderAudioReconstruction();
  _drawWbStrings();
}

function renderWhiteboardBrief(msg){
  const closing = document.getElementById("wb-closing");
  if(closing){
    closing.textContent = msg.closing_text ||
      "We've reached the end of the investigation. The evidence you collected is on the left.";
  }
  const insights = msg.witness_insights || {};
  const map = { sara: "SARA", maya: "MAYA", cole: "COLE" };
  Object.entries(map).forEach(([person, key]) => {
    const el = document.querySelector(`[data-insight="${person}"]`);
    if(!el) return;
    el.textContent = insights[key] || "No interview notes recorded for this witness.";
  });
}

function renderAudioReconstruction(){
  if(!reconstruction || !arFragmentList) return;
  arFragmentList.textContent = "";

  reconstruction.fragments.forEach(fragment => {
    const heard = _wbHeardKeys.has(fragment.key);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-frag-btn" + (heard ? " wb-frag-heard" : "");
    btn.dataset.key = fragment.key;
    btn.innerHTML = `<span class="wb-frag-icon">${heard ? "✓" : "▶"}</span><span class="wb-frag-label">${fragment.label}</span><span class="wb-frag-speaker">${fragment.speaker}</span>`;
    btn.addEventListener("click", () => {
      showLine(fragment.speaker, fragment.text);
      playVoice(fragment.text, fragment.audio_b64, fragment.voice_character || fragment.speaker);
      _wbHeardKeys.add(fragment.key);
      btn.classList.add("wb-frag-heard");
      btn.querySelector(".wb-frag-icon").textContent = "✓";
      if(arProgress) arProgress.textContent = `${_wbHeardKeys.size} / ${reconstruction.fragments.length} AUDIO MARKERS PLAYED`;
      _drawWbStrings();
      if(_wbHeardKeys.has("unknown_man") || _wbHeardKeys.has("missing_interval")) _revealWhiteboardConclusion(true);
    });
    arFragmentList.appendChild(btn);
  });
}

function _revealWhiteboardConclusion(playResolution){
  if(!reconstruction) return;
  if(arResult && !arResult.classList.contains("wb-result-revealed")){
    arResult.classList.add("wb-result-revealed");
    arResult.textContent = reconstruction.resolution || "All fragments recovered.";
    document.querySelector(".wb-choice-panel")?.classList.remove("ar-hidden");
  }
}

function _drawWbStrings(){
  const svg = document.getElementById("wb-strings");
  if(!svg) return;
  svg.innerHTML = "";
  const board = svg.closest(".wb-board");
  if(!board) return;
  const boardRect = board.getBoundingClientRect();

  function centre(el){
    if(!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - boardRect.left + r.width/2, y: r.top - boardRect.top + r.height/2 };
  }

  // Reset person highlights
  board.querySelectorAll(".wb-person-card").forEach(c => c.classList.remove("wb-person-lit"));

  // Each entry: which audio key activates the string, evidence → person
  const CONNECTIONS = [
    { ev: "phone",  person: "maya", key: "couple_reveal",    cls: "wb-string-warm" },
    { ev: "phone",  person: "sara", key: "sara_helping",     cls: "wb-string-warm" },
    { ev: "camera", person: "cole", key: "unknown_man",      cls: "wb-string-hot"  },
    { ev: "phone",  person: "cole", key: "unknown_man",      cls: "wb-string-hot"  },
    { ev: "sd",     person: "cole", key: "missing_interval", cls: "wb-string-hot"  },
    { ev: "camera", person: "cole", key: "missing_interval", cls: "wb-string-hot"  },
  ];

  // Deduplicate same ev→person pair, prefer hot
  const drawn = new Map();
  CONNECTIONS.forEach(c => {
    if(!_wbHeardKeys.has(c.key)) return;
    const k = `${c.ev}-${c.person}`;
    if(!drawn.has(k) || c.cls === "wb-string-hot") drawn.set(k, c);
  });

  drawn.forEach(({ ev, person, cls }) => {
    const a = centre(board.querySelector(`[data-ev="${ev}"]`));
    const b = centre(board.querySelector(`[data-person="${person}"]`));
    if(!a || !b) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.setAttribute("class", `wb-string ${cls}`);
    svg.appendChild(line);
    board.querySelector(`[data-person="${person}"]`)?.classList.add("wb-person-lit");
  });
}

arContinue?.addEventListener("click", () => {
  hideAudioReconstruction();
  drAdvance("audio_reconstruction");
});

document.querySelectorAll(".wb-choice").forEach(button => {
  button.addEventListener("click", () => {
    pendingWhiteboardAccusation = button.dataset.accuse;
    hideAudioReconstruction();
    drAdvance("audio_reconstruction");
  });
});

async function drAdvance(sceneId = currentScene?.id || ""){
  if(drAdvancePending) return;
  drAdvancePending = true;
  const payload = { scene_id: sceneId };
  if(currentScene?.type === "interrogation" && window.DR?.getInterviewLog){
    payload.interview_log = window.DR.getInterviewLog();
  }
  if(useHttpGame){
    try{
      const r = await fetch("/api/game/scene_done", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({session_id: httpSessionId, ...payload}),
      });
      if(!r.ok) throw new Error(await r.text());
      dispatchHttp(await r.json());
    }catch(e){ console.error("dr advance:", e); }
    finally { drAdvancePending = false; }
    return;
  }
  if(ws?.readyState===1) {
    ws.send(JSON.stringify({type:"scene_done", ...payload}));
    setTimeout(() => { drAdvancePending = false; }, 700);
  } else {
    drAdvancePending = false;
    showChoiceHint("Connection lost. Refresh to continue.");
  }
}

// Wire up DR server callbacks
window.DR_inspect = (hotspotKey, cb) => {
  _pendingAnswerCb = cb;
  _drInterrogate({type:"hotspot", key: hotspotKey}, cb);
};

window.DR_ask = (questionKey, cb) => {
  _pendingAnswerCb = cb;
  _drInterrogate({type:"ask", key: questionKey}, cb);
};
window.DR_evidence = (evidenceKey, cb) => {
  _pendingAnswerCb = cb;
  _drInterrogate({type:"evidence", key: evidenceKey}, cb);
};

async function _drInterrogate(params, cb){
  let sceneId = currentScene?.id || "";
  const riRoot = document.getElementById("ri-scene");
  if(
    params.type === "hotspot"
    && riRoot
    && !riRoot.classList.contains("ri-hidden")
  ){
    sceneId = "rooftop_investigation";
  }
  if(useHttpGame){
    try{
      const r = await fetch("/api/game/interrogate", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({session_id: httpSessionId, scene_id: sceneId, ...params}),
      });
      if(!r.ok) throw new Error(await r.text());
      cb(await r.json());
    }catch(e){ console.error("dr interrogate:", e); cb({}); }
    return;
  }
  if(ws?.readyState===1){
    ws.send(JSON.stringify({type:"dr_interrogate", action:params.type, key:params.key, scene_id: sceneId}));
    // answer arrives via interrogation_answer message → _pendingAnswerCb
  }
}

// ── Scene start ───────────────────────────────────────────────────────────
function onSceneStart(scene){
  if(directRooftopStart && rooftopVisitActive && (scene.id === "crime_scene" || scene.id === "cctv_landing")){
    return;
  }
  if(rooftopVisitActive && scene.id === "sara_interview_1"){
    queuedAfterRooftopScene = scene;
    return;
  }
  if(rooftopVisitActive && !rooftopScreenOpen && scene.id === "rooftop_investigation"){
    return;
  }
  if(!narrationDone && currentScene?.has_narration && currentScene?.auto_advance){
    queuedSceneStart = scene;
    return;
  }
  drAdvancePending = false;
  if(!currentScene?.auto_advance && _currentAudio){ _currentAudio.pause(); _currentAudio = null; }
  _narrationAbort = true;
  currentScene = scene;

  // Always tear down the evidence whiteboard unless this scene is the whiteboard.
  const sceneType = scene.type || "video";
  if(sceneType !== "audio_reconstruction" && scene.id !== "audio_reconstruction"){
    hideAudioReconstruction();
  }

  // Rooftop chapter ends once CCTV or interviews begin.
  if(scene.id === "cctv_landing" || scene.id?.startsWith("sara_interview") || scene.id?.startsWith("maya_interview") || scene.id?.startsWith("cole_interview")){
    rooftopVisitActive = false;
    rooftopScreenOpen = false;
    directRooftopStart = false;
  }

  if(scene.id !== "crime_scene") hideStoryCard();
  if(scene.id === "case_decision" && pendingWhiteboardAccusation){
    const branch = pendingWhiteboardAccusation;
    pendingWhiteboardAccusation = null;
    setTimeout(() => send({type:"text_input", text: branch.replace("accuse_", "accuse "), branch_key: branch}), 250);
  }
  const puzzleSlug = puzzleSlugForScene(scene);
  if(puzzleSlug && sceneType !== "interrogation") showPuzzleNav(puzzleSlug);
  else hidePuzzleNav();
  sceneStartedAt = 0;
  sceneVisualReady = false;
  queuedMessages = [];
  hasPaused    = false;
  pendingQ     = null;
  narrationDone = !scene.has_narration;

  clearSubtitle();
  hideChoices();

  if(pauseTimer){ clearTimeout(pauseTimer); pauseTimer=null; }

  window.RI?.hide();

  if(sceneType === "audio_reconstruction"){
    DR.stopInterviewMedia?.();
    DR.hide();
    audioScene?.classList.remove("ar-hidden");
    audioScene?.setAttribute("aria-hidden", "false");
    stopTrailerMusic();
    setSceneMusic(scene.atmosphere || "cctv_review");
    return;
  }

  // Detective room scenes: DR module handles UI; video layer hidden
  if(sceneType === "interrogation"){
    DR.show();
    stopTrailerMusic();
    stopSceneMusic();
    return;
  }

  if(sceneType === "investigation3d"){
    hideSceneLoading();
    DR.hide();
    _narrationAbort = true;
    if(_currentAudio){ _currentAudio.pause(); _currentAudio = null; }
    clearSubtitle();
    stopTrailerMusic();
    setSceneMusic(scene.atmosphere || "rooftop_establishing");
    const investigationRoot = document.getElementById("ri-scene");
    investigationRoot?.classList.remove("ri-hidden");
    investigationRoot?.setAttribute("aria-hidden", "false");
    activateInvestigation(scene);
    return;
  }

  // Regular video scene: hide detective room, show cinematic layers
  DR.hide();
  const atm = scene.atmosphere || "default";
  const shouldLoop = scene.has_narration || !scene.auto_advance;
  if(scene.still_image) showSceneStill(scene.still_image);
  else crossfadeVideo(sceneVideoUrl(atm), shouldLoop, {
    autoplay: !scene.has_narration,
    waitForNarration: Boolean(scene.has_narration),
  });

  stopTrailerMusic();
  setSceneMusic(atm);
}

function rooftopPlaceholderScene(){
  return {
    id: "rooftop_investigation",
    title: "Morning Return - Three Clues",
    type: "investigation3d",
    atmosphere: "rooftop_establishing",
    advance_after: "cctv_landing",
  };
}

function activateInvestigation(scene, attempt = 0){
  if(currentScene?.id !== scene.id) return;
  if(window.RI){
    window.RI.activate(scene, finishRooftopInvestigation, returnToCCTVReview);
    return;
  }
  if(attempt < 16){
    setTimeout(() => activateInvestigation(scene, attempt + 1), 50);
  } else {
    const status = document.getElementById("ri-load-status");
    if(status) status.textContent = "ROOFTOP RENDERER DID NOT LOAD - RESTART AND REFRESH";
    console.error("Rooftop investigation module did not load.");
  }
}

function returnToCCTVReview(){
  rooftopScreenOpen = false;
  window.RI?.hide();
  DR.returnToCCTV();
}

function finishRooftopInvestigation(){
  directRooftopStart = false;
  rooftopScreenOpen = false;
  rooftopVisitActive = false;
  if(queuedAfterRooftopScene){
    const scene = queuedAfterRooftopScene;
    const setup = queuedAfterRooftopSetup;
    queuedAfterRooftopScene = null;
    queuedAfterRooftopSetup = null;
    onSceneStart(scene);
    if(setup) onInterrogationSetup(setup);
    return;
  }
  drAdvance();
}

function runWhenVisualReady(msg){
  if(!sceneVisualReady){
    queuedMessages.push(msg);
    return;
  }
  handleSceneTimedMessage(msg);
}

function flushQueuedMessages(){
  const pending = queuedMessages.splice(0);
  pending.forEach(handleSceneTimedMessage);
}

function handleSceneTimedMessage(msg){
  switch(msg.type){
    case "scene_narration": onSceneNarration(msg); break;
    case "scene_question":  onSceneQuestion(msg);  break;
  }
}

// ── Narration — typewriter, one line at a time, follows the voice ─────────
let _narrationAbort = false;

async function onSceneNarration(msg){
  _narrationAbort = false;
  hideSceneLoading();
  charLabel.textContent = "";
  subtitleText.classList.add("narration");

  const video = activeVid();
  if(video){
    try {
      video.currentTime = 0;
      muteSceneVideo(video);
      await video.play();
      sceneStartedAt = performance.now();
    } catch(e){}
  }

  animateNarration(msg.text, msg.audio_b64);
  await playVoice(msg.text, msg.audio_b64, "NARRATOR");

  _narrationAbort = true;
  subtitleText.style.opacity = "0";
  subtitleText.classList.remove("narration", "typing");
  await sleep(40);
  subtitleText.textContent = "";
  subtitleText.style.opacity = "1";

  narrationDone = true;
  if(currentScene?.story_card){
    pendingHttpAutoAdvance = null;
    if(httpAdvanceTimer){ clearTimeout(httpAdvanceTimer); httpAdvanceTimer = null; }
    showStoryCard(currentScene.story_card);
    return;
  }
  if(pendingHttpAutoAdvance) scheduleHttpAutoAdvance();
  if(pendingQ) schedulePause(pendingQ.pause_at || 6);
  if(queuedSceneStart){
    const nextScene = queuedSceneStart;
    queuedSceneStart = null;
    onSceneStart(nextScene);
  }
}

async function animateNarration(text, audio_b64){
  const displayText = cleanSpeechText(text);
  // Estimate total audio duration from MP3 base64 size (128 kbps → 16000 B/s)
  const totalMs = audio_b64
    ? (audio_b64.length * 0.75 / 16000) * 1000
    : voiceDuration(displayText, "NARRATOR");

  // Split at sentence boundaries — keeps punctuation with the phrase
  const phrases = displayText
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/\.\.\.\s*/g, "...\n")
    .replace(/—\s*/g, "—\n")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const msPerPhrase = totalMs / phrases.length;

  for(const phrase of phrases){
    if(_narrationAbort) break;
    subtitleText.style.opacity = "1";
    subtitleText.classList.add("typing");
    await typewriter(phrase, Math.min(msPerPhrase * 0.55, 2200));
    if(_narrationAbort) break;
    subtitleText.classList.remove("typing");
    await sleep(Math.max(300, msPerPhrase * 0.35));
    if(_narrationAbort) break;
    subtitleText.style.opacity = "0";
    await sleep(220);
    subtitleText.textContent = "";
  }
}

async function typewriter(text, durationMs){
  subtitleText.textContent = "";
  const delay = Math.max(14, Math.min(55, durationMs / text.length));
  for(const ch of text){
    subtitleText.textContent += ch;
    await sleep(delay);
  }
}

function cleanSpeechText(text){
  return (text || "")
    .replace(/<break\s+time="[^"]+"\s*\/>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Scene question ────────────────────────────────────────────────────────
function onSceneQuestion(msg){
  pendingQ = msg;
  // Only schedule pause once narration is done (or if no narration)
  if(narrationDone) schedulePause(msg.pause_at || 6);
}

function onSceneQuestionAudio(msg){
  if(!pendingQ) return;
  if(pendingQ.character !== msg.character || pendingQ.text !== msg.text) return;
  pendingQ.audio_b64 = msg.audio_b64;
  pendingQ.decision_prompt = msg.decision_prompt || pendingQ.decision_prompt;
  pendingQ.decision_audio_b64 = msg.decision_audio_b64;
}

// Pause against actual video playback time so narration and visuals stay aligned.
function schedulePause(pauseAt){
  if(hasPaused) return;
  if(pauseTimer){ clearTimeout(pauseTimer); }
  const video = activeVid();
  const tick = ()=>{
    if(!hasPaused){
      if(video.currentTime >= pauseAt){
        hasPaused = true;
        video.pause();
        fireQuestion();
        return;
      }
      pauseTimer = setTimeout(tick, 80);
    }
  };
  tick();
}

async function fireQuestion(){
  const q = pendingQ; if(!q) return;

  await waitForAudioKey(q, "audio_b64", 4000);
  showLine(q.character, q.text);
  await playVoice(q.text, q.audio_b64, q.character);

  await waitForAudioKey(q, "decision_audio_b64", 2500);
  const decisionPrompt = q.decision_prompt || "Your case is ready. Who should be charged?";
  showLine("NARRATOR", decisionPrompt);
  await playVoice(decisionPrompt, q.decision_audio_b64, "NARRATOR");

  const opts = q.options || [];
  if(opts.length >= 2) showChoices(opts);
}

async function waitForAudioKey(q, key, maxWaitMs){
  const start = Date.now();
  while(!q[key] && Date.now() - start < maxWaitMs) await sleep(60);
}

// ── Choice buttons ────────────────────────────────────────────────────────
function showChoices(opts){
  choiceButtons.forEach((button, index) => {
    const option = opts[index];
    button.hidden = !option;
    if(!option) return;
    button.textContent = option.display;
    button.onclick = ()=> pickChoice(option);
  });
  choiceOverlay.classList.add("visible");
  voiceChoiceBtn.textContent = "Speak Choice";
  voiceChoiceBtn.classList.add("visible");
  showChoiceHint("say the suspect's name, or select your accusation");
}

function hideChoices(){
  choiceOverlay.classList.remove("visible");
  choiceButtons.forEach(button => { button.onclick = null; });
  stopRecording();
  voiceChoiceBtn.classList.remove("visible", "recording");
  choiceHint.classList.remove("visible");
}

function pickChoice(option){
  hideChoices();
  clearSubtitle();
  send({type:"text_input", text: option.display, branch_key: option.key});
}

voiceChoiceBtn?.addEventListener("click", ()=>{
  if(!choiceOverlay.classList.contains("visible")) return;
  if(!isRecording) startRecording();
  else stopRecording();
});

async function startRecording(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    audioChunks = [];
    const mime = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/mp4"]
      .find(t=>MediaRecorder.isTypeSupported(t)) || "";
    mediaRecorder = new MediaRecorder(stream, {mimeType: mime});
    mediaRecorder.ondataavailable = e=>{ if(e.data.size>0) audioChunks.push(e.data); };
    mediaRecorder.onstop = ()=>{
      stream.getTracks().forEach(t=>t.stop());
      const recorded = audioChunks;
      const recordedType = mediaRecorder?.mimeType || "audio/webm";
      isRecording = false;
      voiceChoiceBtn.classList.remove("recording");
      voiceChoiceBtn.textContent = "Speak Choice";
      if(recorded.length && choiceOverlay.classList.contains("visible")){
        showChoiceHint("matching choice...");
        sendBlob(new Blob(recorded, {type: recordedType}));
      }
    };
    mediaRecorder.start();
    isRecording = true;
    voiceChoiceBtn.classList.add("recording");
    voiceChoiceBtn.textContent = "Stop";
    showChoiceHint("listening...");
  } catch(e){
    console.error("voice choice:", e);
    showChoiceHint("microphone unavailable");
  }
}

function stopRecording(){
  if(!isRecording) return;
  if(mediaRecorder?.state !== "inactive") mediaRecorder.stop();
}

function showChoiceHint(text){
  choiceHint.textContent = text;
  choiceHint.classList.add("visible");
}

// ── Scene loading overlay ─────────────────────────────────────────────────
const SCENE_LOADING_TITLES = [
  "OPENING CASE FILE",
  "PULLING ROOFTOP FOOTAGE",
  "CROSS-CHECKING WITNESS ACCOUNTS",
  "SEARCHING FOR THE MISSING ANGLE",
];
const SCENE_LOADING_DETAILS = [
  "Daniel Reed — rooftop fall, after midnight.",
  "Last party on the roof before the flight out.",
  "Maya, Sara, Cole — who stayed when the feed cut?",
  "One frame was missed. One silence was kept.",
];

let _sceneLoadingTimer = null;
let _sceneLoadingMsgIdx = 0;
let _sceneLoadingProgressVideo = null;

function _clearSceneLoadingProgress(){
  if(_sceneLoadingProgressVideo?._onLoadProgress){
    _sceneLoadingProgressVideo.removeEventListener("progress", _sceneLoadingProgressVideo._onLoadProgress);
    _sceneLoadingProgressVideo._onLoadProgress = null;
  }
  _sceneLoadingProgressVideo = null;
}

function _setSceneLoadingProgress(pct){
  const clamped = Math.max(0, Math.min(100, pct));
  if(sceneLoadingFill) sceneLoadingFill.style.width = `${clamped}%`;
  if(sceneLoadingBar) sceneLoadingBar.setAttribute("aria-valuenow", String(Math.round(clamped)));
}

function _rotateSceneLoadingCopy(){
  if(!sceneLoading?.classList.contains("active")) return;
  if(sceneLoading.classList.contains("scene-loading-sync")) return;
  _sceneLoadingMsgIdx = (_sceneLoadingMsgIdx + 1) % SCENE_LOADING_TITLES.length;
  if(sceneLoadingTitle) sceneLoadingTitle.textContent = SCENE_LOADING_TITLES[_sceneLoadingMsgIdx];
  if(sceneLoadingDetail) sceneLoadingDetail.textContent = SCENE_LOADING_DETAILS[_sceneLoadingMsgIdx];
}

function showSceneLoading({ waitForNarration = false } = {}){
  if(!sceneLoading) return;
  _clearSceneLoadingProgress();
  _sceneLoadingMsgIdx = 0;
  if(sceneLoadingTitle) sceneLoadingTitle.textContent = SCENE_LOADING_TITLES[0];
  if(sceneLoadingDetail){
    sceneLoadingDetail.textContent = waitForNarration
      ? "The night Daniel Reed was left behind on the roof…"
      : SCENE_LOADING_DETAILS[0];
  }
  _setSceneLoadingProgress(6);
  sceneLoading.classList.remove("scene-loading-sync");
  sceneLoading.classList.add("active");
  sceneLoading.setAttribute("aria-hidden", "false");
  if(_sceneLoadingTimer) clearInterval(_sceneLoadingTimer);
  _sceneLoadingTimer = setInterval(_rotateSceneLoadingCopy, 2400);
}

function showSceneLoadingSync(){
  if(!sceneLoading) return;
  sceneLoading.classList.add("scene-loading-sync");
  if(sceneLoadingTitle) sceneLoadingTitle.textContent = "DETECTIVE BRIEFING";
  if(sceneLoadingDetail) sceneLoadingDetail.textContent = "Reviewing what happened before the fall…";
  _setSceneLoadingProgress(100);
}

function hideSceneLoading(){
  if(!sceneLoading) return;
  if(_sceneLoadingTimer){ clearInterval(_sceneLoadingTimer); _sceneLoadingTimer = null; }
  _clearSceneLoadingProgress();
  sceneLoading.classList.remove("active", "scene-loading-sync");
  sceneLoading.setAttribute("aria-hidden", "true");
  _setSceneLoadingProgress(0);
}

function attachSceneLoadingProgress(video){
  if(!video) return;
  _clearSceneLoadingProgress();
  _sceneLoadingProgressVideo = video;
  const onProgress = ()=>{
    if(!video.buffered.length || !video.duration || !isFinite(video.duration)) return;
    const end = video.buffered.end(video.buffered.length - 1);
    _setSceneLoadingProgress((end / video.duration) * 100);
  };
  video._onLoadProgress = onProgress;
  video.addEventListener("progress", onProgress);
  onProgress();
}

function preloadSceneVideo(url){
  const target = activeSlot === "a" ? vidB : vidA;
  if(!target || !url) return;
  const base = url.split("?")[0];
  if(target.src && target.src.includes(base) && target.readyState >= 2) return;
  muteSceneVideo(target);
  target.preload = "auto";
  target.src = url;
  target.load();
}

// ── Video crossfade ───────────────────────────────────────────────────────
let _crossfadeTimer = null;

function showSceneStill(url){
  if(_crossfadeTimer){ clearTimeout(_crossfadeTimer); _crossfadeTimer = null; }
  showSceneLoading();
  [vidA, vidB].forEach(video => {
    video.pause();
    video.classList.remove("active");
  });
  sceneBg.style.backgroundImage = `url("${url}")`;
  const image = new Image();
  const ready = ()=>{
    hideSceneLoading();
    sceneStartedAt = Date.now();
    sceneVisualReady = true;
    flushQueuedMessages();
  };
  image.onload = ready;
  image.onerror = ready;
  image.src = url;
}

function crossfadeVideo(url, loop=true, { autoplay = true, waitForNarration = false } = {}){
  if(_crossfadeTimer){ clearTimeout(_crossfadeTimer); _crossfadeTimer = null; }
  showSceneLoading({ waitForNarration: waitForNarration || !autoplay });
  sceneBg.style.backgroundImage = "";

  const next = activeSlot==="a" ? vidB : vidA;
  const prev = activeSlot==="a" ? vidA : vidB;
  const slot = activeSlot;

  // cancel any pending listener on this element
  if(next._onReady){ next.removeEventListener("canplay", next._onReady); next._onReady = null; }
  _clearSceneLoadingProgress();

  next.loop = loop;
  muteSceneVideo(next);
  next.preload = "auto";
  const base = url.split("?")[0];
  const reuse = next.src && next.src.includes(base) && next.readyState >= 2;
  if(!reuse){
    next.src = url;
    next.load();
  }
  attachSceneLoadingProgress(next);

  let fired = false;
  const onReady = ()=>{
    if(fired) return; fired = true;
    if(_crossfadeTimer){ clearTimeout(_crossfadeTimer); _crossfadeTimer = null; }
    next.removeEventListener("canplay", onReady);
    next._onReady = null;
    muteSceneVideo(next);
    next.currentTime = 0;
    next.classList.add("active");
    prev.classList.remove("active");
    prev.pause();
    activeSlot = slot === "a" ? "b" : "a";
    sceneVisualReady = true;
    flushQueuedMessages();

    if(autoplay){
      next.play().catch(()=>{});
      sceneStartedAt = performance.now();
      _setSceneLoadingProgress(100);
      setTimeout(hideSceneLoading, 280);
    } else {
      next.pause();
      showSceneLoadingSync();
    }
  };

  if(reuse){
    onReady();
    return;
  }

  next._onReady = onReady;
  next.addEventListener("canplay", onReady, { once: true });
  _crossfadeTimer = setTimeout(onReady, 3000);
}
function activeVid(){ return activeSlot==="a" ? vidA : vidB; }

function muteSceneVideo(el){
  if(!el) return;
  el.muted = true;
  el.defaultMuted = true;
  el.volume = 0;
  el.setAttribute("muted", "");
}

function unlockMediaAudio(){
  audioUnlocked = true;
  [vidA, vidB].forEach(muteSceneVideo);
}

// ── Subtitles ─────────────────────────────────────────────────────────────
function showLine(char, text){
  charLabel.style.color = CHAR_COLOR[char] || "rgba(255,255,255,0.35)";
  charLabel.textContent = char;
  subtitleText.style.opacity = "0";
  setTimeout(()=>{
    subtitleText.textContent = text;
    subtitleText.classList.add("fade-in");
    subtitleText.style.opacity = "1";
    setTimeout(()=> subtitleText.classList.remove("fade-in"), 400);
  }, 60);
}
function clearSubtitle(){ charLabel.textContent=""; subtitleText.textContent=""; }

function hideStoryCard(){
  if(!storyCard) return;
  storyCard.classList.remove("active");
  storyCard.setAttribute("aria-hidden", "true");
}

function showStoryCard(card){
  if(!storyCard || !card) return;
  if(storyCardKicker) storyCardKicker.textContent = card.kicker || "CASE FILE";
  if(storyCardTitle) storyCardTitle.textContent = card.title || "";
  if(storyCardBeats){
    storyCardBeats.innerHTML = "";
    (card.beats || []).forEach(beat => {
      const li = document.createElement("li");
      li.textContent = beat;
      storyCardBeats.appendChild(li);
    });
  }
  if(storyCardCta) storyCardCta.textContent = card.cta || "LET'S INVESTIGATE";
  storyCard.classList.add("active");
  storyCard.setAttribute("aria-hidden", "false");
}

storyCardCta?.addEventListener("click", ()=>{
  hideStoryCard();
  drAdvance(currentScene?.id || "crime_scene");
});

// ── Ending ────────────────────────────────────────────────────────────────
function triggerEnding(sceneId){
  hideStoryCard();
  const type = (sceneId||"").replace("ending_","") || "alone";
  const copy  = ENDINGS[type] || ENDINGS.alone;
  document.getElementById("ending-name").textContent = copy.name;
  document.getElementById("ending-desc").textContent = copy.desc;
  setTimeout(()=> endingScreen.classList.add("active"), 3000);
}

document.getElementById("ending-replay")?.addEventListener("click", ()=>{
  endingScreen.classList.remove("active");
  hideStoryCard();
  clearSubtitle();
  hideChoices();
  DR.reset();
  DR.hide();
  hideAudioReconstruction();
  reconstruction = null;
  window.RI?.reset();
  rooftopVisitActive = false;
  rooftopScreenOpen = false;
  queuedAfterRooftopScene = null;
  queuedAfterRooftopSetup = null;
  directRooftopStart = false;
  suppressInitialAutoAdvance = false;
  startSceneMusicFromClick("intro_party");
  send({type:"restart"});
});

// ── Audio — ElevenLabs first, browser speech fallback ─────────────────────
async function playVoice(text, b64, character){
  if(soundMuted){
    await sleep(voiceDuration(cleanSpeechText(text), character));
    return;
  }
  if(b64 && await playB64(b64)) return;
  await sleep(voiceDuration(cleanSpeechText(text), character));
}

function playB64(b64){
  if(soundMuted) return Promise.resolve(false);
  return new Promise(async res=>{
    let url = null;
    try {
      const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], {type:"audio/mpeg"}));
      const audio = new Audio(url);
      audio.volume = 1;
      audio.muted = false;
      if(_currentAudio){ _currentAudio.pause(); }
      _currentAudio = audio;
      audio.onended = ()=>{ if(_currentAudio===audio) _currentAudio=null; URL.revokeObjectURL(url); res(true); };
      audio.onerror = ()=>{ if(_currentAudio===audio) _currentAudio=null; URL.revokeObjectURL(url); res(false); };
      await audio.play();
    } catch(e){
      if(url) URL.revokeObjectURL(url);
      res(false);
    }
  });
}

function voiceDuration(text, character){
  const perChar = character === "NARRATOR" ? 48 : 55;
  return Math.max(1800, Math.min(9000, (text || "").length * perChar));
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── Boot — wait for user click to unlock audio autoplay ───────────────────
async function unlockAudioContext(){
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(AudioCtx){
      audioCtx = audioCtx || new AudioCtx();
      await audioCtx.resume();
    }
  } catch(e){}
  unlockMediaAudio();
  bgMusicReady = true;
}

document.getElementById("splash-btn").addEventListener("click", async ()=>{
  // If user opened a dedicated puzzle URL, jump there from the first click.
  if(PUZZLE_SLUG){
    await startPuzzle(PUZZLE_SLUG, { replaceUrl: true });
    return;
  }

  unlockAudioContext();
  stopTrailerMusic();
  startSceneMusicFromClick("intro_party");
  preloadSceneVideo(sceneVideoUrl("intro_party"));

  splash.classList.add("hidden");
  setTimeout(()=> splash.remove(), 900);

  connect();
});

async function splashJump(sceneId, atmosphere, slug = "") {
  if(slug) showPuzzleNav(slug);
  unlockAudioContext();
  stopTrailerMusic();
  startSceneMusicFromClick(atmosphere);
  useHttpGame = true;
  suppressInitialAutoAdvance = true;
  splash?.classList.add("hidden");
  setTimeout(()=> splash?.remove(), 900);
  try {
    const r = await fetch("/api/game/jump", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({scene_id: sceneId}),
    });
    if(!r.ok) throw new Error(await r.text());
    dispatchHttp(await r.json());
  } catch(e) {
    console.error(`jump to ${sceneId}:`, e);
    showChoiceHint("Could not load scene. Restart the server and try again.");
  }
}

// Warm the intro scene file while the menu is visible.
preloadSceneVideo(sceneVideoUrl("intro_party"));

let trailerAbort = false;

trailerBtn?.addEventListener("click", playTrailer);
trailerExitBtn?.addEventListener("click", ()=>{
  trailerAbort = true;
  trailerVideo.pause();
  _hideTrailerTitleCard();
  splash.classList.remove("trailer-playing");
  stopTrailerMusic();
  trailerBtn.textContent = "WATCH TRAILER";
  trailerPlaying = false;
  subtitleText.classList.remove("narration","typing");
  clearSubtitle();
  if(!splash.classList.contains("hidden")) crossfadeVideo("/static/scenes/intro-party.mp4?v=1");
});

// Preload first trailer video so it's buffered before button click
(function preloadFirstTrailerVideo(){
  const v = trailerVideo;
  v.src     = "/static/trailer/trailer_combined.mp4";
  v.preload = "auto";
  v.muted   = true;
  v.load();
})();

// Pre-fetch trailer API on page load so click is instant
let _trailerDataPromise = fetch("/api/trailer").then(r => r.ok ? r.json() : null).catch(()=>null);

async function playTrailer(){
  if(trailerPlaying) return;
  trailerPlaying = true;
  trailerAbort   = false;
  unlockAudioContext();

  try {
    trailerBtn.textContent = "PLAYING";
    splash.classList.add("trailer-playing");

    // Use pre-fetched data (or fallback fetch) in parallel with video ready check
    const [trailer] = await Promise.all([
      _trailerDataPromise || fetch("/api/trailer").then(r => r.json()),
      _waitForVideoReady(trailerVideo),
    ]);
    _trailerDataPromise = null;
    if(!trailer) throw new Error("Trailer data unavailable");

    // Start music exactly when video is about to play
    playTrailerMusic(trailer.music_url || "/static/music/trailer_suspense.mp3");

    charLabel.textContent = "";
    subtitleText.classList.add("narration");
    await Promise.all([
      playVoice(trailer.text, trailer.audio_b64, "TRAILER_NARRATOR"),
      animateNarration(trailer.text, trailer.audio_b64),
      playTrailerSequence(trailer.video_urls || [trailer.video_url || "/static/trailer/trailer_combined.mp4"]),
    ]);

    subtitleText.classList.remove("narration", "typing");
    clearSubtitle();
  } catch(e) {
    console.error("trailer:", e);
  } finally {
    splash.classList.remove("trailer-playing");
    stopTrailerMusic();
    trailerBtn.textContent = "WATCH TRAILER";
    trailerPlaying = false;
    if(!splash.classList.contains("hidden")){
      crossfadeVideo("/static/scenes/intro-party.mp4?v=1");
    }
  }
}

function _waitForVideoReady(video){
  return new Promise(resolve=>{
    if(video.readyState >= 3) return resolve();
    const done = ()=>{ video.removeEventListener("canplay",done); resolve(); };
    video.addEventListener("canplay", done);
    setTimeout(resolve, 2000); // fallback
  });
}

async function playTrailerSequence(urls){
  const valid = urls.filter(Boolean);
  if(!valid.length) return;

  _showTrailerTitleCard("intro"); // auto-hides after 1.8s

  // Show outro card 4s before the video ends via timeupdate
  const video = trailerVideo;
  let outroDone = false;
  const onTimeUpdate = ()=>{
    if(!outroDone && video.duration && video.currentTime >= video.duration - 4){
      outroDone = true;
      _showTrailerTitleCard("outro");
    }
  };
  video.addEventListener("timeupdate", onTimeUpdate);

  for(const url of valid) await playTrailerVideo(url);

  video.removeEventListener("timeupdate", onTimeUpdate);
  _hideTrailerTitleCard();
}

function _showTrailerTitleCard(type){
  if(type === "intro"){
    ttcEyebrow.textContent = "AN INTERACTIVE FILM";
    ttcTitle.textContent   = "THE MISSING ANGLE";
    ttcSub.textContent     = "";
  } else {
    ttcEyebrow.textContent = "AN INTERACTIVE FILM";
    ttcTitle.textContent   = "THE MISSING ANGLE";
    ttcSub.textContent     = "Every angle hides a different truth.";
  }
  trailerTitleCard.classList.add("visible");
  if(type === "intro"){
    setTimeout(()=> trailerTitleCard.classList.remove("visible"), 1800);
  }
}

function _hideTrailerTitleCard(){
  trailerTitleCard.classList.remove("visible");
  ttcEyebrow.textContent = "";
  ttcTitle.textContent   = "";
  ttcSub.textContent     = "";
}

async function playTrailerVideo(url){
  const video = trailerVideo;
  video.pause();
  video.loop = false;
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.setAttribute("muted", "");
  video.onended = null;
  video.oncanplay = null;
  video.onerror = null;
  video.src = url;
  video.load();

  await new Promise(resolve=>{
    let done = false;
    const finish = ()=>{ if(!done){ done = true; resolve(); } };
    video.oncanplay = finish;
    video.oncanplaythrough = finish;
    video.onerror = finish;
    setTimeout(finish, 1800);
  });

  try { video.currentTime = 0; } catch(e){}
  await video.play().catch(e=> console.error("trailer play:", e));

  await new Promise(resolve=>{
    let done = false;
    const finish = ()=>{ if(!done){ done = true; resolve(); } };
    video.onended = finish;
    video.onerror = finish;
    setTimeout(finish, 60000); // up to 60s for combined trailer
  });

  video.loop = true;
  video.pause();
  video.removeAttribute("src");
  video.load();
}
