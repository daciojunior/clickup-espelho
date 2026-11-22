// Ajudante do instalador do Mac: lê e grava os arquivos JSON.
// Roda com o JavaScript que já vem no macOS (osascript -l JavaScript), sem instalar nada.
// Também roda no Node (node mac-json.js ...), que é como foi testado fora do Mac.
ObjC = typeof ObjC === "undefined" ? null : ObjC;
if (ObjC) ObjC.import("Foundation");

function readText(p) {
  if (!ObjC) return require("fs").existsSync(p) ? require("fs").readFileSync(p, "utf8") : null;
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(p)) return null;
  return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null));
}
function writeText(p, s) {
  if (!ObjC) return require("fs").writeFileSync(p, s);
  $(s).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
}
const readJson = (p, d) => { const t = readText(p); return t ? JSON.parse(t) : d; };
const writeJson = (p, o) => writeText(p, JSON.stringify(o, null, 2));

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (cmd === "get") { const v = readJson(file, {})[rest[0]]; return v == null ? "" : String(v); }
  if (cmd === "data") { // data.json do ClickUp Espelho: token + spaces do config.json
    const cfg = readJson(rest[0], {});
    let spaces = cfg.spaces || [];
    if (!cfg.spaces && cfg.spaceName && rest[2]) { // procura o space pelo nome nas respostas do ClickUp
      for (const t of readJson(rest[2] + "/teams.json", {}).teams || [])
        for (const sp of readJson(rest[2] + "/sp_" + t.id + ".json", {}).spaces || [])
          if (sp.name === cfg.spaceName) spaces.push({ teamId: String(t.id), id: String(sp.id), name: sp.name });
    }
    // acrescenta ao que já existe, sem apagar índice nem outras opções
    let cur = null;
    try { cur = readJson(file, null); } catch (e) { cur = null; }
    if (cur && cur.settings) {
      if (rest[1]) {
        cur.settings.token = rest[1];
        if (!(cur.settings.spaces || []).length && spaces.length) cur.settings.spaces = spaces;
        writeJson(file, cur);
      }
    } else writeJson(file, { settings: { token: rest[1] || "", spaces } });
    return String(spaces.length);
  } else if (cmd === "hastoken") {
    try { const d = readJson(file, null); return d && d.settings && d.settings.token ? "1" : "0"; } catch (e) { return "0"; }
  } else if (cmd === "vaults") { // cofres conhecidos do Obsidian, do mais recente para o mais antigo
    return Object.values(readJson(file, {}).vaults || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((v) => v.path).join(String.fromCharCode(10));
  } else if (cmd === "teamids") {
    return (readJson(file, {}).teams || []).map((t) => t.id).join(" ");
  } else if (cmd === "brat") { // acrescenta o repositório à lista do BRAT
    const repo = rest[0];
    const b = readJson(file, {
      pluginList: [], pluginSubListFrozenVersion: [], themesList: [], updateAtStartup: true, updateThemesAtStartup: true,
      enableAfterInstall: true, loggingEnabled: false, loggingPath: "BRAT-log", loggingVerboseEnabled: false, debuggingMode: false,
      notificationsEnabled: true, globalTokenName: "", personalAccessToken: "", selectLatestPluginVersionByDefault: false, allowIncompatiblePlugins: false,
    });
    if (!b.pluginList.includes(repo)) {
      b.pluginList.push(repo);
      if (!b.pluginSubListFrozenVersion) b.pluginSubListFrozenVersion = [];
      b.pluginSubListFrozenVersion.push({ repo, version: "latest" });
    }
    writeJson(file, b);
  } else if (cmd === "enable") { // community-plugins.json: liga os plugins sem tirar os que já estavam
    const list = readJson(file, []);
    for (const n of rest) if (n && !list.includes(n)) list.push(n);
    writeJson(file, list);
  } else if (cmd === "register") { // obsidian.json: registra o cofre e o marca para abrir
    const o = readJson(file, {});
    if (!o.vaults) o.vaults = {};
    let known = false;
    for (const v of Object.values(o.vaults)) {
      const same = v.path === rest[0];
      if (same) known = true;
      if (same) v.open = true; else delete v.open;
    }
    if (!known) {
      let id = "";
      for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
      o.vaults[id] = { path: rest[0], ts: Date.now(), open: true };
    }
    writeJson(file, o);
  } else throw new Error("comando desconhecido: " + cmd);
  return "";
}

// osascript chama run(argv); no Node chamamos direto
function run(argv) { return main(argv); }
if (!ObjC) { const out = main(process.argv.slice(2)); if (out) console.log(out); }
