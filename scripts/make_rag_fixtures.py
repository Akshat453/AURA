#!/usr/bin/env python3
"""Generate the binary RAG test fixtures in testdata/rag (PDF, PPTX, DOCX).

The content is invented, non-sensitive sample material for retrieval tests.
Run with the RAG venv:  runtime/rag-venv/bin/python scripts/make_rag_fixtures.py
"""
import os
import zipfile
from xml.sax.saxutils import escape

import pymupdf

OUT = os.path.join(os.path.dirname(__file__), "..", "testdata", "rag")

PAPER = [
    ("Energy-Efficient Duty-Cycle Scheduling for IoT Sensor Networks",
     "Abstract. Battery-powered sensor nodes in campus IoT deployments waste energy by listening on the radio when no data is expected. "
     "This paper presents an adaptive duty-cycle scheduler that predicts traffic from recent activity and keeps the radio asleep for longer periods. "
     "We evaluate it on a 40-node testbed that monitors classroom temperature and occupancy."),
    ("2. Proposed Method",
     "The scheduler uses an exponentially weighted moving average of packet arrivals to estimate the next active window for every node. "
     "Nodes with low predicted traffic stretch their sleep interval up to eight seconds, while a coordinator broadcasts a short beacon so that "
     "neighbouring nodes stay synchronized. A fallback timer wakes a node if a predicted window is missed twice."),
    ("3. Results",
     "Over a four-week deployment the adaptive scheduler reduced average radio energy consumption by 23 percent compared with a fixed 10 percent "
     "duty cycle. Packet delivery ratio stayed above 98 percent and the median end-to-end latency increased by only 40 milliseconds. "
     "Battery life of the nodes is therefore expected to improve from about five months to more than six months."),
]

SLIDES = [
    ("Process Scheduling", ["Operating Systems — Lecture 7", "CPU scheduling decides which ready process runs next."]),
    ("First-Come, First-Served (FCFS)", ["Processes run in arrival order.", "Simple, but short jobs can wait behind long ones (convoy effect)."]),
    ("Round Robin", ["Each process gets a fixed time quantum of 4 milliseconds in our examples.", "A process that does not finish is moved to the end of the ready queue."]),
    ("Deadlock: Necessary Conditions", ["Mutual exclusion, hold and wait, no preemption and circular wait must all hold for a deadlock.", "Breaking any one condition prevents deadlock."]),
]

LAB = [
    ("heading", "CN-204 Computer Networks Lab Manual"),
    ("heading", "Experiment 1: IP Addressing and Subnetting"),
    ("text", "Divide the network 192.168.10.0/24 into four equal subnets and assign addresses to the lab machines."),
    ("heading", "Experiment 2: TCP Connection Setup"),
    ("text", "Capture packets with Wireshark while opening a web page and identify the TCP three-way handshake: SYN, SYN-ACK and ACK."),
    ("heading", "Experiment 3: Static Routing"),
    ("text", "Configure static routes between three routers in the simulator and verify connectivity with ping and traceroute."),
]


def make_pdf(path):
    doc = pymupdf.open()
    for title, body in PAPER:
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(60, 60, 540, 120), title, fontsize=15)
        page.insert_textbox(pymupdf.Rect(60, 130, 540, 760), body, fontsize=11)
    doc.set_metadata({"title": PAPER[0][0], "author": "Sample fixture"})
    doc.save(path, deflate=True)


CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def make_docx(path):
    paras = []
    for kind, text in LAB:
        style = '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' if kind == "heading" else ""
        paras.append(f'<w:p>{style}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>')
    document = f'{CT}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{"".join(paras)}</w:body></w:document>'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", f'{CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", f'{CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", document)


def make_pptx(path):
    a, p = "http://schemas.openxmlformats.org/drawingml/2006/main", "http://schemas.openxmlformats.org/presentationml/2006/main"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        overrides = "".join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, len(SLIDES) + 1))
        z.writestr("[Content_Types].xml", f'{CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>{overrides}</Types>')
        for i, (title, bullets) in enumerate(SLIDES, start=1):
            body = "".join(f'<a:p><a:r><a:t>{escape(b)}</a:t></a:r></a:p>' for b in bullets)
            z.writestr(f"ppt/slides/slide{i}.xml", f'{CT}<p:sld xmlns:a="{a}" xmlns:p="{p}"><p:cSld><p:spTree>'
                       f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{escape(title)}</a:t></a:r></a:p></p:txBody></p:sp>'
                       f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>{body}</p:txBody></p:sp>'
                       '</p:spTree></p:cSld></p:sld>')


if __name__ == "__main__":
    make_pdf(os.path.join(OUT, "research-paper.pdf"))
    make_docx(os.path.join(OUT, "cn-lab-manual.docx"))
    make_pptx(os.path.join(OUT, "os-scheduling-slides.pptx"))
    # A scanned-style PDF: one page with an image only and no text layer.
    scanned = pymupdf.open()
    page = scanned.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 80), 0)
    pix.clear_with(200)
    page.insert_image(pymupdf.Rect(60, 60, 460, 220), pixmap=pix)
    scanned.save(os.path.join(OUT, "scanned-notice.pdf"))
    print("fixtures written to", os.path.abspath(OUT))
