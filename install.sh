#!/usr/bin/env bash
# Install micromanager into OpenCode from a checkout (a symlink, so the repo stays the source), or remove it. For a run
# without a checkout use OpenCode's own installer, which needs nothing from this script:
#   opencode plugin add 'github:RentschlerTobias/Micromanager#v0.1.0'
#
#   ./install.sh            check the machine (preflight), link packages/micromanager/src/plugin.ts into
#                           ~/.config/opencode/plugins/omacode.ts, write the TUI package ~/.config/opencode/omacode-tui/
#                           into the "plugins" of ~/.config/opencode/cli.json, then ask which profile to install:
#                             Minimal  the plugin and the TUI
#                             Coding   + omacode-services (the local decider and the embedding service)
#                             Creator  + HyperFrames, ComfyUI (no model) and comfy-mcp
#                             Full     + Manim
#                           each says what it downloads before anything is fetched (packages/micromanager/src/setup.ts)
#   ./install.sh --profile minimal|coding|creator|full [--gpu nvidia|amd|amd-igpu|cpu]   that profile, without asking
#   ./install.sh --with hyperframes,manim,comfyui,comfy-mcp [--gpu …]   those tools, without asking
#   ./install.sh --yes | --no-tools | --skip-all   ask nothing, install only the plugin (Minimal)
#   ./install.sh --tools    only the per-tool question round, for a plugin already installed
#   ./install.sh --doctor   the installed state, each finding with its fix
#   ./install.sh --remove [--purge] [--dry-run]   remove the plugin, the TUI package and omacode-services, and say what
#                           stays (tools and models unless --purge; your journal, memory and settings always)
#   ./install.sh --embedding [0.6b|4b|8b]   install omacode-services with that embedding size (was its own unit)
#   ./install.sh --embedding-remove         remove the old micromanager-embedding unit (before omacode-services)
#   ./install.sh --skills   no-op: the plugin registers skills/<name> into OpenCode itself, a restart is enough
# OpenCode loads plugins when it starts: restart the hub/server afterwards.
set -euo pipefail

# pwd -P instead of readlink -f: BSD readlink has no -f, and this script is run on macOS too.
REPO="$(cd "$(dirname "$0")" && pwd -P)"
PLUGINS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
LINK="$PLUGINS/omacode.ts"

CLI="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cli.json"
# The TUI package: opencode 2.0.18 wants a package directory exporting "./tui", and a relative import out of that
# directory does not resolve (live check: a package inside this repository importing ../src/tui.tsx never loaded),
# so the package is written here and imports the code by its absolute path. Its entry must be named tui.tsx: the same
# package with index.tsx was silently not loaded (live check, 2026-10-19). A package install (`plugin add`) needs none
# of this: package.json exports "./tui" itself.
TUI="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/omacode-tui"
# The names before the rename to omacode (2026-11-23): replaced by the ones above on the next install.
OLD_TUI="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/micromanager-tui"

write_tui() {
  mkdir -p "$TUI"
  printf '%s\n' '{ "name": "omacode-tui", "version": "0.1.0", "type": "module", "exports": { "./tui": "./tui.tsx" } }' >"$TUI/package.json"
  printf '%s\n' "// Written by $REPO/install.sh: omacode's TUI plugin lives in the repository." \
    "export { default } from \"$REPO/packages/tui/src/tui.js\"" >"$TUI/tui.tsx"
}

# Add (add) or remove (remove) the TUI package in cli.json's "plugins", keeping everything else in the file.
cli_plugin() {
  node -e '
    const fs = require("node:fs")
    const [file, entry, mode] = process.argv.slice(1)
    let config = {}
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) } catch (err) {
      if (err.code !== "ENOENT") { console.error(`${file} is not plain JSON; add or remove "${entry}" in its "plugins" by hand`); process.exit(0) }
    }
    const plugins = (config.plugins ?? []).filter((p) => p !== entry)
    if (mode === "add") plugins.push(entry)
    config.plugins = plugins
    if (!plugins.length) delete config.plugins
    fs.mkdirSync(require("node:path").dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
    console.log(`${mode === "add" ? "added" : "removed"} ${entry} ${mode === "add" ? "to" : "from"} the plugins of ${file}`)
  ' "$CLI" "${2:-$TUI}" "$1"
}

CLI_TS="$REPO/packages/micromanager/src/cli.ts"

# The optional parts: --profile, --with, --gpu, --yes and --no-tools may follow the plain install.
WITH=""; GPU=""; ASK=1; PROFILE=""; PURGE=""; DRY=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --with) WITH="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
    --with=*) WITH="${args[$i]#--with=}" ;;
    --gpu) GPU="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
    --gpu=*) GPU="${args[$i]#--gpu=}" ;;
    --profile) PROFILE="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
    --profile=*) PROFILE="${args[$i]#--profile=}" ;;
    --yes|-y|--no-tools|--skip-all) ASK=0 ;;
    --purge) PURGE=--purge ;;
    --dry-run) DRY=--dry-run ;;
  esac
