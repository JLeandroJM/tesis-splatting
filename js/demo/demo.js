/* ============================================================
   Demo principal (index.html#demo): clips pre-renderizados.
   Datos: assets/demo/manifest.json (lista de clips) y
   assets/demo/<carpeta>/clip.json (metadatos de cada clip).
   Esquema documentado en el README.

   - Solo se cargan los archivos del clip activo, y dentro de él
     cada grupo de videos se carga al acercarse a la pantalla.
   - Los grupos de videos arrancan sincronizados cuando todos están
     listos y se pausan al salir de pantalla.
   - Todo archivo que falte (404) se muestra como "Pendiente: <archivo>"
     con la proporción del clip: la página nunca queda rota.
   - Enlaces directos: #demo y ?clip=<id>.
   Módulo ES: no crea globales.
   ============================================================ */

const KS_POR_DEFECTO = [100, 1000, 10000, 50000, 175000];
const N_FRAMES_EXPLORA = 5;
// Modelos de la rejilla si clip.json no trae "modelos" (uno por entrenamiento).
const MODELOS_POR_DEFECTO = [
  { archivo: "n05k.mp4", manchas: 5000 },
  { archivo: "n50k.mp4", manchas: 50000 },
  { archivo: "n100k.mp4", manchas: 100000 },
  { archivo: "n175k.mp4", manchas: 175000 },
];
const ESPERA_MAX_LISTOS = 15000;       // ms: si un video no responde, arrancan los demás
const DERIVA_MAX = 0.1;                // s de desfase tolerado entre videos de un grupo

const reduceMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- utilidades ----------
const miles = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const segundos = (s) => s.toLocaleString("es", { maximumFractionDigits: 1 }) + " s";

function el(tag, attrs = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "texto") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...hijos.filter((h) => h !== null && h !== undefined));
  return e;
}

async function leerJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Caja de medio con la proporción del clip y su marcador "Pendiente".
function crearMedio(ar, pie) {
  const caja = el("div", { class: "medio" });
  const pend = el("div", { class: "pendiente", hidden: true });
  caja.append(pend);
  const fig = el("figure", { class: "medio-fig" }, caja, pie ? el("figcaption", { texto: pie }) : null);
  fig.style.setProperty("--ar", ar.css);
  fig.style.setProperty("--ar-num", ar.num);
  return {
    fig, caja,
    pendiente(nombre) {
      pend.textContent = `Pendiente: ${nombre}`;
      pend.hidden = false;
      caja.querySelectorAll("video, img").forEach((m) => (m.hidden = true));
    },
    disponible(m) {
      pend.hidden = true;
      m.hidden = false;
    },
  };
}

// ---------- grupo de videos sincronizados ----------
class GrupoVideos {
  // items: [{ medio, url, nombre }]; observado: elemento que decide carga y visibilidad
  constructor(items, observado, boton) {
    this.items = items.map((it) => {
      const v = el("video", { muted: true, loop: true, playsinline: true, preload: "none", "aria-hidden": "true" });
      v.muted = true; v.defaultMuted = true; v.playsInline = true;
      it.medio.caja.prepend(v);
      return { ...it, v, fallo: false, resuelto: false };
    });
    this.boton = boton;
    boton.hidden = true;                  // se muestra cuando hay algún video que reproducir
    this.estado = "dormido";
    this.visible = false;
    this.quiere = !reduceMovimiento;      // intención de reproducir (el usuario puede pausar)
    this.bloqueado = false;               // el navegador rechazó play() (ahorro de batería, etc.)
    this.timers = [];
    boton.addEventListener("click", () => {
      this.quiere = !(this.quiere && !this.bloqueado);
      this.bloqueado = false;
      if (this.quiere) this.reproducir(); else this.pausar();
      this.actualizarBoton();
    });
    this.actualizarBoton();
    // precarga: al acercarse (200 px); visibilidad: en pantalla, sin margen
    this.ioCarga = new IntersectionObserver((entradas) => {
      if (entradas.some((x) => x.isIntersecting) && this.estado === "dormido") { this.ioCarga.disconnect(); this.cargar(); }
    }, { rootMargin: "200px 0px" });
    this.ioVisible = new IntersectionObserver((entradas) => {
      this.visible = entradas[entradas.length - 1].isIntersecting;
      if (this.visible && this.quiere && this.estado === "listo") this.reproducir();
      if (!this.visible) this.pausar();
    });
    this.ioCarga.observe(observado);
    this.ioVisible.observe(observado);
  }

