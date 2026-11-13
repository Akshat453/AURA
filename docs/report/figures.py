"""Figures for the Agile Lab project report (matplotlib).

The ER diagram is generated from the real SQLite schema of the seeded demo
databases; the burndown and velocity charts use the sprint plan in sprints.py.
"""
import os
import sqlite3

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Ellipse

INK, MUTED, GRID, SURFACE = "#1f2328", "#5b6470", "#d9dde3", "#fcfcfb"
ACCENT, ACCENT_SOFT = "#0f6e66", "#e3f1ef"
BLUE, ORANGE = "#2a78d6", "#eb6834"  # validated categorical slots 1 and 2
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": MUTED, "axes.labelcolor": INK,
                     "xtick.color": MUTED, "ytick.color": MUTED, "figure.facecolor": "white"})


def _box(ax, x, y, w, h, title, lines=(), fc="white", ec=MUTED, title_fc=None, fontsize=9):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.004,rounding_size=0.012", fc=fc, ec=ec, lw=1.2))
    if title_fc:
        ax.add_patch(FancyBboxPatch((x, y + h - 0.045), w, 0.045, boxstyle="round,pad=0.004,rounding_size=0.012", fc=title_fc, ec=ec, lw=1.2))
    ax.text(x + w / 2, y + h - 0.024, title, ha="center", va="center", fontsize=fontsize + 1, weight="bold",
            color="white" if title_fc else INK)
    for i, line in enumerate(lines):
        ax.text(x + 0.012, y + h - 0.07 - i * 0.032, line, ha="left", va="center", fontsize=fontsize, color=INK)


def _arrow(ax, a, b, text="", style="-|>", ls="-", color=MUTED, rad=0.0, fs=8):
    ax.annotate("", xy=b, xytext=a, arrowprops=dict(arrowstyle=style, color=color, lw=1.3, ls=ls,
                                                    connectionstyle=f"arc3,rad={rad}", shrinkA=2, shrinkB=2))
    if text:
        ax.text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.012, text, ha="center", va="bottom", fontsize=fs, color=MUTED,
                bbox=dict(fc="white", ec="none", pad=0.6))


def _canvas(w, h):
    fig = plt.figure(figsize=(w, h))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    return fig, ax


