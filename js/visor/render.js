/* ============================================================
   Visor MBB-GS — motor WebGL2 (sin interfaz).
   Contrato del formato: docs/FORMATO_MODELO_WEB.md.

   Por frame:
   1. EVALUACIÓN (una vez por gaussiana): un fragmento por gaussiana
      evalúa los polinomios de Chebyshev y escribe los atributos
      activados en 3 texturas RGBA32F (MRT):
        G0 = (mu_fila, mu_col, opacidad, depth)
        G1 = (r, g, b, theta)
        G2 = (s1, s2, -, -)
   2. ORDEN: depth se evalúa en la CPU y se ordena con radix sort de
      16 bits (estable, como el CUDA); se reordena cada ORDEN_CADA
      renders o si el tiempo salta.
   3. COMPOSICIÓN: un quad instanciado por gaussiana (3.5σ) en un FBO
      RGBA16F a la resolución nativa del modelo, front-to-back con
      blending premultiplicado.
   4. PRESENTACIÓN: recorta a [0,1] y fuerza alpha = 1 (fondo negro).

   Respaldo sin EXT_color_buffer_float: la evaluación pasa al vertex
   shader (4 veces por gaussiana) y se compone en 16F si existe
   EXT_color_buffer_half_float, o en RGBA8 si no.

   EJE VERTICAL: el formato usa (fila, columna) con la fila hacia
   abajo. El único volteo está en el vertex shader de dibujo (fila ->
   clip y) y su inverso en el fragment shader (gl_FragCoord.y -> fila).
   El FBO queda con la fila 0 arriba en pantalla; leerImagen() devuelve
   las filas de arriba abajo, como un PNG.
   ============================================================ */

import { ATRIBUTOS, chebyshev, tauDeFrame, evaluarDepth, gradoMaximo, coeficientes } from "./formato.js";

// Contorno del modo "ver manchas", en σ (distancia de Mahalanobis).
export const CONTORNO_SIGMA = 1.0;
// Brillo mínimo del contorno en "ver manchas" (las manchas más oscuras se aclaran hasta aquí).
export const BRILLO_MIN_MANCHAS = 0.45;
// Reordenar por profundidad como máximo cada tantos renders…
export const ORDEN_CADA = 3;
// …o antes, si el tiempo salta más de tantos frames.
export const ORDEN_SALTO_FRAMES = 2;

const OPCIONES_CONTEXTO = {
  alpha: false, antialias: false, depth: false, stencil: false,
  premultipliedAlpha: false, preserveDrawingBuffer: false,
  powerPreference: "high-performance",
};

