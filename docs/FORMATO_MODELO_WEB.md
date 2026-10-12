# Formato de modelo para el visor web — MBB-GS

Contrato entre el repositorio de entrenamiento y el repositorio del visor. Quien
implemente el visor **no necesita acceso al código de entrenamiento**: todo lo
que hay que saber está aquí.

Implementación de referencia: `demo_mode/exportar_modelo_web.py` (escribe) y
`demo_mode/render_referencia_cpu.py` (lee y renderiza). Si el código y este
documento discrepan, manda este documento y el código es el bug.

**Validación.** El renderizador de referencia, leyendo el archivo exportado,
reproduce el rasterizador CUDA original a **54.6 dB PSNR de media** (frames 0,
240 y 479 de `musical_20s_1600ep`). Un visor correcto debe quedar en ese orden.

---

## 1. Qué representa el modelo

Un videoclip de `n_frames` cuadros se representa con **N gaussianas 2D de
población fija**: las mismas N durante todo el clip, ninguna nace ni muere.

Cada gaussiana `i` tiene seis atributos, y **cada atributo es un polinomio de
Chebyshev en el tiempo**:

```
p_i(τ) = a_i,0 · T_0(τ) + a_i,1 · T_1(τ) + ... + a_i,K · T_K(τ)
```

El archivo guarda los coeficientes `a`. Renderizar un instante es evaluar los
polinomios en ese instante y rasterizar las gaussianas resultantes.

| Atributo | dim | Grado típico K | Significado |
|---|---:|---:|---|
| `mu` | 2 | 100 | posición `(fila, columna)` en píxeles |
| `opacity` | 1 | 80 | opacidad, antes de la sigmoide |
| `color` | 3 | 30 | RGB, antes de la sigmoide |
| `scale` | 2 | 12 | semiejes en píxeles, antes de la exponencial |
| `theta` | 1 | 6 | rotación en radianes |
| `depth` | 1 | 4 | clave de ordenamiento, **no** es distancia a cámara |

Los grados reales de cada archivo están en la cabecera; no los supongas.

---

## 2. Estructura del archivo

Un solo archivo binario. Cabecera JSON + bloques de coeficientes.

```
offset 0      : 8 bytes  ASCII "MBBGSW01"           (magic)
offset 8      : uint32   little-endian              (longitud de la cabecera JSON)
offset 12     : cabecera JSON, UTF-8, rellenada con espacios
                hasta que 12 + longitud sea múltiplo de 4
offset 12+L   : bloques binarios, en el orden de header["orden_bloques"]
```

El relleno a 4 bytes garantiza que cada bloque empiece alineado, para poder
construir un `Float32Array` o `Uint16Array` sobre el `ArrayBuffer` sin copiar.

Los `offset` de cada bloque en la cabecera son **relativos al inicio de la zona
binaria** (`12 + L`), no al inicio del archivo.

### Cabecera JSON

```json
{
  "magic": "MBBGSW01",
  "version": 1,
  "n_gaussianas": 30000,
  "n_gaussianas_checkpoint": 150000,
  "ancho": 1080,
  "alto": 720,
  "n_frames": 480,
  "fps": 24.0,
  "duracion_s": 20.0,
  "base_temporal": "chebyshev",
  "orden_gaussianas": "importancia_desc",
  "orden_bloques": ["mu","opacity","color","scale","theta","depth","mu_a0_f32"],
  "grados":  {"mu":100,"opacity":80,"color":30,"scale":12,"theta":6,"depth":4},
  "dims":    {"mu":2,"opacity":1,"color":3,"scale":2,"theta":1,"depth":1},
  "bloques": {
    "mu": {
      "dtype": "float16",
      "layout": "[N][dim][K+1], C-order",
      "shape": [30000, 2, 101],
      "offset": 0,
      "length_bytes": 12120000
    }
  },
  "tex_width": 2048,
  "activaciones": { "...": "ver sección 5" },
  "log_scale_min": -0.6931471805599453,
  "log_scale_max": 6.984716320118268,
  "render": {
    "k_sigma": 3.5,
    "tile_size": 16,
    "alpha_max": 0.99,
    "transmitancia_min": 0.0001,
    "fondo_rgb": [0.0, 0.0, 0.0],
    "orden_profundidad": "depth ascendente compuesto primero",
    "satura_color": false
  }
}
```

