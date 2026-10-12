# Qué generar para la demo web (5 clips)

Dos pedidos independientes. Cada uno está escrito para pegarlo tal cual en el
chat de quien tiene el repositorio de entrenamiento y los checkpoints.

Resultado final por clip, en una carpeta `<id>/` (por ejemplo `musical/`):

```
original.mp4                      el clip original
n05k.mp4  n50k.mp4  n100k.mp4  n175k.mp4   el clip renderizado por cada modelo
frame_<j>_original.webp           5 imágenes  (una por cuadro elegido)
frame_<j>_k<K>_video.webp         25 imágenes (5 cuadros × 5 valores de K)
frame_<j>_k<K>_manchas.webp       25 imágenes (5 cuadros × 5 valores de K)
miniatura.webp                    1 imagen pequeña (opcional)
datos.json                        números del clip (ver abajo)
```

---

## Pedido 1 — Entrenar los modelos intermedios y sacar los videos

```text
Contexto: tenemos 5 clips. De cada uno ya existen el video original y un
modelo MBB-GS entrenado con 175 000 gaussianas (checkpoint .pt). Para la demo
web necesito, por cada clip, tres modelos más con menos gaussianas, y un video
renderizado por cada modelo.

1. ENTRENAR, por cada uno de los 5 clips, tres modelos nuevos:
   - uno con 5 000 gaussianas
   - uno con 50 000 gaussianas
   - uno con 100 000 gaussianas
   Usa exactamente la misma configuración con la que se entrenó el de 175 000
   de ese clip (mismo clip, misma resolución, mismos frames, misma loss, mismos
   grados de Chebyshev) y cambia solo el número de gaussianas. Si hay que
   recortar epochs por tiempo, dime cuántos usaste. Guarda los checkpoints.
   Prioridad si no alcanza el tiempo: primero el de 50 000 de los 5 clips,
   después el de 5 000 y por último el de 100 000.

2. RENDERIZAR, por cada clip, el clip completo (todos los frames, en orden) con
   cada modelo y guardar estos 5 videos en una carpeta con el nombre del clip:
   - original.mp4   -> el video original, sin procesar
   - n05k.mp4       -> render del modelo de 5 000
   - n50k.mp4       -> render del modelo de 50 000
   - n100k.mp4      -> render del modelo de 100 000
   - n175k.mp4      -> render del modelo de 175 000 (el que ya existe)
   Los 5 deben tener la MISMA resolución, la MISMA cantidad de frames y los
   MISMOS fps: en la web se reproducen sincronizados.
   Formato: H.264 en .mp4, sin audio, pix_fmt yuv420p, dimensiones pares:
     ffmpeg -framerate <fps> -i frames/%05d.png -an -c:v libx264 \
            -pix_fmt yuv420p -crf 23 -movflags +faststart n50k.mp4
   Cada video debería pesar pocos MB (se ven en celulares).

3. MÉTRICAS: por cada modelo, PSNR medio y SSIM medio sobre todos los frames,
   contra el original. Guárdalas en <clip>/datos.json:
   {
     "fps": 24, "n_frames": 480, "ancho": 1080, "alto": 720,
     "modelos": [
       {"archivo": "n05k.mp4",  "manchas": 5000,   "psnr": 0.0, "ssim": 0.0},
       {"archivo": "n50k.mp4",  "manchas": 50000,  "psnr": 0.0, "ssim": 0.0},
       {"archivo": "n100k.mp4", "manchas": 100000, "psnr": 0.0, "ssim": 0.0},
       {"archivo": "n175k.mp4", "manchas": 175000, "psnr": 0.0, "ssim": 0.0}
     ]
   }

Si algún modelo no llega a tiempo, entrega los videos que sí existan y quita
ese modelo de datos.json: la web muestra los que haya.
```

---

## Pedido 2 — Sacar las imágenes desde los `.pt` de 175 000 que ya existen

No hace falta entrenar nada: todo sale del checkpoint de 175 000 de cada clip.

