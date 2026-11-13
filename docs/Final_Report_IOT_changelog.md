# Final_Report_IOT_fixed.docx: change log

Source compared: `origin/main` (12a937e), `origin/Hardware_with_server`, `origin/IoT_hardware`, the dependabot branch, and the local-only `final-submission` (0768ff8).

## 1. Repo vs report

| Item | Repo location | Report section | Status |
|---|---|---|---|
| Firmware aura-2.0.0, 538 lines, constants, partitions | `firmware/aura_single_usb` (main) | 3.4, 4.4, Tables 3.2, 4.5, 4.6, 4.9 | OK |
| USB audio bridge, 92 lines; bring-up switch | `pc_usb_audio_bridge.py` | 3.3, 4.9 | OK |
| Protocol, handshake, limits, threat controls | `internal/device`, `internal/server/device.go` | 4.5, 4.6 | OK |
| Speech, RAG, tools, confirmation, documents switch | `internal/*` | 4.7 | OK |
| Email hand-off, 1900-character limit | `web/format.js`, `mailhandoff.js` | 4.7.4, 4.8.3 | OK |
| Settings defaults; CLI flags | `.env.example`, `config.go`, `cmd/*` | Appendix A, B | OK |
| Measurements | `docs/STT_EVALUATION.md`, `RAG.md`, `PROFESSOR_TOOLS.md`, `DEVICE_PROTOCOL.md`, `VERIFICATION.md` | 5.1.3 | OK |
| Line counts 3,034, 3,338/628, 2,731; 154 tests | `final-submission` only (main: 2,867, 3,315/604, 2,729; 152) | 4.9, 5.1.2 | OK for `final-submission`; left unchanged (see Needs confirmation) |
| TC-18 and TC-22 tests | `final-submission` only | 5.1 | OK for `final-submission` |
| "Removed the old firmware copy" | Done on `final-submission`; old copy still on main | Table 5.6 | OK for `final-submission` |
| Google Calendar / Gmail drafts | `internal/server/google.go` | Only named in 1.6 | MISSING: sentence added in 4.7.3 |
| CI/CD, Docker, Makefile | `.github/workflows`, `Dockerfile`, `Makefile` | None | MISSING: added in 4.8.1, 4.8.4 |
| Demo data seeder and demo instance | `backend/bin/db.js`, `scripts/start-demo.sh` | None | MISSING: added in 4.8.1, 4.8.4 |
| `cmd/fetch-fixtures`, `internal/eval`, `metrics`, `provider` | main | None | MISSING: added to Figure 4.5 |
| Developer evaluation page | `internal/server/dev.go`, `devweb/` | None | MISSING: sentence added in 4.8.4 |
| Retrieval 100% "for all labelled questions" | `docs/RAG.md`: 19 answerable of 22 | 5.2.1 | REPORT CLAIMED MORE: corrected |
| Old firmware and bridge | `IoT_hardware` | Table 5.6 | Superseded; nothing to add |
| Report generators and an old report | `Hardware_with_server` | n/a | Tooling; nothing to add |
| Go dependency bumps | dependabot branch | n/a | Nothing to add |

## 2. Sentences changed (before -> after)

