# Testing-team training deck: versions

"Testing gokesari.com: techniques, tactics and quality assurance" teaches units 4.1 (testing techniques
and tactics) and 4.3 (software quality assurance) on GoKesari's own workbook, code and defect log.

| Version | Date | File | What changed |
|---|---|---|---|
| 1.0 | 20-Nov-2026 | `GoKesari_Testing_Techniques_Training_v1.0_2026-11-20.pptx` | First issue, 29 slides, on the workbook of 20-Nov (1,048 cases) |
| 2.0 | 23-Nov-2026 | `GoKesari_Testing_Techniques_Training_v2.0_2026-11-23.pptx` | Every count brought up to workbook 2.0 (1,631 cases, 383 scenarios, 63 journeys, 186 defects); new slides: version history (2), what is new since v1.0 (4), testing a feature behind a flag (5); next steps for Cycle 2; 32 slides |

Owner's copies: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/` (same file names; the 20-Nov
file without a version in its name is v1.0). Older versions are never changed.

**Numbering.** A major version (2.0) adds slides or changes what is taught; a minor version (2.1) only
refreshes numbers or wording. Every version gets a new file name with its version and date, and a row
on slide 2 (version history).

**How v2.0 is built** (python-pptx; `add_slide.py` from the pptx skill duplicates slides):

```bash
python3 docs/testing/manual/deck/facts.py docs/testing/manual/deck/deck-text-v2.0.json > facts.json
python3 docs/testing/manual/deck/build_training_deck_v2.py \
  docs/testing/manual/deck/GoKesari_Testing_Techniques_Training_v1.0_2026-11-20.pptx facts.json \
  docs/testing/manual/deck/GoKesari_Testing_Techniques_Training_v2.0_2026-11-23.pptx <pptx skill>/scripts/add_slide.py
```

`facts.py` reads every number from the plan (`tests/qa/catalog`, `docs/testing/manual/test-scenarios.json`,
`test-cases.xlsx`), `tests/unit` and `docs/testing/qa-defects.json`, so the deck never disagrees with the
workbook. `deck-text-v2.0.json` holds the words (version history, the new-feature table, the flag
rules and the next steps). For the next version, copy the text file, change it, and run the two
commands with the newest deck as the input.
