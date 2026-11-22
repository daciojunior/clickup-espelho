// Copia o plugin compilado para o cofre. Uso: npm run install-plugin
// Na primeira vez cria o data.json com o space e o token lido de Clickup.env.
import fs from "node:fs";
import path from "node:path";
// dados desta instalação (cofre de desenvolvimento, space) ficam em instalador/config.json, fora do repositório
const cfg = JSON.parse(fs.readFileSync("instalador/config.json", "utf8"));
const VAULT = process.env.VAULT ?? cfg.devVault;
if (!VAULT) throw new Error("informe VAULT=... ou devVault em instalador/config.json");
const dest = path.join(VAULT, ".obsidian/plugins/clickup-espelho");
fs.mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(dest, f));
const data = path.join(dest, "data.json");
if (!fs.existsSync(data)) {
  const env = fs.existsSync("Clickup.env") ? fs.readFileSync("Clickup.env", "utf8") : "";
  const token = (env.match(/^CLICKUP_TOKEN=(.*)$/m)?.[1] ?? "").trim();
  fs.writeFileSync(data, JSON.stringify({
    settings: { token, spaces: cfg.spaces ?? [] },
  }, null, 2));
  console.log("data.json criado" + (token ? " (com token)" : " (sem token)"));
}
console.log("Plugin instalado em", dest);
