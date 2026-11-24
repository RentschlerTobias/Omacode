// The TUI part of the one install: OpenCode loads a package's "./tui" export as its terminal UI plugin beside the
// server plugin in "." (opencode 2.2.5, Plugin.Features), so `opencode plugin add @omacode/full` brings both.
export { default } from "@omacode/tui/tui"
