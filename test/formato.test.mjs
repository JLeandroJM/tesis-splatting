// Pruebas de js/visor/formato.js sin navegador:  node test/formato.test.mjs
// Opcional: node test/formato.test.mjs <otro-modelo.bin>  (debe fallar la comprobación)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  f16aNumero, convertirF16, chebyshev, tauDeFrame, acotarFrame,
  leerModelo, evaluarGaussiana, evaluarDepth, ErrorFormato,
} from "../js/visor/formato.js";
import { comprobarModelo, compararCaso, comprobarTau, sha256, _sha256JS } from "./validacion.js";

const raiz = fileURLToPath(new URL("..", import.meta.url));
let fallos = 0;
function ok(cond, msg) {
  console.log(`${cond ? "  ok " : "FALLO"}  ${msg}`);
  if (!cond) fallos++;
}
const cargar = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

console.log("float16");
for (const [h, v] of [[0x3c00, 1], [0xc000, -2], [0x7bff, 65504], [0x0001, 2 ** -24], [0x0000, 0], [0x3555, 0.333251953125], [0x7c00, Infinity]]) {
  ok(f16aNumero(h) === v, `0x${h.toString(16)} -> ${v}`);
}
ok(Number.isNaN(f16aNumero(0x7e00)), "0x7e00 -> NaN");
ok(convertirF16(new Uint16Array([0x3c00, 0xbc00]))[1] === -1, "convertirF16 usa la misma tabla");

console.log("Chebyshev: T_k(cos θ) = cos(kθ), K = 100");
let peor = 0;
for (const tau of [-1, -0.73, 0, 0.0020876826722338038, 0.5, 1]) {
  const T = chebyshev(tau, 100, new Float64Array(101));
  for (let k = 0; k <= 100; k++) peor = Math.max(peor, Math.abs(T[k] - Math.cos(k * Math.acos(tau))));
}
ok(peor < 1e-10, `error máximo ${peor.toExponential(2)}`);

console.log("Tiempo");
ok(tauDeFrame(0, 480) === -1 && tauDeFrame(479, 480) === 1, "τ(0) = -1, τ(479) = +1");
ok(acotarFrame(-3, 480) === 0 && acotarFrame(500, 480) === 479, "j se acota a [0, n_frames-1]");
const indice = JSON.parse(readFileSync(raiz + "docs/referencia/index.json"));
for (const t of comprobarTau(indice, 480)) ok(t.ok, `τ de ${t.nombre} (j = ${t.j}) coincide con la fórmula`);

console.log("Errores de formato");
const malo = new Uint8Array(16); malo.set(new TextEncoder().encode("XXXXXXXX"));
try { leerModelo(malo.buffer); ok(false, "magic incorrecto"); } catch (e) { ok(e instanceof ErrorFormato, `magic incorrecto -> ${e.message}`); }

console.log("SHA-256 en JS");
ok(_sha256JS(new ArrayBuffer(0)) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "cadena vacía");
ok(_sha256JS(new TextEncoder().encode("abc").buffer) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "\"abc\"");
for (const n of [55, 56, 63, 64, 65, 1000]) {
  const d = new Uint8Array(n).map((_, i) => (i * 31) & 255).buffer;
  ok(_sha256JS(d) === (await sha256(d)), `${n} bytes = crypto.subtle`);
}

const archivo = process.argv[2] ?? raiz + "assets/models-dev/" + indice.modelo.archivo;
console.log(`Modelo (${archivo.replace(raiz, "")})`);
if (!existsSync(archivo)) {
  console.log("  PENDIENTE  falta el modelo de la referencia");
} else {
  const buf = cargar(archivo);
  const m = leerModelo(buf);
  const c = m.cabecera;
  console.log(`       ${c.n_gaussianas} gaussianas, ${c.ancho}×${c.alto}, grados ${JSON.stringify(c.grados)}`);
  try { leerModelo(buf.slice(0, buf.byteLength - 10)); ok(false, "archivo cortado"); } catch (e) { ok(e instanceof ErrorFormato, `archivo cortado -> ${e.message}`); }
  const g = evaluarGaussiana(m, 0, 0);
  ok(g.opacity > 0 && g.opacity < 1 && g.scale.every((s) => s >= 0.5), "activaciones en rango (gaussiana 0, τ = 0)");
  const d = evaluarDepth(m, 0.3, 50);
  ok([0, 17, 49].every((i) => Math.abs(d[i] - evaluarGaussiana(m, i, 0.3).depth) < 1e-5), "evaluarDepth = depth de evaluarGaussiana");
  ok(_sha256JS(buf) === (await sha256(buf)), "sha256 en JS = crypto.subtle sobre el modelo");

  console.log("Validación CPU contra JSON");
  const fallosModelo = await comprobarModelo(m, buf, indice);
  if (fallosModelo.length) {
    ok(false, `no es el modelo de la referencia: ${fallosModelo.join("; ")}`);
  } else {
    ok(true, `sha256 y cabecera coinciden con index.json["modelo"]`);
    for (const cas of indice.casos) {
      const r = compararCaso(m, JSON.parse(readFileSync(raiz + "docs/referencia/" + cas.json)));
      for (const [a, x] of Object.entries(r.atributos)) {
        ok(x.ok, `${r.nombre.padEnd(21)} ${a.padEnd(7)} error ${x.tipo} ${x.error.toExponential(2)}  (tol ${x.tolerancia}, peor gaussiana ${x.gaussiana})`);
      }
      r.avisos.forEach((a) => console.log("  aviso ", a));
    }
  }
}

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo correcto");
process.exit(fallos ? 1 : 0);
