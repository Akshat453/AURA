"""Builds the Agile Lab project report (Word .docx) from the repository.

    /opt/anaconda3/bin/python docs/report/build_report.py      (or: make report)

Change ROLLNO (and the placeholders below it) and run again. The figures are
regenerated each time; the ER diagram is read from the seeded demo SQLite
databases (run `go run ./cmd/db seed` first). Screenshots come from
scripts/report-screenshots.mjs. Then run docs/report/finalize.py with
LibreOffice's Python to fill in the table of contents and export a PDF.
"""
import os
import re
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor

# ---------------------------------------------------------------------------
# EDIT THESE: your roll number gives the file name; nothing else is invented.
ROLLNO = "ROLLNO"
TEAM = [  # (name, roll number) — replace the placeholders; delete unused rows
    ("[Team member 1 name]", "[Roll no.]"),
    ("[Team member 2 name]", "[Roll no.]"),
    ("[Team member 3 name]", "[Roll no.]"),
    ("[Team member 4 name]", "[Roll no.]"),
]
GUIDE = "[Guide name, designation]"
DEPARTMENT = "[Department of Computer Science and Engineering — verify]"
ACADEMIC_YEAR = "2026–27"
# Scrum roles are mapped to the team rows above by index.
PRODUCT_OWNER, SCRUM_MASTER, DEV_TEAM = 0, 1, (2, 3)
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FIG = os.path.join(HERE, "figures")
SHOTS = os.path.join(HERE, "screenshots")
DEMO = os.environ.get("DEMO_DATA_PATH") or os.path.join(ROOT, "data", "demo")
OUT = os.path.join(ROOT, "docs", f"{ROLLNO}_Agile_Lab_Project Report.docx")
TITLE = "Professor Voice Assistant"
SUBTITLE = "A Local-First, Bilingual (English and Hindi) Voice and Web Assistant for University Faculty"

sys.path.insert(0, HERE)
import figures  # noqa: E402

# ---------------------------------------------------------------------------
# Sprint plan. Illustrative planning data derived from the sprint plans and
# the repository's phase history (git log: phase0&phase3, phase3&phase4,
# backend fixes, phase5); story points are the team's estimates.
STORIES = [
    # id, story, priority, points, planned sprint, done sprint (None = not done)
    ("US-01", "As a professor, I want to hold a button and ask a question by voice in the browser, so that I can use the assistant hands-free.", "High", 8, 1, 1),
    ("US-02", "As a professor, I want my speech transcribed on my own computer, so that my voice recordings never leave it.", "High", 5, 1, 1),
    ("US-03", "As a professor, I want the answer streamed and spoken sentence by sentence, so that I hear the reply quickly.", "High", 8, 1, 1),
    ("US-04", "As a professor, I want to type a question and read the answer, so that I can use the assistant in a quiet room.", "Medium", 3, 1, 1),
    ("US-05", "As a professor, I want to stop a reply at any time, so that I am not forced to listen to a long answer.", "Medium", 3, 1, 1),
    ("US-06", "As a professor, I want answers in a Hindi voice when I ask in Hindi, so that the conversation stays in my language.", "Medium", 3, 1, 2),
    ("US-07", "As a professor, I want to ask in Hindi or Hinglish and be understood, so that I can speak naturally.", "High", 8, 2, 2),
    ("US-08", "As a developer, I want to measure speech recognition accuracy (WER/CER) on public recordings, so that model choices are based on evidence.", "Medium", 5, 2, 2),
    ("US-09", "As a professor, I want a desk device (ESP32) that connects securely to my computer, so that I can ask questions without opening the browser.", "High", 8, 2, 2),
    ("US-10", "As a developer, I want a device simulator, so that the device protocol can be tested without hardware.", "Medium", 5, 2, 2),
    ("US-11", "As a professor, I want to upload course documents (PDF, DOCX, PPTX, TXT, MD) and have them indexed locally, so that I can ask questions about them.", "High", 8, 3, 3),
    ("US-12", "As a professor, I want answers grounded in my documents with citations, so that I can verify every claim.", "High", 8, 3, 3),
    ("US-13", "As a professor, I want current information from a web search with sources, so that answers are up to date.", "Medium", 5, 3, 3),
    ("US-14", "As a professor, I want to decide whether document text may be sent to the cloud model, so that confidential material stays private.", "High", 3, 3, 3),
    ("US-15", "As a developer, I want to evaluate retrieval quality (Recall@k, MRR), so that search settings are chosen by measurement.", "Low", 3, 3, 3),
    ("US-16", "As a professor, I want to verify the desk device on real ESP32 hardware, so that the classroom set-up is proven end to end.", "High", 5, 3, None),
    ("US-17", "As a professor, I want a weekly timetable with today's and the next class, so that I always know where I have to be.", "High", 8, 4, 4),
    ("US-18", "As a professor, I want to create reminders by voice and be notified when they are due, so that I do not miss deadlines.", "High", 8, 4, 4),
    ("US-19", "As a professor, I want notes and voice memos that I can search in English or Hindi, so that ideas are not lost.", "Medium", 5, 4, 4),
    ("US-20", "As a professor, I want email and announcement drafts that are never sent automatically, so that I stay in control of communication.", "Medium", 5, 4, 4),
    ("US-21", "As a professor, I want to confirm or cancel every data-changing action by voice or button, so that the assistant never acts on a misunderstanding.", "High", 8, 4, 4),
    ("US-22", "As a professor, I want a clean, responsive web interface with a dashboard, so that I can see my day at a glance on any screen.", "Medium", 5, 4, 4),
    ("US-23", "As a professor, I want one command to start and stop everything and a configuration check, so that setting up is easy.", "Medium", 3, 4, 4),
    ("US-24", "As a professor, I want optional read-only Google Calendar and Gmail drafts, so that I can use them if my institution allows it.", "Low", 5, 4, 4),
    ("US-25", "As an evaluator, I want realistic demo data, so that every screen can be assessed without real personal data.", "Low", 2, 4, 4),
    ("US-26", "As a team, we want automated build, test and deployment (CI/CD), so that every increment is verified and deployable.", "Medium", 5, None, None),
    ("US-27", "As a professor, I want Microsoft 365 (Outlook calendar and mail drafts) integration.", "Low", 8, None, None),
]
SPRINTS = [
    dict(n=1, name="Sprint 1 (Weeks 1–2)", goal="A working voice loop in the browser: speak, transcribe locally, answer with Gemini and speak the answer.",
         tasks=["Go HTTP server and WebSocket protocol (control JSON + VAP1 binary audio frames)", "AudioWorklet microphone capture and PCM16 streaming",
                "Band-limited resampling to 16 kHz and speech/silence validation in Go", "whisper.cpp client and Gemini streaming client",
                "Sentence splitter and Piper text-to-speech queue", "Basic web page, health and readiness endpoints"],
         review="The increment was demonstrated end to end in English. The Hindi voice (US-06) was not finished and was carried over.",
         well=["Interfaces for speech-to-text, the language model and text-to-speech kept components replaceable.", "Early end-to-end demo exposed latency hot spots."],
         improve=["Story US-06 was underestimated because voice routing depended on language detection.", "Manual testing of audio was slow."],
         actions=["Add an automated speech evaluation (became US-08).", "Split stories that depend on unfinished work."]),
    dict(n=2, name="Sprint 2 (Weeks 3–4)", goal="Understand Hindi and Hinglish, and connect a secure desk device.",
         tasks=["Route English to Whisper small and Hindi/Hinglish/Auto to large-v3-turbo", "STT evaluation tooling on FLEURS and OpenSLR recordings (WER/CER)",
                "Fix the speech gate that rejected quiet speech (app WER 62.4% → 6.7% for English)", "Device protocol: TLS listener, per-device HMAC challenge-response, paced 16 kHz audio",
                "devicectl provisioning tool and device simulator", "USB audio bridge (contributed in a separate branch)"],
         review="Hindi and Hinglish questions were answered in the right voice. The device protocol passed its tests with the simulator; real hardware was not yet available.",
         well=["Measuring WER before and after each change turned opinions into decisions.", "The simulator let the whole team test the device path."],
         improve=["Hinglish accuracy remains limited (about 67% WER, much of it script differences).", "Branch merges needed more coordination."],
         actions=["Keep evaluation results in docs/STT_EVALUATION.md.", "Merge through pull requests with a short description."]),
    dict(n=3, name="Sprint 3 (Weeks 5–6)", goal="Answers grounded in the professor's own documents and in web search, with citations and privacy control.",
         tasks=["Upload validation, text extraction (TXT, MD, DOCX, PPTX in Go; PDF in the sidecar)", "Chunking by headings and pages; SQLite FTS5 keyword index",
                "multilingual-e5-small embeddings and hybrid search with Reciprocal Rank Fusion", "Citation checking and prompt-injection-safe evidence",
                "Tavily web search tool with caching", "Consent setting for sending passages to Gemini; rag-eval tool"],
         review="Hybrid search reached Recall@5 of 100% on the labelled set. Real ESP32 verification (US-16) was attempted but could not be completed and stays in progress.",
         well=["Search quality was measured, which justified the hybrid design.", "Privacy defaults were agreed with the Product Owner before coding."],
         improve=["Hardware availability blocked US-16.", "Some stories mixed backend and UI work."],
         actions=["Track hardware verification as its own story.", "Separate UI tasks on the board."]),
    dict(n=4, name="Sprint 4 (Weeks 7–8)", goal="Turn the assistant into a professor's daily tool: timetable, reminders, notes, memos and drafts, with confirmation before any change.",
         tasks=["SQLite professor database with migrations (classes, reminders, notes, memos, drafts)", "Reminder scheduler and browser notifications",
                "Tool calling with staged proposals and voice/button confirmation (execute once)", "Notes and memo transcripts indexed for search",
                "Redesigned responsive web interface (sidebar, dashboard, ten screens)", "start/stop scripts, config-check, startup guide, demo seed data"],
         review="All new Sprint 4 stories met the Definition of Done. US-16 (carried from Sprint 3) is still in progress because the hardware set-up was not available. Google integrations are tested with simulated servers only.",
         well=["The confirmation design prevented every unconfirmed change in tests, including prompt-injection attempts.", "Browser UI checks caught a stale-render bug before the review."],
         improve=["The sprint was large; velocity rose but the burndown was steep at the end.", "No automated pipeline: tests were run by hand before the review."],
         actions=["Introduce CI/CD (US-26) in the next phase.", "Keep stories at 8 points or fewer."]),
]
# Weekly share of each sprint's completed points (first week, second week).
WEEK_SPLIT = (0.4, 0.6)

