# Built-in Skill Versioning

Built-in agent skills ship with the Docker image under
`/app/skills_agent_defaults/` and are seeded to `/data/skills_agent/` on
container startup by `entrypoint.sh`.

Because `/data` is a persistent volume, the seeding logic must decide on every
start: **leave the installed skill alone, or replace it with a newer version
from the image?** This is controlled by a `version` field in the skill's
frontmatter.

## Frontmatter

```yaml
---
name: wiki
version: 1.0.0
description: ...
# Optional: mark the skill as user-owned so auto-update skips it.
# managed: false
---
```

- `version` — semver string. Missing/empty is treated as `0.0.0`, so any
  shipped version will win over an old unversioned skill.
- `managed: false` — opt-out. When present the entrypoint never touches the
  skill, regardless of versions. Use this if you have customized the skill and
  want to pin your version.

## Startup behaviour (`entrypoint.sh`)

For each skill directory under `/app/skills_agent_defaults/`:

1. **Not installed** (`/data/skills_agent/<name>/` missing) → copy the default
   in. Logged as `Seeded agent skill: <name>`.
2. **Installed, `managed: false`** → skipped. Logged once per start.
3. **Installed, default version > installed version** →
   - the full installed directory is copied to
     `/data/skills_agent/.backups/<name>-v<installed-version>-<YYYYMMDD-HHMMSS>/`
   - the default is copied over the installed skill
   - logged as `Updated agent skill: <name> <old> → <new> (backup: ...)`
4. **Installed, versions equal or installed newer** → nothing happens.

Backups are never garbage-collected automatically; prune
`/data/skills_agent/.backups/` manually if needed.

## Bumping a built-in skill

1. Edit the skill under `data/skills_agent/<name>/`.
2. Bump the `version:` in the SKILL.md frontmatter (semver). Use minor for
   additive/content changes, major if the skill's contract with the agent
   changes incompatibly.
3. Ship a new image. Existing instances pick the update up on the next
   container start and write a backup of the previous version.

## Keeping a local fork

If you have edited a built-in skill on your instance and do not want it
overwritten, add `managed: false` to the frontmatter of
`/data/skills_agent/<name>/SKILL.md`. Remove the flag later to opt back into
auto-updates (the next startup will back up your fork and install the
shipped version).