done
# After the plugin: a profile named, tools named, the profile question in a terminal, or nothing.
optional() {
  if [[ -n "$PROFILE" ]]; then
    node "$CLI_TS" setup "$PROFILE" ${GPU:+--gpu "$GPU"}
  elif [[ -n "$WITH" ]]; then
    node "$CLI_TS" tools install "$WITH" ${GPU:+--gpu "$GPU"}
  elif [[ "$ASK" == 1 && -t 0 && -t 1 ]]; then
    node "$CLI_TS" setup ask
  else
    echo "Minimal: only the plugin (./install.sh --profile coding|creator|full adds more)"
  fi
}
if [[ "${1:-}" == "--tools" ]]; then
  node "$CLI_TS" tools ask
  exit $?
fi
if [[ "${1:-}" == "--doctor" ]]; then
  node "$CLI_TS" doctor
  exit $?
fi

# --skills: no-op since 2026-10-26, kept so an old command still works. The plugin registers skills/<name> through
# ctx.skill at setup (src/skills.ts), so a checkout and a package install both need no links; a restart is enough.
if [[ "${1:-}" == "--skills" ]]; then
  echo "nothing to do: the plugin registers its skills itself; restart the OpenCode server"
  exit 0
fi

# --embedding: the memory's embedding service (src/context/embed.ts). Its own llama.cpp process on the CPU, not in
# llama-swap, where every embedding call would push the loaded chat model off the GPU. Down or missing, the memory
# searches by keywords.
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/micromanager-embedding.service"
if [[ "${1:-}" == "--embedding-remove" ]]; then
  systemctl --user disable --now micromanager-embedding.service 2>/dev/null || true
  rm -f "$UNIT" && systemctl --user daemon-reload && echo "removed micromanager-embedding.service"
  exit 0
fi
if [[ "${1:-}" == "--embedding" ]]; then
  # Since omacode-services (2026-11-21) the embedding service is one of its services, not a unit of its own.
  node "$CLI_TS" services install --embedding "${2:-0.6b}" --replace
  exit $?
fi

if [[ "${1:-}" == "--remove" ]]; then
  if [[ -z "$DRY" ]]; then
    # The links and the TUI package under their names before the rename; the rest is the CLI's uninstall.
    [[ -L "$PLUGINS/micromanager.ts" ]] && rm "$PLUGINS/micromanager.ts" && echo "removed $PLUGINS/micromanager.ts"
    if [[ -d "$OLD_TUI" ]]; then cli_plugin remove "$OLD_TUI"; rm -rf "$OLD_TUI"; fi
  fi
  node "$CLI_TS" uninstall $PURGE $DRY
  exit $?
fi

# Before anything is written: does this machine have what omacode needs?
node "$CLI_TS" preflight || { echo "preflight failed: fix the ✗ lines above and run ./install.sh again" >&2; exit 1; }

mkdir -p "$PLUGINS"
# The link's names before: jev-micromanager.ts (until 2026-10-19), micromanager.ts (until 2026-11-23). Two links to the
# same plugin would load it twice.
for OLD_LINK in "$PLUGINS/jev-micromanager.ts" "$PLUGINS/micromanager.ts"; do
  if [[ -L "$OLD_LINK" && "$(realpath "$OLD_LINK")" == "$(realpath "$REPO/packages/micromanager/src/plugin.ts")" ]]; then
    rm "$OLD_LINK" && echo "removed the old link $OLD_LINK"
  fi
done
# The TUI package's name before: written by this script, so it is ours to remove.
if [[ -f "$OLD_TUI/tui.tsx" ]] && grep -q "install.sh" "$OLD_TUI/tui.tsx"; then
  cli_plugin remove "$OLD_TUI"
  rm -rf "$OLD_TUI" && echo "removed the old TUI package $OLD_TUI"
fi
if [[ -e "$LINK" && ! -L "$LINK" ]]; then
  echo "$LINK exists and is not our link; not touching it" >&2
  exit 1
fi
ln -sfn "$REPO/packages/micromanager/src/plugin.ts" "$LINK"
echo "linked $LINK -> $REPO/packages/micromanager/src/plugin.ts (restart the OpenCode server to load it)"
write_tui
cli_plugin add
echo "the TUI shows job progress from its next start (the sidebar toggles with <leader>b, or set \"session\": {\"sidebar\": \"auto\"} in cli.json; /tasks opens a task)"
optional || echo "a part of the profile did not install; the plugin is installed, try again with ./install.sh --profile <name>, or see ./install.sh --doctor"
