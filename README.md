# Página de tesis — splatting multimedia

Sitio **estático** (HTML + CSS + JS, sin build, sin servidor). Se abre con doble
clic en `index.html` y se publica subiéndolo tal cual a cualquier hosting
estático (GitHub Pages, espacio web de la universidad, etc.).

## Estructura

```
index.html              La demo (primero celular): hero, #demo, audio A/B
tesis.html              Detalles de la tesis: resumen, resultados, tablas
visor.html              Visor WebGL2 en vivo (experimental, no enlazado)
css/style.css           Estilos (identidad visual)
js/demo/demo.js         Demo: clips pre-renderizados (lee assets/demo/)
js/video-compare.js     Slider de frame + videos sincronizados (tesis.html)
js/audio-ab.js          Reproductor A/B de audio
js/main.js              Hero animado, tabs, copiar BibTeX
js/visor/formato.js     Visor WebGL2: lectura del formato de modelo (MBBGSW01)
js/visor/render.js      Visor WebGL2: motor de render
js/visor/ui.js          Visor WebGL2: interfaz (visor.html)
assets/demo/            Clips de la demo: manifest.json + una carpeta por clip
assets/models/          Modelos del visor WebGL2 + manifest.json
assets/models-dev/      Modelos de desarrollo (fuera de git)
docs/                   Contrato del formato y vectores de referencia
test/                   Página de test del visor y pruebas en Node
assets/figures/         Las 5 figuras (generadas con make_figures.py)
assets/videos/          compare_gt.mp4, compare_ours.mp4, teaser.mp4
assets/frames/          Frames para el slider
assets/audio/           gt.wav, gabor.wav, baseline_griffinlim.wav
make_figures.py         Regenera las figuras desde los números de la tesis
```

## Qué reemplazar (los placeholders están etiquetados)

1. **Texto**: en `tesis.html` busca los comentarios `TODO` y `VERIFICAR`
   (título, tu nombre, asesor, universidad, año, enlaces a PDF y código,
   agradecimientos).
2. **Videos** (`assets/videos/`): pon tu par real `compare_gt.mp4` y
   `compare_ours.mp4` — **mismo tamaño, duración y fps**, codificados en H.264.
   Recomiendo clips cortos en loop (5–10 s) y comprimidos para que cargue rápido.
3. **Frames del slider** (`assets/frames/`): extrae un frame representativo de
   cada video, p. ej.:
   ```
   ffmpeg -i compare_gt.mp4   -vf "select=eq(n\,72)" -vframes 1 compare_gt_frame.png
   ffmpeg -i compare_ours.mp4 -vf "select=eq(n\,72)" -vframes 1 compare_ours_frame.png
   ```
4. **Audios** (`assets/audio/`): tus tres `.wav` reales (GT, Gabor, baseline).
   Ajusta las métricas mostradas en los botones dentro de `index.html`.
   Los videos y frames de los puntos 2 y 3 son los del comparador de `tesis.html`.
5. **Figuras**: ya salen de tus números reales. Si cambias un valor, edítalo en
   `make_figures.py` y ejecuta `python3 make_figures.py`.

## Probar en local (visor WebGL2)

El visor descarga los modelos con `fetch`, que no funciona abriendo el HTML
con doble clic (`file://`). Hace falta un servidor local:

```
cd tesis-splatting
python3 -m http.server 8000 --bind 0.0.0.0
```

- En el Mac: <http://localhost:8000/> (demo), <http://localhost:8000/tesis.html>,
  <http://localhost:8000/visor.html> y <http://localhost:8000/test/viewer-test.html>.
- **Desde un celular** en la misma red wifi: averigua la IP del Mac con
  `ipconfig getifaddr en0` y abre `http://<IP>:8000/#demo`.
  WebGL no exige HTTPS. Si no carga, revisa que el cortafuegos de macOS acepte
  conexiones entrantes para Python y que la wifi no aísle a los clientes
  (las redes de invitados y de eventos suelen hacerlo).

La página de test necesita `assets/models-dev/musical-20s.bin` (fuera de git).
Comprueba su sha256 contra `docs/referencia/index.json`, compara la evaluación
CPU y GPU con los JSON y el render con los PNG (PSNR), y mide los fps. Opciones:
`?respaldo=1` simula un dispositivo sin `EXT_color_buffer_float` y
`?respaldo=1&8bits=1` compone además en 8 bits. La sección «Resumen para
copiar» junta todo en texto.

Sin navegador: `node test/formato.test.mjs` prueba la lectura del formato y el
evaluador CPU contra los JSON.

## Demo: clips pre-renderizados

La sección `#demo` de `index.html` lee `assets/demo/manifest.json` y, para el
clip activo, `assets/demo/<carpeta>/clip.json`. Solo se descargan los archivos
del clip activo. **Cualquier archivo que falte se muestra como un recuadro
«Pendiente: <archivo>»** con la proporción del clip, así que se puede publicar
la estructura antes que el contenido.

### Agregar un clip

1. Copia la carpeta del clip en `assets/demo/<id>/` (por ejemplo
   `assets/demo/musical/`), con los archivos de la tabla de abajo.
