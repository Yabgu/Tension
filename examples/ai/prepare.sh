#!/usr/bin/env bash
# Fetch the default GGUF weights for the ai example, unless they are already
# there.
#
# Runs automatically from `npm install` (postinstall) and from `npm start`
# (`--quiet`); run it by hand with `npm run fetch-model`.
#
# The weights are ~2.3 GB and are NOT part of the repo (.gitignore has
# *.gguf): they land in models/ and stay local. The download is a no-op once
# the file is present at the expected size.
#
# Knobs:
#   MODEL=path                 use your own weights -> the default fetch is skipped
#   TENSION_SKIP_MODEL_FETCH=1 skip fetching (install/run offline; fetch later)
#   TENSION_MODEL_URL=...      fetch from a mirror instead of Hugging Face
#   TENSION_MODEL_PATH=...     store the weights somewhere else
#   TENSION_MODEL_SIZE=...     expected byte size (defaults to the q4 file's)
#
# Needs curl. The equivalent manual command is:
#   hf download microsoft/Phi-3-mini-4k-instruct-gguf \
#     Phi-3-mini-4k-instruct-q4.gguf --local-dir models
set -euo pipefail
cd "$(dirname "$0")"

quiet=""
if [ "${1:-}" = "--quiet" ]; then quiet=1; fi
say() { [ -n "$quiet" ] || echo "$@"; }

MODEL_PATH="${TENSION_MODEL_PATH:-models/Phi-3-mini-4k-instruct-q4.gguf}"
MODEL_URL="${TENSION_MODEL_URL:-https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf}"
MODEL_SIZE="${TENSION_MODEL_SIZE:-2393231072}" # 2.3 GB, the q4 GGUF on HF

size_of() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0
}

# Someone brought their own weights: leave their setup alone.
if [ -n "${MODEL:-}" ] && [ "$MODEL" != "$MODEL_PATH" ]; then
  say "==> MODEL=$MODEL is set; not fetching the default model"
  exit 0
fi

# Offline / CI, or `npm install --ignore-scripts` semantics made explicit.
if [ -n "${TENSION_SKIP_MODEL_FETCH:-}" ]; then
  say "==> TENSION_SKIP_MODEL_FETCH is set; not fetching the model"
  say "    fetch it later with: npm run fetch-model"
  exit 0
fi

# Present at the expected size: nothing to do (the common case after the
# first install).
if [ "$(size_of "$MODEL_PATH")" = "$MODEL_SIZE" ]; then
  say "==> $(basename "$MODEL_PATH") already present ($((MODEL_SIZE / 1024 / 1024)) MB)"
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  echo "error: curl is required to fetch the model" >&2
  echo "       (download it yourself, or use: hf download ...)" >&2
  exit 1
}

mkdir -p "$(dirname "$MODEL_PATH")"
part="$MODEL_PATH.part"

echo "==> fetching $(basename "$MODEL_PATH") (~$((MODEL_SIZE / 1024 / 1024)) MB, one time)"
echo "    from $MODEL_URL"
# -C - resumes a partial download; --retry rides out transient CDN hiccups.
curl --fail --location --retry 3 --retry-delay 2 --progress-bar \
  -C - -o "$part" "$MODEL_URL"

got="$(size_of "$part")"
if [ "$got" != "$MODEL_SIZE" ]; then
  echo "error: $MODEL_PATH.part is $got bytes, expected $MODEL_SIZE" >&2
  echo "       incomplete or wrong file; keeping it so a retry can resume," >&2
  echo "       delete it to start the download over" >&2
  exit 1
fi

mv "$part" "$MODEL_PATH"
echo "==> saved $MODEL_PATH"
