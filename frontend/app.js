/* The Missing Angle - interactive thriller
   Flow: video plays -> narration -> pauses -> character line -> clue choices appear.
   The viewer chooses what the movie follows next. */

const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${WS_PROTO}://${location.host}/ws/game`;
const PREFER_HTTP_GAME = location.hostname.includes("vercel.app");

const CHAR_COLOR = { SARA: "#f472b6", COLE: "#94a3b8", MAYA: "#a78bfa" };

const ENDINGS = {
  complicit:       { name: "COMPLICIT",        desc: "The movie cuts away. Sara walks free, and the missing angle stays buried." },
  witness:         { name: "THE CLEAN CUT",    desc: "The obvious footage wins. Sara is blamed, but the ending feels too clean." },
  witness_broken:  { name: "TOO LATE",         desc: "The full frame changes everything, but it arrives after the lie." },
  witness_doubt:   { name: "SHADOW OF DOUBT",  desc: "The edge of the frame stays hidden. Sara is free, but certainty is gone." },
  truth:           { name: "TRUTH",            desc: "The movie chooses the reach over the shove. The fall becomes tragedy, not murder." },
  truth_together:  { name: "UNITED",           desc: "Maya enters the frame, and the motive finally makes sense." },
  betrayal:        { name: "BETRAYED",         desc: "The film reads panic as guilt. Sara is convicted by the angle." },
  alone:           { name: "ALONE",            desc: "The explanation is skipped. The answer disappears with Sara." },
};

// ── Background music ──────────────────────────────────────────────────────
const bgMusic       = new Audio();
bgMusic.loop        = true;
bgMusic.volume      = 0;
let bgMusicAtm      = null;
let bgMusicReady    = false;

const trailerMusic  = new Audio();
trailerMusic.loop   = true;
trailerMusic.volume = 0;

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
    bgMusic.play().catch(()=>{});
    _fadeMusic(0.22);
  } catch(e){}
}

function startSceneMusicFromClick(atmosphere){
  bgMusicAtm = atmosphere;
  bgMusic.src = `/static/music/${atmosphere}.mp3`;
  bgMusic.loop = true;
  bgMusic.muted = false;
  bgMusic.volume = 0.22;
  bgMusic.load();
  bgMusic.play().catch(e=> console.error("scene music play:", e));
}