`ancho` y `alto` están en píxeles y **definen la proporción real del video**. En
`musical_20s` son 1080 × 720, es decir 3:2, no 16:9. El visor debe usar esa
proporción.

`fps` **no está en el checkpoint de entrenamiento**: lo pone el exportador
(`--fps`, por defecto 24). `duracion_s = n_frames / fps`. Si un modelo futuro
se entrenó a otra tasa, hay que pasarla al exportar.

### Disposición de los coeficientes

Cada bloque es un array C-contiguo `[N][dim][K+1]`, float16 little-endian. El
índice plano del coeficiente `k` de la dimensión `d` de la gaussiana `i` es:

```
idx = i * (dim * (K+1)) + d * (K+1) + k
```

Los bloques van por atributo y no entrelazados, porque el visor sube uno por
textura y cada atributo tiene distinto `dim` y distinto `K`.

### El bloque `mu_a0_f32` — leer esto, no es opcional entenderlo

`mu` guarda **coordenadas absolutas en píxeles**, que llegan a ~1080. float16
tiene 11 bits de mantisa, así que a esa magnitud su ULP vale 1.0 y el error de
redondeo alcanza **0.5 px**. Eso se ve.

Medido sobre `musical_20s_1600ep`, frame 240, contra el render CUDA:

| Precisión de los coeficientes | PSNR vs CUDA | Tamaño extra |
|---|---:|---:|
| todo float16 | 47.11 dB | — |
| **solo `mu` k=0 en float32** | **55.90 dB** | **+0.60 MB** |
| `mu` completo en float32 | 55.90 dB | +60.60 MB |
| todo float32 | 56.18 dB | +124.20 MB |

El término constante de `mu` es el único que tiene magnitud grande; los
coeficientes de orden alto describen una oscilación de pocos píxeles y en
float16 van sobrados. Por eso el exportador añade por defecto un bloque
`mu_a0_f32` de shape `[N][2]`, dtype float32, y:

> **si el bloque `mu_a0_f32` está presente, sus valores reemplazan al
> coeficiente `k = 0` del bloque `mu`.**

El slot `k=0` sigue existiendo dentro del bloque `mu` (para que la indexación
sea regular), pero su contenido debe ignorarse.

Cada bloque declara su propio `dtype`; el visor debe respetarlo y no suponer
float16 en todos.

---

## 3. Orden de las gaussianas

Están ordenadas por **importancia descendente**, definida como el promedio
temporal sobre 32 instantes uniformes de `τ ∈ [-1, 1]`:

```
importancia_i = mean_τ [ α_i(τ) · s1_i(τ) · s2_i(τ) ]
```

con `α` ya activada (sigmoide) y `s1, s2` ya activadas (exponencial). El
producto es proporcional a la masa de alpha que la gaussiana deposita en la
imagen, porque la integral de una gaussiana 2D es `2π·α·s1·s2` y la constante no
altera el orden.

**Consecuencia práctica: mostrar las primeras K gaussianas es un prefijo del
array.** El control "número de gaussianas visibles" del visor es simplemente
cambiar cuántos elementos se dibujan, sin reordenar ni filtrar nada.

---

## 4. Tiempo: de frame a τ

```
τ(j) = 2 · j / (n_frames - 1) - 1
```

con `j` el índice de frame. Extremos exactos: `τ(0) = -1` y
`τ(n_frames - 1) = +1`.

`j` **puede ser fraccionario**, y ahí está la gracia de la demo: `j = 240.5`
evalúa un instante que nunca se grabó. Para cámara lenta, basta avanzar `j` en
pasos menores que 1.

Desde segundos: `j = t_segundos · fps`, y luego la fórmula de arriba. Fuera de
`[0, n_frames-1]` el polinomio diverge rápido; el visor debe **acotar `j` a ese
rango**.

### Evaluación de Chebyshev

Recurrencia de primer tipo, la misma que usa el entrenamiento:

```
T_0(τ) = 1
T_1(τ) = τ
T_k(τ) = 2 · τ · T_{k-1}(τ) - T_{k-2}(τ)
```

En el visor se calcula **una vez por frame en la CPU** (es un vector de K+1
valores, con K ≤ 100) y se sube como uniform. No se recalcula por gaussiana ni
por píxel.

Con `|τ| ≤ 1` se cumple `|T_k(τ)| ≤ 1`, así que la recurrencia es estable en
float32 incluso a grado 100.

