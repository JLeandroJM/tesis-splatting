# Página de tesis — splatting multimedia

Sitio **estático** (HTML + CSS + JS, sin build, sin servidor). Se abre con doble
clic en `index.html` y se publica subiéndolo tal cual a cualquier hosting
estático (GitHub Pages, espacio web de la universidad, etc.).

## Estructura

```
index.html              La página entera
css/style.css           Estilos (identidad visual)
js/video-compare.js     Slider de frame + videos sincronizados
js/audio-ab.js          Reproductor A/B de audio
js/main.js              Hero animado, tabs, copiar BibTeX
assets/figures/         Las 5 figuras (generadas con make_figures.py)
assets/videos/          compare_gt.mp4, compare_ours.mp4, teaser.mp4
assets/frames/          Frames para el slider
assets/audio/           gt.wav, gabor.wav, baseline_griffinlim.wav
make_figures.py         Regenera las figuras desde los números de la tesis
```

## Qué reemplazar (los placeholders están etiquetados)

1. **Texto**: en `index.html` busca los comentarios `TODO` y `VERIFICAR`
   (título, tu nombre, asesor, universidad, año, enlaces a PDF y código,
   agradecimientos, BibTeX).
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
5. **Figuras**: ya salen de tus números reales. Si cambias un valor, edítalo en
   `make_figures.py` y ejecuta `python3 make_figures.py`.

## Publicar en GitHub Pages

1. Crea un repositorio y sube el contenido de esta carpeta.
2. Settings → Pages → Source: rama `main`, carpeta `/root`.
3. En un par de minutos tendrás la URL pública.

> Nota sobre tamaño: si los videos pesan mucho, compríme­los antes de subir o usa
> Git LFS; GitHub Pages sirve mejor archivos ligeros.

La plantilla se inspira en la página de Nerfies, liberada por sus autores.
