#!/usr/bin/env bash
# Puts the Scrum plan (docs/SCRUM_PLAN.md) on GitHub: labels, one milestone per
# sprint, and one issue per user story, assigned to its sprint. Stories that
# are already done are closed, so the milestones show real progress.
#
# Needs the GitHub CLI, logged in:   gh auth login
# Run from the repository root:      bash scripts/scrum/setup-github.sh [YYYY-MM-DD]
#
# The optional date is the Monday of week 1; milestones then get due dates
# (end of week 2, 4 and 6). Safe to re-run: existing labels, milestones and
# issues (matched by their "US-xx:" title prefix) are left alone.
set -euo pipefail

command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
START="${1:-}"
echo "Repository: $REPO"

due_date() { # $1 = days after week-1 Monday
  [[ -z "$START" ]] && return 0
  if date -d "$START" >/dev/null 2>&1; then date -u -d "$START + $1 days" +%Y-%m-%dT18:00:00Z
  else date -u -j -v+"$1"d -f %Y-%m-%d "$START" +%Y-%m-%dT18:00:00Z; fi # macOS
}

# ---- labels ---------------------------------------------------------------
label() { gh label create "$1" --color "$2" --description "$3" --repo "$REPO" 2>/dev/null && echo "label: $1" || true; }
label user-story   1d76db "Product backlog item"
label bug          d73a4a "Defect in the increment"
label devops       5319e7 "CI/CD, build, release, infrastructure"
label dependencies 0366d6 "Dependency update"
label priority:high   b60205 "High priority"
label priority:medium fbca04 "Medium priority"
label priority:low    0e8a16 "Low priority"
for p in 1 2 3 5 8; do label "points:$p" c5def5 "Story points"; done
label blocked      000000 "Waiting on something outside the team"

# ---- milestones (one per sprint) -------------------------------------------
milestone() { # title, description, due-offset-days
  if gh api "repos/$REPO/milestones?state=all&per_page=100" -q '.[].title' | grep -qx "$1"; then return; fi
  local args=(-f "title=$1" -f "description=$2")
  if [[ -n "$3" ]]; then local due; due="$(due_date "$3")"; [[ -n "$due" ]] && args+=(-f "due_on=$due"); fi
  gh api "repos/$REPO/milestones" "${args[@]}" >/dev/null && echo "milestone: $1"
}
milestone "Sprint 1" "Weeks 1-2 · A professor can talk to the assistant in English, Hindi or Hinglish and hear the answer" 11
milestone "Sprint 2" "Weeks 3-4 · Answers grounded in documents and the web with citations, plus a secure desk device" 25
milestone "Sprint 3" "Weeks 5-6 · Professor's daily tool, delivered through an automated CI/CD pipeline" 39
milestone "Backlog"  "Next release" ""