  cargar() {
    this.estado = "cargando";
    const resolver = (it, ok) => {
      if (!ok) { it.fallo = true; it.medio.pendiente(it.nombre); }   // también si llega tarde
      if (it.resuelto) return;
      it.resuelto = true;
      if (this.items.every((x) => x.resuelto)) this.listo();
    };
    for (const it of this.items) {
      it.v.addEventListener("canplay", () => resolver(it, true), { once: true });
      it.v.addEventListener("error", () => resolver(it, false), { once: true });
      it.v.preload = "auto";
      it.v.src = it.url;
      it.v.load();
    }
    // si alguno no responde, arrancan los que sí
    this.timers.push(setTimeout(() => {
      this.items.forEach((it) => { it.resuelto = true; });
      this.listo();
    }, ESPERA_MAX_LISTOS));
  }

  listo() {
    if (this.estado === "listo") return;
    this.estado = "listo";
    this.vivos = this.items.filter((it) => !it.fallo).map((it) => it.v);
    if (!this.vivos.length) return;
    this.boton.hidden = false;
    this.vivos.forEach((v) => { v.currentTime = 0; });
    if (this.visible && this.quiere) this.reproducir();
    this.actualizarBoton();
  }

  reproducir() {
    if (this.estado !== "listo" || !this.vivos.length) return;
    const m = this.vivos[0];
    this.vivos.forEach((v) => { if (v !== m) v.currentTime = m.currentTime; });
    Promise.all(this.vivos.map((v) => v.play())).then(
      () => { this.bloqueado = false; this.actualizarBoton(); },
      () => { this.bloqueado = true; this.vivos.forEach((v) => v.pause()); this.actualizarBoton(); },
    );
    if (!this.deriva) {
      this.deriva = setInterval(() => {
        const m0 = this.vivos[0];
        if (m0.paused) return;
        this.vivos.forEach((v) => { if (v !== m0 && Math.abs(v.currentTime - m0.currentTime) > DERIVA_MAX) v.currentTime = m0.currentTime; });
      }, 500);
    }
  }

  pausar() {
    this.vivos?.forEach((v) => v.pause());
    clearInterval(this.deriva);
    this.deriva = null;
  }

  actualizarBoton() {
    const sonando = this.quiere && !this.bloqueado;
    this.boton.textContent = sonando ? "❚❚ Pausar" : "▶ Reproducir";
    this.boton.setAttribute("aria-pressed", String(!sonando));
  }

  destruir() {
    this.ioCarga.disconnect();
    this.ioVisible.disconnect();
    this.pausar();
    this.timers.forEach(clearTimeout);
    for (const it of this.items) { it.v.removeAttribute("src"); it.v.load(); }  // corta la descarga
  }
}

