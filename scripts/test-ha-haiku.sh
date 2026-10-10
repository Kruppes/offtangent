#!/usr/bin/env bash
# Offline only: production provider access is mocked/gated; no HA instance connected.
set -euo pipefail
cd "$(dirname "$0")/.."
python="${1:?Usage: test-ha-haiku.sh /absolute/HA-venv/bin/python /absolute/output-directory}"
out="${2:?Output directory required}"
[[ "$python" = /* && "$out" = /* ]] || { echo 'Absolute paths required' >&2; exit 2; }
mkdir -p "$out/test-tmp"
export TMPDIR="$out/test-tmp" PYTHONDONTWRITEBYTECODE=1
export HA_TEST_PYTHON="$python" PYTHONPATH="$PWD/integrations/home_assistant"
export HA_WIRE_EVIDENCE_PATH="$out/haiku-wire-mock.json"
export HA_BRIDGE_EVIDENCE_PATH="$out/haiku-http-python-bridge.json"
"$python" - <<'PY' | tee "$out/runtime-versions.log"
import importlib.metadata as m
import sys
assert sys.version_info >= (3, 14, 2), sys.version
assert m.version('homeassistant') == '2026.9.4'
print('python', sys.version)
for package in ['homeassistant', 'aiohttp', 'probatio', 'voluptuous']:
    print(package, m.version(package))
PY
flock "${HEAVY_BUILD_LOCK:-/workspace/.heavy-build.lock}" node node_modules/vitest/vitest.mjs run \
  --config scripts/vitest-ha.config.mts --configLoader runner --no-cache --reporter verbose \
  2>&1 | tee "$out/vitest-final.log"
flock "${HEAVY_BUILD_LOCK:-/workspace/.heavy-build.lock}" node node_modules/typescript/bin/tsc \
  -p packages/core/tsconfig.json --noEmit 2>&1 | tee "$out/typecheck-final.log"
echo 'TypeScript core typecheck exit=0' | tee -a "$out/typecheck-final.log"
"$python" -m unittest discover -s integrations/home_assistant/tests -v \
  2>&1 | tee "$out/python-final.log"
"$python" - <<'PY' | tee "$out/python-source-check.log"
import ast
import json
from pathlib import Path
root = Path('integrations/home_assistant')
files = list(root.rglob('*.py'))
for file in files:
    ast.parse(file.read_text(), filename=str(file))
manifest = json.loads((root / 'custom_components/offtangent_conversation/manifest.json').read_text())
assert manifest['domain'] == 'offtangent_conversation' and manifest['config_flow'] is True
assert manifest['requirements'] == []
for file in (root / 'custom_components/offtangent_conversation').rglob('*.json'):
    json.loads(file.read_text())
print(f'{len(files)} Python sources parsed, manifest/base/translations JSON parsed; not hassfest')
PY
printf 'OFFLINE GATES PASSED. No live Anthropic/HA request or deployment performed.\n' | tee "$out/gate-result.log"
