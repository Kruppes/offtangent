#!/usr/bin/env bash
# Publish main to the PUBLIC GitHub mirror, one public commit per main commit.
#
# The public history starts with a root commit "Offtangent 0.29.0"; after it
# every first-parent commit of main appears as its own commit with its original
# message and dates, so outsiders can follow what changes. Every public commit
# ends with the trailer
#   Source-Commit: <sha of the main commit>
# and the newest trailer on the public branch is where the next run continues.
# The push is always a plain fast-forward; this script never forces.
#
# Transformation of one main commit C (first parent C1) into its public commit:
#   tree     public parent tree + the changes C1 -> C, minus PUBLISH_EXCLUDE.
#            Every added or modified file goes through the replacement map
#            REPLACE_FILE (outside the repository, it names private terms;
#            "literal==>replacement" per line, git filter-repo --replace-text
#            format; lines without the arrow are comments). A map hit aborts unless PUBLISH_ALLOW_REPLACE=yes: the fix
#            belongs on main, the map exists for the history before the public
#            cleanup and as a safety net.
#            A commit that changes nothing public (e.g. only .forgejo) is skipped.
#   message  the original message; a merge "Merge branch 'x' ..." becomes
#            "merge: integrate x" and gets the subjects of the merged commits.
#            MESSAGE_DIR/<full sha>.msg replaces a message (for a message that
#            fails the gates: rewrite it generically there, never on main).
#   identity author and committer of the current public tip; original dates.
#
# Gates (any failure aborts before anything is pushed):
#   1. structure: no env/key/db/apk files in any new public tree
#   2. gitleaks over every added or modified file of every new commit
#   3. the blocklist (outside the repo, <ERE><TAB><allowed path substrings>)
#      over the same files
#   4. blocklist + MESSAGE_GREP_FILE over every new commit message
#   5. the public tip must correspond to its Source-Commit (tree equal to the
#      transformed source tree), so a hand-made public commit stops the run
#
# Usage:
#   scripts/publish-commits.sh                       # dry run: build + gates, no push
#   PUBLISH_CONFIRM=yes scripts/publish-commits.sh   # push (fast-forward) + release tags
#
# Environment:
#   SOURCE_REF            ref to publish            (default: origin/main)
#   PUBLISH_URL           public remote url         (default: git@github.com:Kruppes/offtangent.git)
#   PUBLISH_BRANCH        branch on the remote      (default: main)
#   PUBLISH_EXCLUDE       private paths, space separated (default: ".forgejo .github/workflows")
#   BLOCKLIST_FILE        regex rules               (default: /data/secrets/publish-blocklist.txt)
#   REPLACE_FILE          replacement map           (default: /data/secrets/publish-replacements.txt, optional)
#   MESSAGE_GREP_FILE     extra message rules       (default: /data/secrets/publish-message-grep.txt, optional)
#   MESSAGE_DIR           message overrides         (default: /data/secrets/publish-messages)
#   PUBLISH_ALLOW_REPLACE yes = accept replacement map hits on new commits
#   GITLEAKS              gitleaks binary           (default: gitleaks, falls back to /data/bin/gitleaks)
#   PUBLISH_SKIP_FETCH    yes = do not fetch origin (tests against a local remote)
#
# scripts/publish-snapshot.sh is the legacy snapshot path; it refuses to build
# on the per-commit history and stays only for reference.
set -euo pipefail
shopt -s inherit_errexit

SOURCE_REF="${SOURCE_REF:-origin/main}"
PUBLISH_URL="${PUBLISH_URL:-git@github.com:Kruppes/offtangent.git}"
PUBLISH_BRANCH="${PUBLISH_BRANCH:-main}"
PUBLISH_EXCLUDE="${PUBLISH_EXCLUDE:-.forgejo .github/workflows}"
BLOCKLIST_FILE="${BLOCKLIST_FILE:-/data/secrets/publish-blocklist.txt}"
REPLACE_FILE="${REPLACE_FILE:-/data/secrets/publish-replacements.txt}"
MESSAGE_GREP_FILE="${MESSAGE_GREP_FILE:-/data/secrets/publish-message-grep.txt}"
MESSAGE_DIR="${MESSAGE_DIR:-/data/secrets/publish-messages}"
GITLEAKS="${GITLEAKS:-gitleaks}"
command -v "$GITLEAKS" >/dev/null 2>&1 || GITLEAKS=/data/bin/gitleaks

log() { printf '[publish] %s\n' "$*" >&2; }
die() { log "ABORT: $*"; exit 1; }
# GitHub's ssh front end intermittently answers "Permission denied (publickey)"
# for a valid key; every remote call is retried.
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    sleep $((attempt * 2))
  done
  return 1
}

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

