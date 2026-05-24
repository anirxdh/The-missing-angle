/* The Missing Angle - interactive thriller
   Flow: video plays -> narration -> pauses -> character line -> clue choices appear.
   The viewer chooses what the movie follows next. */

const WS_URL = `ws://${location.host}/ws/game`;

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
    _fadeMusic(0.18);
  } catch(e){}
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

// ── State ─────────────────────────────────────────────────────────────────
let ws              = null;
let currentScene    = null;
let pendingQ        = null;
let hasPaused       = false;
let activeSlot      = "a";
let pauseTimer      = null;
let narrationDone   = false;
let sceneStartedAt  = 0;
let isRecording     = false;
let mediaRecorder   = null;
let audioChunks     = [];
let audioCtx        = null;   // single persistent AudioContext, unlocked on splash click
let audioUnlocked   = false;

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

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect(){
  ws = new WebSocket(WS_URL);
  ws.onopen    = ()=>{};
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onerror   = ()=>{};
  ws.onclose   = ()=> setTimeout(connect, 2000);
}
function send(obj){ ws?.readyState===1 && ws.send(JSON.stringify(obj)); }
function sendBlob(b){ ws?.readyState===1 && ws.send(b); }

// ── Message router ────────────────────────────────────────────────────────
function handle(msg){
  switch(msg.type){
    case "scene_start":     onSceneStart(msg.scene);   break;
    case "scene_narration": onSceneNarration(msg);     break;
    case "scene_question":  onSceneQuestion(msg);      break;
    case "scene_question_audio": onSceneQuestionAudio(msg); break;
    case "transcript":      showChoiceHint(`heard: ${msg.text}`); break;
    case "voice_no_match":  showChoiceHint("try one of the two choices"); break;
    case "ending":          triggerEnding(msg.scene);  break;
  }
}

// ── Scene start ───────────────────────────────────────────────────────────
function onSceneStart(scene){
  currentScene = scene;
  sceneStartedAt = Date.now();
  hasPaused    = false;
  pendingQ     = null;
  narrationDone = !scene.has_narration;

  clearSubtitle();
  hideChoices();

  if(pauseTimer){ clearTimeout(pauseTimer); pauseTimer=null; }

  const atm = scene.atmosphere || "default";
  const vidUrl = `/static/scenes/${atm}.mp4`;
  fetch(vidUrl, {method:"HEAD"})
    .then(r=>{ if(r.ok) crossfadeVideo(vidUrl); })
    .catch(()=>{});

  setSceneMusic(atm);
}

// ── Narration — typewriter, one line at a time, follows the voice ─────────
async function onSceneNarration(msg){
  charLabel.textContent = "";
  subtitleText.classList.add("narration");

  await Promise.all([
    playVoice(msg.text, msg.audio_b64, "NARRATOR"),
    animateNarration(msg.text, msg.audio_b64),
  ]);

  subtitleText.style.opacity = "0";
  subtitleText.classList.remove("narration", "typing");
  await sleep(350);
  subtitleText.textContent = "";
  subtitleText.style.opacity = "1";

  narrationDone = true;
  if(pendingQ) schedulePause(pendingQ.pause_at || 6);
}

async function animateNarration(text, audio_b64){
  // Estimate total audio duration from MP3 base64 size (128 kbps → 16000 B/s)
  const totalMs = audio_b64
    ? (audio_b64.length * 0.75 / 16000) * 1000
    : voiceDuration(text, "NARRATOR");

  // Split at sentence boundaries — keeps punctuation with the phrase
  const phrases = text
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/\.\.\.\s*/g, "...\n")
    .replace(/—\s*/g, "—\n")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const msPerPhrase = totalMs / phrases.length;

  for(const phrase of phrases){
    subtitleText.style.opacity = "1";
    subtitleText.classList.add("typing");
    await typewriter(phrase, Math.min(msPerPhrase * 0.55, 2200));
    subtitleText.classList.remove("typing");
    await sleep(Math.max(300, msPerPhrase * 0.35));
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
}

// Wall-clock pause so looping 8s videos hit the mark
function schedulePause(pauseAt){
  if(hasPaused) return;
  if(pauseTimer){ clearTimeout(pauseTimer); }
  const elapsed = Date.now() - sceneStartedAt;
  const delay = Math.max(0, pauseAt * 1000 - elapsed);
  pauseTimer = setTimeout(()=>{
    if(!hasPaused){
      hasPaused = true;
      activeVid().pause();
      fireQuestion();
    }
  }, delay);
}

async function fireQuestion(){
  const q = pendingQ; if(!q) return;

  showLine(q.character, q.text);

  await playVoice(q.text, q.audio_b64, q.character);

  // Show choice buttons if options exist
  const opts = q.options || [];
  if(opts.length >= 2){
    showChoices(opts);
  }
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
  showChoiceHint("say a sentence, or click a choice");
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
function crossfadeVideo(url){
  const next = activeSlot==="a" ? vidB : vidA;
  const prev = activeSlot==="a" ? vidA : vidB;
  next.loop = true;  // always loop scene videos
  muteSceneVideo(next);
  next.src = url; next.load();
  next.oncanplay = ()=>{
    muteSceneVideo(next);
    next.play().catch(()=>{});
    next.classList.add("active");
    prev.classList.remove("active");
    activeSlot = activeSlot==="a" ? "b" : "a";
    setTimeout(()=>{ prev.src=""; }, 1500);
  };
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
  await sleep(voiceDuration(text, character));
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
      audio.onended = ()=>{ URL.revokeObjectURL(url); res(true); };
      audio.onerror = ()=>{ URL.revokeObjectURL(url); res(false); };
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
document.getElementById("splash-btn").addEventListener("click", async ()=>{
  // Create and keep the AudioContext alive for the session
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(AudioCtx){
      audioCtx = audioCtx || new AudioCtx();
      await audioCtx.resume();
    }
  } catch(e){}
  unlockMediaAudio();
  bgMusicReady = true;

  const splash = document.getElementById("splash");
  splash.classList.add("hidden");
  setTimeout(()=> splash.remove(), 900);

  connect();
});
