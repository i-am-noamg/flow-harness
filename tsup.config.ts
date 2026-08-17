import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/cli.ts", "src/flow-launcher.ts", "src/pi-extension.ts"], format: ["esm"], clean: true, sourcemap: true, banner: { js: "#!/usr/bin/env node" }, noExternal: [] });