# ---------------------------------------------------------------------------
doc = Document()
FONT = "Times New Roman"
counters = {"h1": 0, "h2": 0, "h3": 0, "fig": 0, "tab": 0}
HEADINGS = []  # (level, text) in document order, for the table of contents
TOC_PAGES = os.path.join(HERE, "out", "toc-pages.json")  # written by finalize.py
toc_marker = None


def set_cell_shading(cell, hex_fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcPr.append(shd)


def add_field(paragraph, instr, placeholder=""):
    run = paragraph.add_run()
    for tag, text in (("begin", None), ("instr", instr), ("separate", None), ("text", placeholder), ("end", None)):
        if tag == "instr":
            el = OxmlElement("w:instrText")
            el.set(qn("xml:space"), "preserve")
            el.text = text
            run._r.append(el)
        elif tag == "text":
            t = OxmlElement("w:t")
            t.text = text
            run._r.append(t)
        else:
            el = OxmlElement("w:fldChar")
            el.set(qn("w:fldCharType"), tag)
            run._r.append(el)
    return run


def style_setup():
    st = doc.styles
    normal = st["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(12)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    pf = normal.paragraph_format
    pf.space_after = Pt(6)
    pf.line_spacing = 1.3
    for name, size, before in (("Heading 1", 16, 0), ("Heading 2", 13.5, 12), ("Heading 3", 12, 10)):
        h = st[name]
        h.font.name = FONT
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.color.rgb = RGBColor(0x0F, 0x4F, 0x4A) if name != "Heading 3" else RGBColor(0x1F, 0x23, 0x28)
        rpr = h.element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts")
            rpr.append(rf)
        for a in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
            rf.set(qn(a), FONT)
        for a in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            rf.attrib.pop(qn(a), None)  # theme fonts would override Times New Roman
        h.paragraph_format.space_before = Pt(before)
        h.paragraph_format.space_after = Pt(6)
        h.paragraph_format.keep_with_next = True
    cap = st["Caption"]
    cap.font.name = FONT
    cap.font.size = Pt(10)
    cap.font.italic = True
    cap.font.bold = False
    cap.font.color.rgb = RGBColor(0x3D, 0x4A, 0x5C)
    for name in ("List Bullet", "List Number"):
        st[name].font.name = FONT
        st[name].font.size = Pt(12)
        st[name].paragraph_format.space_after = Pt(3)
    # The template's zoom element lacks the required percent attribute.
    zoom = doc.settings.element.find(qn("w:zoom"))
    if zoom is not None:
        zoom.set(qn("w:percent"), "100")


def page_setup():
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21.0)
    sec.left_margin = sec.right_margin = Inches(1)
    sec.top_margin = sec.bottom_margin = Inches(1)
    sec.different_first_page_header_footer = True
    sec.first_page_footer.paragraphs[0].text = ""  # cover page: no number
    sec.first_page_header.paragraphs[0].text = ""
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = fp.add_run("Page ")
    r.font.size = Pt(10)
    add_field(fp, "PAGE", "1").font.size = Pt(10)
    hp = sec.header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    hr = hp.add_run(f"{TITLE} — Agile Lab Project Report")
    hr.font.size = Pt(9)
    hr.font.color.rgb = RGBColor(0x5B, 0x64, 0x70)


def rich(p, text):
    """Adds text with **bold** and `code` spans."""
    for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**"):
            p.add_run(part[2:-2]).bold = True
        elif part.startswith("`"):
            r = p.add_run(part[1:-1])
            r.font.name = "Courier New"
            r.font.size = Pt(10.5)
        else:
            p.add_run(part)
    return p


def para(text, align=WD_ALIGN_PARAGRAPH.JUSTIFY):
    p = doc.add_paragraph()
    p.alignment = align
    return rich(p, text)


def bullets(items, style="List Bullet"):
    for it in items:
        p = doc.add_paragraph(style=style)
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        rich(p, it)


def h1(text, new_page=True):
    # A trailing empty spacer would otherwise be pushed onto a page of its own.
    last = doc.element.body[-2] if doc.element.body[-1].tag == qn("w:sectPr") else doc.element.body[-1]
    if new_page and last.tag == qn("w:p") and not "".join(last.itertext()).strip() and last.find(".//" + qn("w:drawing")) is None:
        last.getparent().remove(last)
    counters["h1"] += 1
    counters["h2"] = counters["h3"] = 0
    p = doc.add_heading(f"{counters['h1']}  {text}", level=1)
    p.paragraph_format.page_break_before = new_page
    HEADINGS.append((1, p.text))
    return p


def h2(text):
    counters["h2"] += 1
    counters["h3"] = 0
    p = doc.add_heading(f"{counters['h1']}.{counters['h2']}  {text}", level=2)
    HEADINGS.append((2, p.text))
    return p


def h3(text):
    counters["h3"] += 1
    return doc.add_heading(f"{counters['h1']}.{counters['h2']}.{counters['h3']}  {text}", level=3)


def caption(kind, text):
    key = "fig" if kind == "Figure" else "tab"
    counters[key] += 1
    p = doc.add_paragraph(style="Caption")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run(f"{kind} {counters['h1']}.{counters[key]}: ").bold = True
    p.add_run(text)
    if kind == "Table":
        p.paragraph_format.keep_with_next = True
    return f"{kind} {counters['h1']}.{counters[key]}"


def figure(path, text, width=6.2):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    if os.path.exists(path):
        p.add_run().add_picture(path, width=Inches(width))
    else:
        r = p.add_run(f"[SCREENSHOT PLACEHOLDER — {os.path.basename(path)} could not be captured]")
        r.bold = True
    return caption("Figure", text)


def figure_pair(paths, text, width=2.6):
    t = doc.add_table(rows=1, cols=len(paths))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for cell, path in zip(t.rows[0].cells, paths):
        cp = cell.paragraphs[0]
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.add_run().add_picture(path, width=Inches(width))
    set_widths(t, [width + 0.3] * len(paths))
    return caption("Figure", text)


def set_widths(t, widths):
    """Sets both the grid and the cell widths (LibreOffice reads the grid)."""
    t.autofit = False
    grid = t._tbl.tblGrid
    for i, gc in enumerate(grid.findall(qn("w:gridCol"))):
        gc.set(qn("w:w"), str(int(widths[i] * 1440)))
    for row in t.rows:
        for i, w in enumerate(widths):
            row.cells[i].width = Inches(w)


def table(headers, rows, widths, text, font=10):
    label = caption("Table", text)
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ""
        r = c.paragraphs[0].add_run(h)
        r.bold = True
        r.font.size = Pt(font)
        set_cell_shading(c, "DCEBE9")
    trPr = t.rows[0]._tr.get_or_add_trPr()
    th = OxmlElement("w:tblHeader")
    th.set(qn("w:val"), "true")
    trPr.append(th)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.1
            rich(p, str(v))
            for r in p.runs:
                r.font.size = Pt(font)
    set_widths(t, widths)
    spacer = doc.add_paragraph()  # small gap after the table (a full line could spill onto an empty page)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = Pt(6)
    return label


def code(text, label):
    t = doc.add_table(rows=1, cols=1)
    t.style = "Table Grid"
    c = t.rows[0].cells[0]
    set_cell_shading(c, "F4F5F7")
    set_widths(t, [6.27])
    c.text = ""
    lines = text.strip("\n").split("\n")
    p = c.paragraphs[0]
    p.paragraph_format.line_spacing = 1.0
    p.paragraph_format.space_after = Pt(0)
    for i, line in enumerate(lines):
        r = p.add_run(line)
        r.font.name = "Courier New"
        r.font.size = Pt(8.5)
        if i < len(lines) - 1:
            r.add_break()
    caption("Figure", label)


def summary(story):
    t = story.split(", so that")[0]
    for prefix in ("As a professor, I want ", "As a developer, I want ", "As an evaluator, I want ", "As a team, we want "):
        t = t.replace(prefix, "")
    return t[:1].upper() + t[1:]


def page_break():
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# ---------------------------------------------------------------------------
def build_figures():
    os.makedirs(FIG, exist_ok=True)
    prof_db = os.path.join(DEMO, "professor", "professor.db")
    rag_db = os.path.join(DEMO, "rag", "index.db")
    if not (os.path.exists(prof_db) and os.path.exists(rag_db)):
        sys.exit("The demo databases are missing: run `go run ./cmd/db seed` first (the ER diagram is read from them).")
    figures.architecture(os.path.join(FIG, "architecture.png"))
    figures.er_diagram(os.path.join(FIG, "er-diagram.png"), prof_db, rag_db)
    figures.use_cases(os.path.join(FIG, "use-cases.png"))
    figures.data_flow(os.path.join(FIG, "data-flow.png"))
    total = sum(s[3] for s in STORIES if s[4] is not None)
    weeks, actual = [0], [total]
    remaining = total
    for sp in SPRINTS:
        done = sum(s[3] for s in STORIES if s[5] == sp["n"])
        for share in WEEK_SPLIT:
            remaining -= round(done * share)
            weeks.append(len(weeks))
            actual.append(remaining)
    actual[-1] = total - sum(s[3] for s in STORIES if s[5] is not None)
    ideal = [total - total * w / 8 for w in weeks]
    figures.burndown(os.path.join(FIG, "burndown.png"), weeks, ideal, actual, total)
    committed, completed = sprint_points()
    figures.velocity(os.path.join(FIG, "velocity.png"), [f"Sprint {s['n']}" for s in SPRINTS], committed, completed)
    return total, actual


def sprint_points():
    committed, completed = [], []
    for sp in SPRINTS:
        n = sp["n"]
        carried = [s for s in STORIES if s[4] is not None and s[4] < n and (s[5] is None or s[5] >= n) and s[4] != n]
        planned = [s for s in STORIES if s[4] == n] + carried
        committed.append(sum(s[3] for s in planned))
        completed.append(sum(s[3] for s in STORIES if s[5] == n))
    return committed, completed


def cover():
    for _ in range(3):
        doc.add_paragraph()
    for text, size, bold, color in (
        ("PANDIT DEENDAYAL ENERGY UNIVERSITY", 16, True, "0F4F4A"), (DEPARTMENT, 12, False, "1F2328"),
        ("", 12, False, "000000"), ("Agile Lab — Project Report", 14, True, "1F2328"), ("", 12, False, "000000"),
        (TITLE, 26, True, "0F6E66"), (SUBTITLE, 14, False, "1F2328"), ("", 12, False, "000000"),
        ("A Web and App Development project following the Scrum framework", 12, False, "5B6470"),
    ):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(text)
        r.font.size, r.bold, r.font.color.rgb = Pt(size), bold, RGBColor.from_string(color)
    doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run("Submitted by").bold = True
    t = doc.add_table(rows=1, cols=2)
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(("Name", "Roll number")):
        t.rows[0].cells[i].text = ""
        t.rows[0].cells[i].paragraphs[0].add_run(h).bold = True
        set_cell_shading(t.rows[0].cells[i], "DCEBE9")
    for name, roll in TEAM:
        cells = t.add_row().cells
        cells[0].text, cells[1].text = name, roll
    set_widths(t, [3.2, 1.8])
    doc.add_paragraph()
    for label, value in (("Course", "Agile Lab"), ("Guide", GUIDE), ("Academic year", ACADEMIC_YEAR), ("Report file", f"{ROLLNO}_Agile_Lab_Project Report")):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(2)
        p.add_run(f"{label}: ").bold = True
        p.add_run(value)


def toc():
    p = doc.add_paragraph()
    p.paragraph_format.page_break_before = True
    r = p.add_run("Table of Contents")
    r.bold, r.font.size, r.font.color.rgb = True, Pt(16), RGBColor(0x0F, 0x4F, 0x4A)
    global toc_marker
    toc_marker = doc.add_paragraph()


def fill_toc():
    """Writes the table of contents as a Word TOC field whose cached result
    already lists every heading with its page (from finalize.py's PDF pass),
    so it is correct before Word refreshes fields; Word's Update Field
    regenerates it."""
    import json
    pages = {}
    if os.path.exists(TOC_PAGES):
        pages = json.load(open(TOC_PAGES))
    entries = [(lvl, text, str(pages.get(text, "–"))) for lvl, text in HEADINGS]

    def fld(run_parent, kind):
        r = OxmlElement("w:r")
        c = OxmlElement("w:fldChar")
        c.set(qn("w:fldCharType"), kind)
        r.append(c)
        run_parent.append(r)

    for i, (lvl, text, page) in enumerate(entries):
        p = toc_marker.insert_paragraph_before()
        pf = p.paragraph_format
        pf.left_indent = Inches(0 if lvl == 1 else 0.3)
        pf.space_after = Pt(2 if lvl == 2 else 4)
        pf.space_before = Pt(4 if lvl == 1 else 0)
        pf.line_spacing = 1.0
        pf.tab_stops.add_tab_stop(Inches(6.27), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        if i == 0:
            fld(p._p, "begin")
            r = OxmlElement("w:r")
            it = OxmlElement("w:instrText")
            it.set(qn("xml:space"), "preserve")
            it.text = 'TOC \\o "1-2" \\h \\z \\u'
            r.append(it)
            p._p.append(r)
            fld(p._p, "separate")
        run = p.add_run(text + "\t" + page)
        run.bold = lvl == 1
        run.font.size = Pt(11.5 if lvl == 1 else 11)
        if i == len(entries) - 1:
            fld(p._p, "end")


# ---------------------------------------------------------------------------
def main():
    style_setup()
    page_setup()
    total, actual = build_figures()
    committed, completed = sprint_points()
    cover()
    toc()

    # Abstract (unnumbered)
    p = doc.add_heading("Abstract", level=1)
    p.paragraph_format.page_break_before = True
    HEADINGS.append((1, "Abstract"))
    para("University faculty spend a considerable part of the day on small administrative tasks: checking the timetable, remembering deadlines, writing notices to students and finding information in course documents. General-purpose voice assistants are cloud services that do not know a professor's timetable or documents, are weak in Hindi and Hinglish, and act on commands without asking. This project, **Professor Voice Assistant**, is a local-first voice and web assistant built for this setting. A professor can ask questions by voice or text in English, Hindi or Hinglish; speech is recognised on the professor's own Mac by whisper.cpp, answers are generated by Google Gemini, grounded where needed in the professor's own documents or a web search with citations, and spoken back by Piper text-to-speech in English or Hindi.")
    para("Beyond questions, the assistant manages a weekly timetable, reminders with a scheduler, notes, voice memos and email or announcement drafts. Every data-changing action is staged as a proposal and executed only after the professor confirms it by voice or with a button; drafts are never sent. Data is stored in two local SQLite databases, and document text reaches the cloud model only with explicit consent. An ESP32-S3 desk device can join the same pipeline over an authenticated TLS WebSocket.")
    para(f"The system was developed in a Go backend with a framework-free JavaScript interface, using Scrum over four two-week sprints. The final increment passes {GO_TESTS} automated Go tests in {GO_PACKAGES} packages under the race detector, {JS_TESTS} JavaScript unit tests and {UI_CHECKS} end-to-end browser checks. Measured results include English speech recognition at 7.2% word error rate on public recordings and hybrid document retrieval with 100% Recall@5 on a labelled question set. Continuous integration and delivery are planned for the next phase.")
    para("**Keywords:** voice assistant, Scrum, speech recognition, retrieval-augmented generation, SQLite, Go, Hindi, privacy, human-in-the-loop confirmation.")

    # 1 Introduction
    h1("Introduction")
    h2("Background")
    para("A professor's working day mixes teaching with many small tasks that interrupt it: finding the room of the next lecture, remembering to submit marks, preparing an announcement, or recalling what a syllabus says about evaluation. These tasks are short but frequent, and they usually happen while the professor's hands and attention are busy — between classes, in the corridor or at the lab. Speech is a natural interface for such moments, and recent open speech models make accurate recognition possible on an ordinary laptop.")
    h2("Problem statement")
    para("Existing assistants do not fit this workflow well. Cloud assistants know nothing about an individual professor's timetable or course documents, send every recording to a remote service, handle Hindi and code-mixed Hinglish poorly, and execute commands immediately, so a misheard request silently creates the wrong reminder. Institutional portals hold the data but have no conversational interface. The problem addressed by this project is therefore: **to build an assistant that understands a professor's spoken English, Hindi and Hinglish, answers from trustworthy sources with citations, manages the professor's own academic data, never changes anything without explicit confirmation, and keeps personal data on the professor's computer.**")
    h2("Objectives")
    bullets(["Provide a hold-to-talk voice interface and a text chat in the browser, with streamed answers spoken sentence by sentence.",
             "Recognise speech locally, routing English to a fast model and Hindi, Hinglish and automatic detection to a multilingual model.",
             "Answer from four sources — general knowledge, the professor's documents, the web, or automatic choice — with verifiable citations.",
             "Manage a timetable, reminders, notes, voice memos and drafts, with a confirmation step before every change.",
             "Keep data local by default (SQLite) and make every transfer to a cloud service explicit and controllable.",
             "Support a low-cost ESP32-S3 desk device over a secure protocol.",
             "Follow Scrum throughout development and measure quality with automated tests and evaluations."])
    h2("Scope")
    para("The scope is a single-user application that runs on the professor's Mac and is used through a browser on the same computer (http://127.0.0.1:8090) or through a provisioned desk device on the local network. It includes speech recognition, answer generation, document retrieval, web search, the professor tools listed above, optional read-only Google Calendar and Gmail draft creation, a configuration audit and startup scripts. It does not include user accounts or multi-user access, sending email, editing institutional systems such as the ERP, or hosting on a public server. Microsoft 365 integration is on hold, and continuous integration and deployment are planned for the next phase.")
    h2("Target users")
    para("The primary users are university professors and teaching faculty who teach several courses and sections, often bilingual in English and Hindi. Secondary stakeholders are department staff who receive announcements and students who benefit from timely communication. During development the team members also acted as testers and as evaluators of the demo data.")

    # 2 Literature / existing systems
    h1("Existing Systems and Proposed Solution")
    h2("Review of existing systems")
    table(["System type", "Strengths", "Limitations for a professor"],
          [["Cloud voice assistants (phone and smart-speaker assistants)", "Mature speech recognition, broad general knowledge", "No access to the professor's timetable or course files; recordings processed in the cloud; actions run without confirmation; limited Hinglish support"],
           ["General chatbots (large language model chat apps)", "Fluent answers and drafting", "Answers are not grounded in local documents; no reliable citations; no reminders or timetable; text typed manually"],
           ["University ERP and learning management portals", "Authoritative academic records", "Form-based, no conversational or voice interface; not available offline"],
           ["Calendar, notes and reminder apps", "Good single-purpose tools", "Separate apps, no unified voice access, no document question answering"]],
          [1.6, 1.8, 2.8], "Comparison of existing approaches")
    para("Research supports the components used here. Whisper showed that weakly supervised training on large multilingual audio gives robust recognition across languages [3]. Retrieval-augmented generation grounds a language model's answer in retrieved passages [7], and combining keyword (BM25) and vector rankings with Reciprocal Rank Fusion is a simple, strong baseline [8]. Multilingual E5 embeddings support cross-lingual retrieval between Hindi questions and English documents [6].")
    h2("Proposed solution")
    para("The proposed system combines these components in one local application with three design principles. **Local first:** speech recognition, speech synthesis, document storage, embeddings and the professor's data stay on the Mac; only the question (and, with consent, short passages) is sent to Gemini. **Grounded answers:** every claim drawn from documents or the web carries a citation that is checked against the retrieved sources. **Human in the loop:** the language model can only propose changes; the Go backend validates each proposal, asks a confirmation question written by the program (not by the model), and executes it once after the professor's own yes.")

    # 3 Requirements
    h1("Requirement Analysis")
    h2("Functional requirements")
    table(["ID", "Requirement"],
          [["FR-01", "The user can ask a question by holding the microphone button or by typing, and receives a streamed text answer and spoken audio."],
           ["FR-02", "The user can choose the language (Auto, English, Hindi, Hinglish) and the answer source (Auto, General, Documents, Web)."],
           ["FR-03", "The system shows citations for document and web evidence and lists the sources under the answer."],
           ["FR-04", "The user can upload PDF, DOCX, PPTX, TXT and Markdown documents, see their indexing status, re-index, delete and test a search."],
           ["FR-05", "The user can add, edit, delete, import (CSV) and export classes, and view the timetable by day and by week with the current and next class highlighted."],
           ["FR-06", "The user can create, edit, complete and delete reminders, including daily, weekday and weekly recurrence; due reminders appear in the browser."],
           ["FR-07", "The user can write, tag, search and delete notes; search works in English and Hindi."],
           ["FR-08", "The user can record a voice memo, preview it, transcribe it locally and save it with or without the audio."],
           ["FR-09", "The user can create, edit, copy and delete email and announcement drafts; the system never sends email."],
           ["FR-10", "Any change requested through the assistant is shown as a confirmation card and executed only after the user confirms by voice or button before it expires."],
           ["FR-11", "The user can stop a reply, start a new conversation and view diagnostics if enabled."],
           ["FR-12", "A provisioned ESP32 device can hold a voice conversation through the same pipeline after authentication."],
           ["FR-13", "Optional: the user can connect Google Calendar (read-only) and create Gmail drafts."]],
          [0.7, 5.5], "Functional requirements")
    h2("Non-functional requirements")
    table(["ID", "Category", "Requirement"],
          [["NFR-01", "Privacy", "Recordings, documents, notes and the databases stay on the Mac; document and note text is sent to Gemini only with server permission and session consent."],
           ["NFR-02", "Security", "REST changes need a same-origin header; the API listens on localhost; devices use TLS and a per-device secret; secrets are never logged."],
           ["NFR-03", "Safety", "No data-changing action runs without explicit confirmation; each confirmed action runs at most once."],
           ["NFR-04", "Performance", "Answers stream as they are generated; English speech recognition completes in about half a second (median 518 ms in evaluation)."],
           ["NFR-05", "Usability", "Responsive layout for desktop, tablet and phone widths; keyboard navigation; reduced-motion support; light and dark themes."],
           ["NFR-06", "Reliability", "Concurrency is tested with the race detector; the reminder scheduler recovers after a restart; optional services can fail without stopping the app."],
           ["NFR-07", "Maintainability", "Provider interfaces isolate speech, language model and search services; configuration is audited by a read-only tool."],
           ["NFR-08", "Portability", "Pure-Go SQLite driver (no C compiler needed for the backend); one command starts all services."]],
          [0.8, 1.1, 4.3], "Non-functional requirements")
    h2("User personas")
    table(["Persona", "Profile", "Goals", "Frustrations"],
          [["Persona A: Senior professor", "Teaches three courses, heads a research group, prefers speaking Hindi or Hinglish", "Know the next class and room instantly; never miss marks deadlines", "Switching between portals; typing on the phone between classes"],
           ["Persona B: Assistant professor", "Teaches labs and a project course, writes many notices", "Quick, polite announcements; answers from the syllabus with references", "Rewriting the same notices; searching long PDFs"],
           ["Persona C: Lab coordinator (secondary)", "Manages lab schedules and equipment", "Reminders for orders and records", "Lost notes and verbal requests"]],
          [1.3, 1.7, 1.6, 1.6], "User personas")
    figure(os.path.join(FIG, "use-cases.png"), "Use-case diagram", width=6.0)

    # 4 Agile methodology
    h1("Agile Methodology (Scrum)")
    h2("Why Agile and Scrum")
    para("The requirements of a voice assistant cannot be fixed in advance: recognition quality, latency and the usefulness of answers only become clear when real speech is tried. Agile development addresses this uncertainty by delivering a working increment in short iterations and adapting the plan to what is learned. Scrum was chosen because it provides a light structure for a small student team — fixed-length sprints, three accountabilities and four events — that matches the weekly lab schedule and makes progress visible to the faculty guide at every sprint review [2].")
    h2("Agile Manifesto values in this project")
    table(["Value [1]", "How it was applied"],
          [["Individuals and interactions over processes and tools", "Daily stand-ups and pair debugging of the audio path; decisions recorded briefly in the docs folder instead of heavy documents."],
           ["Working software over comprehensive documentation", "Every sprint ended with a live demo of a running increment; documentation (architecture, protocol, startup guide) was written alongside the code."],
           ["Customer collaboration over contract negotiation", "The Product Owner represented the professor and reviewed privacy defaults and the confirmation design before they were built."],
           ["Responding to change over following a plan", "Hindi accuracy problems found in Sprint 2 led to model routing; the hardware blocker in Sprint 3 was split into its own story instead of stalling the sprint."]],
          [2.2, 4.0], "Agile Manifesto values mapped to the project")
    h2("Scrum roles")
    po, sm = TEAM[PRODUCT_OWNER], TEAM[SCRUM_MASTER]
    devs = ", ".join(TEAM[i][0] for i in DEV_TEAM if i < len(TEAM))
    table(["Role", "Team member", "Responsibilities"],
          [["Product Owner", f"{po[0]} ({po[1]})", "Owns and orders the product backlog, writes acceptance criteria, represents the professor's needs, accepts stories at the sprint review."],
           ["Scrum Master", f"{sm[0]} ({sm[1]})", "Facilitates the Scrum events, removes impediments (for example hardware access), protects the team from scope changes inside a sprint."],
           ["Development Team", devs + " (with the Product Owner and Scrum Master contributing code)", "Self-organises to turn backlog items into a done increment: backend, interface, testing, documentation."],
           ["Faculty guide (stakeholder)", GUIDE, "Attends sprint reviews, gives feedback and evaluates the increment."]],
          [1.4, 2.0, 2.8], "Scrum roles mapped to team members (fill in the placeholders)")
    h2("Scrum artifacts")
    h3("Product backlog")
    para("The product backlog was written as user stories and ordered by the Product Owner. Story points were estimated with planning poker on a Fibonacci scale (1, 2, 3, 5, 8). Table 4.3 lists the backlog as it stood at the end of Sprint 4.")
    table(["ID", "User story", "Priority", "Points", "Status"],
          [[s[0], s[1], s[2], s[3], (f"Done (Sprint {s[5]})" if s[5] else ("In progress" if s[4] else ("On hold" if s[0] == "US-27" else "Planned")))] for s in STORIES],
          [0.6, 3.9, 0.7, 0.55, 0.95], "Product backlog (end of Sprint 4)", font=9)
    h3("Sprint backlog")
    para("At each sprint planning the team selected stories for the sprint goal and broke them into tasks on the board. The sprint backlogs are shown with each sprint in Section 4.6.")
    h3("Increment")
    para("Each sprint produced a usable increment that was demonstrated in the browser: Sprint 1 a voice loop in English, Sprint 2 bilingual recognition and the device protocol, Sprint 3 grounded answers with citations, and Sprint 4 the professor tools with the redesigned interface. Each increment includes all previous ones; nothing was thrown away.")
    h3("Definition of Done")
    bullets(["Code is reviewed by at least one other team member and merged through a pull request.",
             "`go vet` reports nothing, and all Go tests pass with the race detector; JavaScript tests pass.",
             "The feature is demonstrated end to end in the running application (or with the simulator for device features).",
             "Privacy and confirmation rules are respected: no new path sends data to the cloud or changes data without consent.",
             "Documentation (README, docs folder, `.env.example`) is updated.",
             "No open critical defect for the story.",
             "**Planned addition:** the CI pipeline passes on the pull request (see Section 4.9)."])
    h2("Scrum events")
    table(["Event", "When and how long", "What we did"],
          [["Sprint planning", "First lab day of each sprint, about 1.5 hours", "Agreed the sprint goal, selected stories by priority and capacity, estimated with planning poker, created tasks."],
           ["Daily stand-up", "15 minutes on lab days; written stand-up in the team chat on other days", "Each member answered: what I finished, what I will do next, what is blocking me."],
           ["Sprint review", "Last lab day of the sprint, about 1 hour, with the guide", "Live demo of the increment, feedback from the guide, backlog updated by the Product Owner."],
           ["Sprint retrospective", "After the review, 30–45 minutes", "What went well, what to improve, and one to three concrete actions for the next sprint."]],
          [1.3, 1.9, 3.0], "Scrum events")
    h2("Sprints")
    para("The sprints below are derived from the repository's actual feature history (the phase commits in the git log). Dates are given as sprint weeks because the repository records the merged results of each phase rather than day-by-day work.")
    for sp, com, comp in zip(SPRINTS, committed, completed):
        h3(sp["name"])
        para(f"**Sprint goal.** {sp['goal']}")
        n = sp["n"]
        rows = [[s[0] + (" (carried)" if s[4] < n else ""), summary(s[1]), s[3],
                 ("Done" if s[5] == n else "Carried over" if s[5] else "Not done — carried over" if n < 4 else "Not done — in progress")]
                for s in STORIES if s[4] is not None and (s[4] == n or (s[4] < n and (s[5] is None or s[5] >= n)))]
        table(["Story", "Summary", "Points", "Result"], rows, [0.7, 4.0, 0.6, 0.9], f"Sprint {sp['n']} backlog — committed {com} points, completed {comp} points", font=9.5)
        para("**Main tasks:** " + "; ".join(sp["tasks"]) + ".")
        para(f"**Outcome and review notes.** {sp['review']}")
        para("**Retrospective.**")
        table(["Went well", "To improve", "Actions"],
              [["\n".join("• " + x for x in sp["well"]), "\n".join("• " + x for x in sp["improve"]), "\n".join("• " + x for x in sp["actions"])]],
              [2.07, 2.07, 2.07], f"Sprint {sp['n']} retrospective", font=9.5)
    h2("Velocity and burndown")
    para("The table and the first chart below show the committed and completed story points per sprint; the second chart shows the release burndown over the eight weeks. **These charts are illustrative planning data derived from the sprint plans above; they are not measured from a tracking tool.**")
    table(["Sprint", "Committed points", "Completed points", "Completion"],
          [[f"Sprint {s['n']}", c, d, f"{round(100 * d / c)}%"] for s, c, d in zip(SPRINTS, committed, completed)] +
          [["Average velocity", "", round(sum(completed) / len(completed), 1), ""]],
          [1.6, 1.5, 1.5, 1.2], "Velocity per sprint (illustrative planning data)")
    figure(os.path.join(FIG, "velocity.png"), "Committed and completed story points per sprint (illustrative planning data)", width=5.8)
    figure(os.path.join(FIG, "burndown.png"), f"Release burndown over four sprints, {total} planned points (illustrative planning data)", width=5.8)
    para(f"Velocity rose in Sprint 4 because the architecture and test harness from earlier sprints made new features cheaper; the retrospective nevertheless asked for smaller stories. The {actual[-1]} points left at the end belong to US-16, verification on real ESP32 hardware, which is still in progress.")
    h2("Task board snapshot")
    table(["To Do", "In Progress", "Done"],
          [["US-26 CI/CD pipeline (GitHub Actions)\n\nDeploy each increment automatically\n\nVerify Google integrations with a real account\n\nUS-27 Microsoft 365 integration (on hold)",
            "US-16 Verify the desk device on real ESP32 hardware\n\nManual test with a physical microphone and speakers on every supported browser",
            "Voice loop, streaming answers, Hindi/Hinglish routing (US-01 – US-08)\n\nSecure device protocol and simulator (US-09, US-10)\n\nDocuments, web search, citations, consent (US-11 – US-15)\n\nTimetable, reminders, notes, memos, drafts, confirmation, UI, scripts, demo data (US-17 – US-25)"]],
          [2.0, 2.0, 2.2], "Kanban board at the end of Sprint 4", font=9.5)
    h2("Continuous Integration & Continuous Delivery in our Scrum Process")
    p = para("**Status: PLANNED — to be implemented in the CI/CD phase (GitHub Actions + deployment). No pipeline exists in the repository at the time of this report; all tests in Chapter 7 were run manually.**")
    para("Continuous integration and continuous delivery support Scrum by making the Definition of Done automatic and every increment releasable. The planned process is:")
    bullets(["**Automated build and test on every push and pull request.** A GitHub Actions workflow will run `go vet`, `go test -race ./...` and the JavaScript tests (`node --test`). Tests that need local model servers will stay behind their existing opt-in flags.",
             "**Pipeline in the Definition of Done.** A story is done only when its pull request has a passing pipeline; a red pipeline blocks the merge.",
             "**A deployable increment every sprint.** The workflow will build the Go binary and package it with the web assets, so the increment shown at the sprint review is exactly the artifact the pipeline produced.",
             "**Automated deployment of the increment.** After a merge to the main branch, the packaged build will be published as a release (and, if a hosted demo is used, deployed to it) without manual steps.",
             "**Link to the sprint review.** The review will start from the pipeline's latest successful run: the test report and the release are part of the evidence that the sprint goal was met; failures found in review become backlog items."])
    h3("CI/CD Implementation Results (to be added)")
    para("[To be added after the CI/CD phase: workflow file, screenshots of pipeline runs, test and build times, deployment target and the results of the first automated releases.]")

    # 5 System design
    h1("System Design")
    h2("Architecture")
    para("Figure 5.1 shows the architecture. The Go server is the centre of the system: it serves the web interface, owns every session, calls the local model services and the cloud APIs, and stores data in SQLite. Model-bound work runs in separate local processes — two whisper.cpp servers, two Piper voices and a small Python sidecar for embeddings and PDF text — so that each can be restarted or replaced independently.")
    figure(os.path.join(FIG, "architecture.png"), "System architecture", width=6.3)
    para("A voice turn flows as follows: the browser's AudioWorklet captures native-rate PCM, the server validates and resamples it to 16 kHz, the speech router sends it to the right Whisper model, the assistant routes the question (General, Documents, Web or Auto) and calls Gemini with evidence or tools, and complete sentences enter a bounded text-to-speech queue so that audio starts while the answer is still being generated.")
    h2("Technology stack")
    table(["Layer", "Technology", "Why"],
          [["Backend", "Go 1.26 (standard library HTTP, `log/slog`), coder/websocket", "Concurrency for streaming audio and turns; single static binary"],
           ["Frontend", "HTML, CSS, vanilla JavaScript ES modules, AudioWorklet", "No framework or build step; fast to load; full control of audio"],
           ["Database", "SQLite via modernc.org/sqlite (pure Go), FTS5", "Local, zero administration, full-text search built in"],
           ["Speech recognition", "whisper.cpp (Metal): small (English), large-v3-turbo q5 (Hindi/Hinglish/Auto)", "Accurate, runs offline on Apple silicon"],
           ["Speech synthesis", "Piper 1.8 voices en_US-lessac-medium and hi_IN-priyamvada-medium", "Fast local neural voices for both languages"],
           ["Language model", "Google Gemini via the official Go SDK (google.golang.org/genai)", "Streaming and function calling; free tier for development"],
           ["Retrieval", "intfloat/multilingual-e5-small (ONNX) in a Python sidecar, hybrid FTS5 + vector search with RRF", "Cross-lingual search; measured 100% Recall@5"],
           ["Web search", "Tavily API (optional)", "Search results with content for grounding"],
           ["Device", "ESP32-S3 over WSS with per-device HMAC authentication", "Low-cost classroom device; firmware outside this repository"],
           ["Tooling", "go test (race detector), node --test, headless Chrome via the DevTools protocol, matplotlib", "Automated verification without extra dependencies"]],
          [1.2, 2.8, 2.2], "Technology stack")
    h2("Database design (SQLite)")
    para("The application uses two SQLite databases. `professor.db` holds the professor tools and is migrated by numbered migrations recorded in `PRAGMA user_version`; it is opened with WAL journalling, a busy timeout and foreign keys enabled. `index.db` holds the document index: documents, their chunks with embeddings, an FTS5 full-text table that uses the chunks as external content, and an embedding cache keyed by model and text hash. Figure 5.2 was generated directly from the schema of the seeded databases.")
    figure(os.path.join(FIG, "er-diagram.png"), "Entity–relationship diagram generated from the SQLite schema", width=6.3)
    table(["Table", "Purpose", "Key constraints"],
          [["classes", "Weekly timetable entries", "weekday 1–7, start/end in minutes with end > start, active flag"],
           ["reminders", "One-off and recurring reminders with delivery state", "recurrence ∈ {none, daily, weekdays, weekly}; status ∈ {active, completed}; delivery ∈ {pending, notified, overdue}; UNIQUE action_id"],
           ["notes", "Typed or assistant-created notes with tags", "UNIQUE action_id; indexed for search as document 'note-…'"],
           ["memos", "Voice memo transcripts; audio kept only on request", "UNIQUE action_id; indexed as 'memo-…'"],
           ["drafts", "Email and announcement drafts (never sent)", "kind ∈ {email, announcement}; recipients stored as JSON text"],
           ["documents / chunks", "Uploaded documents and their passages", "chunks.doc_id REFERENCES documents(id) ON DELETE CASCADE"],
           ["chunks_fts", "FTS5 keyword index over chunk text, heading and document name", "external content table (rowid of chunks)"],
           ["embedding_cache", "Embeddings reused across re-indexing", "PRIMARY KEY (model, hash)"]],
          [1.3, 2.2, 2.7], "SQLite tables")
    h2("Data flow")
    figure(os.path.join(FIG, "data-flow.png"), "Level-1 data-flow diagram", width=6.2)
    h2("Routes and APIs")
    table(["Method and path", "Purpose"],
          [["GET /", "Web interface (embedded static files)"], ["GET /healthz, GET /readyz", "Liveness and readiness of each dependency"],
           ["GET /ws (WebSocket)", "Voice and text turns: listen_start/stop, text_input, abort, action_confirm; replies stt_result, llm_delta, sources, action_pending, metrics, binary WAV"],
           ["GET /api/professor", "Feature flags, time zone, consent capabilities"],
           ["GET/POST /api/timetable; PUT/DELETE /api/timetable/{id}", "List, add, update, delete classes"],
           ["GET /api/timetable/day, /next, /export; POST /api/timetable/import", "Day view, next class, CSV export and import"],
           ["GET/POST /api/reminders; PATCH/DELETE /api/reminders/{id}", "Reminders"],
           ["GET/POST /api/notes; GET /api/notes/search; GET/PATCH/DELETE /api/notes/{id}", "Notes and semantic note search"],
           ["GET/POST /api/memos; POST /api/memos/transcribe; PATCH/DELETE /api/memos/{id}; GET /api/memos/{id}/audio", "Voice memos"],
           ["GET/POST /api/drafts; PUT/DELETE /api/drafts/{id}; POST /api/drafts/{id}/gmail", "Drafts and optional Gmail draft"],
           ["GET/POST /api/docs; DELETE /api/docs/{id}; POST /api/docs/{id}/reindex; GET /api/docs/search", "Documents and search test"],
           ["GET /api/google/connect, /callback, /events; POST /api/google/disconnect", "Optional Google integration"],
           ["GET /device (separate TLS listener)", "ESP32 device sessions"],
           ["/dev/… (only with VOICE_DEV_TOOLS=true)", "Speech evaluation dashboard for developers"]],
          [2.9, 3.3], "HTTP routes (all /api routes are localhost-only; changes require the X-Voice-Assistant header)", font=9)

    # 6 Implementation
    h1("Implementation")
    h2("Repository structure")
    code("""cmd/
  professor-assistant/  main server
  db/                   SQLite health check, demo seed and reset
  config-check/         read-only .env audit
  devicectl/            device certificate authority, certificates, secrets
  device-sim/           ESP32 simulator
  rag-eval/ stt-bench/ e2e-check/ tool-bench/ confirm-bench/   evaluation tools
internal/
  server/      HTTP, WebSocket, REST API, device listener, embedded web UI (web/)
  assist/      answer routing, tools, citations, intent router
  actions/     proposals, confirmation state, yes/no classifier
  professor/   timetable, reminders + scheduler, notes, memos, drafts, seed
  rag/         extraction, chunking, FTS5 + vector store, hybrid search
  stt/ tts/ llm/ websearch/          provider clients
  audio/ pipeline/ protocol/ session/ device/ metrics/ config/
scripts/       start-local.sh, stop-local.sh, start-demo.sh, setup-local.sh,
               rag_sidecar.py, ui-check.mjs, report-screenshots.mjs
docs/          architecture, protocols, evaluations, startup guide, this report""", "Repository structure (abridged)")
    h2("Modules")
    table(["Module", "Size (lines of Go)", "Responsibility"],
          [["internal/server", "≈5,900 (incl. tests)", "HTTP and WebSocket handling, turn orchestration, REST API, device gateway"],
           ["internal/professor", "≈3,900", "Professor data, tool definitions, scheduler, migrations, demo seed"],
           ["internal/rag", "≈1,900", "Document pipeline and hybrid retrieval"],
           ["internal/device", "≈1,200", "Device protocol, registry, authentication, audio pacing"],
           ["internal/assist", "≈1,000", "Routing, tool execution loop, citations"],
           ["internal/actions", "≈630", "Confirmation state machine"],
           ["internal/server/web", "≈2,500 (JS, HTML, CSS)", "Web interface: ui.js, chat.js, professor.js, knowledge.js, settings.js, format.js"]],
          [1.6, 1.4, 3.2], "Main modules")
    h2("Key code")
    para("**Confirmed actions run exactly once.** The language model can only stage a proposal; `Decide` applies the professor's decision. The pending action is removed under a mutex before execution, so a second or concurrent confirmation sees it as busy or already decided:")
    code("""func (s *Session) Decide(ctx context.Context, id string, approve bool, edits map[string]string) (Action, error) {
	s.mu.Lock()
	e := s.pending
	...
	if !s.now().Before(e.ExpiresAt) {          // expired questions cannot be approved
		s.finishLocked(e, StatusExpired, ErrExpired.Error())
		...
	}
	e.Status = StatusExecuting
	s.pending = nil
	s.rememberLocked(e) // a concurrent Decide now sees it as busy, then decided
	s.mu.Unlock()
	res, err := e.proposal.Execute(context.WithoutCancel(ctx), e.ID, edits)""", "Excerpt from internal/actions/actions.go")
    para("**Hybrid retrieval.** Keyword (FTS5 BM25) and vector candidates are merged with Reciprocal Rank Fusion; each list adds 1/(k + rank) to a passage's score, with k = 10 chosen by measurement:")
    code("""for i, r := range s.store.VectorSearch(qv[0], docID, candidates) {
	a := get(r.rowID)
	a.vrank, a.similarity, a.similarityPresent = i+1, r.score, true
	a.score += 1 / float64(rrfK+i+1)
}""", "Excerpt from internal/rag/service.go")
    para("**SQLite setup.** The professor database is opened with a busy timeout, foreign keys and write-ahead logging, and migrated in a transaction per migration:")
    code("""db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
db.SetMaxOpenConns(1) // one writer, as in the document index
if err = migrate(db); err != nil { ... }   // applies migrations[user_version:], then PRAGMA user_version = n""", "Excerpt from internal/professor/store.go")
    para("**Stale responses in the interface.** When the professor clicks quickly, an older slow response must not overwrite a newer one. Each loader takes a token from a small guard and renders only if it is still the latest:")
    code("""export function latest() { let seq = 0; return () => { const mine = ++seq; return () => mine === seq } }
// const isCurrent = weekGuard(); const data = await api(...); if (!isCurrent()) return; render(data)""", "Excerpt from internal/server/web/ui.js")
    h2("Database setup on SQLite")
    para("No database server is needed. The databases are created automatically on the first start in `PROFESSOR_DATA_PATH` (default `./data/professor`) and `RAG_STORAGE_PATH` (default `./data/rag`), with file permissions 0600. A read-only health check opens each file in read-only mode, runs `SELECT 1`, checks that the expected tables exist and runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`:")
    code("""$ go run ./cmd/db check
app professor database       OK
app document index           OK
demo professor database      OK
demo document index          OK""", "Output of the database health check")
    h2("Seeding strategy and demo data")
    para("For demonstrations and evaluation the project includes realistic but entirely fictional data. To protect the professor's real data, the demo data lives in **separate SQLite databases** (`DEMO_DATA_PATH`, default `./data/demo`) and is served by a second instance on port 8091 (`./scripts/start-demo.sh`), while the real application on port 8090 is untouched. The seed is idempotent: every demo row has a fixed ID containing `_seed` (for example `rem_seed03`) and is written with `INSERT … ON CONFLICT(id) DO UPDATE`, so re-running it never duplicates rows and never modifies rows created by the professor. Dates are relative to the current day and spread over the last three months; reminders in the past are marked as already announced so the scheduler does not fire them again. Demo documents are added through the real upload path and indexed by the running demo instance. Seeding and resetting refuse to run when `APP_ENV=production` unless `--force` is passed, and `reset` first moves the old demo databases into a time-stamped backup folder.")
    table(["Table", "Demo rows", "Variety"],
          [["classes", 16, "Five courses and three labs Monday–Friday, a seminar with no course code, one inactive Saturday session"],
           ["reminders", 26, "Upcoming, overdue, completed, daily/weekday/weekly recurring; empty and very long descriptions; INR amounts"],
           ["notes", 25, "Lecture notes, meeting minutes, research ideas; Hindi and Hinglish; untagged and very long notes"],
           ["memos", 12, "English, Hindi and Hinglish transcripts without stored audio; a two-word memo"],
           ["drafts", 14, "Emails (example.com addresses, empty recipients) and announcements for sections"],
           ["documents", 4, "Syllabus, lab guidelines, safety SOP and a Hindi exam guideline (plus 37 index entries for notes and memos)"]],
          [1.1, 0.9, 4.2], "Demo data created by `go run ./cmd/db seed`")

    # 7 Testing
    h1("Testing")
    h2("Test strategy")
    bullets(["**Unit and integration tests in Go** (`go test`), including fake speech, language-model and search servers so that every path — including failures — is tested without paid APIs. All run under the race detector.",
             "**Security and safety tests**: confirmation cannot be bypassed by the model, by prompt injection in documents or by a second browser tab; notes stay private by default; device authentication and TLS verification.",
             "**JavaScript unit tests** (`node --test`) for formatting helpers and audio capture.",
             "**End-to-end browser checks** (`scripts/ui-check.mjs`) in headless Chrome over the DevTools protocol on desktop, tablet and phone sizes, with a recorded audio clip in place of the microphone.",
             "**Evaluations**: speech recognition (WER/CER on public FLEURS and OpenSLR recordings) and retrieval (Recall@k and MRR on labelled questions)."])
    h2("Test cases")
    para(f"All results in Table 7.1 come from the test run on {RUN_DATE} on the final code (`VOICE_NETWORK_TESTS=1 go test -race -count=1 ./...`: {GO_TESTS} top-level tests passed in {GO_PACKAGES} packages, none failed), the JavaScript tests ({JS_TESTS}/{JS_TESTS} passed) and the browser check on a copy of the seeded demo data ({UI_CHECKS}/{UI_CHECKS} passed).")
    tc = [
        ("Voice turn: recording is resampled, ordered and flushed", "Transcript matches; frames in order", "TestWebSocketResamplesOrdersAndFlushesRecording"),
        ("Silence and steady noise are rejected; quiet speech accepted", "No transcription of silence", "TestQuietSpeechAcceptedAndSteadyNoiseRejected"),
        ("English goes to the fast model, others to the multilingual model", "Correct Whisper server per language", "TestRouterSendsEnglishToFastModelAndRestToMultilingual"),
        ("Answer citations that do not exist are detected", "Fabricated IDs reported", "TestCitationsDetectFabricatedIDs"),
        ("Evidence cannot close its delimiter (prompt injection)", "Delimiter stripped from content", "TestEvidenceCannotCloseTheDelimiter"),
        ("Web search fails: assistant still answers without inventing sources", "Answer without sources, error reported", "TestWebSearchFailureStillAnswers"),
        ("Reminder created only after spoken confirmation", "No row before 'yes'; one row after", "TestReminderIsCreatedOnlyAfterSpokenConfirmation"),
        ("Duplicate confirmations execute once", "Exactly one execution", "TestDuplicateConfirmationsExecuteOnce"),
        ("Prompt injection cannot approve an action", "Action stays pending", "TestPromptInjectionCannotApprove"),
        ("Confirmation with wrong ID, after expiry, or from another session", "Rejected", "TestButtonConfirmationWrongIDExpiryAndCrossSession"),
        ("Hindi confirmation (\"haan\" in Devanagari) is understood", "Action executed", "TestHindiConfirmation"),
        ("Draft can be reviewed, edited and saved but never sent", "No send call", "TestDraftReviewEditSaveNeverSends"),
        ("Notes are private by default", "No note text sent to Gemini", "TestNotesArePrivateByDefault"),
        ("Timetable today/tomorrow/next class and overlaps", "Correct classes and overlap flags", "TestTimetableTodayTomorrowNextAndOverlap"),
        ("CSV import and export of the timetable", "Round trip preserves classes", "TestCSVImportExport"),
        ("Reminder scheduler fires once and recovers after restart", "One notification per due time", "TestSchedulerFiresOnceAndRecoversAfterRestart"),
        ("Notes CRUD, search and indexing", "Search finds the note; index updated", "TestNotesCRUDSearchAndIndex"),
        ("Demo seed is idempotent and keeps user rows", "Same counts after two runs; user row kept", "TestSeedIsIdempotentAndKeepsUserRows"),
        ("Upload, search, duplicate detection, replace, delete", "Each step behaves correctly", "TestUploadSearchDuplicateReplaceDelete"),
        ("Search falls back to keywords when embeddings are down", "Keyword results with a warning", "TestSearchFallsBackToKeywordsWhenEmbedderDown"),
        ("Device full turn over TLS", "Audio reply received by the simulated device", "TestDeviceFullTurnOverTLS"),
        ("Device authentication and certificate verification", "Bad secret or certificate rejected", "TestDeviceAuthentication / TestDeviceTLSVerification"),
        ("Concurrent writes and scheduler runs", "No data race, no error", "TestConcurrentWritesAndSchedulerRuns"),
        ("REST changes need the same-origin header", "403 without header", "TestRESTRequiresTheSameOriginHeader"),
        ("Browser: every screen opens; class/reminder/note/draft CRUD; validation", "All checks pass on seeded data", "scripts/ui-check.mjs"),
        ("Browser: confirmation card, countdown, double-click runs once", "One reminder created", "scripts/ui-check.mjs"),
        ("Browser: phone and tablet layout without horizontal overflow", "No overflow", "scripts/ui-check.mjs"),
        ("Formatting helpers (time zone, dates, citations)", "Expected strings", "internal/server/webtest/format.test.mjs"),
        ("Database health check on app and demo databases", "OK for all four", "go run ./cmd/db check"),
    ]
    table(["ID", "Scenario", "Expected", "Actual", "Status", "Test"],
          [[f"TC-{i + 1:02d}", s, e, "As expected", "Pass", f"`{t}`"] for i, (s, e, t) in enumerate(tc)],
          [0.55, 1.75, 1.25, 0.7, 0.45, 1.5], f"Test cases and results ({RUN_DATE})", font=8)
    h2("Evaluation results")
    para("The following measurements are recorded in the repository's evaluation documents (`docs/STT_EVALUATION.md`, `docs/RAG.md`); they were measured during development on public recordings and a labelled question set, not re-run for this report.")
    table(["Measure", "English", "Hindi", "Hinglish"],
          [["App word error rate (WER)", "7.2%", "31.0%", "67.4%"], ["App character error rate (CER)", "3.8%", "9.9%", "58.6%"],
           ["Speech recognition median / p95", "518 / 691 ms", "1879 / 2227 ms", "1664 / 1713 ms"]],
          [2.4, 1.25, 1.25, 1.25], "Speech recognition (FLEURS English and Hindi, 20 clips each; OpenSLR 104 Hinglish, 10 clips)")
    table(["Method", "Recall@1", "Recall@5", "MRR", "Median latency"],
          [["Keyword (FTS5)", "58%", "79%", "0.68", "0.2 ms"], ["Vector (e5)", "63%", "84%", "0.74", "5.5 ms"],
           ["Hybrid, RRF k = 10 (default)", "74%", "100%", "0.84", "5.2 ms"]],
          [2.2, 0.9, 0.9, 0.8, 1.3], "Document retrieval (6 documents, 22 labelled questions)")
    para("A fresh run of `go run ./cmd/rag-eval` on the final code passed all its behaviour checks (citations point at the right pages, deleted documents leave nothing behind, duplicates are detected, re-indexing replaces content, scanned PDFs are reported as needing OCR).")
    h2("What was not tested")
    bullets(["The physical microphone and loudspeakers were not tested by automation; the browser checks use a recorded clip in place of the microphone.",
             "The desk device was tested with the simulator only; real ESP32 hardware is not yet verified (US-16).",
             "Google Calendar and Gmail drafts were tested against simulated Google servers, not a real account.",
             "Live Gemini answers were checked in development runs; the automated suite uses a fake Gemini server to avoid quota use."])

    # 8 Results and screenshots
    h1("Results and Screenshots")
    para("The screenshots below were captured automatically by `scripts/report-screenshots.mjs` from the running application on the seeded demo databases. **All names, dates, amounts and addresses shown are fictional demo data.**")
    shots = [("01-dashboard", "Dashboard: today's classes, next lecture, upcoming reminders and recent notes"),
             ("02-assistant", "AI Assistant: chat with hold-to-talk microphone, language and answer-source selectors"),
             ("03-timetable-day", "Timetable, day view with completed and upcoming classes"),
             ("04-timetable-week", "Timetable, week view with the next class and an inactive session"),
             ("05-reminders", "Reminders: recurring, long and upcoming reminders with complete, edit and delete actions"),
             ("06-notes", "Notes: searchable list and editor"),
             ("07-voice-memos", "Voice Memos: recorder and saved transcripts in English, Hindi and Hinglish"),
             ("08-documents", "Documents: indexed demo documents and local search test"),
             ("09-email-drafts", "Email Drafts: editor with the 'never sent automatically' notice"),
             ("10-connected-accounts", "Connected Accounts: optional Google integration (not configured)"),
             ("11-settings", "Settings: appearance, voice, privacy consent and connection health")]
    for name, text in shots:
        figure(os.path.join(SHOTS, name + ".png"), text, width=6.2)
    figure_pair([os.path.join(SHOTS, "12-mobile-dashboard.png"), os.path.join(SHOTS, "13-mobile-timetable.png")], "Phone layout: dashboard and timetable", width=2.4)
    h2("Summary of results")
    bullets([f"{sum(1 for s in STORIES if s[5])} of the {sum(1 for s in STORIES if s[4])} stories planned for Sprints 1–4 met the Definition of Done; the remaining one is the hardware verification (US-16).",
             f"{GO_TESTS} Go tests, {JS_TESTS} JavaScript tests and {UI_CHECKS} browser checks pass on the final increment.",
             "Every screen works with realistic data, including long text, empty fields, overdue and recurring items, and Hindi text.",
             "English recognition reaches 7.2% WER with a median of about half a second; hybrid retrieval finds the right passage in the top five for every labelled question."])

    # 9 Challenges
    h1("Challenges Faced and Solutions")
    table(["Challenge", "Solution"],
          [["Quiet speech was rejected as silence, giving 62% WER in the app although Whisper itself scored 7%.", "Measured both paths on the same recordings and replaced the speech gate; app WER fell to 6.7% for English."],
           ["Hindi recognition with the small model was poor (58.5% WER).", "Routed Hindi, Hinglish and Auto to large-v3-turbo while keeping English on the fast model (Hindi WER 31%)."],
           ["Resampling in the browser produced discontinuities at audio block boundaries.", "Moved all resampling to one tested, band-limited implementation in Go."],
           ["Risk of the assistant acting on a misheard command.", "Staged proposals with Go-written confirmation questions, expiry and execute-once semantics, tested against prompt injection."],
           ["Keeping confidential documents and notes private while using a cloud model.", "Local storage and retrieval; passages are sent only with a server setting and per-session consent; logs contain no text."],
           ["sqlite-vec could not be used with the pure-Go SQLite driver.", "Stored vectors as blobs and used an exact in-memory cosine search, measured at about 5 ms."],
           ["A stale, slower response sometimes overwrote the timetable after quick clicks.", "Found by the browser check; fixed with a latest-request guard in every loader."],
           ["Real ESP32 hardware was not available when needed.", "Built a device simulator and a protocol test suite; hardware verification kept as a separate backlog item."],
           ["The free Gemini tier allows about 15 requests per minute.", "Tests use a fake Gemini server; live checks are opt-in and limited."]],
          [2.6, 3.6], "Challenges and solutions")

    # 10 Conclusion
    h1("Conclusion and Future Scope")
    h2("Conclusion")
    para("The project delivered a working, bilingual, local-first voice assistant for professors. It answers spoken and typed questions with citations from the professor's documents or the web, manages the timetable, reminders, notes, voice memos and drafts, and never changes data without the professor's confirmation. Scrum shaped the work: four sprints each produced a demonstrable increment, retrospectives turned problems such as Hindi accuracy and hardware delays into concrete actions, and measurement — tests, speech and retrieval evaluations — replaced guesswork in technical decisions.")
    h2("Future scope")
    bullets(["**Continuous integration and delivery:** a GitHub Actions pipeline for build and tests on every pull request and automated releases of each increment (planned next phase, Section 4.9).",
             "**Deployment:** packaging for one-step installation on faculty computers, and an optional hosted demo of the web interface.",
             "**Hardware:** verification of the desk device on real ESP32-S3 boards in a classroom (US-16).",
             "**Integrations:** verification of Google Calendar and Gmail drafts with a real institutional account; Microsoft 365 (Outlook calendar and mail drafts) is **on hold** (US-27).",
             "**Language:** better Hinglish recognition, for example by fine-tuning or transliteration of Latin-script technical terms.",
             "**Database:** SQLite fits a single-user, local-first design; a server database could be considered later if a shared, multi-user version is required."])

    # 11 References
    h1("References")
    refs = ["K. Beck et al., \"Manifesto for Agile Software Development,\" 2001. [Online]. Available: https://agilemanifesto.org",
            "K. Schwaber and J. Sutherland, \"The Scrum Guide,\" November 2020. [Online]. Available: https://scrumguides.org",
            "A. Radford, J. W. Kim, T. Xu, G. Brockman, C. McLeavey and I. Sutskever, \"Robust Speech Recognition via Large-Scale Weak Supervision,\" arXiv:2212.04356, 2022.",
            "G. Gerganov et al., \"whisper.cpp: Port of OpenAI's Whisper model in C/C++,\" GitHub repository. [Online]. Available: https://github.com/ggml-org/whisper.cpp",
            "Open Home Foundation, \"Piper: a fast, local neural text to speech system,\" GitHub repository. [Online]. Available: https://github.com/OHF-Voice/piper1-gpl",
            "L. Wang, N. Yang, X. Huang, L. Yang, R. Majumder and F. Wei, \"Multilingual E5 Text Embeddings: A Technical Report,\" arXiv:2402.05672, 2024.",
            "P. Lewis et al., \"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks,\" in Advances in Neural Information Processing Systems 33 (NeurIPS), 2020.",
            "G. V. Cormack, C. L. A. Clarke and S. Buettcher, \"Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods,\" in Proc. 32nd ACM SIGIR, 2009, pp. 758–759.",
            "A. Conneau et al., \"FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech,\" arXiv:2205.12446, 2022.",
            "SQLite Consortium, \"FTS5 Extension\" and \"PRAGMA Statements,\" SQLite documentation. [Online]. Available: https://www.sqlite.org/fts5.html",
            "Google, \"Gemini API documentation\" and \"Google Gen AI SDK for Go.\" [Online]. Available: https://ai.google.dev",
            "I. Fette and A. Melnikov, \"The WebSocket Protocol,\" RFC 6455, IETF, 2011.",
            "The Go Authors, \"The Go Programming Language Documentation.\" [Online]. Available: https://go.dev/doc",
            "Tavily, \"Tavily Search API documentation.\" [Online]. Available: https://docs.tavily.com"]
    for i, r in enumerate(refs):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.4)
        p.paragraph_format.first_line_indent = Inches(-0.4)
        p.add_run(f"[{i + 1}]  ").bold = True
        p.add_run(r)

    # 12 Appendix
    h1("Appendix")
    h2("Demo access (demo only)")
    para("**Demo logins: none.** The assistant is a single-user application that runs on the professor's own computer and is reached only from that computer (localhost); it has no user accounts, passwords or roles, so no demo users were created. The demo is opened at http://127.0.0.1:8091 after `./scripts/start-demo.sh`. All demo data is fictional and uses example.com addresses.")
    h2("Setup instructions")
    code("""# once
brew install go cmake python@3.10
RAG_PYTHON=/opt/anaconda3/bin/python ./scripts/setup-local.sh
cp .env.example .env          # then set GEMINI_API_KEY
go run ./cmd/config-check     # read-only audit of .env

# every day
./scripts/start-local.sh      # open http://127.0.0.1:8090
./scripts/stop-local.sh

# demo data (separate SQLite databases)
go run ./cmd/db seed
./scripts/start-demo.sh       # open http://127.0.0.1:8091
go run ./cmd/db check         # SELECT 1, tables, integrity, foreign keys
go run ./cmd/db reset         # dev only: back up and recreate demo data""", "Setup and run commands")
    h2("Configuration")
    para("All settings are environment variables documented in `.env.example`; `go run ./cmd/config-check` prints a table of every variable with its status (Configured, Empty, Missing, Invalid) without printing secret values. The required secret is `GEMINI_API_KEY`; `TAVILY_API_KEY` and the Google OAuth client are optional. Demo data uses `APP_ENV`, `DEMO_DATA_PATH` and `DEMO_ADDR`.")
    h2("Regenerating this report")
    code("""# edit ROLLNO, TEAM, GUIDE at the top of docs/report/build_report.py
./scripts/start-demo.sh
node scripts/report-screenshots.mjs --url http://127.0.0.1:8091 \\
     --out docs/report/screenshots
/opt/anaconda3/bin/python docs/report/finalize.py   # .docx, contents, PDF""", "Report build commands")

    fill_toc()
    import json
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    with open(os.path.join(HERE, "out", "headings.json"), "w") as f:
        json.dump(HEADINGS, f, ensure_ascii=False)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc.save(OUT)
    print("wrote", os.path.relpath(OUT, ROOT))


# Real results of the final verification run (see the final report).
RUN_DATE = "28 October 2026"
GO_TESTS, GO_PACKAGES, JS_TESTS, UI_CHECKS = 145, 16, 12, 31

if __name__ == "__main__":
    main()