// ---------- explorador de un instante ----------
function crearExplorador(clip, base, ar) {
  const ks = clip.ks;
  const kMax = ks[ks.length - 1];
  const frames = clip.frames;
  const e = { f: 0, k: ks.length - 1, modo: "video", turno: 0 };
  const cache = new Map();

  const precargar = (url) => {
    if (!cache.has(url)) {
      cache.set(url, new Promise((res) => {
        const im = new Image();
        im.onload = () => res(true);
        im.onerror = () => res(false);
        im.src = url;
      }));
    }
    return cache.get(url);
  };
  const jDe = (i) => frames[i]?.j;
  const nombre = (i, modo, k) => {
    const j = jDe(i) ?? "<j>";
    return modo === "original" ? `frame_${j}_original.webp` : `frame_${j}_k${k}_${modo}.webp`;
  };

  // frames
  const filaFrames = el("div", { class: "frames", role: "group", "aria-label": "Instante" });
  const botonesFrame = frames.map((fr, i) => {
    const b = el("button", { type: "button", class: "frame-btn", "aria-pressed": String(i === 0) },
      `Frame ${i + 1}`, el("small", { texto: fr.segundo != null ? segundos(fr.segundo) : "—" }));
    b.addEventListener("click", () => { e.f = i; marcar(botonesFrame, i); precargarFrame(); mostrar(); });
    filaFrames.append(b);
    return b;
  });

  // imagen
  const medio = crearMedio(ar);
  const img = el("img", { alt: "", decoding: "async", hidden: true });
  medio.caja.prepend(img);
  const texto = el("p", { class: "explora-texto" });

  // número de manchas: 5 posiciones fijas
  const rango = el("input", { type: "range", min: "0", max: String(ks.length - 1), step: "1", value: String(e.k), "aria-label": "Número de manchas" });
  const marcas = el("div", { class: "escala-marcas" });
  const botonesK = ks.map((k, i) => {
    const b = el("button", { type: "button", texto: miles(k), "aria-label": `${miles(k)} manchas` });
    b.addEventListener("click", () => ponerK(i));
    marcas.append(b);
    return b;
  });
  const escala = el("div", { class: "escala" }, el("div", { class: "escala-titulo" }, el("span", { texto: "Número de manchas" }), el("span", { class: "escala-valor" })), rango, marcas);
  rango.addEventListener("input", () => ponerK(Number(rango.value)));
  function ponerK(i) {
    e.k = i;
    rango.value = String(i);
    escala.querySelector(".escala-valor").textContent = miles(ks[i]);
    botonesK.forEach((b, x) => b.classList.toggle("activa", x === i));
    mostrar();
  }

  // modo
  const modos = el("div", { class: "segmentado", role: "group", "aria-label": "Qué mostrar" });
  const botonesModo = [["video", "Imagen"], ["manchas", "Ver manchas"], ["original", "Original"]].map(([m, t], i) => {
    const b = el("button", { type: "button", "aria-pressed": String(i === 0), texto: t });
    b.addEventListener("click", () => { e.modo = m; marcar(botonesModo, i); mostrar(); });
    modos.append(b);
    return b;
  });

  function marcar(botones, i) { botones.forEach((b, x) => b.setAttribute("aria-pressed", String(x === i))); }

  function precargarFrame() {
    if (jDe(e.f) === undefined || jDe(e.f) === null) return;
    precargar(base + nombre(e.f, "original"));
    for (const k of ks) for (const m of ["video", "manchas"]) precargar(base + nombre(e.f, m, k));
  }

  function mostrar() {
    const k = ks[e.k];
    const archivo = nombre(e.f, e.modo, k);
    escala.classList.toggle("inactiva", e.modo === "original");
    rango.disabled = e.modo === "original";
    texto.textContent = e.modo === "original"
      ? "Cuadro original del video."
      : `Las ${miles(k)} manchas más importantes del modelo de ${miles(kMax)}`;
    const turno = ++e.turno;
    if (jDe(e.f) === undefined || jDe(e.f) === null) { medio.pendiente(archivo); return; }
    precargar(base + archivo).then((ok) => {
      if (turno !== e.turno) return;                      // el usuario ya eligió otra cosa
      if (ok) { img.src = base + archivo; medio.disponible(img); }
      else medio.pendiente(archivo);
    });
  }

  // se precarga al acercarse, no al abrir el clip
  const cont = el("div", { class: "explora" }, filaFrames, el("div", { class: "explora-img" }, medio.fig), texto, escala, modos);
  const io = new IntersectionObserver((en) => {
    if (en.some((x) => x.isIntersecting)) { io.disconnect(); precargarFrame(); ponerK(e.k); }
  }, { rootMargin: "300px 0px" });
  io.observe(cont);
  if (!frames.some((f) => f.j != null)) ponerK(e.k);        // sin datos: mostrar marcadores ya
  return { cont, destruir: () => io.disconnect() };
}

