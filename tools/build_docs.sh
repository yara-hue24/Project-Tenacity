#!/bin/sh
# Builds the demo slides and the project description as PDF from docs/src, with headless Chrome.
# Usage: tools/build_docs.sh "Team name" "Member One, Member Two"
# Needs a local server on the repository root: python3 -m http.server 8765 --bind 127.0.0.1
set -e
cd "$(dirname "$0")/.."
TEAM="${1:-Team name}"
MEMBERS="${2:-Team members}"
CHROME="${CHROME:-google-chrome}"
mkdir -p docs/build
for name in slides description; do
  TEAM="$TEAM" MEMBERS="$MEMBERS" python3 - "$name" <<'PY'
import os, sys, html
name = sys.argv[1]
text = open(f'docs/src/{name}.html', encoding='utf-8').read()
text = text.replace('{{TEAM}}', html.escape(os.environ['TEAM'])).replace('{{MEMBERS}}', html.escape(os.environ['MEMBERS']))
open(f'docs/build/{name}.html', 'w', encoding='utf-8').write(text.replace('../../vendor', '../../vendor').replace('../img', '../img'))
PY
done
"$CHROME" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=docs/Tenacity-demo-slides.pdf http://127.0.0.1:8765/docs/build/slides.html
"$CHROME" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=docs/Tenacity-project-description.pdf http://127.0.0.1:8765/docs/build/description.html