---

## 5. Activaciones

Tras evaluar el polinomio se obtiene el valor **crudo**. Cada atributo lleva su
activación. Código de referencia, `src/gs2d_video/core/modelo.py`,
`_aplicar_activaciones`:

```python
out['mu']      = out['mu_raw']
out['theta']   = out['theta_raw']
out['depth']   = out['depth_raw']
out['opacity'] = torch.sigmoid(out['opacity_raw'])
out['color']   = torch.sigmoid(out['color_raw'])
out['scale']   = torch.exp(out['scale_raw'].clamp(min=log_min, max=log_max))
```

Es decir:

| Atributo | Activación |
|---|---|
| `mu`, `theta`, `depth` | identidad |
| `opacity`, `color` | `sigmoid(x) = 1 / (1 + e^-x)` |
| `scale` | `exp(clamp(x, log_scale_min, log_scale_max))` |

Los límites del clamp están en la cabecera y valen
`log_scale_min = ln(0.5)` y `log_scale_max = ln(max(alto, ancho))`. **El clamp
no es cosmético**: sin él un coeficiente de orden alto extremo produce una
exponencial gigantesca y una gaussiana que cubre la pantalla.

---

## 6. Coordenadas

- `mu` está en **píxeles absolutos**, no normalizado.
- `mu[0]` es la **fila** (eje vertical, hacia abajo), `mu[1]` la **columna**
  (eje horizontal, hacia la derecha). Ojo: es `(y, x)`, no `(x, y)`.
- Origen en la esquina **superior izquierda**.
- El **centro** del píxel `(fila, col)` está en `(fila + 0.5, col + 0.5)`. El
  kernel CUDA evalúa exactamente ahí:
  ```c
  float pr = (float)fila + 0.5f;
  float pc = (float)col  + 0.5f;
  ```
- `scale` está en píxeles, y son desviaciones estándar (σ), no diámetros.
- `theta` en radianes.

Para WebGL, donde el origen de textura suele estar abajo, hay que voltear el eje
vertical al escribir el framebuffer o al mapear la textura; conviene hacerlo en
un solo sitio y dejarlo documentado.

---

## 7. Covarianza y forma cónica

El rasterizador no usa la covarianza sino su **inversa**, la forma cónica, con
tres valores `(m00, m01, m11)`. Código de referencia,
`cuda/raster_cuda/raster_cuda_kernel.cu`, `build_conic_kernel`:

```c
float s, c;  __sincosf(th, &s, &c);
float inv_sx2 = 1.0f / (sx * sx + 1e-8f);
float inv_sy2 = 1.0f / (sy * sy + 1e-8f);
conic[0] = c*c * inv_sx2 + s*s * inv_sy2;   // m00
conic[1] = c*s * (inv_sx2 - inv_sy2);       // m01
conic[2] = s*s * inv_sx2 + c*c * inv_sy2;   // m11
```

con `sx = scale[0]`, `sy = scale[1]`, `th = theta`. El `+1e-8` evita dividir por
cero y hay que conservarlo.

---

## 8. Evaluación de la gaussiana y composición

### Alpha en un píxel

Código de referencia, `evaluar_alpha_values_device`:

```c
float dx = pr - mu_f;            // pr = fila + 0.5,  mu_f = mu[0]
float dy = pc - mu_c;            // pc = col  + 0.5,  mu_c = mu[1]
float quad = dx*(m00*dx + m01*dy) + dy*(m01*dx + m11*dy);
float G = expf(-0.5f * quad);
float alpha = opacity * G;
if (alpha > 0.99f) alpha = 0.99f;
```

Puntos que se prestan a error:

- **`alpha` se satura por arriba a 0.99**, nunca a 1.0. Esto deja siempre algo
  de transmitancia y es lo que hace que la escena no se "selle".
- **No hay clamp por abajo.** No existe el típico descarte de
  `alpha < 1/255` de otros rasterizadores de splatting. No lo añadas.
- **No hay corte por radio dentro del bucle de composición.** Toda gaussiana que
  esté en la lista del tile se evalúa para todos los píxeles del tile, por lejos
  que caiga su centro. `k_sigma` interviene **solo** para decidir a qué tiles se
  asigna cada gaussiana (sección 9), no para recortar dentro del tile.

### Composición

Front-to-back, acumulando transmitancia:

