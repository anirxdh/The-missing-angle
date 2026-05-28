import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const RI = (() => {
  const marbleWorldUrl = "/world/Rooftop%20bar%20cityscape%20evening.spz";
  const evidence = [
    {
      key: "audio_recorder",
      label: "DAMAGED AUDIO RECORDER",
      description: "Cracked recorder from the fight. Captures Maya and Daniel's argument — and the phone he grabbed from her.",
      source: "Rooftop / left sofa",
      hint: "Left side — follow the walkway toward the railing.",
      suspect: "MAYA",
      position: [-3.55, 0.56, -0.45],
      color: 0x2c526d,
      shape: "phone",
      scale: 0.28,
    },
    {
      key: "memory_card",
      label: "MICRO SD AUDIO CARD",
      description: "Daniel's backup copy of the rooftop audio. Whoever cut the camera feed did not want this recovered.",
      source: "Rooftop / bar counter",
      hint: "Center bar — check the main counter ahead of you.",
      suspect: null,
      position: [0.05, 0.56, -1.85],
      color: 0x242a2c,
      shape: "card",
      scale: 0.28,
    },
    {
      key: "camera_panel",
      label: "WIRELESS AUDIO TRANSMITTER",
      description: "Transmitter tied to the rooftop security feed. Signal cut out at 23:02 — right before Daniel fell.",
      source: "Rooftop / open floor",
      hint: "Right side — open floor near the bar lights. Look for the glowing marker.",
      suspect: null,
      position: [3.55, 0.58, 0.55],
      color: 0x4e8c7b,
      shape: "panel",
      scale: 0.32,
    },
  ];
  const requiredEvidenceKeys = new Set(["audio_recorder", "memory_card", "camera_panel"]);
  const requiredEvidenceTotal = requiredEvidenceKeys.size;

  let scene;
  let camera;
  let renderer;
  let sparkRenderer;
  let raycaster;
  let root;
  let canvas;
  let animationId;
  let active = false;
  let onAdvance = null;
  let onBack = null;
  let markerClock = 0;
  let yaw = 0;
  let pitch = -0.08;
  let drag = null;
  const movement = new Set();
  const evidenceMeshes = [];
  const collected = new Set();
  let flashlight = null;
  let flashlightOn = false;
  let hoveredEntry = null;
  let hintedKey = null;
  let cameraFov = 54;
  let nextHintIndex = 0;
  let marbleLoaded = false;
  let reviewOpen = false;
  let evidenceRevealTimer = null;
  let reviewAudio = null;
  const heardReviewAudio = new Set();
  const addedToCaseFile = new Set();
  const $ = id => document.getElementById(id);

  function showBrief(text) {
    const brief = $("ri-brief");
    if (!brief) return;
    brief.textContent = text || "";
  }

  function activate(sceneData, advance, back) {
    ensureScene();
    onAdvance = advance;
    onBack = back;
    active = true;
    if (marbleLoaded) {
      root.classList.remove("ri-world-preview");
    } else {
      root.classList.add("ri-world-preview");
    }
    root.classList.remove("ri-hidden");
    root.setAttribute("aria-hidden", "false");
    // Always show the rooftop loader on entry; hide only when evidence is cleared to reveal.
    $("ri-load-status")?.classList.remove("ri-loaded");
    setEvidenceDevicesVisible(false);
    if (marbleLoaded) scheduleEvidenceReveal();
    setFlashlight(false);
    camera.position.set(0, 1.62, 3.2);
    setZoom(54);
    yaw = 0;
    pitch = -0.06;
    updateCamera();
    updateEvidenceList();
    resize();
    render();
  }

  function hide() {
    if (!root) return;
    active = false;
    root.classList.add("ri-hidden");
    root.setAttribute("aria-hidden", "true");
    stopReviewAudio();
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (evidenceRevealTimer) {
      clearTimeout(evidenceRevealTimer);
      evidenceRevealTimer = null;
    }
    setEvidenceDevicesVisible(false);
  }

  function reset() {
    hide();
    collected.clear();
    addedToCaseFile.clear();
    reviewOpen = false;
    heardReviewAudio.clear();
    stopReviewAudio();
    root?.classList.remove("ri-review-mode");
    $("ri-review")?.classList.add("ri-hidden");
    evidenceMeshes.forEach(({ object, glowRing, clueLight, marker }) => {
      object.visible = active && marbleLoaded && !collected.has(object.userData.evidence?.key);
      if (glowRing?.material) glowRing.material.opacity = 0;
      if (marker?.material) marker.material.opacity = 1;
      if (clueLight) clueLight.intensity = 0;
    });
    setHoveredEvidence(null);
    resetHint();
    showBrief("");
    updateEvidenceList();
  }

  function ensureScene() {
    if (renderer) return;
    root = $("ri-scene");
    canvas = $("ri-canvas");
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080d);
    camera = new THREE.PerspectiveCamera(cameraFov, 1, 0.01, 2000);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    raycaster = new THREE.Raycaster();
    flashlight = new THREE.SpotLight(0xfff1cf, 5.5, 12, Math.PI / 8, 0.5, 1.35);
    flashlight.position.set(0, 0, 0);
    flashlight.target.position.set(0, -0.45, -6);
    camera.add(flashlight);
    camera.add(flashlight.target);
    scene.add(camera);
    sparkRenderer = new SparkRenderer({
      renderer,
      sortRadial:     true,
      focalAdjustment: 1.6,
      maxStdDev:       Math.sqrt(5),
      enableLod:       true,
      lodSplatScale:   2.0,
    });
    scene.add(sparkRenderer);

    buildRooftop();
    addRooftopLighting();
    evidence.forEach(addEvidenceProp);
    buildReviewUI();
    wireUI();
    window.addEventListener("resize", resize);
  }

  function buildReviewUI() {
    if (!root || $("ri-review")) return;
    const panel = document.createElement("section");
    panel.id = "ri-review";
    panel.className = "ri-review ri-hidden";
    panel.innerHTML = `
      <div class="ri-review-inner">
        <div class="ri-review-kicker">ROOFTOP EVIDENCE</div>
        <h2 class="ri-review-title">RECOVERED CLUES</h2>
        <p class="ri-review-sub">Listen to each clip, then add it to the case file. The full picture comes together after CCTV and the interviews.</p>
        <div id="ri-review-caption" class="ri-review-caption" aria-live="polite"></div>
        <div id="ri-review-list" class="ri-review-list"></div>
        <div class="ri-review-actions">
          <button id="ri-review-back" type="button" class="ri-review-secondary">BACK</button>
          <button id="ri-review-continue" type="button" class="ri-review-primary" disabled>ADD ALL TO CASE FILE</button>
        </div>
      </div>
    `;
    root.appendChild(panel);

    panel.querySelector("#ri-review-back")?.addEventListener("click", hideReview);
    panel.querySelector("#ri-review-continue")?.addEventListener("click", () => {
      if (!allRequiredEvidenceCollected() || !onAdvance) return;
      if (!allRequiredAdded()) return;
      hide();
      onAdvance();
    });
  }

  function allRequiredAdded() {
    return [...requiredEvidenceKeys].every(key => addedToCaseFile.has(key));
  }

  function showReview() {
    if (!root) return;
    reviewOpen = true;
    root.classList.add("ri-review-mode");
    $("ri-review")?.classList.remove("ri-hidden");
    updateReviewList();
    updateEvidenceList();
  }

  function hideReview() {
    if (!root) return;
    stopReviewAudio();
    reviewOpen = false;
    root.classList.remove("ri-review-mode");
    $("ri-review")?.classList.add("ri-hidden");
    updateEvidenceList();
  }

  function updateReviewList() {
    const list = $("ri-review-list");
    if (!list) return;
    const items = evidence.filter(item => requiredEvidenceKeys.has(item.key) && collected.has(item.key));
    list.innerHTML = "";

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "ri-review-row";
      const added = addedToCaseFile.has(item.key);
      const heard = heardReviewAudio.has(item.key);
      row.innerHTML = `
        <div class="ri-review-card">
          <img class="ri-review-thumb" src="${EVIDENCE_IMAGES[item.key] || ""}" alt="" />
          <div class="ri-review-meta">
            <div class="ri-review-label">${item.label}</div>
            <div class="ri-review-desc">${item.description}</div>
          </div>
        </div>
        <div class="ri-review-buttons">
          <button type="button" class="ri-review-btn ri-review-btn-listen ${heard ? "is-heard" : ""}" data-action="listen" data-key="${item.key}">
            ${heard ? "REPLAY AUDIO" : "LISTEN TO AUDIO"}
          </button>
          <button type="button" class="ri-review-btn ${added ? "is-added" : ""}" data-action="add" data-key="${item.key}">
            ${added ? "ADDED" : "ADD TO CASE FILE"}
          </button>
        </div>
      `;
      row.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => handleReviewAction(btn.dataset.action, btn.dataset.key, btn));
      });
      list.appendChild(row);
    });

    const cont = $("ri-review-continue");
    if (cont) {
      cont.disabled = !allRequiredAdded();
      cont.textContent = allRequiredAdded() ? "CONTINUE TO CCTV" : "ADD ALL TO CASE FILE";
    }
  }

  function handleReviewAction(action, key, button) {
    const item = evidence.find(e => e.key === key);
    if (!item) return;
    if (action === "listen") {
      playReviewAudio(key, button);
      return;
    }
    if (action !== "add") return;
    if (addedToCaseFile.has(key)) return;
    window.DR?.addEvidence?.(item);
    window.DR_inspect?.(key, data => {
      if (data.track_key) {
        window.DR?.addEvidence?.({
          key: data.track_key,
          label: data.label || `${item.label} (AUDIO)`,
          description: data.text || item.description,
          source: data.source || item.source,
          suspect: data.suspect || item.suspect || null,
        });
      }
      addedToCaseFile.add(key);
      updateReviewList();
      updateEvidenceList();
    });
  }

  function setReviewCaption(speaker, text, playing) {
    const caption = $("ri-review-caption");
    if (!caption) return;
    if (!text) {
      caption.textContent = "";
      caption.classList.remove("is-playing");
      return;
    }
    caption.textContent = speaker ? `${speaker}: ${text}` : text;
    caption.classList.toggle("is-playing", Boolean(playing));
  }

  function stopReviewAudio() {
    if (!reviewAudio) return;
    try {
      reviewAudio.pause();
    } catch (e) {}
    reviewAudio = null;
    setReviewCaption("", "", false);
    document.querySelectorAll(".ri-review-btn-listen.is-playing").forEach(btn => {
      btn.classList.remove("is-playing");
    });
  }

  function resetListenButton(button, key) {
    if (!button) return;
    button.disabled = false;
    button.classList.remove("is-playing");
    button.textContent = heardReviewAudio.has(key) ? "REPLAY AUDIO" : "LISTEN TO AUDIO";
  }

  function playReviewAudio(key, button) {
    if (button) {
      document.querySelectorAll(".ri-review-btn-listen.is-playing").forEach(btn => btn.classList.remove("is-playing"));
      button.classList.add("is-playing");
      button.textContent = "LOADING…";
      button.disabled = true;
    }
    let settled = false;
    const finish = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimeout);
      if (button) resetListenButton(button, key);
      return data;
    };
    const loadTimeout = setTimeout(() => {
      finish({});
      setReviewCaption("", "", false);
    }, 12000);
    window.DR_inspect?.(key, data => {
      data = finish(data) || {};
      if (button) {
        button.disabled = false;
        button.textContent = heardReviewAudio.has(key) ? "REPLAY AUDIO" : "LISTEN TO AUDIO";
      }
      if (!data?.audio_b64) {
        if (button) button.classList.remove("is-playing");
        setReviewCaption("", "", false);
        return;
      }
      stopReviewAudio();
      if (button) {
        button.classList.add("is-playing");
        button.textContent = "REPLAY AUDIO";
      }
      heardReviewAudio.add(key);
      setReviewCaption(data.speaker || "RECOVERED AUDIO", data.text || "", true);
      try {
        const bytes = Uint8Array.from(atob(data.audio_b64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
        const audio = new Audio(url);
        reviewAudio = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          reviewAudio = null;
          if (button) button.classList.remove("is-playing");
          setReviewCaption(data.speaker || "RECOVERED AUDIO", data.text || "", false);
          updateReviewList();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          reviewAudio = null;
          if (button) button.classList.remove("is-playing");
          setReviewCaption("", "", false);
        };
        audio.play().catch(() => {
          if (button) button.classList.remove("is-playing");
          setReviewCaption("", "", false);
        });
      } catch (e) {
        if (button) button.classList.remove("is-playing");
        setReviewCaption("", "", false);
      }
    });
  }

  function setEvidenceDevicesVisible(visible) {
    evidenceMeshes.forEach(entry => {
      entry.object.visible = Boolean(visible) && !collected.has(entry.item.key);
      if (!entry.object.visible) {
        if (entry.glowRing?.material) entry.glowRing.material.opacity = 0;
        if (entry.clueLight) entry.clueLight.intensity = 0;
      }
    });
  }

  function scheduleEvidenceReveal() {
    if (evidenceRevealTimer) clearTimeout(evidenceRevealTimer);
    setEvidenceDevicesVisible(false);
    $("ri-load-status")?.classList.remove("ri-loaded");
    evidenceRevealTimer = setTimeout(() => {
      evidenceRevealTimer = null;
      if (!active || !marbleLoaded || root?.classList.contains("ri-hidden")) return;
      setEvidenceDevicesVisible(true);
      $("ri-load-status")?.classList.add("ri-loaded");
    }, 480);
  }

  function buildRooftop() {
    const splat = new SplatMesh({
      url:       marbleWorldUrl,
      extSplats: true,
      lod:       true,
      lodScale:  2.0,
      onLoad: () => {
        marbleLoaded = true;
        root?.classList.remove("ri-world-preview");
        scheduleEvidenceReveal();
        updateEvidenceList();
      },
    });
    splat.name = "marble-rooftop-world";
    scene.add(splat);
  }

  const EVIDENCE_IMAGES = {
    audio_recorder: "/static/evidence/phone_case.png",
    memory_card:    "/static/evidence/memory_card.png",
    camera_panel:   "/static/evidence/camera_panel.png",
  };

  function addRooftopLighting() {
    scene.add(new THREE.HemisphereLight(0x728ab8, 0x070a10, 1.28));
    const moon = new THREE.DirectionalLight(0xa7bcdf, 1.45);
    moon.position.set(-7, 12, 7);
    scene.add(moon);
    const fill = new THREE.DirectionalLight(0x546d9c, 0.48);
    fill.position.set(8, 5, -8);
    scene.add(fill);
  }

  function addEvidenceProp(item) {
    const object = buildEvidenceAsset(item);
    object.position.set(...item.position);
    object.visible = false; // hidden until splat finishes loading
    object.userData.evidence = item;
    scene.add(object);

    const glowRing = buildEvidenceGlowRing();
    const size = item.scale || 0.38;
    glowRing.scale.set(size / 0.38, size / 0.38, 1);
    object.add(glowRing);

    const clueLight = new THREE.PointLight(0xffd056, 0, 6, 1.4);
    clueLight.position.set(0, 0.28, 0);
    object.add(clueLight);

    const marker = object.userData.marker;
    evidenceMeshes.push({ item, object, glowRing, marker, clueLight });
  }

  function buildEvidenceGlowRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.24, 0.36, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffd056,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.02;
    ring.renderOrder = 1398;
    return ring;
  }

  function buildEvidenceAsset(item) {
    const group = new THREE.Group();
    const size = item.scale || 0.38;
    const texture = new THREE.TextureLoader().load(evidenceSvgDataUri(item));
    texture.colorSpace = THREE.SRGBColorSpace;
    const marker = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
      })
    );
    marker.position.y = size * 0.42;
    marker.renderOrder = 1400;
    marker.userData.evidence = item;
    group.add(marker);
    group.userData.marker = marker;
    return group;
  }

  function evidenceSvgDataUri(item) {
    const accent = `#${item.color.toString(16).padStart(6, "0")}`;
    const device = deviceSvg(item, accent);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
        <g>
          ${device}
        </g>
      </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function deviceSvg(item, accent) {
    if (item.key === "memory_card") {
      return `
        <g transform="translate(110 110) rotate(-12)">
          <path d="M-54 -64h76l32 34v94a12 12 0 0 1-12 12h-96a12 12 0 0 1-12-12V-52a12 12 0 0 1 12-12z" fill="#15191c" stroke="#090b0d" stroke-width="5"/>
          <path d="M22 -64v34h32" fill="#242a2e"/>
          <g fill="#b58d39">
            <rect x="-40" y="-48" width="10" height="32" rx="2"/>
            <rect x="-24" y="-48" width="10" height="32" rx="2"/>
            <rect x="-8" y="-48" width="10" height="32" rx="2"/>
            <rect x="8" y="-48" width="10" height="32" rx="2"/>
          </g>
          <line x1="-42" y1="16" x2="42" y2="16" stroke="#343b40" stroke-width="4"/>
          <line x1="-42" y1="38" x2="20" y2="38" stroke="#343b40" stroke-width="4"/>
        </g>`;
    }
    if (item.key === "camera_panel") {
      return `
        <g transform="translate(110 110)">
          <rect x="-50" y="-76" width="100" height="152" rx="14" fill="#111719" stroke="#07090a" stroke-width="5"/>
          <rect x="-30" y="-52" width="60" height="38" rx="5" fill="#1d3435" stroke="#426768" stroke-width="3"/>
          <circle cx="25" cy="35" r="12" fill="#090b0d" stroke="#445258" stroke-width="4"/>
          <path d="M-28 16h28M-28 30h22M-28 44h18" stroke="#48545a" stroke-width="5" stroke-linecap="round"/>
          <path d="M58 -62c24 34 24 72 0 112" stroke="#58666b" stroke-width="7" fill="none"/>
        </g>`;
    }
    return `
      <g transform="translate(110 110) rotate(-14)">
        <rect x="-42" y="-78" width="84" height="156" rx="18" fill="#111820" stroke="#07090c" stroke-width="5"/>
        <rect x="-28" y="-50" width="56" height="74" rx="8" fill="#101820" stroke="#3a4f5a" stroke-width="3"/>
        <circle cx="0" cy="50" r="12" fill="#1b0705" stroke="#7b2a22" stroke-width="4"/>
        <path d="M-18 -30h36M-18 -14h36M-18 2h36" stroke="#66747a" stroke-width="5" stroke-linecap="round"/>
        <path d="M-58 -24c-12 18-12 48 0 66" stroke="#4f6570" stroke-width="6" fill="none"/>
      </g>`;
  }

  function wireUI() {
    canvas.addEventListener("pointerdown", event => {
      drag = { x: event.clientX, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      if (!drag) {
        setHoveredEvidence(hitEvidence(event));
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 9) drag.moved = true;
      yaw = Math.max(-1.7, Math.min(1.4, yaw - dx * 0.004));
      pitch = Math.max(-0.38, Math.min(0.28, pitch - dy * 0.003));
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateCamera();
    });
    canvas.addEventListener("pointerup", event => {
      if (drag && !drag.moved) inspectAt(event);
      drag = null;
    });
    canvas.addEventListener("wheel", event => {
      if (!active) return;
      event.preventDefault();
      setZoom(cameraFov + (event.deltaY > 0 ? 4 : -4));
    }, { passive: false });

    window.addEventListener("keydown", event => {
      if (!active) return;
      const key = event.key.toLowerCase();
      if (key === "f") {
        setFlashlight(!flashlightOn);
        return;
      }
      if (["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"].includes(key)) {
        movement.add(key);
        event.preventDefault();
      }
    });
    window.addEventListener("keyup", event => movement.delete(event.key.toLowerCase()));
    $("ri-hint-btn").addEventListener("click", revealNextHint);
    $("ri-back").addEventListener("click", () => {
      if (onBack) onBack();
    });
    $("ri-flashlight")?.addEventListener("click", () => setFlashlight(!flashlightOn));
    $("ri-continue").addEventListener("click", () => {
      if (!allRequiredEvidenceCollected() || !onAdvance) return;
      if (!reviewOpen) {
        showReview();
        return;
      }
      if (!allRequiredAdded()) return;
      hide();
      onAdvance();
    });
  }

  function inspectAt(event) {
    const item = hitEvidence(event);
    if (item) {
      setHoveredEvidence(item);
      collectEvidence(item);
    }
  }

  function hitEvidence(event) {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const targets = evidenceMeshes
      .filter(entry => !collected.has(entry.item.key))
      .map(entry => entry.object)
      .filter(target => target.visible);
    const hit = raycaster.intersectObjects(targets, true)[0];
    return hit?.object.userData.evidence || null;
  }

  function setHoveredEvidence(item) {
    const entry = item && evidenceMeshes.find(candidate => candidate.item.key === item.key);
    if (hoveredEntry === entry) return;
    hoveredEntry = entry || null;
    canvas.style.cursor = hoveredEntry ? "pointer" : "grab";
  }

  function setFlashlight(enabled) {
    flashlightOn = enabled;
    if (flashlight) flashlight.visible = enabled;
    const button = $("ri-flashlight");
    if (!button) return;
    button.textContent = enabled ? "LIGHT ON" : "LIGHT OFF";
    button.setAttribute("aria-pressed", String(enabled));
  }

  function setZoom(nextFov) {
    cameraFov = Math.max(34, Math.min(76, nextFov));
    if (camera) {
      camera.fov = cameraFov;
      camera.updateProjectionMatrix();
    }
  }

  function collectEvidence(item) {
    if (!item || collected.has(item.key)) return;
    collected.add(item.key);
    if (hintedKey === item.key) {
      hintedKey = null;
      $("ri-hint-text")?.classList.remove("is-active");
      $("ri-hint-btn")?.classList.remove("is-active");
    }
    const entry = evidenceMeshes.find(candidate => candidate.item.key === item.key);
    if (entry) {
      entry.object.visible = false;
      if (entry.glowRing?.material) entry.glowRing.material.opacity = 0;
      if (entry.clueLight) entry.clueLight.intensity = 0;
    }
    setHoveredEvidence(null);
    if (allRequiredEvidenceCollected()) showReview();
    updateEvidenceList();
  }

  function resetHint() {
    nextHintIndex = 0;
    hintedKey = null;
    const text = $("ri-hint-text");
    const btn = $("ri-hint-btn");
    if (text) {
      text.textContent = "Tap for a search area.";
      text.classList.remove("is-active");
    }
    btn?.classList.remove("is-active");
  }

  function revealNextHint() {
    const remaining = evidence.filter(item => requiredEvidenceKeys.has(item.key) && !collected.has(item.key));
    const text = $("ri-hint-text");
    const btn = $("ri-hint-btn");
    if (!remaining.length) {
      text.textContent = "The three key clues are recovered.";
      text?.classList.remove("is-active");
      btn?.classList.remove("is-active");
      hintedKey = null;
      return;
    }
    const item = remaining[nextHintIndex % remaining.length];
    nextHintIndex += 1;
    hintedKey = item.key;
    if (text) {
      text.textContent = item.hint;
      text.classList.add("is-active");
    }
    btn?.classList.add("is-active");
  }

  function orientEvidenceToCamera(entry) {
    const target = entry.object;
    const dx = camera.position.x - target.position.x;
    const dz = camera.position.z - target.position.z;
    target.rotation.y = Math.atan2(dx, dz);
  }

  function updateEvidenceList() {
    if (!$("ri-evidence-list")) return;
    const list = $("ri-evidence-list");
    list.innerHTML = "";
    const logged = evidence.filter(item => collected.has(item.key));
    if (!logged.length) {
      const empty = document.createElement("div");
      empty.className = "ri-evidence-empty";
      empty.textContent = "None logged";
      list.appendChild(empty);
    }
    logged.forEach(item => {
      const line = document.createElement("div");
      line.className = "ri-evidence-row ri-found";
      line.textContent = item.label;
      list.appendChild(line);
    });
    const requiredCount = requiredEvidenceCount();
    $("ri-counter").textContent = `${requiredCount} / ${requiredEvidenceTotal} KEY CLUES`;
    const proceed = $("ri-continue");
    const ready = allRequiredEvidenceCollected();
    proceed.disabled = !ready;
    if (!ready) {
      proceed.textContent = "FIND 3 KEY CLUES";
    } else if (!reviewOpen) {
      proceed.textContent = "REVIEW EVIDENCE";
    } else {
      proceed.textContent = allRequiredAdded() ? "RETURN TO SURVEILLANCE" : "ADD TO CASE FILE";
    }
  }

  function requiredEvidenceCount() {
    return [...requiredEvidenceKeys].filter(key => collected.has(key)).length;
  }

  function allRequiredEvidenceCollected() {
    return requiredEvidenceCount() >= requiredEvidenceTotal;
  }

  function updateCamera() {
    const look = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
    camera.lookAt(camera.position.clone().add(look));
  }

  function moveCamera() {
    if (!movement.size) return;
    const speed = 0.07;
    const forward = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    if (movement.has("w") || movement.has("arrowup")) camera.position.addScaledVector(forward, speed);
    if (movement.has("s") || movement.has("arrowdown")) camera.position.addScaledVector(forward, -speed);
    if (movement.has("a") || movement.has("arrowleft")) camera.position.addScaledVector(right, -speed);
    if (movement.has("d") || movement.has("arrowright")) camera.position.addScaledVector(right, speed);
    camera.position.x = Math.max(-5.8, Math.min(5.8, camera.position.x));
    camera.position.z = Math.max(-5.2, Math.min(4.8, camera.position.z));
    updateCamera();
  }

  function resize() {
    if (!renderer || !root) return;
    const w = root.clientWidth  || innerWidth;
    const h = root.clientHeight || innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ssW = w * 2 * dpr;
    const ssH = h * 2 * dpr;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function render() {
    if (!active) return;
    markerClock += 0.045;
    moveCamera();
    evidenceMeshes.forEach((entry, index) => {
      if (collected.has(entry.item.key)) return;
      if (!entry.object.visible) {
        if (entry.glowRing?.material) entry.glowRing.material.opacity = 0;
        if (entry.clueLight) entry.clueLight.intensity = 0;
        return;
      }
      orientEvidenceToCamera(entry);
      const hinted = hintedKey === entry.item.key;
      const hovered = entry === hoveredEntry;
      const pulse = 0.5 + Math.sin(markerClock * 2.4 + index) * 0.5;
      const hintPulse = 0.55 + Math.sin(markerClock * 3.6 + index) * 0.45;

      if (hinted) {
        entry.glowRing.material.opacity = 0.35 + hintPulse * 0.55;
        entry.glowRing.material.color.setHex(0xffd056);
        entry.glowRing.scale.setScalar(1 + hintPulse * 0.22);
        entry.clueLight.intensity = 2.4 + hintPulse * 1.8;
        entry.clueLight.color.setHex(0xffd056);
        entry.marker.material.opacity = 1;
      } else if (hovered) {
        entry.glowRing.material.opacity = 0.22 + pulse * 0.18;
        entry.glowRing.material.color.setHex(0xa8c8ff);
        entry.glowRing.scale.setScalar(1);
        entry.clueLight.intensity = 1.1 + pulse * 0.5;
        entry.clueLight.color.setHex(0xa8c8ff);
        entry.marker.material.opacity = 1;
      } else {
        entry.glowRing.material.opacity = 0.08 + pulse * 0.06;
        entry.glowRing.material.color.setHex(0xffd056);
        entry.glowRing.scale.setScalar(1);
        entry.clueLight.intensity = 0.35 + pulse * 0.15;
        entry.clueLight.color.setHex(0xffd056);
        entry.marker.material.opacity = 0.92;
      }
    });
    renderer.render(scene, camera);

    animationId = requestAnimationFrame(render);
  }

  return { activate, showBrief, hide, reset };
})();

window.RI = RI;
