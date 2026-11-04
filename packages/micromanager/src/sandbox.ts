// The sandbox lives in src/shell/ now (the shell plugin, enable-able on its own). This file keeps the old import
// path working for the parts of the plugin that are not the shell plugin: the same names, from one place.

export * from "./shell/sandbox.ts"