```c
float T = 1.0f;                       // transmitancia
float3 out = (0,0,0);                 // el fondo es negro
for (cada gaussiana del tile, en orden de depth ascendente) {
    float alpha = ...;                // como arriba
    float peso  = alpha * T;
    out += peso * color;
    T   *= (1.0f - alpha);
    if (T < 1.0e-4f) break;           // terminación temprana
}
```

- **El fondo es negro `(0,0,0)`** y no se compone explícitamente: el acumulador
  arranca en cero y lo que quede sin cubrir se queda negro.
- **El color no se satura** dentro del kernel. El recorte a `[0,1]` ocurre solo
  al convertir a 8 bits para guardar la imagen:
  ```python
  render = torch.nan_to_num(render, nan=0.0, posinf=1.0, neginf=0.0)
  render = render.clamp(0, 1)
  ```
  En WebGL esto ocurre solo si el framebuffer es de 8 bits; con uno flotante hay
  que recortar a mano al presentar.
- **Terminación temprana** cuando `T < 1e-4`. Es una optimización: si el visor
  no la implementa el resultado es prácticamente el mismo, solo más lento.

---

## 9. Teselado y orden por profundidad

El rasterizador CUDA divide la imagen en tiles de `tile_size × tile_size`
(16×16) y a cada tile le asigna las gaussianas que pueden afectarlo.

### Caja envolvente

```c
float extent_fila = k_sigma * sqrtf((c*sx)*(c*sx) + (s*sy)*(s*sy));
float extent_col  = k_sigma * sqrtf((s*sx)*(s*sx) + (c*sy)*(c*sy));
int min_f = floorf(fila - extent_fila),  max_f = ceilf(fila + extent_fila);
int min_c = floorf(col  - extent_col),   max_c = ceilf(col  + extent_col);
```

con `k_sigma = 3.5` por defecto, `s = sin(theta)`, `c = cos(theta)`. Si la caja
queda entera fuera de la imagen, la gaussiana se descarta. Si no, se recorta a
los bordes y se asigna a todos los tiles que toca.

**Esta caja es la única función de `k_sigma`.** Una gaussiana con un centro muy
lejano no aporta a un tile simplemente porque no aparece en su lista, no porque
se la recorte por distancia.

### Orden por profundidad

Dentro de cada tile, las gaussianas se ordenan por `depth` **ascendente**, y se
componen en ese orden, es decir **la de `depth` menor se compone primero y queda
delante**.

El CUDA lo hace cuantizando `depth` a 16 bits y ordenando por una clave entera:

```c
const int DEPTH_SCALE = 65536;
float dn = (depth[i] - dmin) / (dmax - dmin + 1e-8f);   // dmin/dmax globales
dn = clamp(dn, 0.0f, 1.0f);
int depth_q = clamp((int)(dn * (DEPTH_SCALE - 1)), 0, DEPTH_SCALE - 1);
key = tile_id * DEPTH_SCALE + depth_q;                  // orden ascendente
```

`dmin` y `dmax` son el mínimo y el máximo de `depth` **sobre todas las
gaussianas del frame**, recalculados en cada instante. El orden es estable: a
igual `depth_q`, gana el índice de gaussiana menor.

`depth` **no es una distancia a una cámara**: no hay cámara ni proyección. Es
solo una clave de orden, y por eso le basta grado 4.

Un visor puede ordenar directamente por el `depth` float sin cuantizar. La
diferencia frente a CUDA es despreciable salvo empates exactos.

---

## 10. Pseudocódigo del render para WebGL2

Pensado para quien no tiene acceso a este repositorio. Enfoque: **una instancia
por gaussiana, un quad, blending por hardware**.

### 10.1 Carga

```js
const buf  = await (await fetch('musical-20s.bin')).arrayBuffer();
const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));  // "MBBGSW01"
const L     = new DataView(buf).getUint32(8, true);                 // little-endian
const head  = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, L)));
const base  = 12 + L;

// un bloque -> un Uint16Array (float16 crudo) o Float32Array
function bloque(nombre) {
  const b = head.bloques[nombre];
  return b.dtype === 'float16'
    ? new Uint16Array (buf, base + b.offset, b.length_bytes / 2)
    : new Float32Array(buf, base + b.offset, b.length_bytes / 4);
}
```

### 10.2 Texturas

Un `texStorage2D` por atributo. Como `N` puede superar el tamaño máximo de
textura, se usa una textura 2D de ancho `head.tex_width` (2048) y alto
`ceil(total / tex_width)`, con formato de un canal:

| Textura | Formato interno | Contenido |
|---|---|---|
| `texMu` | `R16F` | bloque `mu`, `N·2·(K_mu+1)` valores |
| `texMuDC` | `R32F` | bloque `mu_a0_f32`, `N·2` valores |
| `texOpacity` | `R16F` | bloque `opacity` |
| `texColor` | `R16F` | bloque `color` |
| `texScale` | `R16F` | bloque `scale` |
| `texTheta` | `R16F` | bloque `theta` |
| `texDepth` | `R16F` | bloque `depth` |

`R16F` acepta directamente los bits de float16 con
`type = gl.HALF_FLOAT` y el `Uint16Array` sin conversión. Usar
`gl.NEAREST` en ambos filtros y `CLAMP_TO_EDGE`: son datos, no imágenes.

Indexación dentro del shader:

```glsl
float leerCoef(sampler2D tex, int idx, int texW) {
  ivec2 uv = ivec2(idx % texW, idx / texW);
  return texelFetch(tex, uv, 0).r;
}
// idx = i * (dim * (K+1)) + d * (K+1) + k
```

### 10.3 Por frame, en la CPU

1. Acotar `j` al rango `[0, n_frames-1]` y calcular `τ = 2j/(n_frames-1) - 1`.
2. Calcular los `T_k(τ)` por la recurrencia, hasta el grado máximo.
3. Subirlos como uniform. Con K ≤ 100, `uniform float uT[101]` sobra, o una
   textura 1D `R32F` de 101 téxeles si se prefiere no gastar uniforms.
4. Fijar `uNumVisibles = K` con el valor del control deslizante.

### 10.4 Vertex shader — una instancia por gaussiana

```glsl
// atributo del quad: aCorner in {(-1,-1),(1,-1),(-1,1),(1,1)}
// gl_InstanceID = índice de gaussiana i

// 1. evaluar los polinomios
float mu_y = 0.0, mu_x = 0.0;
for (int k = 0; k <= K_MU; ++k) {
  mu_y += uT[k] * leerCoef(texMu, i*2*(K_MU+1) + 0*(K_MU+1) + k, texW);
  mu_x += uT[k] * leerCoef(texMu, i*2*(K_MU+1) + 1*(K_MU+1) + k, texW);
}
// reponer el término constante desde la textura de alta precisión
mu_y += leerCoef32(texMuDC, i*2 + 0) - leerCoef(texMu, i*2*(K_MU+1) + 0, texW);
mu_x += leerCoef32(texMuDC, i*2 + 1) - leerCoef(texMu, i*2*(K_MU+1) + (K_MU+1), texW);

// igual para opacity, color, scale, theta, depth (cada uno con su grado)

// 2. activaciones
float alpha0 = 1.0 / (1.0 + exp(-op_raw));
vec3  color  = 1.0 / (1.0 + exp(-col_raw));
vec2  sc     = exp(clamp(scale_raw, uLogScaleMin, uLogScaleMax));

// 3. forma cónica
float s = sin(th), c = cos(th);
float i1 = 1.0/(sc.x*sc.x + 1e-8), i2 = 1.0/(sc.y*sc.y + 1e-8);
vec3 conic = vec3(c*c*i1 + s*s*i2,  c*s*(i1-i2),  s*s*i1 + c*c*i2);

// 4. quad que cubre 3.5 sigma, con los mismos extents que el teselado CUDA
float extY = 3.5 * sqrt((c*sc.x)*(c*sc.x) + (s*sc.y)*(s*sc.y));
float extX = 3.5 * sqrt((s*sc.x)*(s*sc.x) + (c*sc.y)*(c*sc.y));
vec2 pix = vec2(mu_x, mu_y) + aCorner * vec2(extX, extY);

// 5. a clip space; ojo con el eje vertical
gl_Position = vec4((pix / vec2(uAncho, uAlto)) * 2.0 - 1.0, 0.0, 1.0);
gl_Position.y = -gl_Position.y;

vConic = conic;  vColor = color;  vAlpha0 = alpha0;  vCentro = vec2(mu_x, mu_y);
// descartar las no visibles mandándolas fuera de pantalla
if (gl_InstanceID >= uNumVisibles) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
```

### 10.5 Fragment shader

