"""Fills in the report's table of contents and exports a PDF (LibreOffice).

    /opt/anaconda3/bin/python docs/report/finalize.py      (or: make report)

Builds the .docx, converts it to PDF with LibreOffice, reads the page of each
heading with pdftotext (Poppler), rebuilds the .docx with those page numbers
in the table of contents, and repeats until the numbers are stable. Page
images for a visual check go to docs/report/out/pages/.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "out")
sys.path.insert(0, HERE)
import build_report  # noqa: E402  (ROLLNO and paths)

SOFFICE = shutil.which("soffice") or "/Applications/LibreOffice.app/Contents/MacOS/soffice"
PDFTOTEXT, PDFTOPPM = shutil.which("pdftotext"), shutil.which("pdftoppm")


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def to_pdf(docx):
    profile = tempfile.mkdtemp(prefix="lo-profile-")
    try:
        subprocess.run([SOFFICE, f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "pdf", "--outdir", OUT_DIR, docx],
                       check=True, capture_output=True, timeout=300)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return os.path.join(OUT_DIR, os.path.splitext(os.path.basename(docx))[0] + ".pdf")


def heading_pages(pdf, headings):
    text = subprocess.run([PDFTOTEXT, "-layout", pdf, "-"], check=True, capture_output=True, text=True).stdout
    pages = text.split("\f")
    found, start = {}, 0
    for _, h in headings:
        want = norm(h)
        for i in range(start, len(pages)):
            lines = [norm(l) for l in pages[i].splitlines()]
            if any(l == want or (l.startswith(want) and ".." not in l and not re.search(r"\d+$", l[len(want):])) for l in lines if ".." not in l):
                found[h] = i + 1
                start = i
                break
    return found, len(pages) - (1 if pages and not pages[-1].strip() else 0)


def main():
    if not os.path.exists(SOFFICE) or not PDFTOTEXT:
        sys.exit("Needs LibreOffice (brew install --cask libreoffice) and Poppler (brew install poppler).")
    os.makedirs(OUT_DIR, exist_ok=True)
    py = sys.executable
    previous = None
    for attempt in range(4):
        subprocess.run([py, os.path.join(HERE, "build_report.py")], check=True)
        pdf = to_pdf(build_report.OUT)
        with open(os.path.join(OUT_DIR, "headings.json")) as f:  # written by build_report.py
            headings = json.load(f)
        found, n_pages = heading_pages(pdf, headings)
        missing = [h for _, h in headings if h not in found]
        with open(build_report.TOC_PAGES, "w") as f:
            json.dump(found, f, ensure_ascii=False, indent=1)
        print(f"pass {attempt + 1}: {n_pages} pages, {len(found)} headings located" + (f", not found: {missing}" if missing else ""))
        if found == previous:
            break
        previous = found
    subprocess.run([py, os.path.join(HERE, "build_report.py")], check=True)
    pdf = to_pdf(build_report.OUT)
    if PDFTOPPM:
        pages_dir = os.path.join(OUT_DIR, "pages")
        shutil.rmtree(pages_dir, ignore_errors=True)
        os.makedirs(pages_dir)
        subprocess.run([PDFTOPPM, "-jpeg", "-r", "60", pdf, os.path.join(pages_dir, "page")], check=True)
    print("PDF:", os.path.relpath(pdf, build_report.ROOT))


if __name__ == "__main__":
    main()