2. Añade una entrada a `assets/demo/manifest.json`:
   ```json
   { "id": "musical", "titulo": "Musical", "carpeta": "musical", "miniatura": "musical/miniatura.webp" }
   ```
   `carpeta` y `miniatura` son relativas a `assets/demo/`. Si la miniatura no
   existe, el chip muestra solo el título. El orden del manifest es el de los
   chips, y el primero es el que se abre por defecto.
3. Para abrirlo directamente: `index.html?clip=musical` (el QR del stand puede
   apuntar a `…/tesis-splatting/#demo` o a `…/?clip=<id>`).

### Archivos de cada carpeta `assets/demo/<id>/`

| Archivo | Dónde se ve |
|---|---|
| `clip.json` | metadatos (ver abajo) |
| `original.mp4` | «Más manchas, más detalle»: el clip original |
| los que liste `modelos` (p. ej. `top020k.mp4`, `n175k.mp4`) | «Más manchas, más detalle»: un video por nivel de manchas |
| `reconstruido.mp4` + `poster.webp` | «El video, dibujado con manchas»: reconstrucción con sonido y controles (opcional) |
| `frame_<j>_k<K>_video.webp` | «Explora un instante», modo Imagen |
| `frame_<j>_k<K>_manchas.webp` | «Explora un instante», modo Ver manchas |
| `frame_<j>_original.webp` | «Explora un instante», botón Original |
| `miniatura.webp` | chip del clip (opcional; la ruta la da el manifest) |

`<j>` son los 5 índices de `frames` y `<K>` los 5 valores de `ks`: 5 × 5 × 2 + 5
= 55 imágenes por clip. Los videos deben tener la misma duración y fps (se
reproducen sincronizados, en bucle y sin sonido); H.264 en `.mp4` es lo más
compatible con iPhone. Instrucciones para generarlos: `docs/INSTRUCCIONES_CLIPS.md`.

### `clip.json`

```json
{
  "titulo": "Musical",
  "credito": "Fuente: autor, título y licencia del clip.",
  "fps": 24,
  "duracion_s": 12.0,
  "ancho": 640,
  "alto": 360,
  "modelos": [
    { "archivo": "n05k.mp4",  "manchas": 5000,   "psnr": 28.1, "ssim": 0.91 },
    { "archivo": "n50k.mp4",  "manchas": 50000,  "psnr": 32.0, "ssim": 0.95 },
    { "archivo": "n100k.mp4", "manchas": 100000, "psnr": 34.0, "ssim": 0.96 },
    { "archivo": "n175k.mp4", "manchas": 175000, "psnr": 35.2, "ssim": 0.97 }
  ],
  "frames": [ { "j": 48, "segundo": 2.0 }, … 5 en total ],
  "ks": [100, 1000, 10000, 50000, 175000]
}
```

- `ancho` y `alto` dan la proporción de todos los recuadros (16:9 si faltan);
  horizontales y verticales funcionan igual.
- `modelos`: un video por modelo entrenado, en el orden en que se muestran tras
  «Original». La rejilla muestra los que haya; si el total de videos es impar
  (por ejemplo, original + 4 modelos), el original va arriba a todo el ancho.
  `psnr` (dB) y `ssim` son opcionales y salen en una línea técnica pequeña.
- `frames[].j` es el índice de frame de los nombres de archivo; `segundo` se
  muestra en el botón (si falta, se calcula como `j / fps`).
- `ks` son las 5 posiciones del slider; el texto dice «Las N manchas más
  importantes del modelo de <último valor de ks>».
- `titulo` y `credito` se muestran en la página (el crédito, en letra pequeña).
- Opcionales: `reconstruccion` (`archivo`, `poster`, `ancho`, `alto`) añade el
  video con sonido; `modelos[].etiqueta` cambia el texto bajo un video;
  `nota_modelos` cambia la frase bajo la rejilla. **Si `frames` no está, la
  sección «Explora un instante» no se muestra.**

Ejemplo real: `assets/demo/star-wars/clip.json`. Los videos fuente sin procesar
(`videos_originales/`, `videos_175k_gaussianas/`, `top_gaussians/`) están fuera
de git; los de la web se generan recortando y reduciendo esos con ffmpeg.

## Visor WebGL2 (experimental): modelos

El visor lee `assets/models/manifest.json`. Mientras no exista, usa
`assets/models-dev/musical-20s.bin` (que no se publica). Formato:

```json
{
  "modelos": [
    {
      "id": "musical",
      "nombre": "Musical",
      "archivo": "musical.bin",
      "miniatura": "musical.jpg",
      "bytes": 7000000,
      "descripcion": "opcional"
    }
  ]
}
```

Las rutas son relativas a `assets/models/`. `bytes` se muestra antes de
descargar. La proporción del visor sale del ancho y el alto de cada modelo:
horizontales y verticales funcionan sin tocar nada.

El visor está en `visor.html`, sin enlace desde la demo:
`visor.html#viewer` carga el primer modelo al instante y
`visor.html?modelo=<id>#viewer` abre uno concreto.

## Publicar en GitHub Pages

1. Crea un repositorio y sube el contenido de esta carpeta.
2. Settings → Pages → Source: rama `main`, carpeta `/root`.
3. En un par de minutos tendrás la URL pública.

> Nota sobre tamaño: si los videos pesan mucho, compríme­los antes de subir o usa
> Git LFS; GitHub Pages sirve mejor archivos ligeros.

La plantilla se inspira en la página de Nerfies, liberada por sus autores.
