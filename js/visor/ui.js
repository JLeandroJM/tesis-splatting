/* ============================================================
   Visor MBB-GS — interfaz de la sección #viewer.
   - Selector de modelos (assets/models/manifest.json; si no existe,
     el modelo de desarrollo de assets/models-dev/).
   - Carga diferida con IntersectionObserver; inmediata si la URL
     trae #viewer o ?modelo=<id> (el QR del stand apunta ahí).
   - Intro: la primera vez, el número de manchas sube de 1 a N en
     ~4 s (escala logarítmica) y luego se reproduce a velocidad normal.
   - Velocidad normal = frames enteros (como el video original);
     lenta y muy lenta = tiempo continuo, con instantes entre frames.
   - Render bajo demanda; se detiene fuera de pantalla y avisa al
     hero con el evento "visor:activo" para que pause su animación.
   Módulo ES: no crea globales.
   ============================================================ */

import { leerModelo, descargarModelo, tauDeFrame, acotarFrame } from "./formato.js";
import { RenderMBBGS } from "./render.js";

const MODELO_DEV = {
  id: "musical-dev",
  nombre: "Musical (desarrollo)",
  archivo: "assets/models-dev/musical-20s.bin",
  miniatura: "assets/models-dev/musical-20s.png",
  bytes: 22801804,
};
const DURACION_INTRO = 4000;          // ms
const UMBRAL_FRACCION = 0.02;         // |j - round(j)| a partir del cual el instante "nunca se grabó"
const VELOCIDADES = { normal: 1, lenta: 0.25, "muy-lenta": 0.1 };

const reduceMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- utilidades ----------
const mb = (b) => (b / 1e6).toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " MB";
// 150000 -> "150 000" (espacio no separable, como pide el texto de la demo)
const miles = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const reloj = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const suave = (x) => x * x * (3 - 2 * x);

// Slider táctil: arrastre con el dedo (touch-action: pan-y deja desplazar la
// página en vertical), clic en la pista y teclado. Valor en [0, 1].
function crearSlider(el, { alMover, alSoltar, paso = 0.01, texto }) {
  const carril = el.querySelector(".carril");
  let valor = 0, arrastrando = false;
  function poner(v, emitir) {
    valor = Math.min(1, Math.max(0, v));
    el.style.setProperty("--v", valor);
    el.setAttribute("aria-valuenow", Math.round(valor * 1000) / 10);
    if (texto) el.setAttribute("aria-valuetext", texto(valor));
    if (emitir) alMover(valor);
  }
  const desdeX = (x) => { const r = carril.getBoundingClientRect(); return (x - r.left) / r.width; };
  el.addEventListener("pointerdown", (e) => {
    arrastrando = true;
    el.setPointerCapture(e.pointerId);
    poner(desdeX(e.clientX), true);
  });
  el.addEventListener("pointermove", (e) => { if (arrastrando) poner(desdeX(e.clientX), true); });
  const soltar = () => { if (arrastrando) { arrastrando = false; alSoltar?.(); } };
  el.addEventListener("pointerup", soltar);
  el.addEventListener("pointercancel", soltar);
  el.addEventListener("keydown", (e) => {
    const p = e.shiftKey ? paso * 10 : paso;
    const nuevo = { ArrowLeft: valor - p, ArrowDown: valor - p, ArrowRight: valor + p, ArrowUp: valor + p,
      PageDown: valor - 0.1, PageUp: valor + 0.1, Home: 0, End: 1 }[e.key];
    if (nuevo === undefined) return;
    e.preventDefault();
    poner(nuevo, true);
    alSoltar?.();
  });
  return { poner: (v) => poner(v, false), get arrastrando() { return arrastrando; } };
}