// Qué soporta este navegador, sin crear nada permanente.
export function soporte() {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const s = {
    webgl2: true,
    colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
    colorBufferHalfFloat: !!gl.getExtension("EXT_color_buffer_half_float"),
    floatBlend: !!gl.getExtension("EXT_float_blend"),
    maxTextura: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return s;
}

// ---------- GLSL ----------
const CABECERA_GLSL = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// Triángulo que cubre la pantalla, sin buffers.
const VS_PANTALLA = CABECERA_GLSL + `
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Evaluación de una gaussiana: se inserta en el shader de evaluación o, en
// el respaldo, en el vertex shader de dibujo. Los grados van como #define
// para que los bucles tengan límite constante.
function glslEvaluar(cab, tieneA0) {
  const g = cab.grados;
  const nT4 = Math.ceil((gradoMaximo(cab) + 1) / 4);
  return `
#define W_COEF ${cab.tex_width}
#define K_MU ${g.mu}
#define K_OP ${g.opacity}
#define K_COL ${g.color}
#define K_SC ${g.scale}
#define K_TH ${g.theta}
#define K_DP ${g.depth}
uniform sampler2D uMu, uMuA0, uOp, uCol, uSc, uTh, uDp;
uniform vec4 uT[${nT4}];          // T_0..T_K empaquetados de 4 en 4
uniform vec2 uLogScale;           // (log_scale_min, log_scale_max)

float T(int k) { return uT[k >> 2][k & 3]; }
float coef(sampler2D t, int idx) { return texelFetch(t, ivec2(idx % W_COEF, idx / W_COEF), 0).r; }
// suma_{k=k0..K} a_k T_k para el bloque que empieza en base
float serie(sampler2D t, int base, int k0, int K) {
  float s = 0.0;
  for (int k = k0; k <= K; ++k) s += coef(t, base + k) * T(k);
  return s;
}
float sigmoide(float x) { return 1.0 / (1.0 + exp(-x)); }

// idx = i*(dim*(K+1)) + d*(K+1) + k   (formato, sección 2)
void evaluar(int i, out vec4 g0, out vec4 g1, out vec4 g2) {
  int b = i * 2 * (K_MU + 1);
${tieneA0
    ? `  // mu_a0_f32 reemplaza al coeficiente k = 0 de mu (sección 2)
  float fila = coef(uMuA0, i * 2)     + serie(uMu, b, 1, K_MU);
  float col  = coef(uMuA0, i * 2 + 1) + serie(uMu, b + K_MU + 1, 1, K_MU);`
    : `  float fila = serie(uMu, b, 0, K_MU);
  float col  = serie(uMu, b + K_MU + 1, 0, K_MU);`}
  float op = sigmoide(serie(uOp, i * (K_OP + 1), 0, K_OP));
  int bc = i * 3 * (K_COL + 1);
  vec3 color = vec3(sigmoide(serie(uCol, bc, 0, K_COL)),
                    sigmoide(serie(uCol, bc + (K_COL + 1), 0, K_COL)),
                    sigmoide(serie(uCol, bc + 2 * (K_COL + 1), 0, K_COL)));
  int bs = i * 2 * (K_SC + 1);
  vec2 sc = exp(clamp(vec2(serie(uSc, bs, 0, K_SC), serie(uSc, bs + K_SC + 1, 0, K_SC)),
                      uLogScale.x, uLogScale.y));
  float th = serie(uTh, i * (K_TH + 1), 0, K_TH);
  float dp = serie(uDp, i * (K_DP + 1), 0, K_DP);
  g0 = vec4(fila, col, op, dp);
  g1 = vec4(color, th);
  g2 = vec4(sc, 0.0, 0.0);
}
`;
}

function fsEvaluacion(cab, tieneA0, anchoEval) {
  return CABECERA_GLSL + glslEvaluar(cab, tieneA0) + `
uniform int uN;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  int i = int(gl_FragCoord.y) * ${anchoEval} + int(gl_FragCoord.x);
  if (i >= uN) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); return; }
  evaluar(i, o0, o1, o2);
}`;
}

function vsDibujo(cab, tieneA0, anchoEval, evalEnVS) {
  return CABECERA_GLSL + (evalEnVS ? glslEvaluar(cab, tieneA0) : `
