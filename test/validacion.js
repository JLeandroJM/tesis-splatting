/* ============================================================
   Validación del visor contra docs/referencia/.
   El modelo con que se generó la referencia está descrito en el
   bloque "modelo" de docs/referencia/index.json (archivo, sha256,
   grados, resolución). Antes de comparar se exige que el .bin
   cargado sea ese: si no, no hay comparación.
   Lo usan test/viewer-test.html y test/formato.test.mjs.
   ============================================================ */

import { evaluarGaussiana, tauDeFrame } from "../js/visor/formato.js";

// Tolerancias de la comparación con el JSON. No están en el documento:
// son mías, holgadas frente al error de float32 y estrictas frente a
// cualquier bug (τ, recurrencia, activaciones o índices).
export const TOLERANCIAS = {
  mu: { abs: 1e-2 },          // píxeles
  opacity: { abs: 1e-4 },
  color: { abs: 1e-4 },
  scale: { rel: 1e-3 },
  theta: { abs: 1e-3 },       // radianes
  depth: { abs: 1e-3 },
};

// Umbrales de PSNR del render GPU contra los PNG (el quad recorta a
// 3.5σ y el rasterizador de referencia no, así que no se esperan 54.6 dB).
export const PSNR_OK = 40;
export const PSNR_BUG = 30;

// ---------- SHA-256 ----------
// crypto.subtle solo existe en contexto seguro (https o localhost); desde el
// celular por http://<IP>:8000 no, así que hay una implementación en JS.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256JS(buffer) {
  const datos = new Uint8Array(buffer);
  const n = datos.length;
  const bloques = Math.ceil((n + 9) / 64);
  const cola = new Uint8Array(128);                    // último(s) bloque(s) con el relleno
  const inicioCola = Math.floor(n / 64) * 64;
  cola.set(datos.subarray(inicioCola));
  cola[n - inicioCola] = 0x80;
  const bits = n * 8;
  const fin = (bloques - inicioCola / 64) * 64;
  new DataView(cola.buffer).setUint32(fin - 4, bits >>> 0);
  new DataView(cola.buffer).setUint32(fin - 8, Math.floor(bits / 2 ** 32));

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const vistaDatos = new DataView(datos.buffer, datos.byteOffset, datos.byteLength);
  const vistaCola = new DataView(cola.buffer);
  for (let b = 0; b < bloques; b++) {
    const off = b * 64;
    const [vista, base] = off < inicioCola ? [vistaDatos, off] : [vistaCola, off - inicioCola];
    for (let t = 0; t < 16; t++) w[t] = vista.getUint32(base + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], c = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
      w[t] = w[t - 16] + s0 + w[t - 7] + s1;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

export async function sha256(buffer) {
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return sha256JS(buffer);
}
export { sha256JS as _sha256JS };

// ---------- comprobación del modelo ----------
// Devuelve la lista de discrepancias entre el modelo cargado y el descrito
// en index.json["modelo"] (vacía = es el mismo modelo).
export async function comprobarModelo(modelo, buffer, indice) {
  const ref = indice.modelo;
  if (!ref) return ["index.json no tiene el bloque \"modelo\""];
  const cab = modelo.cabecera;
  const fallos = [];
  const hash = await sha256(buffer);
  if (hash !== ref.sha256) fallos.push(`sha256 ${hash.slice(0, 12)}… ≠ ${ref.sha256.slice(0, 12)}… de la referencia`);
  for (const [a, K] of Object.entries(ref.grados)) {
    if (cab.grados[a] !== K) fallos.push(`grado de ${a} = ${cab.grados[a]}, la referencia usa ${K}`);
  }
  for (const k of ["n_gaussianas", "ancho", "alto", "n_frames"]) {
    if (ref[k] !== undefined && cab[k] !== ref[k]) fallos.push(`${k} = ${cab[k]}, la referencia usa ${ref[k]}`);
  }
  return fallos;
}

const plano = (v) => (Array.isArray(v) ? v : [v]);

// Compara atributos activados (lista de {mu, opacity, color, scale, theta, depth})
// con los de un caso JSON.
export function compararAtributos(calc, caso) {
  const n = Math.min(calc.length, caso.primeras_n_gaussianas);
  const ref = caso.atributos_activados;
  const res = { nombre: caso.nombre, tau: caso.tau, n, atributos: {}, avisos: [] };
  for (const a of Object.keys(TOLERANCIAS)) {
    const tol = TOLERANCIAS[a];
    let peor = 0, peorI = -1;
    for (let i = 0; i < n; i++) {
      const r = plano(ref[a][i]), c = plano(calc[i][a]);
      for (let d = 0; d < r.length; d++) {
        const e = tol.rel ? Math.abs(c[d] - r[d]) / Math.max(Math.abs(r[d]), 1e-12) : Math.abs(c[d] - r[d]);
        if (!(e <= peor)) { peor = e; peorI = i; }       // !(<=) atrapa NaN
      }
    }
    res.atributos[a] = { error: peor, tipo: tol.rel ? "rel" : "abs", tolerancia: tol.rel ?? tol.abs, gaussiana: peorI, ok: peor <= (tol.rel ?? tol.abs) };
  }
  // pista del error más probable (sección 10.5): fila y columna intercambiadas
  if (!res.atributos.mu.ok) {
    let peorCruzado = 0;
    for (let i = 0; i < n; i++) {
      peorCruzado = Math.max(peorCruzado, Math.abs(calc[i].mu[0] - ref.mu[i][1]), Math.abs(calc[i].mu[1] - ref.mu[i][0]));
    }
    if (peorCruzado <= TOLERANCIAS.mu.abs) res.avisos.push("mu coincide con fila y columna intercambiadas");
  }
  res.ok = Object.values(res.atributos).every((x) => x.ok);
  return res;
}

// Evaluador CPU contra un caso JSON.
export function compararCaso(modelo, caso) {
  const calc = [];
  for (let i = 0; i < caso.primeras_n_gaussianas; i++) calc.push(evaluarGaussiana(modelo, i, caso.tau));
  const res = compararAtributos(calc, caso);
  if (caso.n_frames !== modelo.cabecera.n_frames) res.avisos.push(`n_frames del caso (${caso.n_frames}) ≠ cabecera (${modelo.cabecera.n_frames})`);
  return res;
}

// τ de cada caso frente a la fórmula de la sección 4 (240.5 = entre 240 y 241).
export function comprobarTau(indice, nFrames) {
  const esperado = { frame0000: 0, frame0240: 240, entre_frames_240_241: 240.5 };
  return indice.casos.map((c) => {
    const j = esperado[c.nombre];
    const tau = j === undefined ? null : tauDeFrame(j, nFrames);
    return { nombre: c.nombre, j, tauCaso: c.tau, tauFormula: tau, ok: tau !== null && Math.abs(tau - c.tau) < 1e-9 };
  });
}

// PSNR entre dos imágenes RGB en [0,1] (Float32Array o Uint8ClampedArray/255
// vía `escalaB`). `canalesA`/`canalesB` = componentes por píxel (3 o 4).
export function psnr(a, canalesA, b, canalesB, escalaB = 1, pixeles) {
  let se = 0;
  for (let p = 0; p < pixeles; p++) {
    for (let c = 0; c < 3; c++) {
      const d = a[p * canalesA + c] - b[p * canalesB + c] * escalaB;
      se += d * d;
    }
  }
  const mse = se / (pixeles * 3);
  return mse === 0 ? Infinity : 10 * Math.log10(1 / mse);
}
