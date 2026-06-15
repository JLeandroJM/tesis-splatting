/* ============================================================
   Reproductor A/B de audio.
   Alterna entre GT / Gabor (ours) / baseline manteniendo el
   currentTime y el estado de reproducción, para comparar el
   MISMO instante entre versiones. Sin dependencias.
   ============================================================ */

function initAudioAB(root) {
  const audio = root.querySelector("audio");
  const sources = Array.from(root.querySelectorAll(".src"));
  const playBtn = root.querySelector(".play");
  const bar = root.querySelector(".bar");
  const fill = root.querySelector(".bar .fill");
  const time = root.querySelector(".time");

  let current = sources[0];

  function fmt(t) {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function selectSource(btn) {
    if (btn === current) return;
    const wasPlaying = !audio.paused;
    const t = audio.currentTime;
    sources.forEach(s => s.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    current = btn;
    audio.src = btn.dataset.src;
    audio.load();
    // restaurar instante y estado tras cargar
    const restore = () => {
      audio.currentTime = Math.min(t, audio.duration || t);
      if (wasPlaying) audio.play().catch(()=>{});
      audio.removeEventListener("loadedmetadata", restore);
    };
    audio.addEventListener("loadedmetadata", restore);
  }

  sources.forEach(s => {
    s.addEventListener("click", () => selectSource(s));
  });

  function setPlayIcon() { playBtn.textContent = audio.paused ? "▶" : "❚❚"; }

  playBtn.addEventListener("click", () => {
    if (audio.paused) audio.play().catch(()=>{}); else audio.pause();
  });
  audio.addEventListener("play", setPlayIcon);
  audio.addEventListener("pause", setPlayIcon);

  audio.addEventListener("timeupdate", () => {
    const d = audio.duration || 0;
    const p = d ? (audio.currentTime / d) * 100 : 0;
    fill.style.width = p + "%";
    time.textContent = `${fmt(audio.currentTime)} / ${fmt(d)}`;
  });
  audio.addEventListener("ended", setPlayIcon);

  bar.addEventListener("click", (e) => {
    const r = bar.getBoundingClientRect();
    const p = (e.clientX - r.left) / r.width;
    audio.currentTime = p * (audio.duration || 0);
  });

  // init
  audio.src = current.dataset.src;
  current.setAttribute("aria-pressed", "true");
  setPlayIcon();
  time.textContent = "0:00 / 0:00";
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-audio-ab]").forEach(initAudioAB);
});
