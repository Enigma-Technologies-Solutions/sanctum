// Loads the core and the vendored pdf-lib the way the built page does: as plain scripts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

function script(path) {
  const mod = { exports: {} };
  new Function("module", "exports", readFileSync(path, "utf8"))(mod, mod.exports);
  return mod.exports;
}

export const PDFLib = script(join(ROOT, "vendor", "pdf-lib.min.js"));
export const core = script(join(ROOT, "src", "watermark-core.js"));
