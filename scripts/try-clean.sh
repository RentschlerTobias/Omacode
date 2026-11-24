#!/usr/bin/env bash
# A trial install on a machine that has never seen omacode: a fresh Arch Linux container (scripts/clean/Containerfile)
# with nothing but its base system, sudo and a user. Rootless podman; nothing on the host changes but the image.
#
#   scripts/try-clean.sh checkout [--auto]   the committed tree copied in (git archive HEAD), then ./install.sh
#   scripts/try-clean.sh npm [--auto]        the packages packed here (npm pack, as the release would), installed into
#                                            the container and registered with OpenCode as `opencode plugin add` would
#   scripts/try-clean.sh services            a container with systemd: install.sh --yes, then omacode-services
#                                            (uv sync of the decider, about 2 GB) and its status
#
# Without --auto you get a shell in the container with the next step printed: answer install.sh's questions, log in to
# OpenCode (`opencode auth login`) and make a first deck. With --auto the steps that need no login run on their own
# and the result is printed: install, doctor, and whether OpenCode loads the plugin.
#
# Limits of a container, not of omacode: no GPU (ComfyUI is left out), and bubblewrap may be refused inside rootless
# podman, so doctor's sandbox line can fail here and not on a real machine.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
IMAGE="omacode-clean:arch"
MODE="${1:-}"
AUTO="${2:-}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omacode-clean.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

case "$MODE" in checkout|npm|services) ;; *) sed -n '2,17p' "$0"; exit 1 ;; esac

podman build -q -t "$IMAGE" -f "$REPO/scripts/clean/Containerfile" "$REPO/scripts/clean" >/dev/null

# What every mode runs first inside: the PATH a login shell would have after the installers (OpenCode puts itself
# into ~/.opencode/bin, uv and npm tools into ~/.local/bin).
PRELUDE='export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"; set -e'
# Whether OpenCode loads the server plugin: the micromanager agent exists only then.
PLUGIN_CHECK='cd ~ && if opencode debug agents --standalone 2>/dev/null | grep -q "\"name\": \"Micromanager\""; then echo "OK: OpenCode loads the plugin (the Micromanager agent is there)"; else echo "FAIL: OpenCode did not load the plugin"; fi'

run() {
  local script="$1" hint="$2"
  if [[ "$AUTO" == "--auto" ]]; then
    podman run --rm --userns=keep-id -v "$WORK:/in:ro,Z" "$IMAGE" bash -lc "$PRELUDE; $script"
  else
    podman run --rm -it --userns=keep-id -v "$WORK:/in:ro,Z" "$IMAGE" bash -lc "$PRELUDE; $script; echo; echo '$hint'; exec bash"
  fi
}

case "$MODE" in
checkout)
  git -C "$REPO" archive --format=tar --prefix=omacode/ HEAD >"$WORK/omacode.tar"
  if [[ "$AUTO" == "--auto" ]]; then
    run 'tar xf /in/omacode.tar -C ~ && cd ~/omacode && ./install.sh --yes && node packages/micromanager/src/cli.ts doctor || true; '"$PLUGIN_CHECK" ""
  else
    run 'tar xf /in/omacode.tar -C ~ && cd ~/omacode' "Next: ./install.sh   (then: opencode auth login, opencode, and pick a goal in the welcome)"
  fi
  ;;
npm)
  mkdir -p "$WORK/packs"
  for w in core guard sandbox artifact state context tui micromanager full; do
    (cd "$REPO" && npm pack --workspace "@omacode/$w" --pack-destination "$WORK/packs" --silent >/dev/null)
  done
  # What a user without a checkout does: Node and OpenCode first, then the plugin package. The packages are not on
  # npm yet, so the tarballs packed here stand in for `opencode plugin add @omacode/full`: installed into one prefix
  # and registered in opencode.json by path, which is what plugin add records too.
  SETUP='sudo pacman -Syu --noconfirm --needed nodejs npm git >/dev/null &&
    curl -fsSL https://opencode.ai/v2/install | bash -s -- --version 2.2.5 >/dev/null &&
    npm install --no-audit --no-fund --prefix ~/.local/share/omacode-npm /in/packs/*.tgz >/dev/null &&
    mkdir -p ~/.config/opencode ~/.local/bin &&
    printf "{ \"plugins\": [\"%s\"] }\n" "$HOME/.local/share/omacode-npm/node_modules/@omacode/full" > ~/.config/opencode/opencode.json &&
    ln -sf ~/.local/share/omacode-npm/node_modules/.bin/omacode ~/.local/bin/omacode'
  if [[ "$AUTO" == "--auto" ]]; then
    run "$SETUP && { omacode doctor || true; } && $PLUGIN_CHECK" ""
  else
    run "$SETUP" "Next: omacode doctor, opencode auth login, opencode (the welcome asks what you want to make)"
  fi
  ;;
services)
  git -C "$REPO" archive --format=tar --prefix=omacode/ HEAD >"$WORK/omacode.tar"
  name="omacode-clean-services-$$"
  podman run -d --rm --name "$name" --systemd=always -v "$WORK:/in:ro,Z" --user root "$IMAGE" /usr/lib/systemd/systemd >/dev/null
  trap 'podman stop -t 3 "$name" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
  # A user session for systemctl --user, as a login would start it.
  podman exec "$name" loginctl enable-linger tester
  for _ in $(seq 1 30); do podman exec "$name" test -S /run/user/1000/bus && break; sleep 1; done
  podman exec -u tester -e XDG_RUNTIME_DIR=/run/user/1000 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "$name" bash -lc "$PRELUDE"'
    tar xf /in/omacode.tar -C ~ && cd ~/omacode && ./install.sh --yes
    sudo pacman -S --noconfirm --needed uv >/dev/null
    node packages/micromanager/src/cli.ts services install
    sleep 3
    systemctl --user is-active omacode-services.service && echo "OK: omacode-services runs" || { echo "FAIL: omacode-services is not running"; journalctl --user -u omacode-services --no-pager | tail -20; }
    node packages/micromanager/src/cli.ts services status'
  ;;
esac
