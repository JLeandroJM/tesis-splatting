/* ============================================================
   Visor MBB-GS — lectura del formato de modelo (MBBGSW01).
   Contrato: docs/FORMATO_MODELO_WEB.md. Si este código y el
   documento discrepan, manda el documento.

   Sin WebGL: aquí solo se lee el archivo, se valida la cabecera
   y se evalúan gaussianas en la CPU (referencia para las pruebas
   y para el orden por profundidad del render).
   Módulo ES: no crea globales.
   ============================================================ */

export const MAGIC = "MBBGSW01";

// atributo -> dimensión (sección 1 del formato)
export const ATRIBUTOS = { mu: 2, opacity: 1, color: 3, scale: 2, theta: 1, depth: 1 };

const BYTES_DTYPE = { float16: 2, float32: 4 };

export class ErrorFormato extends Error {
  constructor(msg) { super(msg); this.name = "ErrorFormato"; }
}

// ---------- float16 -> float32 ----------
// Tabla de los 65 536 patrones de bits (256 KB); se construye una vez.
let tablaF16 = null;

export function f16aNumero(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;                 // subnormal o cero
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

export function convertirF16(u16) {
  if (!tablaF16) {
    tablaF16 = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) tablaF16[h] = f16aNumero(h);
  }
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = tablaF16[u16[i]];
  return out;
}

// ---------- tiempo (sección 4) ----------
export function acotarFrame(j, nFrames) {
  return Math.min(Math.max(j, 0), nFrames - 1);
}

export function tauDeFrame(j, nFrames) {
  return (2 * acotarFrame(j, nFrames)) / (nFrames - 1) - 1;
}

// T_0..T_K por la recurrencia de primer tipo.
export function chebyshev(tau, K, out = new Float32Array(K + 1)) {
  out[0] = 1;
  if (K >= 1) out[1] = tau;
  for (let k = 2; k <= K; k++) out[k] = 2 * tau * out[k - 1] - out[k - 2];
  return out;
}

// ---------- cabecera (sección 2) ----------
function decodificarCabecera(bytes) {
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new ErrorFormato(`Magic incorrecto: "${magic}" (se esperaba "${MAGIC}")`);
  const L = new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(8, true);
  if ((12 + L) % 4 !== 0) throw new ErrorFormato(`Cabecera mal rellenada: 12 + ${L} no es múltiplo de 4`);
  return { L, necesita: 12 + L };
}

function parsearCabecera(bytes, L) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + L)));
  } catch (e) {
    throw new ErrorFormato(`Cabecera JSON ilegible: ${e.message}`);
  }
}

