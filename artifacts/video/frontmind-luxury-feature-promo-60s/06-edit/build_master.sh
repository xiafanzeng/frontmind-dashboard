#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h:h:h:h}

cd "$PROJECT_DIR"
node artifacts/video/frontmind-luxury-feature-promo-60s/06-edit/render_frames.mjs
node artifacts/video/frontmind-luxury-feature-promo-60s/06-edit/build_audio.mjs
node artifacts/video/frontmind-luxury-feature-promo-60s/06-edit/build_video.mjs