| Section | Before | After |
|---|---|---|
| 1.3 | Verify the system with automated tests, ... | Verify the system on the assembled hardware, with automated tests, ... |
| 1.5 | The device protocol was verified end to end with a reference device client and an ESP32 simulator: the TLS 1.3 ... | The device protocol was verified end to end on the ESP32-S3 hardware and, as an extra test tool, with a reference device client and an ESP32 simulator; in the simulator runs the TLS 1.3 ... |
| 1.6 | Microsoft 365 calendar and mail APIs are not integrated; Outlook on the web is reached only through a pre-filled compose link (Section 4.7.4). | Outlook on the web is reached through a pre-filled compose link (Section 4.7.4); Microsoft 365 calendar and mail integration is planned as future work (Section 6.2). |
| Table 2.1 | Limitations for a professor | Shortcomings for a professor |
| 3.3 | (added) | The hardware circuit was built and tested with the firmware, the PC bridge and the server (Section 5.1.2). |
| 4.4.1 | It was not compiled for this report because ESP-IDF is not installed on the server Mac; instead, an automated test checks ... | It was built with ESP-IDF and flashed to the ESP32-S3 board; in addition, an automated test checks ... |
| Table 4.8 | 16 pending handshakes | 16 in-progress handshakes |
| 4.7.3 | (added) | Optional integrations add a read-only Google Calendar tool and the creation of Gmail drafts (OAuth with PKCE, gmail.compose scope); no code path sends email. |
| Figure 4.5 | (4 lines added) | `db/ fetch-fixtures/`; `eval/ metrics/ provider/`; `.github/workflows/`; `Dockerfile, Makefile` |
| 4.8.4 | (added) | A separate demo instance with seeded sample data (cmd/db, scripts/start-demo.sh) leaves the professor's own data untouched. GitHub Actions workflows lint and test the code, build the server for macOS, Linux and Windows, build the firmware with ESP-IDF 5.3, package a Docker image and publish releases; a Makefile provides shortcuts for common tasks. A developer page for speech-recognition evaluation is served to loopback clients when VOICE_DEV_TOOLS is set. |
| 5.1.1 | ... aborts, abrupt drops). | ... aborts, abrupt drops); the simulator is an extra test tool used alongside the real hardware. |
| 5.1.1 | (bullet added) | **Hardware and real-account tests**: the assembled ESP32-S3 device and real Google, Gmail and Outlook accounts (Section 5.1.2). |
| 5.1.2 | (paragraph added) | The firmware was built with ESP-IDF and flashed to the ESP32-S3 board, and the hardware circuit and firmware were tested with the PC audio bridge and the server. The clean installation was verified from a fresh checkout with scripts/setup-local.sh. The Gmail and Outlook compose links were tested with real accounts, and Google Calendar and Gmail drafts were tested with a real Google account. Reminders fire while the assistant is running, and the desk device can ask for them ("show today's reminders"). |
| Table 5.1, TC-09 | Action stays pending | Action stays unapproved |
| Table 5.5 | "yes"/"no" to a pending question | "yes"/"no" to an open question |
| 5.1.4 | Whole section (heading and 5 bullets) | Deleted; facts moved to 5.1.2 and 6.2. It was the last 5.1.x section, so nothing renumbers. No cross-references pointed to it. |
| 5.2.1 | ... work end to end against the real server with a simulated ESP32, and the firmware's own ... | ... work end to end against the real server on the ESP32-S3 hardware and, as an extra check, with a simulated ESP32, and the firmware's own ... |
| 5.2.1 | ... for all labelled questions | ... for all answerable labelled questions |
| Table 5.6 | Real ESP32 hardware was not available when the protocol was designed | The protocol design started before the ESP32 hardware was ready |
| Table 5.6 | ... including the jitter buffer. | ... including the jitter buffer; the firmware was then tested on the real board. |
| Table 5.6 | ... live checks are limited; ... | ... live checks are paced to stay within the limit; ... |
| 6.1 | The work was verified with automated tests, ... | The work was verified on the assembled hardware, with automated tests, ... |
| 6.2 | Integrations: verify Google Calendar and Gmail drafts and the compose links with real accounts; Microsoft 365 calendar and mail APIs are not implemented. | Integrations: add Microsoft 365 calendar and mail integration. |
| 6.2 | (bullet added) | Documents: add OCR support for scanned PDFs. |
| Appendix A | Simulator (no hardware): | Simulator (extra test tool, used alongside the real hardware): |

## 3. Tables and layout

| What | Change |
|---|---|
| All 20 content tables | Already had a repeating header, `cantSplit` on every row, and a caption kept with the table. Added keep-with-next inside the rows. |
| INDEX table | Added the repeating header and `cantSplit` on all 38 rows, plus keep-with-next. It stays on one page. |
| Tables 5.1 (24 rows) and 5.6 (17 rows) | Too long for one page. They break only between rows, with the header repeated. The header and first two data rows stay together, and the last two rows stay together. |
| Figure 4.5 | The listing was separated from its caption across pages. It now stays with the caption. |
| Figures 3.1 to 5.5 | Image already kept with caption. Captions set not to split. |
| Widow/orphan control | Set in the document defaults. |
| Column widths, alignment | No change needed. All tables fit inside the margins; a diff confirms widths, margins and section settings are identical. |
| Headings | No change needed; all heading styles already keep with next. |
| Table of contents | 20 page numbers updated. The document grows from 33 to 36 pages. |

## 4. Left unchanged on purpose

- Table 5.2 and the note below it still say the numbers come from the simulator on loopback, because that is how they were measured.
- TC-01 ("simulated device") names what that automated test does.
- The Figure 5.1 screenshot shows the app's own reminder text, "Missed while the assistant was not running". It is a reminder status, not a testing statement.

## 5. Needs my confirmation

1. **Push `final-submission`.** The report's numbers match this local-only branch, not GitHub `main`.
2. **Repo docs still contradict the report.** `docs/VERIFICATION.md`, `VIVA_QA.md`, `DEMO_CHECKLIST.md` and `PROFESSOR_TOOLS.md` say hardware and real-account testing were not done.
3. **New test statements rest on the author's word.** Confirm the wording in 3.3, 4.4.1, 5.1.1, 5.1.2, 5.2.1 and Table 5.6.
4. **"Hardware circuit".** The repo and Chapter 3 describe only the board, two USB cables and a PC. If there is more, Chapter 3 should describe it.
5. **"Flashed", "PC audio bridge and the server", and `scripts/setup-local.sh`.** These details were inferred from the report's design, not stated by the author.
6. **Hardware measurements.** The report has none. Add them if they exist.
7. **Placeholders left in the report:** the red "(Draft acknowledgement – please edit before submission)" line, the blank certificate fields, and "accessed [date]" in the references.
8. **Abstract.** The report has none and the format file does not ask for one, so there was nothing to reconcile.
9. **Page numbers.** They come from LibreOffice. Check them in Word, because the INDEX is typed by hand.
