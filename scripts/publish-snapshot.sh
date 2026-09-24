#!/usr/bin/env bash
# Publish a history-less snapshot of a ref to the PUBLIC GitHub mirror.
#
# Why a script: the mirror must never receive the internal history. Every
# publication is one commit whose tree equals the source ref and whose parent
# is the previous snapshot, so the public chain is a linear list of
# "offtangent snapshot <sha>" commits and the push is always a fast-forward.
#
# Gates (any failure aborts before anything is created or pushed):
#   1. gitleaks over the exported tree
#   2. a blocklist of regexes kept OUTSIDE the repository (it names the very
#      things that must not leak), one rule per line:
#        <ERE regex><TAB><comma separated path substrings where a hit is ok>
#   3. structural checks (no env/key/db/apk files tracked)
#
# Usage:
#   scripts/publish-snapshot.sh                # dry run: scan + build commit, no push
#   PUBLISH_CONFIRM=yes scripts/publish-snapshot.sh
#
# Environment:
#   SOURCE_REF      ref to publish            (default: origin/main)
#   PUBLISH_URL     public remote url         (default: git@github.com:Kruppes/offtangent.git)
#   PUBLISH_BRANCH  branch on the remote      (default: main)
#   BLOCKLIST_FILE  regex rules               (default: /data/secrets/publish-blocklist.txt)
#   GITLEAKS        gitleaks binary           (default: gitleaks, falls back to /data/bin/gitleaks)
set -euo pipefail

SOURCE_REF="${SOURCE_REF:-origin/main}"
PUBLISH_URL="${PUBLISH_URL:-git@github.com:Kruppes/offtangent.git}"
PUBLISH_BRANCH="${PUBLISH_BRANCH:-main}"
BLOCKLIST_FILE="${BLOCKLIST_FILE:-/data/secrets/publish-blocklist.txt}"
GITLEAKS="${GITLEAKS:-gitleaks}"
command -v "$GITLEAKS" >/dev/null 2>&1 || GITLEAKS=/data/bin/gitleaks

log() { printf '[publish] %s\n' "$*" >&2; }
die() { log "ABORT: $*"; exit 1; }

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

[ -r "$BLOCKLIST_FILE" ] || die "blocklist not readable: $BLOCKLIST_FILE"
command -v "$GITLEAKS" >/dev/null 2>&1 || die "gitleaks not found"

git fetch -q origin
src_sha=$(git rev-parse --verify "${SOURCE_REF}^{commit}") || die "cannot resolve $SOURCE_REF"
src_tree=$(git rev-parse "${src_sha}^{tree}")
src_short=$(git rev-parse --short "$src_sha")
log "source $SOURCE_REF = $src_sha"

# --- export the exact tree that would be published -------------------------
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive --format=tar "$src_tree" | tar -x -C "$work"

# --- gate 3: structural -----------------------------------------------------
bad_files=$(git ls-tree -r --name-only "$src_tree" \
  | grep -E '(^|/)\.env($|\.[^e])|\.(pem|key|p12|jks|keystore|apk|db|sqlite|sqlite3)$|(^|/)secrets?\.json$' || true)
[ -z "$bad_files" ] || die "tracked files that must not be published:
$bad_files"

# --- gate 1: gitleaks -------------------------------------------------------
leaks_report="$work/.gitleaks.json"
if ! "$GITLEAKS" detect --no-git --source "$work" --report-path "$leaks_report" --exit-code 1 >/dev/null 2>&1; then
  die "gitleaks found secrets (report: $leaks_report, kept only while the script runs; rerun with --verbose manually)"
fi
log "gitleaks: clean"

# --- gate 2: blocklist -----------------------------------------------------
hits=0
rule_no=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  rule_no=$((rule_no + 1))
  regex=${line%%	*}
  allow=""
  [ "$regex" != "$line" ] && allow=${line#*	}
  # grep the exported tree; report file:line only, never the matched text
  matches=$(grep -r -I -i -n -E -e "$regex" "$work" --exclude=.gitleaks.json 2>/dev/null | cut -d: -f1,2 || true)
  [ -z "$matches" ] && continue
  while IFS= read -r m; do
    rel=${m#"$work"/}
    ok=0
    if [ -n "$allow" ]; then
      IFS=',' read -r -a allowed <<< "$allow"
      for a in "${allowed[@]}"; do
        a=$(printf '%s' "$a" | sed 's/^ *//;s/ *$//')
        [ -n "$a" ] && case "$rel" in *"$a"*) ok=1 ;; esac
      done
    fi
    if [ "$ok" -eq 0 ]; then
      hits=$((hits + 1))
      log "blocklist rule #$rule_no hit: $rel"
    fi
  done <<< "$matches"
done < "$BLOCKLIST_FILE"
[ "$hits" -eq 0 ] || die "$hits blocklist hit(s); fix them on the source branch, the publish does not rewrite content"
log "blocklist: clean ($rule_no rules)"

# --- previous snapshot on the public remote --------------------------------
remote_sha=$(git ls-remote "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" | cut -f1 || true)
parent_args=()
if [ -n "$remote_sha" ]; then
  git fetch -q "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" || die "cannot fetch $PUBLISH_URL $PUBLISH_BRANCH"
  # every commit reachable from the public branch must itself be a snapshot
  bad=$(git log --format='%H %s' "$remote_sha" | grep -v ' offtangent snapshot ' || true)
  [ -z "$bad" ] || die "public $PUBLISH_BRANCH contains non-snapshot commits, refusing to build on it:
$bad"
  if [ "$(git rev-parse "${remote_sha}^{tree}")" = "$src_tree" ]; then
    log "public $PUBLISH_BRANCH ($remote_sha) already has this tree, nothing to publish"
    exit 0
  fi
  parent_args=(-p "$remote_sha")
  log "parent: $remote_sha (snapshot chain of $(git rev-list --count "$remote_sha"))"
else
  log "public $PUBLISH_BRANCH is empty, creating a root snapshot"
fi

snap=$(GIT_AUTHOR_NAME=bob GIT_AUTHOR_EMAIL=bob@offtangent.local \
       GIT_COMMITTER_NAME=bob GIT_COMMITTER_EMAIL=bob@offtangent.local \
       git commit-tree "$src_tree" "${parent_args[@]}" -m "offtangent snapshot $src_short")
log "snapshot commit $snap (tree $src_tree)"
[ -z "$(git diff --stat "$src_sha" "$snap")" ] || die "snapshot tree differs from source (internal error)"

if [ "${PUBLISH_CONFIRM:-}" != "yes" ]; then
  log "dry run: set PUBLISH_CONFIRM=yes to push $snap to $PUBLISH_URL $PUBLISH_BRANCH"
  exit 0
fi

git push "$PUBLISH_URL" "$snap:refs/heads/$PUBLISH_BRANCH"
# GitHub's ssh front end occasionally rejects a second connection right after a
# push; the push itself is already acknowledged, so retry the read-back.
pushed=""
for attempt in 1 2 3 4 5; do
  pushed=$(git ls-remote "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" 2>/dev/null | cut -f1 || true)
  [ -n "$pushed" ] && break
  sleep $((attempt * 2))
done
[ "$pushed" = "$snap" ] || die "remote $PUBLISH_BRANCH is '${pushed:-unreadable}', expected $snap"
log "published: $PUBLISH_URL $PUBLISH_BRANCH = $snap (source $src_sha)"
