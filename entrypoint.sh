#!/bin/bash
set -e

echo "[axiom] Starting entrypoint..."

# Ensure data directories exist
mkdir -p /data/db /data/config /data/memory/daily /data/skills /data/skills_agent /data/npm-global /workspace

# ---------------------------------------------------------------------------
# Seed / auto-update built-in agent skills
#   - If a skill is not installed yet → seed from image defaults.
#   - If an installed skill has a lower `version:` (frontmatter) than the
#     shipped default → back up the installed copy and update in place.
#   - If the installed SKILL.md has `managed: false` → never touch, the user
#     has taken ownership of it.
# Skills ship with the image under /app/skills_agent_defaults/
# ---------------------------------------------------------------------------

# Extract a frontmatter value (e.g. version, managed) from a SKILL.md file.
# Only reads the leading YAML block between the first two `---` lines.
# Prints the value (trimmed, unquoted) or nothing if key/file is absent.
read_skill_frontmatter() {
    local file="$1"
    local key="$2"
    [ -f "$file" ] || return 0
    awk -v key="$key" '
        NR == 1 && $0 != "---" { exit }
        NR == 1 { in_fm = 1; next }
        in_fm && $0 == "---" { exit }
        in_fm {
            # match "key: value" at start of line, case-sensitive
            if (match($0, "^[[:space:]]*" key "[[:space:]]*:[[:space:]]*")) {
                val = substr($0, RSTART + RLENGTH)
                # strip surrounding quotes and trailing whitespace/comments
                sub(/[[:space:]]*(#.*)?$/, "", val)
                sub(/^"/, "", val); sub(/"$/, "", val)
                sub(/^'\''/, "", val); sub(/'\''$/, "", val)
                print val
                exit
            }
        }
    ' "$file"
}

# Returns 0 if $1 is strictly newer than $2 in semver-ish sort order.
# Missing/empty version is treated as 0.0.0 so any real version wins over it.
skill_version_newer() {
    local a="${1:-0.0.0}"
    local b="${2:-0.0.0}"
    [ "$a" = "$b" ] && return 1
    local top
    top=$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n1)
    [ "$top" = "$a" ]
}

if [ -d /app/skills_agent_defaults ]; then
    backup_root="/data/skills_agent/.backups"
    for skill_dir in /app/skills_agent_defaults/*/; do
        skill_name=$(basename "$skill_dir")
        target="/data/skills_agent/$skill_name"
        default_skill_md="$skill_dir/SKILL.md"

        if [ ! -d "$target" ]; then
            cp -r "$skill_dir" "$target"
            echo "[axiom] Seeded agent skill: $skill_name"
            continue
        fi

        installed_skill_md="$target/SKILL.md"
        managed=$(read_skill_frontmatter "$installed_skill_md" managed)
        if [ "$managed" = "false" ]; then
            echo "[axiom] Skill '$skill_name' is user-managed (managed: false) — skipping auto-update."
            continue
        fi

        default_version=$(read_skill_frontmatter "$default_skill_md" version)
        installed_version=$(read_skill_frontmatter "$installed_skill_md" version)

        if skill_version_newer "$default_version" "$installed_version"; then
            mkdir -p "$backup_root"
            ts=$(date +%Y%m%d-%H%M%S)
            backup_path="$backup_root/${skill_name}-v${installed_version:-unknown}-${ts}"
            cp -r "$target" "$backup_path"
            rm -rf "$target"
            cp -r "$skill_dir" "$target"
            echo "[axiom] Updated agent skill: $skill_name ${installed_version:-<none>} → $default_version (backup: $backup_path)"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Seed persona files for multi-persona agents (only if not already present)
# Persona seed files ship with the image under /app/agents-seed/<agentId>/
# Target: /data/agents/<agentId>/
# ---------------------------------------------------------------------------
mkdir -p /data/agents
if [ -d /app/agents-seed ]; then
    for agent_dir in /app/agents-seed/*/; do
        agent_id=$(basename "$agent_dir")
        target="/data/agents/$agent_id"
        if [ ! -d "$target" ]; then
            cp -r "$agent_dir" "$target"
            echo "[axiom] Seeded persona files: $agent_id"
        else
            # Copy only files that don't exist yet (never overwrite user edits)
            for src_file in "$agent_dir"*; do
                [ -f "$src_file" ] || continue
                filename=$(basename "$src_file")
                if [ ! -f "$target/$filename" ]; then
                    cp "$src_file" "$target/$filename"
                    echo "[axiom] Seeded persona file: $agent_id/$filename"
                fi
            done
        fi
    done
fi

# Fix ownership on first run or after migration from root user
if [ "$(stat -c '%u' /workspace)" = "0" ]; then
    echo "[axiom] Migrating workspace ownership to agent user..."
    chown -R agent:agent /workspace
fi

if [ "$(stat -c '%u' /data)" = "0" ]; then
    echo "[axiom] Migrating data ownership to agent user..."
    chown -R agent:agent /data
fi

# Always ensure /data/config is owned by agent (may have been created by root)
chown -R agent:agent /data/config 2>/dev/null || true

# Set up home defaults if missing (volume overlays image content on first run)
if [ ! -f /workspace/.bashrc ]; then
    cp /etc/skel/.bashrc /workspace/.bashrc
    chown agent:agent /workspace/.bashrc
fi

if [ ! -d /workspace/.ssh ]; then
    gosu agent mkdir -p -m 700 /workspace/.ssh
fi

# ---------------------------------------------------------------------------
# Restore agent-installed packages from previous container runs
# These are auto-tracked by the DPkg::Post-Invoke hook in track-packages.sh
# ---------------------------------------------------------------------------
AGENT_PACKAGES="/data/agent-packages.txt"
if [ -f "$AGENT_PACKAGES" ] && [ -s "$AGENT_PACKAGES" ]; then
    echo "[axiom] Found tracked agent packages, checking for restoration..."
    apt-get update -qq 2>/dev/null

    available=()
    unavailable=()
    already_installed=()

    while IFS= read -r pkg || [ -n "$pkg" ]; do
        pkg=$(echo "$pkg" | xargs)
        [ -z "$pkg" ] && continue

        # Check if already installed in this image (might have been added to base)
        if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
            already_installed+=("$pkg")
            continue
        fi

        # Check if available in current repos
        if apt-cache show "$pkg" > /dev/null 2>&1; then
            available+=("$pkg")
        else
            unavailable+=("$pkg")
        fi
    done < "$AGENT_PACKAGES"

    if [ ${#already_installed[@]} -gt 0 ]; then
        echo "[axiom] ${#already_installed[@]} package(s) already in base image, skipping."
    fi

    if [ ${#unavailable[@]} -gt 0 ]; then
        echo "[axiom] ⚠ ${#unavailable[@]} package(s) no longer available (skipped):"
        printf "[axiom]   - %s\n" "${unavailable[@]}"
        # Append to log for historical reference
        {
            echo "--- $(date '+%Y-%m-%d %H:%M:%S') --- Image: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"') ---"
            printf "  %s\n" "${unavailable[@]}"
        } >> /data/packages-unavailable.log
    fi

    if [ ${#available[@]} -gt 0 ]; then
        echo "[axiom] Restoring ${#available[@]} agent-installed package(s)..."
        failed=()
        idx=0
        for pkg in "${available[@]}"; do
            idx=$((idx + 1))
            echo "[axiom]   [$idx/${#available[@]}] Installing $pkg..."
            if ! apt-get install -y "$pkg" > /dev/null 2>&1; then
                failed+=("$pkg")
                echo "[axiom]   ✗ Failed: $pkg"
            fi
        done
        succeeded=$(( ${#available[@]} - ${#failed[@]} ))
        if [ ${#failed[@]} -eq 0 ]; then
            echo "[axiom] ✓ All ${#available[@]} packages restored successfully."
        else
            echo "[axiom] ✓ Restored $succeeded/${#available[@]} packages (${#failed[@]} failed)."
        fi
    else
        echo "[axiom] No packages need restoration."
    fi

    rm -f /tmp/apt-restore.log
fi

# ---------------------------------------------------------------------------
# Install user-defined packages from packages.txt (manual/static list)
# ---------------------------------------------------------------------------
PACKAGES_FILE="/data/packages.txt"
if [ -f "$PACKAGES_FILE" ] && [ -s "$PACKAGES_FILE" ]; then
    echo "[axiom] Found $PACKAGES_FILE, checking for packages to install..."
    apt-get update -qq 2>/dev/null

    while IFS= read -r package || [ -n "$package" ]; do
        # Skip empty lines and comments
        package=$(echo "$package" | xargs)
        if [ -z "$package" ] || [[ "$package" == \#* ]]; then
            continue
        fi

        # Skip if already installed
        if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
            continue
        fi

        # Check availability
        if ! apt-cache show "$package" > /dev/null 2>&1; then
            echo "[axiom] ⚠ Package '$package' not available, skipping."
            continue
        fi

        echo "[axiom] Installing package: $package"
        apt-get install -y "$package" 2>/dev/null || {
            echo "[axiom] ⚠ Failed to install package '$package'"
        }
    done < "$PACKAGES_FILE"
    echo "[axiom] User-defined package installation complete."
else
    echo "[axiom] No $PACKAGES_FILE found, skipping."
fi

# Clean up apt cache to save space
apt-get clean 2>/dev/null || true
rm -rf /var/lib/apt/lists/*

# Start the application as agent user
echo "[axiom] Starting server as agent user..."
cd /app
exec gosu agent npm run start --workspace=packages/web-backend