// Valida la cabecera. Con `bytesArchivo` comprueba además que los bloques
// caben en el archivo.
export function validarCabecera(cab, bytesArchivo) {
  const err = (m) => { throw new ErrorFormato(m); };
  if (cab.version !== 1) err(`Versión ${cab.version} no soportada (este visor lee la 1)`);
  for (const k of ["n_gaussianas", "ancho", "alto", "n_frames", "fps"]) {
    if (!(cab[k] > 0)) err(`Cabecera: "${k}" falta o no es positivo`);
  }
  if (cab.n_frames < 2) err("Cabecera: n_frames debe ser al menos 2");
  if (cab.base_temporal !== "chebyshev") err(`Base temporal "${cab.base_temporal}" no soportada`);
  if (!(cab.tex_width > 0)) err("Cabecera: falta tex_width");
  if (!(cab.log_scale_min < cab.log_scale_max)) err("Cabecera: log_scale_min/max inválidos");

  const N = cab.n_gaussianas;
  const base = 12 + cab._L;
  for (const [nombre, dim] of Object.entries(ATRIBUTOS)) {
    const b = cab.bloques?.[nombre];
    if (!b) err(`Falta el bloque "${nombre}"`);
    const K = cab.grados?.[nombre];
    if (!(Number.isInteger(K) && K >= 0)) err(`Grado de "${nombre}" inválido: ${K}`);
    if (cab.dims?.[nombre] !== dim) err(`dims.${nombre} = ${cab.dims?.[nombre]}, se esperaba ${dim}`);
    const esperada = [N, dim, K + 1];
    if (JSON.stringify(b.shape) !== JSON.stringify(esperada)) {
      err(`Bloque "${nombre}": shape ${JSON.stringify(b.shape)}, se esperaba ${JSON.stringify(esperada)}`);
    }
  }
  if (cab.bloques.mu_a0_f32) {
    const s = cab.bloques.mu_a0_f32.shape;
    if (JSON.stringify(s) !== JSON.stringify([N, 2])) err(`Bloque "mu_a0_f32": shape ${JSON.stringify(s)}, se esperaba [${N},2]`);
  }
  for (const [nombre, b] of Object.entries(cab.bloques)) {
    const bpe = BYTES_DTYPE[b.dtype];
    if (!bpe) err(`Bloque "${nombre}": dtype "${b.dtype}" no soportado`);
    const n = b.shape.reduce((a, x) => a * x, 1);
    if (b.length_bytes !== n * bpe) err(`Bloque "${nombre}": length_bytes ${b.length_bytes} ≠ ${n} × ${bpe}`);
    if ((base + b.offset) % bpe !== 0) err(`Bloque "${nombre}": desalineado`);
    if (bytesArchivo !== undefined && base + b.offset + b.length_bytes > bytesArchivo) {
      err(`Bloque "${nombre}" se sale del archivo (¿descarga incompleta?)`);
    }
  }
  return cab;
}

// Modelo completo en memoria: cabecera + una vista por bloque, sin copiar.
export function leerModelo(buffer) {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new ErrorFormato("Plataforma big-endian: no soportada");
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new ErrorFormato("Archivo demasiado corto");
  const { L, necesita } = decodificarCabecera(bytes);
  if (bytes.length < necesita) throw new ErrorFormato("Archivo cortado dentro de la cabecera");
  const cab = parsearCabecera(bytes, L);
  cab._L = L;
  validarCabecera(cab, bytes.length);

  const base = 12 + L;
  const bloques = {};
  for (const [nombre, b] of Object.entries(cab.bloques)) {
    const Tipo = b.dtype === "float16" ? Uint16Array : Float32Array;
    bloques[nombre] = new Tipo(buffer, base + b.offset, b.length_bytes / BYTES_DTYPE[b.dtype]);
  }
  return { cabecera: cab, bloques, bytes: bytes.length, _f32: {} };
}

// Lee solo la cabecera de un archivo remoto: corta la descarga en cuanto la
// tiene (sirve con servidores que ignoran Range, como python -m http.server).
export async function leerCabeceraRemota(url) {
  const r = await fetch(url);
  if (!r.ok) throw new ErrorFormato(`No se pudo abrir ${url} (HTTP ${r.status})`);
  const total = Number(r.headers.get("Content-Length")) || undefined;
  const reader = r.body.getReader();
  let acum = new Uint8Array(0);
  let necesita = 12;
  let L = null;
  while (acum.length < necesita) {
    const { done, value } = await reader.read();
    if (done) break;
    const n = new Uint8Array(acum.length + value.length);
    n.set(acum); n.set(value, acum.length); acum = n;
    if (L === null && acum.length >= 12) ({ L, necesita } = decodificarCabecera(acum));
  }
  reader.cancel().catch(() => {});
  if (L === null || acum.length < necesita) throw new ErrorFormato("Archivo cortado dentro de la cabecera");
  const cab = parsearCabecera(acum, L);
  cab._L = L;
  const encoding = r.headers.get("Content-Encoding");
  return validarCabecera(cab, encoding ? undefined : total);
}

