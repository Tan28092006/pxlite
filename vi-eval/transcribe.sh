#!/usr/bin/env bash
# Ask a model to transcribe one rendered page verbatim; no proxy, no tools beyond Read.
# usage: transcribe.sh <claude|codex> <model> <png> <out.txt>
set -euo pipefail
kind=$1 model=$2 png=$3 out=$4
prompt="Transcribe ALL text in the image $png verbatim, character for character, in the original language (Vietnamese with full diacritics). The glyph ↵ marks an original line break: output a real newline instead. If you see an escape like [U+1EA1], output the Unicode character it encodes. Output only the transcribed text, nothing else."
if [ "$kind" = claude ]; then
  # --setting-sources '' keeps the user's hooks and CLAUDE.md out of the test.
  echo "$prompt" | env -u HTTPS_PROXY -u NODE_EXTRA_CA_CERTS claude -p --model "$model" --max-turns 6 --allowedTools Read --setting-sources '' > "$out"
else
  codex exec --skip-git-repo-check -m "$model" -c model_reasoning_effort=low -c 'openai_base_url="https://chatgpt.com/backend-api/codex"' -i "$png" -o "$out" "$prompt" < /dev/null > /dev/null 2>&1
fi