// ---------- clip ----------
function normalizar(datos, meta) {
  const d = datos || {};
  const ancho = Number(d.ancho), alto = Number(d.alto);
  const conProporcion = ancho > 0 && alto > 0;
  let frames = Array.isArray(d.frames) ? d.frames.slice(0, N_FRAMES_EXPLORA) : [];
  frames = frames.map((f) => ({ j: f.j, segundo: f.segundo ?? (d.fps ? f.j / d.fps : null) }));
  while (frames.length < N_FRAMES_EXPLORA) frames.push({ j: null, segundo: null });
  return {
    titulo: d.titulo || meta.titulo,
    credito: d.credito,
    fps: d.fps,
    ks: Array.isArray(d.ks) && d.ks.length ? d.ks : KS_POR_DEFECTO,
    frames,
    modelos: Array.isArray(d.modelos) && d.modelos.length ? d.modelos : MODELOS_POR_DEFECTO,
    notaModelos: d.nota_modelos,
    reconstruccion: d.reconstruccion,
    // sin clip.json se enseña la estructura completa; con él, solo lo que declara
    conExplorador: !datos || (Array.isArray(d.frames) && d.frames.length > 0),
    ar: conProporcion ? { css: `${ancho} / ${alto}`, num: ancho / alto } : { css: "16 / 9", num: 16 / 9 },
  };
}

function lineaMetricas(clip) {
  const partes = clip.modelos
    .map((m) => {
      if (m.psnr == null && m.ssim == null) return null;
      const v = [m.psnr != null ? `PSNR ${m.psnr.toLocaleString("es", { maximumFractionDigits: 2 })} dB` : null,
        m.ssim != null ? `SSIM ${m.ssim.toLocaleString("es", { maximumFractionDigits: 3 })}` : null].filter(Boolean).join(", ");
      return `${miles(m.manchas)} manchas: ${v}`;
    })
    .filter(Boolean);
  return partes.length ? el("p", { class: "note demo-tecnico", texto: `Técnico: ${partes.join(" · ")}.` }) : null;
}

function construirClip(clip, base, datosFaltan) {
  const destructores = [];
  const frag = document.createDocumentFragment();
  if (datosFaltan) frag.append(el("div", { class: "pendiente pendiente-linea", texto: "Pendiente: clip.json" }));

  // el video reconstruido, con sonido y controles (solo si clip.json lo declara)
  if (clip.reconstruccion?.archivo) {
    const r = clip.reconstruccion;
    const ar = r.ancho > 0 && r.alto > 0 ? { css: `${r.ancho} / ${r.alto}`, num: r.ancho / r.alto } : clip.ar;
    const medio = crearMedio(ar);
    const v = el("video", { controls: true, playsinline: true, preload: "none", src: base + r.archivo, poster: r.poster ? base + r.poster : null });
    v.addEventListener("error", () => medio.pendiente(r.archivo), { once: true });
    medio.caja.prepend(v);
    // se pausa al salir de pantalla
    const io = new IntersectionObserver((en) => { if (!en[en.length - 1].isIntersecting) v.pause(); });
    io.observe(medio.caja);
    destructores.push({ destruir: () => { io.disconnect(); v.pause(); v.removeAttribute("src"); v.load(); } });
    frag.append(el("div", { class: "demo-bloque demo-reconstruido" },
      el("h3", { texto: "El video, dibujado con manchas" }),
      medio.fig,
      el("p", { class: "demo-nota", texto: "Todo lo que ves aquí son 175 000 manchas de color moviéndose. Dale a reproducir y sube el volumen." })));
  }

  // A) más manchas, más detalle
  const rejilla = el("div", { class: "rejilla" });
  const videos = [["original.mp4", "Original"], ...clip.modelos.map((m) => [m.archivo, m.etiqueta || `${miles(m.manchas)} manchas`])];
  // con un número impar de videos, el original va arriba a todo el ancho
  rejilla.classList.toggle("impar", videos.length % 2 === 1);
  const itemsRejilla = videos.map(([archivo, etiqueta]) => {
    const medio = crearMedio(clip.ar, etiqueta);
    rejilla.append(medio.fig);
    return { medio, url: base + archivo, nombre: archivo };
  });
  const botonRejilla = el("button", { type: "button", class: "ctrl-btn ghost" });
  destructores.push(new GrupoVideos(itemsRejilla, rejilla, botonRejilla));
  frag.append(el("div", { class: "demo-bloque" },
    el("h3", { texto: "Más manchas, más detalle" }),
    rejilla,
    el("p", { class: "demo-nota", texto: clip.notaModelos || "Cada video es un modelo distinto: el clip representado con ese número de manchas de color." }),
    lineaMetricas(clip),
    el("div", { class: "grupo-ctrl" }, botonRejilla)));

  // B) explora un instante
  if (clip.conExplorador) {
    const explorador = crearExplorador(clip, base, clip.ar);
    destructores.push(explorador);
    frag.append(el("div", { class: "demo-bloque" }, el("h3", { texto: "Explora un instante" }), explorador.cont));
  }

  // C) crédito
  frag.append(el("p", { class: "credito-clip", texto: clip.credito || "Fuente del clip: pendiente." }));
  return { frag, destruir: () => destructores.forEach((d) => d.destruir()) };
}

