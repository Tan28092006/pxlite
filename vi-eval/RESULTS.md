# Vietnamese rendering fix — 2026-11-15

## Problem

pxpipe 0.16.0's glyph atlases skip Latin Extended Additional (U+1E00–1EFF), where most Vietnamese letters live (ả ạ ế ầ ố ợ …).
Missing letters were rendered as `[U+1EA3]`-style escapes: Spleen 5×8 (Claude) lacked 90 of 134 Vietnamese letters, JetBrains Mono 14 px (Sol, Terra) lacked 102.
The escape check (`escapeMissingGlyphs`) uses the Spleen bitmap atlas for every font.

## Fix

`build/atlas/scripts/gen-atlas.ts` (upstream v0.16.0 plus two env knobs, `ATLAS_EXTRA_RANGES` and `ATLAS_PRIMARY_RANGES`) regenerates four atlases into `vendor/pxpipe-proxy/dist/core/`:

- `atlas.js`, `atlas-gray.js`: Spleen 5×8 plus U+1E00–1EFF drawn by Unifont at 8 px.
- `atlas-jbmono14.js`, `atlas-gray-jbmono14.js`: plus U+0100–024F and U+1E00–1EFF; Vietnamese letters drawn by JetBrains Mono itself.

The generator reproduced the shipped atlases byte for byte before the change (codepoints, offsets, pixels identical for Spleen gray and both JetBrains Mono 14 atlases).
`pxlite.mjs` loads the vendored copy; the global `pxpipe` install is untouched.

## Measurement

Sample: `sample-vi.txt` (885 chars, 159 accented syllables, taken from this session's replies), rendered with `render.mjs` the way history collapse renders it, transcribed by the model with no proxy (`transcribe.sh`), scored with `score.py` (syllable = exact word match after NFC).

| Reader | Render | Image tokens (Claude formula) | Syllable accuracy per run |
|---|---|---|---|
| Opus 5.5 | stock Spleen (escapes) | 142 | 0.758, 0.217, 0.505, 0.624 |
| Opus 5.5 | **Spleen + Vietnamese** | **79** | 0.995, 0.969, 0.969 |
| Opus 5.5 | JetBrains Mono 14 + Vietnamese | 187 | 0.985, 0.990, 1.000 |
| Terra | stock JetBrains Mono 14 | 318 | 0.717, 0.763 |
| Terra | **JetBrains Mono 14 + Vietnamese** | **187** | 1.000, 0.964 |
| Sol | stock JetBrains Mono 14 | 318 | 0.510, 0.990 |
| Sol | **JetBrains Mono 14 + Vietnamese** | **187** | 0.943, 0.949 |
| Sonnet 5.5 | Spleen + Vietnamese | 79 | 0.840, 0.923, 0.897 |
| Sonnet 5.5 | **JetBrains Mono 14 + Vietnamese** | **187** | 0.990, 0.990, 0.990 |

Decision: keep Spleen for Opus (near JetBrains Mono accuracy at 2.4× fewer image tokens).
Superseded 2026-11-16: Sonnet 5.5 is back on Opus's Spleen profile by the user's choice (no `gptProfiles` override). The earlier note read: Sonnet 5.5 gets Opus's Spleen profile by default but misreads 8–16 % of syllables on it, so it was overridden to JetBrains Mono 14 (84 cols, also for history) via `gptProfiles["claude-sonnet-5-5"]`; the override keeps Claude's image billing because pxpipe completes a partial profile from the model's built-in one.
Cost of that choice, measured: first live Sonnet request (system + tool docs only) sent 58,062 input tokens vs a 65,928-token text baseline (−12 %; Opus on Spleen saves ~30 % there).
Offline on this session's latest request (1.13 M chars of history): Spleen would leave 66k text chars + 24.8k image tokens, JetBrains leaves 435k text chars + 10.8k image tokens (pxpipe's gate images less at the larger font).
Runs are few (2–4 per cell) and one sample text; treat as a strong direction, not a benchmark.
Opus stock-render runs 1–3 needed `--max-turns 6` (the 1568×68 strip made it re-read); the first stock run used 3.

## Rebuild after a pxpipe upgrade

```
cd build/atlas
ATLAS_EXTRA_RANGES=1E00-1EFF ATLAS_GRAY=1 ATLAS_OUT_GRAY=out/atlas-gray.ts ATLAS_OUT=out/unused.ts npx tsx scripts/gen-atlas.ts
ATLAS_EXTRA_RANGES=1E00-1EFF ATLAS_OUT=out/atlas.ts npx tsx scripts/gen-atlas.ts
export ATLAS_PRIMARY_FONT=assets/JetBrainsMono-Regular.ttf ATLAS_PRIMARY_FAMILY="JetBrains Mono" ATLAS_PRIMARY_PX=14 ATLAS_FALLBACK_PX=14 ATLAS_PROFILE=ascii ATLAS_ALLOW_ANY_CELL=1 ATLAS_EXTRA_RANGES=0100-024F,1E00-1EFF ATLAS_PRIMARY_RANGES=00C0-00FF,0102-0103,0110-0111,0128-0129,0168-0169,01A0-01A1,01AF-01B0,1EA0-1EF9
ATLAS_GRAY=1 ATLAS_OUT_GRAY=out/atlas-gray-jbmono14.ts ATLAS_OUT=out/unused.ts npx tsx scripts/gen-atlas.ts
ATLAS_OUT=out/atlas-jbmono14.ts npx tsx scripts/gen-atlas.ts
# copy the new pxpipe package to ../../vendor/pxpipe-proxy, then:
node build-vendor.mjs out ../../vendor/pxpipe-proxy/dist/core
```

Fetch `scripts/gen-atlas.ts` for the new tag and re-apply the two env knobs; `node --test test.mjs` checks Vietnamese coverage.
