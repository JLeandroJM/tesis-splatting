/* ============================================================
   Comparación de video — dos modos:
   (1) Slider sobre frame congelado (GT vs Ours)
   (2) Videos en loop lado a lado con control compartido
   Sin dependencias. Soporta ratón, táctil y teclado.
   ============================================================ */

// ---------- (1) SLIDER SOBRE FRAME ----------
function initCompareSlider(root) {
  const grip = root.querySelector(".grip");
  let dragging = false;

  function setSplit(clientX) {
    const r = root.getBoundingClientRect();
    let pct = ((clientX - r.left) / r.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    root.style.setProperty("--x", pct + "%");
    grip.setAttribute("aria-valuenow", Math.round(pct));
  }

  root.addEventListener("pointerdown", (e) => {
    dragging = true;
    root.setPointerCapture(e.pointerId);
    setSplit(e.clientX);
  });
  root.addEventListener("pointermove", (e) => { if (dragging) setSplit(e.clientX); });
  root.addEventListener("pointerup",   () => { dragging = false; });
  root.addEventListener("pointercancel", () => { dragging = false; });

  // teclado sobre el grip
  grip.addEventListener("keydown", (e) => {
    const cur = parseFloat(getComputedStyle(root).getPropertyValue("--x")) || 50;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft")  { root.style.setProperty("--x", Math.max(0, cur - step) + "%"); e.preventDefault(); }
    if (e.key === "ArrowRight") { root.style.setProperty("--x", Math.min(100, cur + step) + "%"); e.preventDefault(); }
    grip.setAttribute("aria-valuenow", Math.round(parseFloat(getComputedStyle(root).getPropertyValue("--x"))));
  });
}

// ---------- (2) VIDEOS LADO A LADO SINCRONIZADOS ----------
function initSyncedVideos(scope) {
  const videos = Array.from(scope.querySelectorAll("video[data-sync]"));
  if (!videos.length) return;
  const playBtn = scope.querySelector("[data-play]");
  const restartBtn = scope.querySelector("[data-restart]");

  function setIcon(playing) {
    if (playBtn) playBtn.querySelector(".lbl").textContent = playing ? "Pausar" : "Reproducir";
  }

  function playAll()  { videos.forEach(v => v.play().catch(()=>{})); setIcon(true); }
  function pauseAll() { videos.forEach(v => v.pause()); setIcon(false); }

  // re-sincroniza el resto al frame del primero (evita deriva)
  function resync(master) {
    videos.forEach(v => { if (v !== master) v.currentTime = master.currentTime; });
  }

  if (playBtn) playBtn.addEventListener("click", () => {
    if (videos[0].paused) playAll(); else pauseAll();
  });
  if (restartBtn) restartBtn.addEventListener("click", () => {
    videos.forEach(v => v.currentTime = 0);
    playAll();
  });

  // mantener sincronía cada vez que el master da una vuelta del loop
  videos[0].addEventListener("seeked", () => resync(videos[0]));
  videos[0].addEventListener("play", () => {
    videos.forEach(v => { if (v.paused) v.play().catch(()=>{}); });
    setIcon(true);
  });
  videos[0].addEventListener("pause", () => setIcon(false));
  // corrección de deriva periódica
  setInterval(() => {
    const m = videos[0];
    videos.forEach(v => {
      if (v !== m && Math.abs(v.currentTime - m.currentTime) > 0.12) v.currentTime = m.currentTime;
    });
  }, 1000);

  setIcon(!videos[0].paused);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".cs").forEach(initCompareSlider);
  document.querySelectorAll("[data-synced-group]").forEach(initSyncedVideos);
});