# ---- user stories ----------------------------------------------------------
# id | sprint | points | priority | state | story
STORIES=$(cat <<'EOF'
US-01|Sprint 1|8|high|closed|As a professor, I want to hold a button and ask a question by voice in the browser, so that I can use the assistant hands-free.
US-02|Sprint 1|5|high|closed|As a professor, I want my speech transcribed on my own computer, so that my voice recordings never leave it.
US-03|Sprint 1|8|high|closed|As a professor, I want the answer streamed and spoken sentence by sentence, so that I hear the reply quickly.
US-04|Sprint 1|3|medium|closed|As a professor, I want to type a question and read the answer, so that I can use the assistant in a quiet room.
US-05|Sprint 1|3|medium|closed|As a professor, I want to stop a reply at any time, so that I am not forced to listen to a long answer.
US-06|Sprint 1|3|medium|closed|As a professor, I want answers in a Hindi voice when I ask in Hindi, so that the conversation stays in my language.
US-07|Sprint 1|8|high|closed|As a professor, I want to ask in Hindi or Hinglish and be understood, so that I can speak naturally.
US-23|Sprint 1|3|medium|closed|As a professor, I want one command to start and stop everything and a configuration check, so that setting up is easy.
US-08|Sprint 2|5|medium|closed|As a developer, I want to measure speech recognition accuracy (WER/CER) on public recordings, so that model choices are based on evidence. (Carried over from Sprint 1.)
US-09|Sprint 2|8|high|closed|As a professor, I want a desk device (ESP32) that connects securely to my computer, so that I can ask questions without opening the browser.
US-10|Sprint 2|5|medium|closed|As a developer, I want a device simulator, so that the device protocol can be tested without hardware.
US-11|Sprint 2|8|high|closed|As a professor, I want to upload course documents (PDF, DOCX, PPTX, TXT, MD) and have them indexed locally, so that I can ask questions about them.
US-12|Sprint 2|8|high|closed|As a professor, I want answers grounded in my documents with citations, so that I can verify every claim.
US-13|Sprint 2|5|medium|closed|As a professor, I want current information from a web search with sources, so that answers are up to date.
US-14|Sprint 2|3|high|closed|As a professor, I want to decide whether document text may be sent to the cloud model, so that confidential material stays private.
US-15|Sprint 2|3|low|closed|As a developer, I want to evaluate retrieval quality (Recall@k, MRR), so that search settings are chosen by measurement.
US-16|Backlog|5|high|open|As a professor, I want the desk device verified on real ESP32 hardware, so that the classroom set-up is proven end to end. (Blocked: hardware not available in Sprint 2.)
US-26|Sprint 3|8|medium|closed|As a team, we want every push automatically built and tested and every merge to main published and deployed (CI/CD), so that every increment is verified and releasable.
US-17|Sprint 3|8|high|closed|As a professor, I want a weekly timetable with today's and the next class, so that I always know where I have to be.
US-18|Sprint 3|8|high|closed|As a professor, I want to create reminders by voice and be notified when they are due, so that I do not miss deadlines.
US-19|Sprint 3|5|medium|closed|As a professor, I want notes and voice memos that I can search in English or Hindi, so that ideas are not lost.
US-20|Sprint 3|5|medium|closed|As a professor, I want email and announcement drafts that are never sent automatically, so that I stay in control of communication.
US-21|Sprint 3|8|high|closed|As a professor, I want to confirm or cancel every data-changing action by voice or button, so that the assistant never acts on a misunderstanding.
US-22|Sprint 3|5|medium|closed|As a professor, I want a clean, responsive web interface with a dashboard, so that I can see my day at a glance on any screen.
US-24|Sprint 3|5|low|closed|As a professor, I want optional read-only Google Calendar and Gmail drafts, so that I can use them if my institution allows it.
US-25|Sprint 3|2|low|closed|As an evaluator, I want realistic demo data, so that every screen can be assessed without real personal data.
US-27|Backlog|8|low|open|As a professor, I want Microsoft 365 (Outlook calendar and mail drafts) integration. (On hold.)
EOF
)

existing="$(gh issue list --repo "$REPO" --state all --limit 500 --json title -q '.[].title')"
while IFS='|' read -r id sprint points priority state story; do
  [[ -z "$id" ]] && continue
  if grep -q "^${id}:" <<<"$existing"; then echo "exists: $id"; continue; fi
  title="${id}: ${story%%, so that*}"
  title="${title/As a professor, I want /}"; title="${title/As a developer, I want /}"
  title="${title/As an evaluator, I want /}"; title="${title/As a team, we want /}"
  labels="user-story,points:${points},priority:${priority}"
  [[ "$id" == "US-26" ]] && labels+=",devops"
  [[ "$id" == "US-16" ]] && labels+=",blocked"
  body="### User story
${story}

**Sprint:** ${sprint} · **Story points:** ${points} · **Priority:** ${priority}

See [docs/SCRUM_PLAN.md](../blob/main/docs/SCRUM_PLAN.md) for acceptance and the week-by-week plan."
  url="$(gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$labels" --milestone "$sprint")"
  echo "created: $id  $url"
  if [[ "$state" == closed ]]; then gh issue close "$url" --repo "$REPO" --reason completed >/dev/null; fi
done <<<"$STORIES"

echo
echo "Done. Next: create a board under Projects → New project → Board, add these issues,"
echo "and use the columns Product Backlog / Sprint Backlog / In Progress / In Review / Done."