// ---------- demo ----------
async function initDemo(root) {
  const chips = root.querySelector(".chips");
  const zona = root.querySelector(".demo-clip");
  const urlManifest = new URL(root.dataset.manifest, location.href);
  const params = new URLSearchParams(location.search);
  let actual = null, turno = 0;

  const manifest = await leerJSON(urlManifest.href);
  const clips = Array.isArray(manifest?.clips) ? manifest.clips : [];
  if (!clips.length) {
    zona.replaceChildren(el("div", { class: "pendiente pendiente-linea", texto: `Pendiente: ${root.dataset.manifest}` }));
    return;
  }

  const botones = clips.map((c) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": "false" });
    if (c.miniatura) {
      const im = el("img", { src: new URL(c.miniatura, urlManifest).href, alt: "", loading: "lazy", decoding: "async" });
      im.addEventListener("error", () => im.remove());   // sin miniatura: solo el título
      b.append(im);
    }
    b.append(el("span", { texto: c.titulo || c.id }));
    b.addEventListener("click", () => {
      if (c === actual) return;
      abrir(c);
      history.replaceState(null, "", `?clip=${encodeURIComponent(c.id)}#demo`);
    });
    chips.append(b);
    return b;
  });

  async function abrir(c) {
    const miTurno = ++turno;
    actual?.vista?.destruir();
    actual = c;
    botones.forEach((b, i) => b.setAttribute("aria-pressed", String(clips[i] === c)));
    botones[clips.indexOf(c)].scrollIntoView({ block: "nearest", inline: "nearest" });
    const base = new URL((c.carpeta || c.id).replace(/\/?$/, "/"), urlManifest).href;
    const datos = await leerJSON(base + "clip.json");
    if (miTurno !== turno) return;
    const clip = normalizar(datos, c);
    const vista = construirClip(clip, base, !datos);
    c.vista = vista;
    zona.replaceChildren(vista.frag);
  }

  abrir(clips.find((c) => c.id === params.get("clip")) || clips[0]);

  // enlace directo (QR): colocar #demo arriba aunque cambien las alturas al cargar
  if (location.hash === "#demo" || params.has("clip")) {
    let tocado = false;
    for (const ev of ["wheel", "touchmove", "keydown", "pointerdown"]) addEventListener(ev, () => (tocado = true), { once: true, passive: true });
    const colocar = () => { if (!tocado) document.getElementById("demo").scrollIntoView({ block: "start" }); };
    colocar();
    document.fonts?.ready.then(colocar);
    addEventListener("load", () => setTimeout(colocar, 0));
    const ro = new ResizeObserver(colocar);
    ro.observe(document.body);
    setTimeout(() => ro.disconnect(), 4000);
  }
}

document.querySelectorAll("[data-demo]").forEach(initDemo);
