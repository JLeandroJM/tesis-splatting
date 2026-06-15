/* ============================================================
   Hero: campo ambiental de "splats" gaussianos (el método
   representa una señal como suma de primitivas gaussianas).
   Respeta prefers-reduced-motion. + tabs + copiar BibTeX.
   ============================================================ */

function initSplatField() {
  const canvas = document.getElementById("splatfield");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, dpr, blobs;

  const palette = [
    [224,163,64],   // ámbar
    [91,91,214],    // indigo
    [80,196,200],   // cian apagado
    [150,120,230],  // violeta
  ];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.parentElement.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeBlobs() {
    const n = Math.max(16, Math.min(34, Math.round(W / 36)));
    blobs = Array.from({ length: n }, () => {
      const c = palette[Math.floor(Math.random() * palette.length)];
      return {
        x: Math.random() * W, y: Math.random() * H,
        rx: 60 + Math.random() * 150, ry: 40 + Math.random() * 110,
        rot: Math.random() * Math.PI,
        vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
        a: 0.05 + Math.random() * 0.10, c,
      };
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(b.rx, b.ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      const [r, gg, bl] = b.c;
      g.addColorStop(0, `rgba(${r},${gg},${bl},${b.a})`);
      g.addColorStop(1, `rgba(${r},${gg},${bl},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function step() {
    for (const b of blobs) {
      b.x += b.vx; b.y += b.vy;
      if (b.x < -200) b.x = W + 200; if (b.x > W + 200) b.x = -200;
      if (b.y < -200) b.y = H + 200; if (b.y > H + 200) b.y = -200;
    }
    draw();
    requestAnimationFrame(step);
  }

  resize(); makeBlobs(); draw();
  window.addEventListener("resize", () => { resize(); makeBlobs(); draw(); });
  if (!reduce) requestAnimationFrame(step);
}

function initTabs() {
  document.querySelectorAll("[data-tabs]").forEach(group => {
    const tabs = Array.from(group.querySelectorAll(".tab"));
    const panels = Array.from(group.querySelectorAll(".panel"));
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.setAttribute("aria-selected", "false"));
        panels.forEach(p => p.classList.remove("active"));
        tab.setAttribute("aria-selected", "true");
        panels[i].classList.add("active");
        // pausa los videos de los paneles ocultos; reproduce los del activo
        panels.forEach((p, j) => {
          const vids = p.querySelectorAll("video");
          if (j === i) vids.forEach(v => v.play().catch(()=>{}));
          else vids.forEach(v => v.pause());
        });
      });
    });
  });
}

function initCopyBib() {
  const btn = document.querySelector(".copybib");
  const pre = document.querySelector("pre.bib");
  if (!btn || !pre) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.trim());
      const old = btn.textContent;
      btn.textContent = "¡Copiado!";
      setTimeout(() => (btn.textContent = old), 1600);
    } catch { btn.textContent = "Selecciona y copia manualmente"; }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initSplatField();
  initTabs();
  initCopyBib();
});