// Descarga con progreso. onProgreso(recibidos, total | undefined).
// `bytesEsperados` (del manifest) sirve de total si no hay Content-Length.
export async function descargarModelo(url, { onProgreso, bytesEsperados, signal } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new ErrorFormato(`No se pudo descargar ${url} (HTTP ${r.status})`);
  const comprimido = !!r.headers.get("Content-Encoding");
  const total = (!comprimido && Number(r.headers.get("Content-Length"))) || bytesEsperados || undefined;
  if (!r.body || !r.body.getReader) {
    const buf = await r.arrayBuffer();
    onProgreso?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = r.body.getReader();
  let destino = new Uint8Array(total || 8 << 20);
  let recibidos = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (recibidos + value.length > destino.length) {           // total desconocido o inexacto
      const n = new Uint8Array(Math.max(destino.length * 2, recibidos + value.length));
      n.set(destino.subarray(0, recibidos)); destino = n;
    }
    destino.set(value, recibidos);
    recibidos += value.length;
    onProgreso?.(recibidos, total);
  }
  return recibidos === destino.length ? destino.buffer : destino.slice(0, recibidos).buffer;
}

// ---------- evaluación en CPU ----------
// Coeficientes de un bloque como Float32Array (convierte float16 una vez y lo guarda).
export function coeficientes(modelo, nombre) {
  if (!modelo._f32[nombre]) {
    const b = modelo.bloques[nombre];
    modelo._f32[nombre] = b instanceof Uint16Array ? convertirF16(b) : b;
  }
  return modelo._f32[nombre];
}

export function gradoMaximo(cab) {
  return Math.max(...Object.keys(ATRIBUTOS).map((a) => cab.grados[a]));
}

// Valor crudo (sin activar) de las `dim` componentes de un atributo.
// idx = i·(dim·(K+1)) + d·(K+1) + k   (sección 2)
export function evaluarCrudo(modelo, nombre, i, T) {
  const cab = modelo.cabecera;
  const dim = ATRIBUTOS[nombre];
  const K1 = cab.grados[nombre] + 1;
  const c = coeficientes(modelo, nombre);
  const a0 = nombre === "mu" ? modelo.bloques.mu_a0_f32 : null;
  const out = new Array(dim);
  for (let d = 0; d < dim; d++) {
    const base = i * dim * K1 + d * K1;
    // si existe mu_a0_f32, reemplaza al coeficiente k = 0 de mu (sección 2)
    let s = a0 ? a0[i * 2 + d] : c[base];
    for (let k = 1; k < K1; k++) s += c[base + k] * T[k];
    out[d] = s;
  }
  return out;
}

const sigmoide = (x) => 1 / (1 + Math.exp(-x));

// Atributos activados de la gaussiana i en el instante tau (sección 5).
// mu = [fila, columna]; scale = [s1, s2] en píxeles (σ).
export function evaluarGaussiana(modelo, i, tau) {
  const cab = modelo.cabecera;
  const T = chebyshev(tau, gradoMaximo(cab), new Float64Array(gradoMaximo(cab) + 1));
  const lo = cab.log_scale_min, hi = cab.log_scale_max;
  return {
    mu: evaluarCrudo(modelo, "mu", i, T),
    opacity: sigmoide(evaluarCrudo(modelo, "opacity", i, T)[0]),
    color: evaluarCrudo(modelo, "color", i, T).map(sigmoide),
    scale: evaluarCrudo(modelo, "scale", i, T).map((x) => Math.exp(Math.min(Math.max(x, lo), hi))),
    theta: evaluarCrudo(modelo, "theta", i, T)[0],
    depth: evaluarCrudo(modelo, "depth", i, T)[0],
  };
}

// depth de las n primeras gaussianas en `tau`, en `out` (para el orden del render).
export function evaluarDepth(modelo, tau, n, out = new Float32Array(n)) {
  const K1 = modelo.cabecera.grados.depth + 1;
  const c = coeficientes(modelo, "depth");
  const T = chebyshev(tau, K1 - 1);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const b = i * K1;
    for (let k = 0; k < K1; k++) s += c[b + k] * T[k];
    out[i] = s;
  }
  return out;
}
