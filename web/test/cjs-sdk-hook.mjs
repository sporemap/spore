// The pump SDK's ESM build cannot load under Node (its agent-payments dependency imports `BN` as a
// named export from CommonJS anchor), and Node's CommonJS export detection does not see the names
// in its CJS build either. Vite bundles the ESM fine; for node-side tests this hook serves a tiny
// synthesized ES module that re-exports every name of the CommonJS build.
import { createRequire, registerHooks } from "node:module";
const require = createRequire(import.meta.url);
const VIRTUAL = "spore:pump-sdk";
const names = Object.keys(require("@pump-fun/pump-sdk"));
const source = `import { createRequire } from "node:module";\nconst m = createRequire(${JSON.stringify(import.meta.url)})("@pump-fun/pump-sdk");\n` +
  names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`).join("\n") + `\nexport default m;\n`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@pump-fun/pump-sdk") return { url: VIRTUAL, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === VIRTUAL) return { format: "module", source, shortCircuit: true };
    return next(url, context);
  },
});
