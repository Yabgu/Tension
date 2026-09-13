#!/usr/bin/env bash
# Fetch the GGUF weights for the ai example, unless they are already there.
# `npm install` (postinstall) and `npm start` run it; `npm run fetch-model` too.
# ~2.3 GB, kept local (.gitignore has *.gguf); an interrupted fetch resumes.
# MODEL=path overrides the destination; TENSION_SKIP_MODEL_FETCH=1 skips.
set -euo pipefail
cd "$(dirname "$0")"

MODEL="${MODEL:-models/Phi-3-mini-4k-instruct-q4.gguf}"
URL=https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf

if [ -f "$MODEL" ]; then
  echo "==> $(basename "$MODEL") already present"
  exit 0
fi

if [ -n "${TENSION_SKIP_MODEL_FETCH:-}" ]; then
  echo "==> TENSION_SKIP_MODEL_FETCH is set; fetch it later with 'npm run fetch-model'"
  exit 0
fi

echo "==> fetching $(basename "$MODEL") (~2.3 GB, one time)"
mkdir -p "$(dirname "$MODEL")"
curl -fL -C - --progress-bar -o "$MODEL.part" "$URL"
mv "$MODEL.part" "$MODEL"
echo "==> saved $MODEL"