[ -r "$BLOCKLIST_FILE" ] || die "blocklist not readable: $BLOCKLIST_FILE"
command -v "$GITLEAKS" >/dev/null 2>&1 || die "gitleaks not found"
command -v python3 >/dev/null 2>&1 || die "python3 not found"
[ -r "$REPLACE_FILE" ] || { log "no replacement map at $REPLACE_FILE, publishing without one"; REPLACE_FILE=""; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

is_excluded() {
  local p=$1 e
  for e in $PUBLISH_EXCLUDE; do
    case "$p" in "$e"|"$e"/*) return 0 ;; esac
  done
  return 1
}

# apply the replacement map to one blob; prints the resulting blob sha
replace_blob() {
  local sha=$1
  if [ -z "$REPLACE_FILE" ]; then printf '%s\n' "$sha"; return; fi
  git cat-file blob "$sha" | python3 -c '
import sys
data = sys.stdin.buffer.read()
if b"\0" in data[:8192]:
    sys.stdout.buffer.write(data); sys.exit(0)
for line in open(sys.argv[1], "rb"):
    line = line.rstrip(b"\n")
    # a line without the arrow is a comment (a pair may itself start with "#")
    if b"==>" not in line:
        continue
    old, new = line.split(b"==>", 1)
    data = data.replace(old, new)
sys.stdout.buffer.write(data)' "$REPLACE_FILE" | git hash-object -w --stdin
}

# public tree of a source commit, computed from scratch (used for gate 5)
full_public_tree() {
  local src=$1 idx="$work/full.index" e
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$src"
  for e in $PUBLISH_EXCLUDE; do
    GIT_INDEX_FILE="$idx" git rm -q -r -f --cached --ignore-unmatch -- "$e" >/dev/null
  done
  GIT_INDEX_FILE="$idx" git write-tree
}

# --- source and public state ------------------------------------------------
[ "${PUBLISH_SKIP_FETCH:-}" = "yes" ] || git fetch -q origin
src_sha=$(git rev-parse --verify "${SOURCE_REF}^{commit}") || die "cannot resolve $SOURCE_REF"
log "source $SOURCE_REF = $src_sha"

remote_sha=$(retry git ls-remote "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" | cut -f1 || true)
[ -n "$remote_sha" ] || die "public $PUBLISH_BRANCH is empty; the root commit is created once by hand, not by this script"
retry git fetch -q "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" || die "cannot fetch $PUBLISH_URL $PUBLISH_BRANCH"
[ "$(git rev-parse FETCH_HEAD)" = "$remote_sha" ] || die "fetched public tip differs from ls-remote"
last=$(git log -1 --format=%B "$remote_sha" | sed -n 's/^Source-Commit: \([0-9a-f]\{40\}\)$/\1/p' | tail -n1)
[ -n "$last" ] || die "public tip $remote_sha has no Source-Commit trailer (legacy snapshot chain?)"
git cat-file -e "$last^{commit}" 2>/dev/null || die "Source-Commit $last of the public tip is unknown here"
first_parents=$(git rev-list --first-parent "$src_sha")
grep -qx "$last" <<< "$first_parents" \
  || die "Source-Commit $last is not on the first-parent line of $SOURCE_REF"
ident_name=$(git log -1 --format=%an "$remote_sha")
ident_email=$(git log -1 --format=%ae "$remote_sha")
log "public tip $remote_sha = source $last, identity $ident_name <$ident_email>"

# --- gate 5: the public tip corresponds to its Source-Commit ------------------
expect_tree=$(full_public_tree "$last")
remote_tree=$(git rev-parse "$remote_sha^{tree}")
if [ "$expect_tree" != "$remote_tree" ]; then
  # differences are acceptable only where the replacement map explains them
  unexplained=0
  while IFS= read -r -d '' p; do
    want=$(git rev-parse -q --verify "$remote_tree:$p" || true)
    have=$(git rev-parse -q --verify "$expect_tree:$p" || true)
    if [ -n "$want" ] && [ -n "$have" ] && [ "$(replace_blob "$have")" = "$want" ]; then
      continue
    fi
    unexplained=$((unexplained + 1))
    log "public tip differs from its source in $p"
  done < <(git diff -z --name-only --no-renames "$expect_tree" "$remote_tree")
  [ "$unexplained" -eq 0 ] || die "public tip $remote_sha does not match source $last ($unexplained file(s))"
  log "public tip matches its source after the replacement map"
fi

mapfile -t todo < <(git rev-list --first-parent --reverse "$last..$src_sha")
if [ "${#todo[@]}" -eq 0 ]; then
  log "nothing to publish: public $PUBLISH_BRANCH is at $last (0 new commits)"
  exit 0
fi
log "${#todo[@]} source commit(s) after $last"

# --- build the public commits (objects only, no refs) -------------------------
parent=$remote_sha
parent_tree=$remote_tree
new_commits=()
replaced_total=0
idx="$work/index"
for c in "${todo[@]}"; do
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$parent_tree"
  : > "$work/info"
  while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
    is_excluded "$path" && continue
    # meta = ":<old mode> <new mode> <old sha> <new sha> <status>"
    read -r _ new_mode _ new_sha status <<< "${meta#:}"
    if [ "$status" = "D" ]; then
      printf '0 %s\t%s\n' "0000000000000000000000000000000000000000" "$path" >> "$work/info"
      continue
    fi
    if [ "$new_mode" = "160000" ]; then
      out_sha=$new_sha
    else
      out_sha=$(replace_blob "$new_sha")
      if [ "$out_sha" != "$new_sha" ]; then
        replaced_total=$((replaced_total + 1))
        log "replacement map changed $path in ${c:0:12}"
      fi
    fi
    printf '%s %s\t%s\n' "$new_mode" "$out_sha" "$path" >> "$work/info"
  done < <(git diff-tree -z -r --no-renames --no-commit-id "$c^1" "$c")
  [ -s "$work/info" ] && GIT_INDEX_FILE="$idx" git update-index --index-info < "$work/info"
  tree=$(GIT_INDEX_FILE="$idx" git write-tree)
  if [ "$tree" = "$parent_tree" ]; then
    log "skip ${c:0:12} (no public change): $(git log -1 --format=%s "$c")"
    continue
  fi
  msgfile="$work/msg"
  if [ -r "$MESSAGE_DIR/$c.msg" ]; then
    cat "$MESSAGE_DIR/$c.msg" > "$msgfile"
    log "message of ${c:0:12} taken from $MESSAGE_DIR"
  else
    git log -1 --format=%B "$c" > "$msgfile"
    if [ -n "$(git rev-parse -q --verify "$c^2" || true)" ]; then
      subj=$(head -n1 "$msgfile")
      body=$(tail -n +2 "$msgfile" | sed -e '/./,$!d')
      if [[ "$subj" =~ ^Merge\ branch\ \'([^\']+)\' ]]; then
        subj="merge: integrate ${BASH_REMATCH[1]}"
      fi
      {
        printf '%s\n\n' "$subj"
        [ -n "$body" ] && printf '%s\n\n' "$body"
        printf 'Contained commits:\n'
        git log --format='- %s' "$c^1..$c^2"
      } > "$msgfile"
    fi
  fi
  # strip trailing blank lines, then append the trailer
  printf '%s\n\nSource-Commit: %s\n' "$(cat "$msgfile")" "$c" > "$msgfile.final"
  new=$(GIT_AUTHOR_NAME="$ident_name" GIT_AUTHOR_EMAIL="$ident_email" \
        GIT_COMMITTER_NAME="$ident_name" GIT_COMMITTER_EMAIL="$ident_email" \
        GIT_AUTHOR_DATE="$(git log -1 --format='%at %az' "$c")" \
        GIT_COMMITTER_DATE="$(git log -1 --format='%ct %cz' "$c")" \
        git commit-tree "$tree" -p "$parent" -F "$msgfile.final")
  new_commits+=("$new")
  parent=$new
  parent_tree=$tree
done

if [ "${#new_commits[@]}" -eq 0 ]; then
  log "nothing to publish: no public change since $last (0 new commits)"
  exit 0
fi
if [ "$replaced_total" -gt 0 ] && [ "${PUBLISH_ALLOW_REPLACE:-}" != "yes" ]; then
  die "$replaced_total file(s) changed by the replacement map; fix them on main (or PUBLISH_ALLOW_REPLACE=yes)"
fi
new_tip=$parent

# --- gates over every new commit ----------------------------------------------
scan="$work/scan"
mkdir -p "$scan"
n=0
for c in "${new_commits[@]}"; do
  n=$((n + 1))
  d=$(printf '%s/%04d' "$scan" "$n")
  mkdir -p "$d"
  git diff-tree -z -r --no-renames --diff-filter=AM --name-only "$c^" "$c" \
    | xargs -0 -r git archive "$c" -- | tar -x -C "$d"
  bad_files=$(git ls-tree -r --name-only "$c" \
    | grep -E '(^|/)\.env($|\.[^e])|\.(pem|key|p12|jks|keystore|apk|db|sqlite|sqlite3)$|(^|/)secrets?\.json$' || true)
  [ -z "$bad_files" ] || die "commit $n ($c) tracks files that must not be published:
$bad_files"
done
log "structure: clean (${#new_commits[@]} trees)"

gl_args=()
if git cat-file -e "$new_tip:.gitleaks.toml" 2>/dev/null; then
  git show "$new_tip:.gitleaks.toml" > "$work/gitleaks.toml"
  gl_args=(--config "$work/gitleaks.toml")
fi
if ! "$GITLEAKS" detect --no-git --source "$scan" "${gl_args[@]}" --report-path "$work/gitleaks.json" --exit-code 1 >/dev/null 2>&1; then
  die "gitleaks found secrets in the new commits (rerun gitleaks manually with --verbose)"
fi
log "gitleaks: clean"

hits=0
rule_no=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  rule_no=$((rule_no + 1))
  regex=${line%%	*}
  allow=""
  [ "$regex" != "$line" ] && allow=${line#*	}
  # report commit/file:line only, never the matched text
  matches=$(grep -r -I -i -n -E -e "$regex" "$scan" 2>/dev/null | cut -d: -f1,2 || true)
  if [ -n "$matches" ]; then
    while IFS= read -r m; do
      rel=${m#"$scan"/}
      num=${rel%%/*}
      rel=${rel#*/}
      ok=0
      if [ -n "$allow" ]; then
        IFS=',' read -r -a allowed <<< "$allow"
        for a in "${allowed[@]}"; do
          a=$(printf '%s' "$a" | sed 's/^ *//;s/ *$//')
          if [ -n "$a" ]; then case "$rel" in *"$a"*) ok=1 ;; esac; fi
        done
      fi
      if [ "$ok" -eq 0 ]; then
        hits=$((hits + 1))
        log "blocklist rule #$rule_no hit: commit $num $rel"
      fi
    done <<< "$matches"
  fi
  # messages: the blocklist applies without path allowances
  n=0
  for c in "${new_commits[@]}"; do
    n=$((n + 1))
    if git log -1 --format=%B "$c" | grep -q -i -E -e "$regex"; then
      hits=$((hits + 1))
      log "blocklist rule #$rule_no hit: message of commit $n (source $(git log -1 --format=%B "$c" | sed -n 's/^Source-Commit: //p'))"
    fi
  done
