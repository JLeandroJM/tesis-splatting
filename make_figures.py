#!/usr/bin/env python3
"""
Genera las 5 figuras estrella de la tesis a partir de los números reales medidos.
Paleta y tipografía coherentes con la página web (indigo + ámbar sobre papel frío).
Las figuras son las mismas que pueden ir en el documento LaTeX.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import os

OUT = os.path.join(os.path.dirname(__file__), "assets", "figures")
os.makedirs(OUT, exist_ok=True)

# ---- paleta (coherente con la web) ----
INK     = "#15171C"
MUTED   = "#6B7280"
INDIGO  = "#5B5BD6"   # acento principal / "ours"
AMBER   = "#E0A340"   # ganador / ground truth
GRID    = "#E4E6EB"
LOSE    = "#B7BCC6"   # barras no ganadoras

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 12,
    "axes.edgecolor": "#C9CDD6",
    "axes.linewidth": 0.9,
    "axes.titlesize": 13,
    "axes.titleweight": "bold",
    "axes.labelcolor": INK,
    "axes.titlecolor": INK,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "text.color": INK,
    "figure.dpi": 150,
    "savefig.dpi": 150,
    "savefig.bbox": "tight",
    "savefig.facecolor": "white",
    "figure.facecolor": "white",
    "axes.facecolor": "white",
})

def style(ax, ylabel, title):
    ax.set_title(title, pad=12, loc="left")
    ax.set_ylabel(ylabel, fontsize=11)
    ax.grid(axis="y", color=GRID, linewidth=1, zorder=0)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)

def save(fig, name):
    path = os.path.join(OUT, name)
    fig.savefig(path)
    plt.close(fig)
    print("escrita", name)

# ======================================================================
# 1. VIDEO — ablación de tipo_loss (PSNR). motion gana.
# ======================================================================
labels = ["baseline", "edge", "motion", "temporal"]
psnr   = [31.83, 31.88, 33.24, 31.93]
colors = [LOSE, LOSE, AMBER, LOSE]
fig, ax = plt.subplots(figsize=(7, 4.2))
bars = ax.bar(labels, psnr, color=colors, width=0.62, zorder=3,
              edgecolor="white", linewidth=1.2)
for b, v in zip(bars, psnr):
    ax.text(b.get_x()+b.get_width()/2, v+0.06, f"{v:.2f}",
            ha="center", va="bottom", fontsize=11,
            fontweight="bold" if v == max(psnr) else "normal",
            color=INK if v == max(psnr) else MUTED)
ax.set_ylim(31, 33.8)
style(ax, "PSNR (dB)", "Ablación de loss · video 720p")
ax.text(0.0, -0.18, "100k gaussianas · 600 frames · 800 epochs",
        transform=ax.transAxes, color=MUTED, fontsize=9.5)
save(fig, "video_loss_ablation.png")

# ======================================================================
# 2. VIDEO — exponente_frame: degradación monótona.
# ======================================================================
q     = [1, 2, 4, 8]
psnrq = [33.24, 29.77, 21.19, 14.70]
fig, ax = plt.subplots(figsize=(7, 4.2))
ax.plot(q, psnrq, "-o", color=INDIGO, linewidth=2.4, markersize=8,
        markerfacecolor="white", markeredgecolor=INDIGO,
        markeredgewidth=2, zorder=3)
for xi, yi in zip(q, psnrq):
    ax.annotate(f"{yi:.2f}", (xi, yi), textcoords="offset points",
                xytext=(8, 8), fontsize=10.5, color=INK)
# resaltar el óptimo q=1
ax.scatter([1], [33.24], s=150, color=AMBER, zorder=4, edgecolor="white", linewidth=1.5)
ax.set_xticks(q)
ax.set_xlabel("exponente_frame  q", fontsize=11)
ax.set_ylim(12, 36)
style(ax, "PSNR (dB)", "Sensibilidad al exponente de frame")
ax.text(0.0, -0.18, "q = 1 equivale a la pérdida motion (óptimo)",
        transform=ax.transAxes, color=MUTED, fontsize=9.5)
save(fig, "video_qframe.png")

# ======================================================================
# 3. AUDIO — capacidad: SI-SDR vs N, sweet spot 48k.
# ======================================================================
N      = [16, 32, 48, 64]            # miles de átomos
sisdr  = [7.12, 10.08, 11.88, 12.68]
ratio  = [13.8, 6.9, 4.59, 3.4]
fig, ax = plt.subplots(figsize=(7, 4.2))
ax.plot(N, sisdr, "-o", color=INDIGO, linewidth=2.4, markersize=8,
        markerfacecolor="white", markeredgecolor=INDIGO,
        markeredgewidth=2, zorder=3, label="SI-SDR")
ax.scatter([48], [11.88], s=160, color=AMBER, zorder=4,
           edgecolor="white", linewidth=1.5)
for xi, yi, ri in zip(N, sisdr, ratio):
    ax.annotate(f"{yi:.2f} dB\n{ri:g}×", (xi, yi), textcoords="offset points",
                xytext=(0, 12), ha="center", fontsize=9.5, color=MUTED)
ax.set_xticks(N)
ax.set_xticklabels([f"{n}k" for n in N])
ax.set_xlabel("número de átomos  N", fontsize=11)
ax.set_ylim(5, 14.5)
style(ax, "SI-SDR (dB)", "Capacidad vs calidad · audio Gabor")
ax.text(0.0, -0.18, "anotación: SI-SDR / ratio de compresión (fp16mix). Sweet spot N = 48k",
        transform=ax.transAxes, color=MUTED, fontsize=9.5)
save(fig, "audio_capacity.png")

# ======================================================================
# 4. AUDIO — Gabor vs gaussiana pura (argumento de Nyquist).
# ======================================================================
fig, ax = plt.subplots(figsize=(7, 4.2))
# gaussiana pura: barre N
Ng   = [48, 250, 500]
sg   = [-0.43, 14.86, 18.48]
ax.plot(Ng, sg, "-o", color=LOSE, linewidth=2.2, markersize=8,
        markerfacecolor="white", markeredgecolor=LOSE, markeredgewidth=2,
        zorder=3, label="gaussiana pura")
for xi, yi in zip(Ng, sg):
    ax.annotate(f"{yi:.2f}", (xi, yi), textcoords="offset points",
                xytext=(8, -4), fontsize=9.5, color=MUTED)
# Gabor: un punto a 48k que ya alcanza ~12 dB
ax.scatter([48], [11.88], s=190, color=AMBER, zorder=5,
           edgecolor="white", linewidth=1.6)
ax.annotate("Gabor  N=48k\n11.88 dB", (48, 11.88), textcoords="offset points",
            xytext=(14, 6), fontsize=10.5, color=INK, fontweight="bold")
# línea guía: dónde la pura iguala al Gabor
ax.axhline(11.88, color=AMBER, linewidth=1, linestyle=(0, (4, 4)), alpha=0.7, zorder=1)
ax.set_xlabel("número de primitivas  N (miles)", fontsize=11)
ax.set_ylim(-3, 20)
style(ax, "SI-SDR (dB)", "Gabor vs gaussiana pura · igual modelo")
ax.legend(frameon=False, loc="lower right", fontsize=10)
ax.text(0.0, -0.18, "a igual N=48k el Gabor gana ~12 dB; la pura solo iguala con ~250k (ya no comprime)",
        transform=ax.transAxes, color=MUTED, fontsize=9)
save(fig, "audio_gabor_vs_gauss.png")

# ======================================================================
# 5. COMPARACIÓN honesta vs compañero (SNR_ST, 30s estéreo).
# ======================================================================
fig, ax = plt.subplots(figsize=(7, 4.2))
names = ["Compañero\n(espectrograma\n+ Griffin-Lim)", "Nuestro Gabor\n(Mid/Side)"]
snr   = [-2.59, 12.30]
cols  = [LOSE, AMBER]
bars = ax.bar(names, snr, color=cols, width=0.55, zorder=3,
              edgecolor="white", linewidth=1.2)
for b, v in zip(bars, snr):
    off = 0.4 if v >= 0 else -1.0
    ax.text(b.get_x()+b.get_width()/2, v+off, f"{v:+.2f} dB",
            ha="center", va="bottom" if v >= 0 else "top",
            fontsize=12, fontweight="bold",
            color=INK if v > 0 else MUTED)
ax.axhline(0, color="#C9CDD6", linewidth=1)
ax.set_ylim(-6, 15)
style(ax, "SNR estéreo (dB)", "Compresión honesta de waveform · 30 s")
ax.text(0.0, -0.2, "reconstrucción honesta en ambos (sin reusar la fase original)",
        transform=ax.transAxes, color=MUTED, fontsize=9.5)
save(fig, "audio_vs_companero.png")

print("\nListo:", os.listdir(OUT))
