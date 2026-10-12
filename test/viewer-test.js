/* ============================================================
   Página de test del visor: test/viewer-test.html
   Orden (formato, sección 10.8): primero los números del JSON,
   después las imágenes. Luego el rendimiento.
   ============================================================ */

import { leerModelo, descargarModelo, acotarFrame } from "../js/visor/formato.js";
import { RenderMBBGS, soporte } from "../js/visor/render.js";
import { comprobarModelo, compararCaso, compararAtributos, comprobarTau, psnr, PSNR_OK, PSNR_BUG } from "./validacion.js";

const REF = "../docs/referencia/";
const MODELOS = "../assets/models-dev/";
const params = new URLSearchParams(location.search);
const opciones = { forzarRespaldo: params.has("respaldo"), forzar8bits: params.has("8bits") };

const $ = (s) => document.querySelector(s);
const cuerpo = (id) => $(`#${id} .cuerpo`);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const si = (v) => (v ? '<span class="ok">sí</span>' : '<span class="mal">no</span>');
const marca = (ok) => (ok ? '<span class="ok">✓</span>' : '<span class="mal">✗</span>');
const mb = (b) => (b / 1e6).toFixed(1) + " MB";
const resumen = [];
const anotar = (l) => { resumen.push(l); $("#resumen").textContent = resumen.join("\n"); };
const errorEn = (id, msg) => { cuerpo(id).innerHTML = `<div class="error">${esc(msg)}</div>`; };
const siguienteFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function tabla(cabeceras, filas) {
  return `<div class="table-scroll" style="margin-top:8px"><table><thead><tr>${cabeceras.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
    `<tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function tablaAtributos(resultados) {
  const attrs = Object.keys(resultados[0].atributos);
  const filas = resultados.map((r) => [r.nombre, ...attrs.map((a) => {
    const x = r.atributos[a];
    return `${marca(x.ok)} ${x.error.toExponential(1)}`;
  })]);
  const avisos = resultados.flatMap((r) => r.avisos.map((a) => `<p class="aviso">${esc(r.nombre)}: ${esc(a)}</p>`)).join("");
  const tol = attrs.map((a) => `${a} ${resultados[0].atributos[a].tipo} ≤ ${resultados[0].atributos[a].tolerancia}`).join(" · ");
  return tabla(["caso", ...attrs], filas) + avisos + `<p class="note">Error máximo sobre las ${resultados[0].n} primeras gaussianas. Tolerancias: ${tol}.</p>`;
}

// ---------- 1. dispositivo ----------
function probarSoporte() {
  const s = soporte();
  if (!s.webgl2) {
    cuerpo("s-soporte").innerHTML = '<div class="error">Este navegador no tiene WebGL2: el visor mostraría la miniatura y un mensaje.</div>';
    anotar(`${navigator.userAgent}\nWebGL2: NO`);
    return null;
  }
  cuerpo("s-soporte").innerHTML = tabla(["", ""], [
    ["Navegador", `<span style="font-size:12px">${esc(navigator.userAgent)}</span>`],
    ["GPU", esc(s.gpu)],
    ["EXT_color_buffer_float", si(s.colorBufferFloat)],
    ["EXT_color_buffer_half_float", si(s.colorBufferHalfFloat)],
    ["MAX_TEXTURE_SIZE", s.maxTextura],
    ["MAX_DRAW_BUFFERS", s.maxDrawBuffers],
    ["Pantalla", `${screen.width}×${screen.height} CSS · DPR ${devicePixelRatio}`],
    ["Opciones", opciones.forzarRespaldo ? `respaldo forzado${opciones.forzar8bits ? " + 8 bits" : ""}` : "ninguna"],
  ]);
  anotar(`${navigator.userAgent}`);
  anotar(`GPU: ${s.gpu} | EXT_color_buffer_float: ${s.colorBufferFloat ? "sí" : "NO"} | half_float: ${s.colorBufferHalfFloat ? "sí" : "no"} | MAX_TEXTURE_SIZE ${s.maxTextura}`);
  return s;
}

// ---------- imágenes ----------
async function cargarPNG(url) {
  const blob = await (await fetch(url)).blob();
  let bmp;
  try { bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
  catch { bmp = await createImageBitmap(blob); }
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

function canvasDe(w, h, pintar) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let p = 0; p < w * h; p++) { pintar(p, img.data, p * 4); img.data[p * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

function figura(canvas, texto) {
  const f = document.createElement("figure");
  f.append(canvas);
  const fc = document.createElement("figcaption");
  fc.innerHTML = texto;
  f.append(fc);
  return f;
}

// ---------- principal ----------
async function main() {
  const s = probarSoporte();
  const indice = await (await fetch(REF + "index.json")).json();
  const archivo = MODELOS + indice.modelo.archivo;

  // 2. modelo
  let buffer;
  try {
    const t0 = performance.now();
    buffer = await descargarModelo(archivo, {
      onProgreso: (r, t) => { cuerpo("s-modelo").textContent = `Descargando ${archivo}: ${mb(r)}${t ? " / " + mb(t) : ""}`; },
    });
    cuerpo("s-modelo").textContent = `Descargado en ${((performance.now() - t0) / 1000).toFixed(1)} s. Comprobando sha256…`;
  } catch (e) {
    errorEn("s-modelo", `${e.message}. ¿Está ${indice.modelo.archivo} en assets/models-dev/?`);
    return;
  }
  const modelo = leerModelo(buffer);
  const cab = modelo.cabecera;
  const t0 = performance.now();
  const fallos = await comprobarModelo(modelo, buffer, indice);
  const tHash = performance.now() - t0;
  const descripcion = `${indice.modelo.archivo} · ${mb(modelo.bytes)} · ${cab.n_gaussianas} gaussianas · ${cab.ancho}×${cab.alto} · ${cab.n_frames} frames · grados ${Object.entries(cab.grados).map(([a, k]) => `${a} ${k}`).join(" / ")}`;
  if (fallos.length) {
    cuerpo("s-modelo").innerHTML = `<p class="estado">${esc(descripcion)}</p><div class="error">No es el modelo con que se generó la referencia, no se compara:<br>${fallos.map(esc).join("<br>")}</div>`;
    ["s-cpu", "s-gpu", "s-psnr"].forEach((id) => errorEn(id, "Sin comparación: el modelo no coincide con index.json[\"modelo\"]."));
    anotar("Modelo: NO coincide con la referencia");
  } else {
    cuerpo("s-modelo").innerHTML = `<p class="estado"><span class="ok">✓</span> ${esc(descripcion)}<br>sha256 coincide con index.json (${tHash.toFixed(0)} ms, ${globalThis.crypto?.subtle ? "crypto.subtle" : "SHA-256 en JS"})</p>`;
  }

  const casos = await Promise.all(indice.casos.map(async (c) => ({ ...c, datos: await (await fetch(REF + c.json)).json() })));
  const frameDeTau = (tau) => acotarFrame(((tau + 1) * (cab.n_frames - 1)) / 2, cab.n_frames);

  if (!fallos.length) {
    // 3. CPU contra JSON
    const taus = comprobarTau(indice, cab.n_frames);
    const cpu = casos.map((c) => compararCaso(modelo, c.datos));
    cuerpo("s-cpu").innerHTML = tablaAtributos(cpu) +
      `<p class="note">τ de los casos frente a la fórmula de la sección 4: ${taus.map((t) => `${t.nombre} ${marca(t.ok)}`).join(" · ")}</p>`;
    anotar(`CPU vs JSON: ${cpu.every((r) => r.ok) ? "OK" : "FALLA"}`);
  }

  if (!s) return;
  let render;
  const lienzo = $("#lienzo");
  try {
    render = new RenderMBBGS(lienzo, opciones);
    const info = render.cargar(modelo);
    anotar(`Ruta: evaluación ${info.evalEnGPU ? "en pasada previa (GPU)" : "en vertex shader (respaldo)"} · composición ${info.formatoAcum}`);
  } catch (e) {
    ["s-gpu", "s-psnr"].forEach((id) => errorEn(id, e.message));
    console.error(e);
    return;
  }

  if (!fallos.length) {
    // 4. evaluación GPU contra JSON
    if (render.evalEnGPU) {
      const gpu = casos.map((c) => compararAtributos(render.leerEvaluacion(frameDeTau(c.tau), c.datos.primeras_n_gaussianas), c.datos));
      cuerpo("s-gpu").innerHTML = tablaAtributos(gpu);
      anotar(`GPU vs JSON: ${gpu.every((r) => r.ok) ? "OK" : "FALLA"}`);
    } else {
      cuerpo("s-gpu").innerHTML = '<p class="estado aviso">No aplica: sin EXT_color_buffer_float la evaluación va en el vertex shader y no se puede leer. El PSNR de abajo la valida indirectamente.</p>';
    }

    // 5. PSNR contra PNG
    cuerpo("s-psnr").innerHTML = "";
    const filas = [];
    for (const c of casos) {
      const ref = await cargarPNG(REF + c.png);
      const j = frameDeTau(c.tau);
      render.dibujar({ j, n: cab.n_gaussianas, forzarOrden: true });
      const img = render.leerImagen();
      const w = render.ancho, h = render.alto;
      if (ref.width !== w || ref.height !== h) { errorEn("s-psnr", `${c.png} mide ${ref.width}×${ref.height}, el modelo ${w}×${h}`); return; }
      const valor = psnr(img, 3, ref.data, 4, 1 / 255, w * h);
      const clase = valor >= PSNR_OK ? "ok" : valor < PSNR_BUG ? "mal" : "aviso";
      filas.push([c.nombre, `j = ${j.toFixed(2)}`, `<span class="${clase}">${valor.toFixed(2)} dB</span>`]);
      anotar(`PSNR ${c.nombre}: ${valor.toFixed(2)} dB`);

      const cont = document.createElement("div");
      cont.className = "imgs";
      cont.append(
        figura(canvasDe(w, h, (p, d, o) => { d[o] = ref.data[p * 4]; d[o + 1] = ref.data[p * 4 + 1]; d[o + 2] = ref.data[p * 4 + 2]; }), `${esc(c.nombre)} · referencia`),
        figura(canvasDe(w, h, (p, d, o) => { d[o] = img[p * 3] * 255; d[o + 1] = img[p * 3 + 1] * 255; d[o + 2] = img[p * 3 + 2] * 255; }), "visor (GPU)"),
        figura(canvasDe(w, h, (p, d, o) => {
          for (let k = 0; k < 3; k++) d[o + k] = Math.min(255, Math.abs(img[p * 3 + k] - ref.data[p * 4 + k] / 255) * 255 * 10);
        }), "|diferencia| × 10"),
      );
      cuerpo("s-psnr").append(cont);
      await siguienteFrame();
    }
    cuerpo("s-psnr").insertAdjacentHTML("afterbegin", tabla(["caso", "frame", "PSNR"], filas) +
      `<p class="note">Todas las gaussianas, orden recalculado en cada caso. Correcto &gt; ${PSNR_OK} dB; bug &lt; ${PSNR_BUG} dB. El quad recorta a 3.5σ y el rasterizador de referencia no, así que no se esperan los 54.6 dB de la referencia CPU.</p>`);
  }

  // 6. rendimiento
  const botones = [$("#b-bench"), $("#b-bench-manchas")];
  botones.forEach((b) => (b.disabled = false));
  botones.forEach((b, k) => b.addEventListener("click", async () => {
    botones.forEach((x) => (x.disabled = true));
    try { await medir(render, cab, Number($("#n-bench").value) || 25000, k ? "manchas" : "imagen"); }
    finally { botones.forEach((x) => (x.disabled = false)); }
  }));
  render.dibujar({ j: 0, n: 25000 });
}

// Dos medidas:
// - rendimiento bruto: 60 frames seguidos y una sincronización (ms por frame,
//   sin tope de refresco);
// - fps reales: 4 s de requestAnimationFrame (con tope = refresco de pantalla).
// En ambas el instante avanza en continuo (0.1 frames por render), así que se
// evalúa cada frame y se reordena según la política normal (cada 3 renders).
async function medir(render, cab, n, modo) {
  n = Math.max(1, Math.min(n, cab.n_gaussianas));
  const salida = cuerpo("s-fps");
  const estado = document.createElement("p");
  estado.textContent = `Midiendo ${n} gaussianas (${modo})…`;
  salida.append(estado);
  await siguienteFrame();

  let j = 100;
  const avanzar = () => { j += 0.1; if (j > cab.n_frames - 1) j = 0; return j; };
  for (let i = 0; i < 5; i++) render.dibujar({ j: avanzar(), n, modo });   // calentamiento
  render.sincronizar();

  const FRAMES = 60;
  let tOrden = 0, ordenes = 0;
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    const a = performance.now();
    const { ordenado } = render.dibujar({ j: avanzar(), n, modo });
    if (ordenado) { tOrden += performance.now() - a; ordenes++; }
  }
  render.sincronizar();
  const msFrame = (performance.now() - t0) / FRAMES;

  const DURACION = 4000;
  const tiempos = [];
  await new Promise((fin) => {
    let previo = null;
    const inicio = performance.now();
    function paso(t) {
      if (previo !== null) tiempos.push(t - previo);
      previo = t;
      render.dibujar({ j: avanzar(), n, modo });
      if (t - inicio < DURACION) requestAnimationFrame(paso); else fin();
    }
    requestAnimationFrame(paso);
  });
  tiempos.sort((a, b) => a - b);
  const mediana = tiempos[Math.floor(tiempos.length / 2)];
  const p90 = tiempos[Math.floor(tiempos.length * 0.9)];
  const fps = 1000 / mediana;

  const linea = `${n} gaussianas, ${modo}, ${render.ancho}×${render.alto}: ${msFrame.toFixed(1)} ms/frame bruto (≈ ${(1000 / msFrame).toFixed(0)} fps sin tope) · ` +
    `${fps.toFixed(0)} fps reales (mediana ${mediana.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms) · orden CPU ${ordenes ? (tOrden / ordenes).toFixed(1) : "-"} ms cuando toca`;
  estado.textContent = linea;
  anotar(`FPS ${linea}`);
}

main().catch((e) => {
  console.error(e);
  document.querySelector(".wrap").insertAdjacentHTML("beforeend", `<div class="error">${esc(e.stack || e.message)}</div>`);
});