// ---------- visor ----------
function initVisor(root) {
  const $ = (s) => root.querySelector(s);
  const escena = $(".visor-marco");
  const canvas = $("canvas");
  const poster = $(".visor-poster");
  const carga = $(".visor-carga");
  const mensaje = $(".visor-mensaje");
  const nunca = $(".visor-nunca");
  const controles = $(".visor-controles");
  const btnPlay = $(".play");
  const tiempo = $(".visor-tiempo");
  const valorManchas = $(".visor-manchas-valor");
  const tecnico = $(".visor-tecnico");
  const listaModelos = $(".visor-modelos");

  const params = new URLSearchParams(location.search);
  const e = {
    modelos: [], actual: null, render: null, cab: null, abortar: null,
    listo: false, visible: false, activo: false,
    j: 0, reproduciendo: false, velocidad: 1, s: 1, n: 1, modo: "imagen",
    intro: null, introHecha: false, sucio: true, ultimoJ: null, raf: 0, tPrevio: null,
  };

  function mostrarMensaje(html) {
    mensaje.innerHTML = html;
    mensaje.hidden = !html;
  }

  // ----- sliders -----
  const sliderTiempo = crearSlider($(".vslider-tiempo"), {
    paso: 1 / 200,
    texto: (v) => reloj(v * (e.cab ? e.cab.duracion_s ?? e.cab.n_frames / e.cab.fps : 0)),
    alMover: (v) => {
      if (!e.cab) return;
      e.j = v * (e.cab.n_frames - 1);          // continuo al arrastrar
      pedirDibujo();
    },
    alSoltar: () => { e.tPrevio = null; },
  });
  const nDeS = (s) => Math.max(1, Math.round(Math.pow(e.cab.n_gaussianas, s)));
  const sliderManchas = crearSlider($(".vslider-manchas"), {
    paso: 1 / 100,
    texto: (s) => e.cab ? `${miles(nDeS(s))} de ${miles(e.cab.n_gaussianas)}` : "",
    alMover: (s) => { if (e.cab) { ponerManchas(s); pedirDibujo(); } },
  });
  function ponerManchas(s) {
    e.s = s;
    e.n = nDeS(s);
    valorManchas.textContent = `${miles(e.n)} de ${miles(e.cab.n_gaussianas)}`;
    sliderManchas.poner(s);
  }

  // ----- botones -----
  function ponerReproduccion(si) {
    e.reproduciendo = si;
    e.tPrevio = null;
    btnPlay.textContent = si ? "❚❚" : "▶";
    btnPlay.setAttribute("aria-label", si ? "Pausar" : "Reproducir");
    e.sucio = true;
    pedirDibujo();
  }
  btnPlay.addEventListener("click", () => ponerReproduccion(!e.reproduciendo));
  canvas.addEventListener("click", () => { if (e.listo) ponerReproduccion(!e.reproduciendo); });

  function grupo(selector, alElegir) {
    const botones = Array.from(root.querySelectorAll(selector));
    botones.forEach((b) => b.addEventListener("click", () => {
      botones.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      alElegir(b.dataset.valor);
    }));
  }
  grupo("[data-velocidad]", (v) => { e.velocidad = VELOCIDADES[v]; e.sucio = true; pedirDibujo(); });
  grupo("[data-modo]", (v) => { e.modo = v; e.sucio = true; pedirDibujo(); });

  // cualquier interacción cancela la intro
  const cancelarIntro = () => { if (e.intro) { e.intro = null; } };
  controles.addEventListener("pointerdown", cancelarIntro, true);
  controles.addEventListener("keydown", cancelarIntro, true);
  canvas.addEventListener("pointerdown", cancelarIntro, true);

  // ----- bucle -----
  function pedirDibujo() {
    e.sucio = true;
    if (!e.raf && e.listo && e.visible) e.raf = requestAnimationFrame(bucle);
  }

  function bucle(t) {
    e.raf = 0;
    if (!e.listo || !e.visible) { e.tPrevio = null; return; }
    const cab = e.cab, ultimo = cab.n_frames - 1;
    const dt = e.tPrevio === null ? 0 : Math.min((t - e.tPrevio) / 1000, 0.1);
    e.tPrevio = t;

    if (e.intro) {
      if (e.intro.inicio === null) e.intro.inicio = t;
      const x = Math.min(1, (t - e.intro.inicio) / DURACION_INTRO);
      ponerManchas(suave(x));
      e.sucio = true;
      if (x >= 1) { e.intro = null; ponerReproduccion(true); }
    }
    if (e.reproduciendo && !sliderTiempo.arrastrando) {
      e.j += dt * cab.fps * e.velocidad;
      if (e.j > ultimo) e.j = 0;                // bucle
    }
    // velocidad normal = frames enteros, como el video grabado
    const jDibujo = e.reproduciendo && e.velocidad === 1 ? Math.floor(e.j) : acotarFrame(e.j, cab.n_frames);
    if (e.sucio || jDibujo !== e.ultimoJ) {
      e.render.dibujar({ j: jDibujo, n: e.n, modo: e.modo });
      e.ultimoJ = jDibujo;
      e.sucio = false;
      actualizarTiempo(jDibujo);
    }
    if (e.reproduciendo || e.intro) e.raf = requestAnimationFrame(bucle);
    else e.tPrevio = null;
  }

  function actualizarTiempo(j) {
    const cab = e.cab;
    const dur = cab.duracion_s ?? cab.n_frames / cab.fps;
    if (!sliderTiempo.arrastrando) sliderTiempo.poner(j / (cab.n_frames - 1));
    tiempo.textContent = `${reloj(j / cab.fps)} / ${reloj(dur)}`;
    nunca.hidden = Math.abs(j - Math.round(j)) <= UMBRAL_FRACCION;
    const tau = tauDeFrame(j, cab.n_frames);
    tecnico.textContent = `${miles(e.n)} gaussianas 2D de ${miles(cab.n_gaussianas)} · polinomios de Chebyshev (grado de posición ${cab.grados.mu}) · ` +
      `frame ${j.toFixed(2).replace(".", ",")} de ${cab.n_frames - 1} · τ = ${tau >= 0 ? "+" : "−"}${Math.abs(tau).toFixed(4).replace(".", ",")} · ` +
      `${cab.ancho}×${cab.alto} · composición ${e.render.formatoAcum}${e.render.evalEnGPU ? "" : " (respaldo)"}`;
  }

  // Avisa al hero para que pause su animación mientras el visor está activo.
  function actualizarActivo() {
    const activo = e.listo && e.visible;
    if (activo === e.activo) return;
    e.activo = activo;
    document.dispatchEvent(new CustomEvent("visor:activo", { detail: { activo } }));
    if (activo) { e.sucio = true; pedirDibujo(); }
  }

  // ----- modelos -----
  async function leerManifest() {
    const url = root.dataset.manifest;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      const base = new URL(url, location.href);
      return (m.modelos || []).map((x) => ({
        ...x,
        archivo: new URL(x.archivo, base).href,
        miniatura: x.miniatura && new URL(x.miniatura, base).href,
      }));
    } catch {
      return [MODELO_DEV];                       // mientras no exista el manifest
    }
  }

  function construirSelector() {
    listaModelos.innerHTML = "";
    for (const m of e.modelos) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "visor-modelo";
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = `${m.miniatura ? `<img src="${m.miniatura}" alt="" loading="lazy">` : ""}` +
        `<span><span class="nombre"></span><span class="mb">${m.bytes ? mb(m.bytes) : ""}</span></span>`;
      b.querySelector(".nombre").textContent = m.nombre;
      b.addEventListener("click", () => { if (m !== e.actual) cargarModelo(m); });
      m.boton = b;
      listaModelos.append(b);
    }
  }

  function modeloInicial() {
    const id = params.get("modelo");
    return e.modelos.find((m) => m.id === id) || e.modelos[0];
  }

  async function cargarModelo(m) {
    e.abortar?.abort();
    const abortar = (e.abortar = new AbortController());
    e.actual = m;
    e.modelos.forEach((x) => x.boton.setAttribute("aria-pressed", String(x === m)));
    e.listo = false;
    actualizarActivo();
    e.intro = null;
    ponerReproduccion(false);
    if (m.miniatura) { poster.src = m.miniatura; poster.hidden = false; }
    canvas.hidden = true;
    mostrarMensaje("");
    controles.classList.add("inactivo");
    carga.hidden = false;
    const barra = carga.querySelector(".fill");
    const texto = carga.querySelector(".visor-carga-texto");
    barra.style.width = "0%";
    texto.textContent = "Descargando modelo…";

    let buffer;
    try {
      buffer = await descargarModelo(m.archivo, {
        bytesEsperados: m.bytes,
        signal: abortar.signal,
        onProgreso: (r, total) => {
          if (total) barra.style.width = `${Math.min(100, (100 * r) / total)}%`;
          texto.textContent = `Descargando modelo… ${mb(r)}${total ? " de " + mb(total) : ""}`;
        },
      });
    } catch (err) {
      if (abortar.signal.aborted) return;
      carga.hidden = true;
      mostrarMensaje(`No se pudo descargar el modelo.<br><small>${err.message}</small>`);
      return;
    }
    if (abortar.signal.aborted) return;
    texto.textContent = "Preparando…";
    await new Promise((r) => requestAnimationFrame(() => r()));

    try {
      const modelo = leerModelo(buffer);
      buffer = null;
      e.render.cargar(modelo);
      e.cab = modelo.cabecera;
    } catch (err) {
      console.error(err);
      carga.hidden = true;
      mostrarMensaje(`No se pudo abrir el modelo.<br><small>${err.message}</small>`);
      return;
    }
    if (abortar.signal.aborted) return;

    // la proporción sale de la cabecera de cada modelo (horizontal o vertical)
    root.style.setProperty("--ar", `${e.cab.ancho} / ${e.cab.alto}`);
    root.style.setProperty("--ar-num", e.cab.ancho / e.cab.alto);
    carga.hidden = true;
    poster.hidden = true;
    canvas.hidden = false;
    controles.classList.remove("inactivo");
    e.j = 0;
    e.ultimoJ = null;

    if (!e.introHecha) {
      e.introHecha = true;
      if (reduceMovimiento) ponerManchas(1);    // sin animación ni reproducción automática
      else { ponerManchas(0); e.intro = { inicio: null }; }
    } else {
      ponerManchas(1);
      ponerReproduccion(true);
    }
    e.listo = true;
    actualizarActivo();
    pedirDibujo();
  }

  // ----- arranque -----
  try {
    e.render = new RenderMBBGS(canvas);
  } catch {
    e.render = null;
  }

  canvas.addEventListener("webglcontextlost", (ev) => {
    ev.preventDefault();
    e.listo = false;
    actualizarActivo();
    mostrarMensaje("Recuperando el visor…");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    e.render = new RenderMBBGS(canvas);
    if (e.actual) cargarModelo(e.actual);
  });

  let pedido = false;
  async function empezar() {
    if (pedido) return;
    pedido = true;
    e.modelos = await leerManifest();
    construirSelector();
    const m = modeloInicial();
    if (!e.render) {
      m.boton.setAttribute("aria-pressed", "true");
      if (m.miniatura) { poster.src = m.miniatura; poster.hidden = false; }
      controles.hidden = true;
      listaModelos.hidden = true;
      mostrarMensaje("Tu navegador no puede mostrar el visor interactivo: necesita WebGL2.<br><small>Prueba con Chrome, Safari o Firefox actualizados.</small>");
      return;
    }
    cargarModelo(m);
  }

  // visibilidad (render y hero) y precarga (300 px antes de llegar)
  new IntersectionObserver((entradas) => {
    e.visible = entradas[entradas.length - 1].isIntersecting;
    actualizarActivo();
  }).observe(escena);
  const precarga = new IntersectionObserver((entradas) => {
    if (entradas.some((x) => x.isIntersecting)) { precarga.disconnect(); empezar(); }
  }, { rootMargin: "300px 0px" });
  precarga.observe(root);

  // enlace directo (QR): #viewer o ?modelo=<id> -> cargar ya y colocar la página
  const enlaceDirecto = () => location.hash === "#viewer" || params.has("modelo");
  if (enlaceDirecto()) {
    empezar();
    // Se coloca el visor mismo (no el título de la sección) arriba, para que
    // en el celular se vean imagen y controles. Las fuentes y las figuras
    // pueden mover la página: se recoloca mientras el usuario no la toque.
    let tocado = false;
    for (const ev of ["wheel", "touchmove", "keydown", "pointerdown"]) addEventListener(ev, () => (tocado = true), { once: true, passive: true });
    const colocar = () => {
      if (tocado) return;
      const y = root.getBoundingClientRect().top + scrollY - 12;
      scrollTo({ top: y, behavior: "instant" });
    };
    colocar();
    document.fonts?.ready.then(colocar);
    // tras "load" el navegador puede hacer su propio salto al ancla: ir después
    addEventListener("load", () => setTimeout(colocar, 0));
    // y mientras la página cambie de altura en los primeros segundos
    const ro = new ResizeObserver(colocar);
    ro.observe(document.body);
    setTimeout(() => ro.disconnect(), 4000);
  }
  addEventListener("hashchange", () => { if (location.hash === "#viewer") empezar(); });
}

document.querySelectorAll("[data-visor]").forEach(initVisor);