uniform sampler2D uG0, uG1, uG2;`) + `
layout(location = 0) in vec2 aEsquina;   // (-1,-1) (1,-1) (-1,1) (1,1)
layout(location = 1) in uint aIdx;       // índice de gaussiana, ya ordenado por depth
uniform vec2 uTam;                       // (ancho, alto) del modelo
uniform float uKQuad;                    // semiancho del quad, en σ
flat out vec2 vMu;                       // (fila, col)
flat out vec3 vConica;                   // (m00, m01, m11)
flat out vec4 vColor;                    // (r, g, b, opacidad)
void main() {
  int i = int(aIdx);
  vec4 g0, g1, g2;
${evalEnVS
    ? "  evaluar(i, g0, g1, g2);"
    : `  ivec2 p = ivec2(i % ${anchoEval}, i / ${anchoEval});
  g0 = texelFetch(uG0, p, 0); g1 = texelFetch(uG1, p, 0); g2 = texelFetch(uG2, p, 0);`}
  // forma cónica (sección 7), con sx = scale[0], sy = scale[1]
  float th = g1.w;
  vec2 sc = g2.xy;
  float s = sin(th), c = cos(th);
  float i1 = 1.0 / (sc.x * sc.x + 1e-8), i2 = 1.0 / (sc.y * sc.y + 1e-8);
  vConica = vec3(c*c*i1 + s*s*i2, c*s*(i1 - i2), s*s*i1 + c*c*i2);
  // caja con los mismos extents que el teselado CUDA (sección 9)
  float extFila = uKQuad * sqrt((c*sc.x)*(c*sc.x) + (s*sc.y)*(s*sc.y));
  float extCol  = uKQuad * sqrt((s*sc.x)*(s*sc.x) + (c*sc.y)*(c*sc.y));
  vec2 pix = vec2(g0.y, g0.x) + aEsquina * vec2(extCol, extFila);   // (col, fila)
  // VOLTEO: la fila crece hacia abajo, el clip y hacia arriba
  gl_Position = vec4(pix.x / uTam.x * 2.0 - 1.0, 1.0 - pix.y / uTam.y * 2.0, 0.0, 1.0);
  vMu = g0.xy;
  vColor = vec4(g1.rgb, g0.z);
}`;
}

// Forma cuadrática en el centro del píxel (sección 8). ¡Ojo! m00 multiplica
// la diferencia de FILAS (sección 10.5).
const GLSL_CUADRATICA = `
flat in vec2 vMu;
flat in vec3 vConica;
flat in vec4 vColor;
uniform float uAlto;
out vec4 oColor;
float cuadratica() {
  float fila = uAlto - gl_FragCoord.y;   // VOLTEO inverso: centro del píxel = fila + 0.5
  float col  = gl_FragCoord.x;
  float df = fila - vMu.x, dc = col - vMu.y;
  return df * (vConica.x * df + vConica.y * dc) + dc * (vConica.y * df + vConica.z * dc);
}`;

const FS_IMAGEN = CABECERA_GLSL + GLSL_CUADRATICA + `
void main() {
  float a = min(vColor.a * exp(-0.5 * cuadratica()), 0.99);   // sin corte por abajo
  oColor = vec4(vColor.rgb * a, a);                            // premultiplicado
}`;

const FS_MANCHAS = CABECERA_GLSL + GLSL_CUADRATICA + `
uniform float uContorno;
void main() {
  float d = sqrt(cuadratica());
  float w = max(fwidth(d), 1e-4);
  float linea = 1.0 - smoothstep(0.5 * w, 1.5 * w, abs(d - uContorno));
  if (linea <= 0.0) discard;
  // color propio de la mancha; solo se aclaran las muy oscuras (brillo mínimo
  // BRILLO_MIN) para que se vean sobre el fondo negro
  float m = max(vColor.r, max(vColor.g, vColor.b));
  vec3 c = vColor.rgb * (max(m, ${BRILLO_MIN_MANCHAS.toFixed(3)}) / max(m, 1e-3));
  float a = linea * (0.35 + 0.65 * vColor.a);
  oColor = vec4(c * a, a);
}`;

const FS_PRESENTAR = CABECERA_GLSL + `
uniform sampler2D uAcum;
out vec4 oColor;
void main() {
  vec3 c = texelFetch(uAcum, ivec2(gl_FragCoord.xy), 0).rgb;
  oColor = vec4(clamp(c, 0.0, 1.0), 1.0);   // salida opaca sobre negro
}`;

// ---------- utilidades GL ----------
function compilar(gl, tipo, fuente) {
  const s = gl.createShader(tipo);
  gl.shaderSource(s, fuente);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numerada = fuente.split("\n").map((l, i) => `${String(i + 1).padStart(3)} ${l}`).join("\n");
    console.error(numerada);
    throw new Error(`Error de compilación de shader: ${log}`);
  }
  return s;
}

function programa(gl, vs, fs) {
  const p = gl.createProgram();
  const v = compilar(gl, gl.VERTEX_SHADER, vs), f = compilar(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Error de enlace: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const nombre = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    u[nombre] = gl.getUniformLocation(p, nombre);
  }
  return { p, u };
}

function texturaVacia(gl, formato, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, formato, w, h);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}

// Un bloque de coeficientes -> textura de un canal de ancho `w`. Sube las
// filas completas y luego la fila final parcial, sin copiar el array.
function texturaBloque(gl, datos, w) {
  const f16 = datos instanceof Uint16Array;
  const h = Math.ceil(datos.length / w);
  const t = texturaVacia(gl, f16 ? gl.R16F : gl.R32F, w, h);
  const tipo = f16 ? gl.HALF_FLOAT : gl.FLOAT;
  const llenas = Math.floor(datos.length / w);
  if (llenas) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, llenas, gl.RED, tipo, datos.subarray(0, llenas * w));
  const resto = datos.length - llenas * w;
  if (resto) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, llenas, resto, 1, gl.RED, tipo, datos.subarray(llenas * w));
  return { t, h };
}

function fboCompleto(gl, texturas) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  texturas.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(texturas.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) { gl.deleteFramebuffer(f); return null; }
  return f;
}

// ---------- orden por profundidad ----------
// Radix sort LSD estable de 16 bits sobre depth cuantizado con dmin/dmax del
// frame (como el CUDA, sección 9): a igual clave gana el índice menor.
class Ordenador {
  constructor() { this.cap = 0; }
  reservar(n) {
    if (n <= this.cap) return;
    this.cap = n;
    this.idx = new Uint32Array(n); this.tmp = new Uint32Array(n);
    this.clave = new Uint16Array(n); this.depth = new Float32Array(n);
    this.cuenta = new Uint32Array(256);
  }
  ordenar(modelo, tau, n) {
    this.reservar(n);
    const { idx, tmp, clave, cuenta } = this;
    const depth = evaluarDepth(modelo, tau, n, this.depth);
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < n; i++) { const d = depth[i]; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
    const esc = 65535 / (dmax - dmin + 1e-8);
    for (let i = 0; i < n; i++) {
      const q = ((depth[i] - dmin) * esc) | 0;
      clave[i] = q < 0 ? 0 : q > 65535 ? 65535 : q;
      tmp[i] = i;
    }
    // pasada 1: byte bajo (tmp -> idx); pasada 2: byte alto (idx -> tmp)
    for (const [desde, hacia, sh] of [[tmp, idx, 0], [idx, tmp, 8]]) {
      cuenta.fill(0);
      for (let i = 0; i < n; i++) cuenta[(clave[desde[i]] >> sh) & 255]++;
      let acc = 0;
      for (let b = 0; b < 256; b++) { const c = cuenta[b]; cuenta[b] = acc; acc += c; }
      for (let i = 0; i < n; i++) { const g = desde[i]; hacia[cuenta[(clave[g] >> sh) & 255]++] = g; }
    }
    return tmp.subarray(0, n);
  }
}

// ---------- motor ----------
export class RenderMBBGS {
  // opciones.forzarRespaldo: simula un dispositivo sin EXT_color_buffer_float
  // opciones.forzar8bits: además, compone en RGBA8
  constructor(canvas, opciones = {}) {
    this.canvas = canvas;
    this.opciones = opciones;
    const gl = canvas.getContext("webgl2", OPCIONES_CONTEXTO);
    if (!gl) throw new Error("WebGL2 no disponible");
    this.gl = gl;
    const float = !opciones.forzarRespaldo && !!gl.getExtension("EXT_color_buffer_float");
    const half = !opciones.forzar8bits && (float || !!gl.getExtension("EXT_color_buffer_half_float"));
    this.evalEnGPU = float;                            // pasada de evaluación a RGBA32F
    this.formatoAcum = half ? "RGBA16F" : "RGBA8";
    if (!float) console.warn("[visor] Sin EXT_color_buffer_float: evaluación en el vertex shader (más lenta).");
    if (!half) console.warn("[visor] Sin framebuffer de punto flotante: se compone en RGBA8 (puede oscurecerse y verse con bandas).");

    this.ordenador = new Ordenador();
    this.progPresentar = programa(gl, VS_PANTALLA, FS_PRESENTAR);
    this.vaoVacio = gl.createVertexArray();
    this.modelo = null;
  }

  // Sube un modelo (resultado de leerModelo). Libera el anterior.
  cargar(modelo) {
    this.liberarModelo();
    const gl = this.gl;
    const cab = modelo.cabecera;
    const N = cab.n_gaussianas;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (cab.tex_width > maxTex) throw new Error(`tex_width ${cab.tex_width} > MAX_TEXTURE_SIZE ${maxTex}`);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const tieneA0 = !!modelo.bloques.mu_a0_f32;
    const nombres = [...Object.keys(ATRIBUTOS), ...(tieneA0 ? ["mu_a0_f32"] : [])];
    this.texCoef = {};
    for (const n of nombres) {
      const { t, h } = texturaBloque(gl, modelo.bloques[n], cab.tex_width);
      if (h > maxTex) throw new Error(`El bloque ${n} necesita ${h} filas de textura (máximo ${maxTex})`);
      this.texCoef[n] = t;
    }

    // evaluación: una textura de anchoEval × filas por atributo empaquetado
    this.anchoEval = Math.min(2048, maxTex);
    this.filasEval = Math.ceil(N / this.anchoEval);
    if (this.evalEnGPU) {
      this.texEval = [0, 1, 2].map(() => texturaVacia(gl, gl.RGBA32F, this.anchoEval, this.filasEval));
      this.fboEval = fboCompleto(gl, this.texEval);
      if (!this.fboEval) {
        console.warn("[visor] FBO RGBA32F incompleto: evaluación en el vertex shader.");
        this.texEval.forEach((t) => gl.deleteTexture(t));
        this.texEval = null;
        this.evalEnGPU = false;
      } else {
        this.progEval = programa(gl, VS_PANTALLA, fsEvaluacion(cab, tieneA0, this.anchoEval));
      }
    }

    // composición a resolución nativa
    this.ancho = cab.ancho; this.alto = cab.alto;
    this.canvas.width = cab.ancho; this.canvas.height = cab.alto;
    const intentar = (f) => {
      const t = texturaVacia(gl, f, cab.ancho, cab.alto);
      const fbo = fboCompleto(gl, [t]);
      if (!fbo) gl.deleteTexture(t);
      return fbo && { t, fbo };
    };
    let acum = this.formatoAcum === "RGBA16F" && intentar(gl.RGBA16F);
    if (!acum) {
      if (this.formatoAcum === "RGBA16F") console.warn("[visor] FBO RGBA16F incompleto: se compone en RGBA8.");
      this.formatoAcum = "RGBA8";
      acum = intentar(gl.RGBA8);
    }
    this.texAcum = acum.t; this.fboAcum = acum.fbo;

    const vs = vsDibujo(cab, tieneA0, this.anchoEval, !this.evalEnGPU);
    this.progImagen = programa(gl, vs, FS_IMAGEN);
    this.progManchas = programa(gl, vs, FS_MANCHAS);

    // geometría: quad (atributo 0) + índice por instancia (atributo 1)
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.bufQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.bufIdx = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIdx);
    gl.bufferData(gl.ARRAY_BUFFER, N * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.T = new Float32Array(Math.ceil((gradoMaximo(cab) + 1) / 4) * 4);
    // Tras subir las texturas solo hace falta depth en la CPU (para ordenar):
    // se guarda una copia para no retener el ArrayBuffer del archivo entero.
    let depth = coeficientes(modelo, "depth");
    if (depth.buffer === modelo.bloques.depth.buffer) depth = depth.slice();
    this.modelo = { cabecera: cab, bloques: {}, _f32: { depth } };
    this.orden = null;                                  // {n, j, renders}
    return { evalEnGPU: this.evalEnGPU, formatoAcum: this.formatoAcum };
  }

  _uniformesEval(prog, j) {
    const gl = this.gl, cab = this.modelo.cabecera;
    chebyshev(tauDeFrame(j, cab.n_frames), gradoMaximo(cab), this.T);
    gl.uniform4fv(prog.u.uT, this.T);
    gl.uniform2f(prog.u.uLogScale, cab.log_scale_min, cab.log_scale_max);
    const unidades = ["uMu", "uOp", "uCol", "uSc", "uTh", "uDp", "uMuA0"];
    const bloques = ["mu", "opacity", "color", "scale", "theta", "depth", "mu_a0_f32"];
    unidades.forEach((u, k) => {
      if (!prog.u[u] || !this.texCoef[bloques[k]]) return;
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, this.texCoef[bloques[k]]);
      gl.uniform1i(prog.u[u], k);
    });
  }

  // Pasada 1: evalúa las n primeras gaussianas en el frame j.
  evaluar(j, n) {
    const gl = this.gl;
    const filas = Math.ceil(n / this.anchoEval);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboEval);
    gl.viewport(0, 0, this.anchoEval, filas);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progEval.p);
    this._uniformesEval(this.progEval, j);
    gl.uniform1i(this.progEval.u.uN, n);
    gl.bindVertexArray(this.vaoVacio);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Reordena si toca. `forzar` reordena siempre (pruebas).
  _ordenar(j, n, forzar) {
    const o = this.orden;
    const toca = forzar || !o || o.n !== n || o.renders >= ORDEN_CADA || Math.abs(j - o.j) > ORDEN_SALTO_FRAMES;
    if (!toca) { o.renders++; return false; }
    const tau = tauDeFrame(j, this.modelo.cabecera.n_frames);
    const idx = this.ordenador.ordenar(this.modelo, tau, n);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIdx);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, idx);
    this.orden = { n, j, renders: 1 };
    return true;
  }

  // Dibuja el frame j (fraccionario) con las n primeras gaussianas.
  // modo: "imagen" | "manchas". Devuelve {ordenado} para las métricas.
  dibujar({ j, n, modo = "imagen", forzarOrden = false, presentar = true }) {
    const gl = this.gl, cab = this.modelo.cabecera;
    n = Math.max(1, Math.min(n ?? cab.n_gaussianas, cab.n_gaussianas));
    if (this.evalEnGPU) this.evaluar(j, n);
    const ordenado = this._ordenar(j, n, forzarOrden);

    // pasada 3: composición front-to-back, dst += (1 - dst.a) * src
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboAcum);
    gl.viewport(0, 0, this.ancho, this.alto);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
    const prog = modo === "manchas" ? this.progManchas : this.progImagen;
    gl.useProgram(prog.p);
    if (this.evalEnGPU) {
      ["uG0", "uG1", "uG2"].forEach((u, k) => {
        gl.activeTexture(gl.TEXTURE0 + k);
        gl.bindTexture(gl.TEXTURE_2D, this.texEval[k]);
        gl.uniform1i(prog.u[u], k);
      });
    } else {
      this._uniformesEval(prog, j);
    }
    gl.uniform2f(prog.u.uTam, this.ancho, this.alto);
    gl.uniform1f(prog.u.uAlto, this.alto);
    const k = cab.render?.k_sigma ?? 3.5;
    gl.uniform1f(prog.u.uKQuad, modo === "manchas" ? CONTORNO_SIGMA + 0.5 : k);
    if (prog.u.uContorno) gl.uniform1f(prog.u.uContorno, CONTORNO_SIGMA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.disable(gl.BLEND);

    if (presentar) this.presentar();
    return { ordenado };
  }

  // Pasada 4: FBO -> canvas, recortado y opaco.
  presentar() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progPresentar.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texAcum);
    gl.uniform1i(this.progPresentar.u.uAcum, 0);
    gl.bindVertexArray(this.vaoVacio);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Espera a que la GPU termine (lee 1 píxel del canvas). Para medir tiempos.
  sincronizar() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  // Imagen compuesta como RGB float en [0,1], filas de arriba abajo, con el
  // mismo posproceso que la referencia (NaN -> 0, recorte a [0,1]).
  leerImagen() {
    const gl = this.gl, w = this.ancho, h = this.alto;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboAcum);
    let crudo, esc = 1;
    if (this.formatoAcum === "RGBA8") {
      crudo = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, crudo);
      esc = 1 / 255;
    } else {
      crudo = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, crudo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;                     // readPixels empieza por abajo
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const v = crudo[(src + x) * 4 + c] * esc;
          out[(y * w + x) * 3 + c] = v > 0 ? (v < 1 ? v : 1) : 0;   // NaN -> 0
        }
      }
    }
    return out;
  }

  // Atributos activados de las n primeras gaussianas tal como los evaluó la
  // GPU en el frame j (solo con evaluación en GPU). Formato del JSON.
  leerEvaluacion(j, n) {
    if (!this.evalEnGPU) return null;
    const gl = this.gl;
    this.evaluar(j, n);
    n = Math.min(n, this.anchoEval);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboEval);
    const g = [0, 1, 2].map((k) => {
      const b = new Float32Array(n * 4);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + k);
      gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, b);
      return b;
    });
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return Array.from({ length: n }, (_, i) => ({
      mu: [g[0][i * 4], g[0][i * 4 + 1]],
      opacity: g[0][i * 4 + 2],
      depth: g[0][i * 4 + 3],
      color: [g[1][i * 4], g[1][i * 4 + 1], g[1][i * 4 + 2]],
      theta: g[1][i * 4 + 3],
      scale: [g[2][i * 4], g[2][i * 4 + 1]],
    }));
  }

  liberarModelo() {
    if (!this.modelo) return;
    const gl = this.gl;
    Object.values(this.texCoef).forEach((t) => gl.deleteTexture(t));
    this.texEval?.forEach((t) => gl.deleteTexture(t));
    for (const f of [this.fboEval, this.fboAcum]) if (f) gl.deleteFramebuffer(f);
    gl.deleteTexture(this.texAcum);
    for (const p of [this.progEval, this.progImagen, this.progManchas]) if (p) gl.deleteProgram(p.p);
    gl.deleteBuffer(this.bufQuad); gl.deleteBuffer(this.bufIdx);
    gl.deleteVertexArray(this.vao);
    this.texEval = this.fboEval = this.progEval = null;
    this.evalEnGPU = !this.opciones.forzarRespaldo && !!gl.getExtension("EXT_color_buffer_float");
    this.modelo = null;
  }

  liberar() {
    this.liberarModelo();
    const gl = this.gl;
    gl.deleteProgram(this.progPresentar.p);
    gl.deleteVertexArray(this.vaoVacio);
  }
}
