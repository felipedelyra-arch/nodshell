#!/usr/bin/env bash
# Regenerates the SYNTHETIC pt-BR speech set (tests/fixtures/voice/*.wav) from phrases.json. Idempotent; local only.
# Piper: piper-tts 1.8.0 (PyPI; home page github.com/OHF-voice/piper1-gpl), voice pt_BR-faber-medium (rhasspy/piper-voices).
set -euo pipefail
cd "$(dirname "$0")/.."
V=tests/fixtures/voice
C=$V/.cache
VOICE=pt_BR-faber-medium
URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium
declare -A SHA=(
  [$VOICE.onnx]=75e913eb463db0b6ac7ddf68d3e4c9ac19ace36dc3b710a81039b448352b8ffc
  [$VOICE.onnx.json]=6b6801319e5a70aa4d75c63343515f55d1cd671ecd1ac511586bc16216812261
)
mkdir -p "$C"
for f in "${!SHA[@]}"; do
  if ! { [ -f "$C/$f" ] && echo "${SHA[$f]}  $C/$f" | sha256sum -c --quiet -; }; then
    curl -fL --proto '=https' -o "$C/$f" "$URL/$f"
    echo "${SHA[$f]}  $C/$f" | sha256sum -c -
  fi
done
~/.local/bin/uv run --no-project --with piper-tts==1.8.0 --with numpy python -I scripts/voice-fixtures.py "$V" "$C/$VOICE.onnx"