def architecture(path):
    fig, ax = _canvas(11, 7.2)
    _box(ax, 0.02, 0.55, 0.2, 0.3, "Browser (web UI)", ["Vanilla JS, no framework", "AudioWorklet microphone", "Chat, dashboard, timetable,", "reminders, notes, memos,", "drafts, documents, settings"], title_fc=ACCENT)
    _box(ax, 0.02, 0.15, 0.2, 0.25, "ESP32-S3 desk device", ["WSS /device (TLS)", "HMAC challenge-response", "16 kHz PCM up/down", "(simulator: cmd/device-sim)"], title_fc=ACCENT)
    _box(ax, 0.3, 0.12, 0.38, 0.76, "Go server  (cmd/professor-assistant)", [
        "HTTP: / (embedded web)  ·  /api/*  ·  /healthz  ·  /readyz",
        "WebSocket /ws: control JSON + VAP1 binary audio frames",
        "session: one active turn per connection, cancellation",
        "audio: validation, band-limited resampling to 16 kHz",
        "stt: router (English → small, Hindi/Auto → large-v3-turbo)",
        "assist: routing General / Documents / Web / Auto, tools",
        "llm: Gemini streaming + function calling",
        "actions: proposal → confirmation → execute once",
        "professor: timetable, reminders + scheduler, notes,",
        "     memos, drafts (SQLite)",
        "rag: upload, chunk, FTS5 + vector hybrid search",
        "pipeline: sentence splitter → bounded TTS queue",
        "device: secure listener for ESP32 sessions",
        "metrics: per-turn latency breakdown",
    ], fc=ACCENT_SOFT, title_fc=ACCENT, fontsize=8.6)
    _box(ax, 0.76, 0.6, 0.22, 0.32, "Local model services", ["whisper.cpp :8081 (small, EN)", "whisper.cpp :8082 (large-v3-turbo)", "Piper TTS :5000 (en_US)", "Piper TTS :5001 (hi_IN)", "RAG sidecar :8084 (Python:", "  e5-small ONNX, PDF text)"], title_fc="#5b6470")
    _box(ax, 0.76, 0.3, 0.22, 0.22, "Cloud APIs", ["Google Gemini (answers)", "Tavily (web search, optional)", "Google Calendar / Gmail", "  drafts (optional, off)"], title_fc="#8a5a14")
    _box(ax, 0.76, 0.03, 0.22, 0.2, "SQLite on this Mac", ["data/professor/professor.db", "data/rag/index.db + files/", "memo audio (opt-in)"], title_fc="#3d4a5c")
    _arrow(ax, (0.22, 0.72), (0.3, 0.72), "WebSocket + REST", style="<|-|>")
    _arrow(ax, (0.22, 0.27), (0.3, 0.27), "WSS /device", style="<|-|>")
    _arrow(ax, (0.68, 0.76), (0.76, 0.76), "HTTP (localhost)", style="<|-|>")
    _arrow(ax, (0.68, 0.41), (0.76, 0.41), "HTTPS", style="<|-|>")
    _arrow(ax, (0.68, 0.16), (0.76, 0.13), "database/sql", style="<|-|>")
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def er_diagram(path, professor_db, rag_db):
    def tables(db, skip=()):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        out = []
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts_%' ORDER BY rowid"):
            if name in skip:
                continue
            cols = [(r[1], r[2] or "fts", r[5]) for r in con.execute(f"PRAGMA table_info('{name}')")]
            fks = [(r[3], r[2], r[4]) for r in con.execute(f"PRAGMA foreign_key_list('{name}')")]
            out.append((name, cols, fks))
        con.close()
        return out

    prof, rag = tables(professor_db), tables(rag_db)
    fig, ax = _canvas(12, 9.6)
    ax.text(0.25, 0.985, "professor.db (Phase 5 professor data)", ha="center", va="top", fontsize=11, weight="bold", color=ACCENT)
    ax.text(0.78, 0.985, "index.db (Phase 4 document index)", ha="center", va="top", fontsize=11, weight="bold", color="#3d4a5c")
    ax.plot([0.535, 0.535], [0.02, 0.97], color=GRID, lw=1, ls="--")
    # (x, top) per table; heights follow the real column counts.
    pos = {"classes": (0.01, 0.95), "notes": (0.01, 0.572), "drafts": (0.01, 0.326), "reminders": (0.275, 0.95), "memos": (0.275, 0.55),
           "documents": (0.555, 0.95), "chunks": (0.782, 0.95), "embedding_cache": (0.555, 0.5), "chunks_fts": (0.782, 0.5)}
    row = 0.022
    geo = {}
    for name, cols, fks in prof + rag:
        x, top = pos.get(name, (0.56, 0.3))
        w = 0.245 if name in [t[0] for t in prof] else 0.208
        h = 0.05 + row * len(cols)
        y = top - h
        color = ACCENT if (name, cols, fks) in prof else "#3d4a5c"
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.002,rounding_size=0.008", fc="white", ec=color, lw=1.3))
        ax.add_patch(FancyBboxPatch((x, top - 0.04), w, 0.04, boxstyle="round,pad=0.002,rounding_size=0.008", fc=color, ec=color, lw=1.3))
        label = name + ("  (FTS5 virtual)" if name == "chunks_fts" else "")
        ax.text(x + w / 2, top - 0.02, label, ha="center", va="center", color="white", weight="bold", fontsize=9.5)
        fk_cols = {f[0] for f in fks}
        for i, (c, t, pk) in enumerate(cols):
            yy = top - 0.055 - i * row
            mark = "PK " if pk else ("FK " if c in fk_cols else "")
            ax.text(x + 0.008, yy, mark, ha="left", va="center", fontsize=7.5, color=ORANGE if mark == "FK " else color, weight="bold")
            ax.text(x + 0.035, yy, c, ha="left", va="center", fontsize=8, color=INK)
            ax.text(x + w - 0.008, yy, t.upper(), ha="right", va="center", fontsize=7.5, color=MUTED)
        geo[name] = (x, y, w, h, top)
    # Real foreign key: chunks.doc_id -> documents.id (ON DELETE CASCADE).
    for name, cols, fks in rag:
        for col, ref, refcol in fks:
            x1, y1, w1, h1, t1 = geo[name]
            x2, y2, w2, h2, t2 = geo[ref]
            ci = [c[0] for c in cols].index(col)
            _arrow(ax, (x1 + 0.005, t1 - 0.055 - ci * row), (x2 + w2, t2 - 0.055), color=ORANGE)
            ax.text(x2, 0.35, f"FK  {name}.{col} → {ref}.{refcol}  (N : 1, ON DELETE CASCADE)", ha="left", va="center", fontsize=8, color=ORANGE, weight="bold")
    xc, yc, wc, hc, tc = geo["chunks"]
    xf, yf, wf, hf, tf = geo["chunks_fts"]
    _arrow(ax, (xf + wf / 2, tf), (xc + wc / 2, yc), "external content\n(rowid)", ls="--")
    xn, yn, wn, hn, tn = geo["notes"]
    xm, ym, wm, hm, tm = geo["memos"]
    xd, yd, wd, hd, td = geo["documents"]
    _arrow(ax, (xm + wm, tm - 0.1), (xd, yd + 0.02), ls=":", color=ACCENT, rad=-0.15)
    ax.text(0.28, 0.06, "No foreign keys inside professor.db:\nthe five tables are independent.\naction_id is UNIQUE (idempotent\nconfirmed actions); CHECK\nconstraints act as enums.\n\nDotted arrow: notes and memos are\nalso indexed in index.db as\ndocuments 'note-…' / 'memo-…'\n(logical link, no foreign key).",
            ha="left", va="bottom", fontsize=8.5, color=MUTED)
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def use_cases(path):
    fig, ax = _canvas(11, 7.5)
    ax.add_patch(FancyBboxPatch((0.2, 0.03), 0.58, 0.92, boxstyle="round,pad=0.005,rounding_size=0.015", fc="#f6f7f8", ec=MUTED, lw=1.2))
    ax.text(0.49, 0.93, "Professor Voice Assistant", ha="center", fontsize=12, weight="bold", color=INK)

    def actor(x, y, name):
        ax.add_patch(plt.Circle((x, y + 0.08), 0.022, fc="white", ec=INK, lw=1.4))
        ax.plot([x, x], [y + 0.058, y - 0.0], color=INK, lw=1.4)
        ax.plot([x - 0.03, x + 0.03], [y + 0.035, y + 0.035], color=INK, lw=1.4)
        ax.plot([x, x - 0.025], [y, y - 0.05], color=INK, lw=1.4)
        ax.plot([x, x + 0.025], [y, y - 0.05], color=INK, lw=1.4)
        ax.text(x, y - 0.075, name, ha="center", va="top", fontsize=10, weight="bold")
        return (x + 0.03, y + 0.03)

    prof = actor(0.08, 0.55, "Professor")
    dev = actor(0.08, 0.15, "ESP32 device")
    cases = ["Ask a question by voice or text", "Get grounded answers with citations", "Upload and search documents",
             "View today / week timetable", "Create, edit, complete reminders", "Write and search notes",
             "Record and transcribe voice memos", "Draft emails / announcements", "Confirm or cancel an action",
             "Configure privacy, voice, theme", "Connect Google (optional)"]
    pts = []
    for i, c in enumerate(cases):
        y = 0.86 - i * 0.075
        ax.add_patch(Ellipse((0.49, y), 0.4, 0.06, fc="white", ec=ACCENT, lw=1.3))
        ax.text(0.49, y, c, ha="center", va="center", fontsize=9)
        pts.append((0.29, y, 0.69))
    for i, (xl, y, xr) in enumerate(pts):
        ax.plot([prof[0], xl], [prof[1], y], color=GRID, lw=1)
    for i in (0, 8):
        ax.plot([dev[0], pts[i][0]], [dev[1], pts[i][1]], color=MUTED, lw=1, ls="--")
    for name, y, links in (("Gemini API", 0.75, (0, 1, 7)), ("Tavily", 0.5, (1,)), ("Google APIs", 0.2, (10,))):
        ax.add_patch(FancyBboxPatch((0.84, y - 0.04), 0.14, 0.08, boxstyle="round,pad=0.004,rounding_size=0.01", fc="white", ec="#8a5a14", lw=1.2))
        ax.text(0.91, y, name, ha="center", va="center", fontsize=9.5, weight="bold", color="#8a5a14")
        for i in links:
            ax.plot([pts[i][2], 0.84], [pts[i][1], y], color="#d8c3a0", lw=1)
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def data_flow(path):
    fig, ax = _canvas(11, 6.6)

    def proc(x, y, n, text):
        ax.add_patch(Ellipse((x, y), 0.2, 0.15, fc=ACCENT_SOFT, ec=ACCENT, lw=1.4))
        ax.text(x, y, f"P{n}\n{text}", ha="center", va="center", fontsize=9)

    def store(x, y, text):
        ax.plot([x - 0.1, x + 0.1], [y + 0.035, y + 0.035], color=INK, lw=1.3)
        ax.plot([x - 0.1, x + 0.1], [y - 0.035, y - 0.035], color=INK, lw=1.3)
        ax.text(x, y, text, ha="center", va="center", fontsize=9)

    def ext(x, y, text):
        ax.add_patch(FancyBboxPatch((x - 0.08, y - 0.045), 0.16, 0.09, boxstyle="square,pad=0", fc="white", ec=INK, lw=1.4))
        ax.text(x, y, text, ha="center", va="center", fontsize=9.5, weight="bold")

    ext(0.08, 0.6, "Professor")
    proc(0.3, 0.8, 1, "Capture and\ntranscribe speech")
    proc(0.55, 0.8, 2, "Plan, retrieve\nand answer")
    proc(0.8, 0.8, 3, "Synthesize\nspeech")
    proc(0.3, 0.35, 4, "Manage professor\ndata + confirm")
    proc(0.62, 0.35, 5, "Index and search\ndocuments")
    store(0.3, 0.08, "D1 professor.db")
    store(0.62, 0.08, "D2 index.db + files")
    ext(0.93, 0.5, "Gemini /\nTavily")
    _arrow(ax, (0.12, 0.65), (0.21, 0.77), "audio (PCM16)")
    _arrow(ax, (0.4, 0.8), (0.45, 0.8), "text")
    _arrow(ax, (0.65, 0.8), (0.7, 0.8), "sentences")
    _arrow(ax, (0.8, 0.72), (0.12, 0.56), rad=-0.25)
    ax.text(0.47, 0.505, "WAV reply + text", ha="center", fontsize=8, color=MUTED, bbox=dict(fc="white", ec="none", pad=0.6))
    _arrow(ax, (0.6, 0.73), (0.87, 0.55), "prompt + evidence", style="<|-|>")
    _arrow(ax, (0.52, 0.73), (0.35, 0.42), "tool calls / results", style="<|-|>")
    _arrow(ax, (0.57, 0.73), (0.62, 0.43), "search / passages", style="<|-|>")
    _arrow(ax, (0.12, 0.57), (0.21, 0.38), "CRUD, yes / no", style="<|-|>")
    _arrow(ax, (0.3, 0.27), (0.3, 0.12), "rows", style="<|-|>")
    _arrow(ax, (0.62, 0.27), (0.62, 0.12), "chunks, vectors", style="<|-|>")
    _arrow(ax, (0.4, 0.35), (0.52, 0.35), "notes / memos text")
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)