```glsl
vec2 p  = vec2(gl_FragCoord.x, uAlto - gl_FragCoord.y);  // a (col, fila)
float dy = p.x - vCentro.x;    // columna
float dx = p.y - vCentro.y;    // fila
float quad = dx*(vConic.x*dx + vConic.y*dy) + dy*(vConic.y*dx + vConic.z*dy);
float a = min(vAlpha0 * exp(-0.5 * quad), 0.99);
outColor = vec4(vColor * a, a);        // color premultiplicado
```

**Ojo con el orden de los índices.** `conic.x` (m00) multiplica el término de
**fila** y `conic.z` (m11) el de **columna**, porque en el kernel `dx` es la
diferencia de filas. Intercambiarlos transpone todas las elipses y es el error
más fácil de cometer al portar esto.

### 10.6 Ordenamiento y blending

El blending de hardware compone en el orden en que llegan las primitivas, así
que hay que **dibujarlas ordenadas por `depth` ascendente**.

`depth` cambia con `τ`, así que en teoría hay que reordenar cada frame. En la
práctica:

- **Opción A, recomendada para la feria.** Ordenar en la CPU cada frame con un
  radix sort sobre `depth` cuantizado. Con N ≤ 50 000 son unos pocos ms; se
  puede hacer cada 2 o 3 frames sin que se note, porque `depth` tiene grado 4 y
  varía despacio.
- **Opción B.** Ordenar una vez con el `depth` del instante inicial y no volver
  a hacerlo. Se ven artefactos donde dos gaussianas se cruzan en profundidad.

El orden se aplica rellenando un buffer de índices de instancia y dibujando con
`drawElementsInstanced` sobre él.

Blending, con color premultiplicado y acumulación front-to-back:

```js
gl.enable(gl.BLEND);
gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE,
                     gl.ONE_MINUS_DST_ALPHA, gl.ONE);
gl.clearColor(0, 0, 0, 0);          // fondo negro, alpha 0
```

Con este modo, el destino acumula `dst = dst + (1 - dst.a) · src`, que es
exactamente `out += T · alpha · color` con `T = 1 - dst.a`. Equivale al bucle de
la sección 8 sin la terminación temprana.

### 10.7 Controles de la demo

| Control | Implementación |
|---|---|
| Tiempo / cámara lenta | cambiar `j` (fraccionario), recalcular `T_k(τ)`, redibujar |
| Nº de gaussianas | cambiar `uNumVisibles`; el array ya está ordenado por importancia |
| Ver elipses | segundo shader que dibuja el contorno de `quad == k_sigma²` en vez de rellenar |

### 10.8 Verificación

En `demo_mode/referencia/` hay, para tres valores de τ (uno de ellos **entre dos
frames**):

- `<caso>.json` — los atributos **ya activados** de las 20 primeras gaussianas.
  Sirve para comprobar la evaluación de Chebyshev y las activaciones sin
  renderizar nada.
- `<caso>.png` — el frame completo renderizado por la referencia.

Orden sugerido para depurar: primero cuadrar los números del JSON (si no
coinciden, el fallo está en τ, en la recurrencia o en las activaciones), y solo
después comparar imágenes.

---

## 11. Puntos que quedaron sin resolver

1. **`fps` no está en el checkpoint.** `info_clip.json` de `musical_20s_1600ep`
   trae `fps_extraccion: null`. El valor 24 sale de que el clip se llama
   `musical_20s` y tiene 480 frames; es una inferencia razonable, no un dato
   registrado. Para otros modelos hay que pasar `--fps` explícitamente.

2. **El residuo de 54.6 dB frente a CUDA no está desglosado del todo.** Con
   coeficientes float32 la referencia llega a 56.18 dB, no a infinito. Lo que
   queda se explica por `--use_fast_math` en la compilación CUDA (`__sincosf`,
   `expf` aproximados) y por el orden de acumulación en float32, pero no se
   verificó término a término.

3. **No se comprobó qué hace el kernel con gaussianas de escala degenerada**
   (σ muy cerca de 0). El `+1e-8` del cónico evita la división por cero, pero no
   se probó el caso límite.

4. **El modo de blending de la sección 10.6 no se validó contra el visor real**,
   porque aquí no hay WebGL. La equivalencia algebraica con el bucle de la
   sección 8 sí está comprobada a mano, pero conviene contrastar el primer
   render del visor contra los PNG de `demo_mode/referencia/`.