function _fadeMusic(target){
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

function playTrailerMusic(url){
  if(!url) return Promise.resolve();
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
let currentScene    = null;
let pendingQ        = null;
let hasPaused       = false;
let activeSlot      = "a";
let pauseTimer      = null;
let narrationDone   = false;
let sceneStartedAt  = 0;
let sceneVisualReady = false;
let queuedMessages  = [];
let isRecording     = false;
let mediaRecorder   = null;
let audioChunks     = [];
let audioCtx        = null;   // single persistent AudioContext, unlocked on splash click
let audioUnlocked   = false;
let trailerPlaying  = false;
let _currentAudio   = null;

// ── DOM ───────────────────────────────────────────────────────────────────
const sceneBg        = document.getElementById("scene-bg");
const vidA           = document.getElementById("scene-video-a");
const vidB           = document.getElementById("scene-video-b");
const sceneCanvas    = document.getElementById("scene-canvas");
const subtitleText   = document.getElementById("subtitle-text");
const charLabel      = document.getElementById("character-label");
const transOverlay   = document.getElementById("scene-transition");
const endingScreen   = document.getElementById("ending-screen");
const choiceOverlay  = document.getElementById("choice-overlay");
const choiceBtnA     = document.getElementById("choice-a");
const choiceBtnB     = document.getElementById("choice-b");
const voiceChoiceBtn = document.getElementById("voice-choice-btn");
const choiceHint     = document.getElementById("choice-hint");
const splash         = document.getElementById("splash");
const trailerBtn     = document.getElementById("trailer-btn");
const trailerVideo   = document.getElementById("trailer-video");
const trailerControls   = document.getElementById("trailer-controls");
const trailerExitBtn    = document.getElementById("trailer-exit-btn");
const trailerReplayBtn  = document.getElementById("trailer-replay-btn");
const trailerFfBtn      = document.getElementById("trailer-ff-btn");
const trailerCaptions   = document.getElementById("trailer-captions");
const trailerTitleCard  = document.getElementById("trailer-title-card");
const ttcEyebrow        = document.getElementById("ttc-eyebrow");
const ttcTitle          = document.getElementById("ttc-title");
const ttcSub            = document.getElementById("ttc-sub");

// ── Canvas particles ──────────────────────────────────────────────────────
const ctx2d = sceneCanvas.getContext("2d");
function resizeCanvas(){ sceneCanvas.width=innerWidth; sceneCanvas.height=innerHeight; }
window.addEventListener("resize", resizeCanvas); resizeCanvas();

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

function dispatchHttp(data){
  httpSessionId = data.session_id || httpSessionId;
  (data.messages || []).forEach(handle);
  if(httpAdvanceTimer){ clearTimeout(httpAdvanceTimer); httpAdvanceTimer = null; }
  if(data.auto_advance){
    httpAdvanceTimer = setTimeout(
      ()=> httpAdvance(),
      data.auto_advance.delay_ms || 3000
    );
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
      body: JSON.stringify({session_id: httpSessionId}),
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
    case "scene_start":     onSceneStart(msg.scene);   break;
    case "scene_narration": runWhenVisualReady(msg);   break;
    case "scene_question":  runWhenVisualReady(msg);   break;
    case "scene_question_audio": onSceneQuestionAudio(msg); break;
    case "transcript":      showChoiceHint(`heard: ${msg.text}`); break;
    case "voice_no_match":  showChoiceHint("try one of the two choices"); break;
    case "ending":          triggerEnding(msg.scene);  break;
  }
}

// ── Scene start ───────────────────────────────────────────────────────────
function onSceneStart(scene){
  // For auto-advance transitions the server waits for narration to finish naturally.
  // Only cut audio for user-initiated choices (interactive → next scene).
  if(!currentScene?.auto_advance && _currentAudio){ _currentAudio.pause(); _currentAudio = null; }
  _narrationAbort = true;
  currentScene = scene;
  sceneStartedAt = 0;
  sceneVisualReady = false;
  queuedMessages = [];
  hasPaused    = false;
  pendingQ     = null;
  narrationDone = !scene.has_narration;

  clearSubtitle();
  hideChoices();

  if(pauseTimer){ clearTimeout(pauseTimer); pauseTimer=null; }

  const atm = scene.atmosphere || "default";
  const shouldLoop = !scene.auto_advance;
  crossfadeVideo(`/static/scenes/${atm}.mp4?v=3`, shouldLoop);

  // When first interactive scene loads, fade out trailer suspense and switch to scene BGM
  if(!scene.auto_advance){
    stopTrailerMusic();
    setSceneMusic(atm);
  }
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
  charLabel.textContent = "";
  subtitleText.classList.add("narration");

  // Animation runs alongside audio but we only wait for audio.
  // When audio ends we abort the animation and hand off immediately.
  animateNarration(msg.text, msg.audio_b64);
  await playVoice(msg.text, msg.audio_b64, "NARRATOR");

  _narrationAbort = true;
  subtitleText.style.opacity = "0";
  subtitleText.classList.remove("narration", "typing");
  await sleep(80);
  subtitleText.textContent = "";
  subtitleText.style.opacity = "1";

  narrationDone = true;
  if(pendingQ) schedulePause(pendingQ.pause_at || 6);
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
  const decisionPrompt = q.decision_prompt || "The film holds. Which angle should we follow?";
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
  choiceBtnA.textContent = opts[0].display;
  choiceBtnB.textContent = opts[1].display;
  choiceBtnA.onclick = ()=> pickChoice(opts[0]);
  choiceBtnB.onclick = ()=> pickChoice(opts[1]);
  choiceOverlay.classList.add("visible");
  voiceChoiceBtn.textContent = "Speak Choice";
  voiceChoiceBtn.classList.add("visible");
  showChoiceHint("say a sentence, or select a cut");
}

function hideChoices(){
  choiceOverlay.classList.remove("visible");
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

// ── Video crossfade ───────────────────────────────────────────────────────
let _crossfadeTimer = null;

function crossfadeVideo(url, loop=true){
  if(_crossfadeTimer){ clearTimeout(_crossfadeTimer); _crossfadeTimer = null; }

  const next = activeSlot==="a" ? vidB : vidA;
  const prev = activeSlot==="a" ? vidA : vidB;
  const slot = activeSlot;

  // cancel any pending listener on this element
  if(next._onReady){ next.removeEventListener("canplay", next._onReady); next._onReady = null; }

  next.loop = loop;
  muteSceneVideo(next);
  next.src = url;
  next.load();

  let fired = false;
  const onReady = ()=>{
    if(fired) return; fired = true;
    if(_crossfadeTimer){ clearTimeout(_crossfadeTimer); _crossfadeTimer = null; }
    next.removeEventListener("canplay", onReady);
    next._onReady = null;
    muteSceneVideo(next);
    next.currentTime = 0;
    next.play().catch(()=>{});
    next.classList.add("active");
    prev.classList.remove("active");
    activeSlot = slot === "a" ? "b" : "a";
    sceneStartedAt = Date.now();
    sceneVisualReady = true;
    flushQueuedMessages();
  };

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
  }, 150);
}
function clearSubtitle(){ charLabel.textContent=""; subtitleText.textContent=""; }

// ── Ending ────────────────────────────────────────────────────────────────
function triggerEnding(sceneId){
  const type = (sceneId||"").replace("ending_","") || "alone";
  const copy  = ENDINGS[type] || ENDINGS.alone;
  document.getElementById("ending-name").textContent = copy.name;
  document.getElementById("ending-desc").textContent = copy.desc;
  setTimeout(()=> endingScreen.classList.add("active"), 3000);
}

document.getElementById("ending-replay")?.addEventListener("click", ()=>{
  endingScreen.classList.remove("active");
  clearSubtitle();
  hideChoices();
  send({type:"restart"});
});

// ── Audio — ElevenLabs first, browser speech fallback ─────────────────────
async function playVoice(text, b64, character){
  if(b64 && await playB64(b64)) return;
  await sleep(voiceDuration(cleanSpeechText(text), character));
}

function playB64(b64){
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
  unlockAudioContext();
  stopTrailerMusic();
  playTrailerMusic("/static/music/trailer_suspense.mp3");
  crossfadeVideo("/static/scenes/party_night.mp4?v=3");

  splash.classList.add("hidden");
  setTimeout(()=> splash.remove(), 900);

  connect();
});

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
  if(!splash.classList.contains("hidden")) crossfadeVideo("/static/scenes/party_night.mp4?v=3");
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
      playTrailerSequence(trailer.video_urls || [trailer.video_url || "/static/trailer/rooftop-party-to-crime-scene.mp4"]),
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
      crossfadeVideo("/static/scenes/party_night.mp4?v=3");
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
  for(let i = 0; i < valid.length; i++){
    if(i === 0) _showTrailerTitleCard("intro");
    if(i === valid.length - 1) _showTrailerTitleCard("outro");
    await playTrailerVideo(valid[i]);
  }
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