def _style_axes(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.grid(axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)


def burndown(path, weeks, ideal, actual, total):
    fig, ax = plt.subplots(figsize=(8, 4.2))
    _style_axes(ax)
    ax.plot(weeks, ideal, color=MUTED, lw=1.5, ls="--")
    ax.plot(weeks, actual, color=BLUE, lw=2, marker="o", markersize=6, markeredgecolor="white", markeredgewidth=1.5)
    ax.text(4.1, ideal[4] - 6, "Ideal", color=MUTED, va="top", fontsize=9)
    ax.text(weeks[-1] + 0.15, actual[-1], f"Actual ({actual[-1]} pts left)", color=INK, va="center", fontsize=9)
    for s in (2, 4, 6):
        ax.axvline(s, color=GRID, lw=1)
    for i, s in enumerate((1, 3, 5, 7)):
        ax.text(s, total * 1.02, f"Sprint {i + 1}", ha="center", fontsize=9, color=MUTED)
    ax.set_xlim(0, 9.6)
    ax.set_ylim(0, total * 1.08)
    ax.set_xticks(weeks)
    ax.set_xlabel("Week")
    ax.set_ylabel("Story points remaining")
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)


def velocity(path, names, committed, completed):
    fig, ax = plt.subplots(figsize=(8, 3.8))
    _style_axes(ax)
    x = range(len(names))
    bw = 0.36
    b1 = ax.bar([i - bw / 2 - 0.01 for i in x], committed, bw, color=BLUE, label="Committed")
    b2 = ax.bar([i + bw / 2 + 0.01 for i in x], completed, bw, color=ORANGE, label="Completed")
    for bars in (b1, b2):
        for b in bars:
            ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.8, f"{int(b.get_height())}", ha="center", fontsize=9, color=INK)
    ax.set_xticks(list(x))
    ax.set_xticklabels(names)
    ax.set_ylabel("Story points")
    ax.set_ylim(0, max(committed) * 1.18)
    ax.legend(frameon=False, loc="upper left")
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)
