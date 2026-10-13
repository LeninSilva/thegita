# Gītā Companion

An installable, offline study companion to the **Bhagavad Gītā**, built for serious study or a book club.

- **The text**: all 700 verses in a fresh study translation from the Sanskrit (`bhagavad-gita-translation.md`). Key Sanskrit terms appear in brackets, and translator's notes (✦) mark genuine ambiguities.
- **An introductory chapter**: the text and its date, the epic setting, Arjuna's dilemma, karma and saṁsāra, Sāṅkhya and the guṇas, the Upaniṣads, the three yogas, the Gītā's God, ethical frameworks, the commentators, the modern Gītā, and current scholarship.
- **For each of the 18 chapters**: a summary, an overview, an interactive concept map, current research and debates, and seminar questions.
- **For each of the 74 sections**:
  - study footnotes (†) on difficult verses
  - a reconstruction of the argument
  - insight into its structure, strengths and tensions
  - sources cited and echoed
  - its place in the wider conversation
  - why it matters
  - discussion questions
  - an interactive argument diagram
- **A glossary**: 134 terms. Every technical term in the app is tappable and opens its definition.
- **Highlighting**: five colours. It works on verses, commentary, your own notes, and diagram boxes.
- **Notes**: notes on any verse, passage or section.
- **My notes**: one view that gathers every highlight and note by chapter and section. You can search and filter it by colour, and export or import it as a backup.
- **Global search**: one search across verses, footnotes, analysis, glossary, diagrams and your own notes. Diacritics are optional, so "krsna" finds "Kṛṣṇa".
- **Works offline** after the first visit. Highlights and notes are stored on the device.

## Install on your phone

1. Open the site's URL on your phone.
2. Add it to your home screen:
   - **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**.
   - **Android (Chrome):** tap the **⋮** menu, then **Install app** (or **Add to Home screen**).
3. Open it from the home-screen icon. It runs full-screen in portrait and works without a connection.

Your highlights and notes stay on that device. Use **My notes → Export** to back them up or move them to another device.

## Hosting

The app is a static site with no build step at deploy time. Serve the repository root from any static host (Vercel, Netlify, GitHub Pages) or locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Editing the content

The study content lives in plain-text files:

- `content/intro.txt`: the introductory chapter
- `content/glossary.txt`: glossary entries
- `content/chNN.txt`: each chapter's sections, footnotes, analysis panels, questions and diagrams
- `bhagavad-gita-translation.md`: the verse text

After editing, rebuild the data file:

```sh
python3 tools/build.py
```

The build checks every glossary term, verse reference and diagram link, and refuses to write `data/gita.json` if anything is broken. It also stamps a new cache version into `sw.js` so installed copies update.