done < "$BLOCKLIST_FILE"
if [ -r "$MESSAGE_GREP_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    n=0
    for c in "${new_commits[@]}"; do
      n=$((n + 1))
      if git log -1 --format=%B "$c" | grep -q -i -E -e "$line"; then
        hits=$((hits + 1))
        log "message rule hit: commit $n (source $(git log -1 --format=%B "$c" | sed -n 's/^Source-Commit: //p'))"
      fi
    done
  done < "$MESSAGE_GREP_FILE"
fi
[ "$hits" -eq 0 ] || die "$hits blocklist/message hit(s); fix files on main, messages via $MESSAGE_DIR/<sha>.msg"
log "blocklist: clean ($rule_no rules, files and messages)"

# --- release tags ---------------------------------------------------------------
tags=()
for c in "${new_commits[@]}"; do
  ver=$(git log -1 --format=%s "$c" | sed -n 's/^chore(release): v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
  [ -n "$ver" ] || continue
  if [ -n "$(retry git ls-remote "$PUBLISH_URL" "refs/tags/v$ver" | cut -f1 || true)" ]; then
    die "tag v$ver already exists on $PUBLISH_URL"
  fi
  tags+=("v$ver=$c")
done

n=0
for c in "${new_commits[@]}"; do
  n=$((n + 1))
  log "  $n. $c $(git log -1 --format='%ad %s' --date=short "$c")"
done
for t in "${tags[@]}"; do log "  tag ${t%%=*} -> ${t#*=}"; done
log "would publish ${#new_commits[@]} commit(s): $remote_sha..$new_tip"

if [ "${PUBLISH_CONFIRM:-}" != "yes" ]; then
  log "dry run: set PUBLISH_CONFIRM=yes to fast-forward $PUBLISH_URL $PUBLISH_BRANCH to $new_tip"
  exit 0
fi

# fast-forward only: no --force, the remote rejects anything else
retry git push "$PUBLISH_URL" "$new_tip:refs/heads/$PUBLISH_BRANCH" || die "push failed (not a fast-forward?)"
for t in "${tags[@]}"; do
  retry git push "$PUBLISH_URL" "${t#*=}:refs/tags/${t%%=*}" || die "tag push ${t%%=*} failed"
done
pushed=$(retry git ls-remote "$PUBLISH_URL" "refs/heads/$PUBLISH_BRANCH" | cut -f1 || true)
[ "$pushed" = "$new_tip" ] || die "remote $PUBLISH_BRANCH is '${pushed:-unreadable}', expected $new_tip"
log "published: $PUBLISH_URL $PUBLISH_BRANCH = $new_tip (source $src_sha, ${#new_commits[@]} commit(s))"