```text
Contexto: por cada uno de los 5 clips tengo el checkpoint .pt del modelo MBB-GS
de 175 000 gaussianas y el video original. Necesito imágenes fijas que muestren
cómo se ve un cuadro usando solo las K gaussianas más importantes.

Por cada clip:

1. ELEGIR 5 CUADROS repartidos por el clip:
   j = round((n_frames - 1) * p)  para p = 0.1, 0.3, 0.5, 0.7, 0.9
   (j es el índice de frame, empezando en 0).

2. ORDENAR las gaussianas por importancia, de mayor a menor. Es el mismo orden
   que ya calcula demo_mode/exportar_modelo_web.py:
     importancia_i = media sobre 32 instantes uniformes de tau en [-1, 1] de
                     opacidad_i(tau) * escala1_i(tau) * escala2_i(tau)
   con los atributos YA activados (sigmoide para la opacidad, exp(clamp) para
   las escalas). "Las K más importantes" = las K primeras de ese orden.

3. Por cada cuadro j y por cada K en [100, 1000, 10000, 50000, 175000], generar
   dos imágenes a la resolución del clip:

   a) frame_<j>_k<K>_video.webp
      Render normal del cuadro j (tau = 2*j/(n_frames-1) - 1) usando SOLO las
      K primeras gaussianas, con el rasterizador de siempre (mismo orden por
      depth, mismo blending, fondo negro). Con K = 175000 es el render completo.

   b) frame_<j>_k<K>_manchas.webp
      Las mismas K gaussianas dibujadas como CONTORNOS de elipse sobre fondo
      negro, sin relleno. Por cada gaussiana, la elipse a 1 sigma:
        centro      = mu = (fila, columna)   <- OJO: mu[0] es la fila (y)
        sx, sy      = scale activada (sigmas en píxeles)
        c, s        = cos(theta), sin(theta)
        fila(t)     = mu[0] + sx*cos(t)*c - sy*sin(t)*s
        columna(t)  = mu[1] + sx*cos(t)*s + sy*sin(t)*c      t en [0, 2*pi)
      Línea de ~1 px, con antialiasing. Color = el color RGB activado de la
      gaussiana; si es muy oscuro, aclararlo para que se vea sobre negro
      (escalar el RGB para que su canal máximo valga al menos 0.45).
      Dibujar de mayor a menor depth, para que las de depth menor (las de
      delante) queden encima.

4. Por cada cuadro j, guardar también el cuadro j del video ORIGINAL:
      frame_<j>_original.webp

5. Una miniatura del clip: miniatura.webp, el cuadro central del original
   reducido a ~160 px de ancho.

NOMBRES: <j> y <K> van como números sin ceros a la izquierda. Ejemplo con j=48:
   frame_48_original.webp
   frame_48_k100_video.webp      frame_48_k100_manchas.webp
   frame_48_k1000_video.webp     frame_48_k1000_manchas.webp
   frame_48_k10000_video.webp    frame_48_k10000_manchas.webp
   frame_48_k50000_video.webp    frame_48_k50000_manchas.webp
   frame_48_k175000_video.webp   frame_48_k175000_manchas.webp
Total por clip: 5 cuadros * (1 + 5 + 5) = 55 imágenes, más la miniatura.

FORMATO: .webp, calidad ~85, a la resolución del clip (si es más fácil sacar
.png, también sirven: se convierten después).

Añade a <clip>/datos.json los 5 cuadros elegidos:
   "frames": [48, 144, 240, 335, 431]
y, en texto, el título del clip y el crédito de la fuente (autor y licencia).

Comprobación rápida: frame_<j>_k175000_video debe verse igual que el cuadro j
de n175k.mp4, y frame_<j>_k100_video debe ser unas pocas manchas grandes y
borrosas sobre negro. Si las elipses de "manchas" salen giradas o transpuestas
respecto al render, fila y columna están intercambiadas.
```

---

## Entrega

Una carpeta por clip con todo lo anterior. Se copia en
`assets/demo/<id>/` del repositorio de la web; el `clip.json` y la entrada del
`manifest.json` se escriben a partir de `datos.json` (ver README).
