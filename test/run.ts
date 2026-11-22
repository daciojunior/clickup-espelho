// Teste do núcleo: lê o ClickUp real, grava numa pasta temporária e simula as escritas
// (o "ClickUp" das escritas é uma cópia em memória; nenhum card real é alterado),
// exceto o bloco final, que cria, altera e apaga um card temporário de verdade.
// Uso: CLICKUP_TOKEN=... SPACE_ID=... OUT_DIR=... npm test
import * as fs from "node:fs";
import * as path from "node:path";
import { archiveTask, createTask, fetchSpace, fetchTasks, getTask, updateTask, type Changes, type Http, type NewTask, type Task, uploadAttachment, type RawPost } from "../src/clickup";
import { buildPlan, hash, parseFm, stripFrontmatter, syncCycle, type Api, type Index, type VaultPort } from "../src/core";

const token = process.env.CLICKUP_TOKEN!;
const spaceId = process.env.SPACE_ID!;
const out = process.env.OUT_DIR!;
if (!token || !spaceId || !out) throw new Error("defina CLICKUP_TOKEN, SPACE_ID e OUT_DIR");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const http: Http = async (url, tk, method = "GET", body) => {
  const r = await fetch(url, {
    method, headers: { Authorization: tk, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const abs = (p: string) => path.join(out, p);
const walk = (dir: string): string[] =>
  fs.readdirSync(abs(dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.posix.join(dir, e.name)) : [path.posix.join(dir, e.name)]);
const port: VaultPort = {
  exists: async (p) => fs.existsSync(abs(p)),
  read: async (p) => fs.readFileSync(abs(p), "utf8"),
  write: async (p, c) => fs.writeFileSync(abs(p), c),
  mkdir: async (p) => void fs.mkdirSync(abs(p), { recursive: true }),
  rename: async (a, b) => fs.renameSync(abs(a), abs(b)),
  trash: async (p) => fs.rmSync(abs(p)),
  isEmptyDir: async (p) => fs.readdirSync(abs(p)).length === 0,
  rmdir: async (p) => fs.rmdirSync(abs(p)),
  mtime: async (p) => fs.statSync(abs(p)).mtimeMs,
  list: async (d) => walk(d).filter((f) => f.endsWith(".md")),
  readImage: async (name) => (fs.existsSync(abs(name)) ? new Uint8Array(fs.readFileSync(abs(name))).buffer : null),
  image: async (name, url) => { if (!fs.existsSync(abs(name))) { downloads.push(url); fs.writeFileSync(abs(name), "img"); } },
  findById: async (id) =>
    walk("").find((f) => f.endsWith(".md") && !f.includes("_conflitos") && parseFm(fs.readFileSync(abs(f), "utf8")).clickup_id === id) ?? null,
};

const downloads: string[] = [];
const uploads: { id: string; fileName: string; size: number }[] = [];
const attach: Record<string, NonNullable<Task["attachments"]>> = {};
let fails = 0;
const check = (label: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "OK   " : "FALHA"} ${label} ${extra}`);
  if (!ok) fails++;
};

const ROOT = "";
const space = await fetchSpace(http, token, spaceId, "Clinical Frontier");
{
  // status fixos só em memória: o teste não depende dos status que o space real tem hoje
  const CLASSIC = ["backlog", "to do", "in progress", "espera", "complete"];
  for (const l of space.lists) {
    const old = [...l.statuses].sort((a, b) => a.orderindex - b.orderindex).map((x) => x.status);
    for (const t of l.tasks) t.status = { status: CLASSIC[Math.max(0, old.indexOf(t.status.status)) % CLASSIC.length] };
    l.statuses = CLASSIC.map((status, i) => ({ status, color: "#888888", orderindex: i }));
  }
}
{
  // estrutura de pais e subtarefas só em memória: o space real pode não ter subtarefas
  const t = space.lists[0].tasks.filter((x) => !x.parent);
  if (t.length < 12) throw new Error("poucos cards na 1ª lista para montar o teste");
  const sub = (kid: number, par: number) => { t[kid].parent = t[par].id; };
  sub(1, 0); sub(2, 0); sub(3, 0); sub(5, 4); sub(6, 4); sub(7, 6); sub(9, 8);
  const other = space.lists[0].statuses.map((s) => s.status).find((s) => s !== t[0].status.status)!;
  t[1].status = { status: other };
  t[7].status = { status: space.lists[0].statuses.map((s) => s.status).find((s) => s !== t[4].status.status)! };
}
const all = () => space.lists.flatMap((l) => l.tasks);
const byId = (id: string) => all().find((t) => t.id === id)!;
const index: Index = {};
const pushes: { id: string; ch: Changes }[] = [];
const PRIO: Record<string, any> = { "": null };
const created: { listId: string; t: NewTask }[] = [];
const archived: string[] = [];
const moves: { id: string; listId: string }[] = [];
let seq = 0;
const fake: Api = {
  create: async (listId, t) => {
    created.push({ listId, t });
    const id = "novo" + ++seq;
    return {
      id, name: t.name, markdown_description: t.body ? t.body + "\n" : "", parent: t.parent ?? null, url: "https://x/" + id,
      status: { status: t.status ?? space.lists.find((l) => l.id === listId)!.statuses[0].status },
      priority: t.priority ? { priority: t.priority } : null,
      date_created: String(Date.now() + seq), date_updated: String(Date.now()),
    };
  },
  archive: async (id) => { archived.push(id); },
  get: async (id) => ({ ...byId(id), attachments: attach[id] ?? [] }),
  upload: async (id, fileName, data) => {
    uploads.push({ id, fileName, size: data.byteLength });
    return `https://t1.p.clickup-attachments.com/t1/cccccccc-2222-3333-4444-00000000000${uploads.length}/${encodeURIComponent(fileName)}`;
  },
  move: async (id, listId) => { moves.push({ id, listId }); },
  update: async (id, ch) => {
    pushes.push({ id, ch });
    const t: Task = { ...byId(id) };
    if (ch.name !== undefined) t.name = ch.name;
    if (ch.status !== undefined) t.status = { status: ch.status };
    if (ch.parent !== undefined) t.parent = ch.parent;
    if (ch.priority !== undefined) t.priority = ch.priority in PRIO ? null : { priority: ch.priority };
    if (ch.body !== undefined) t.markdown_description = ch.body + "\n"; // ClickUp reformatando
    t.date_updated = String(Date.now());
    return t;
  },
};
const updateFake = (id: string, ch: Changes) => fake.update(id, ch).then((t) => Object.assign(byId(id), t));
const cycle = async () => { pushes.length = 0; created.length = 0; archived.length = 0; return (await syncCycle(port, fake, ROOT, [space], index, { statusColors: { "in progress": "cyan" } })).stats; };
const quietStats = (s: any) => !s.created && !s.updated && !s.moved && !s.trashed && !s.conflicts && !s.pushed && !s.added && !s.archived && !s.converted && !s.errors.length;
const total = all().length;

let st = await cycle();
check("1ª sincronização cria todas as notas", st.created === total, `(${st.created})`);
check("raiz vazia: space direto na raiz", fs.existsSync(abs("Clinical Frontier/Desenvolvimento/1 - backlog")));
const plan0 = buildPlan(ROOT, [space], { statusColors: { "in progress": "cyan" } });
const leaf = plan0.notes.find((n) => !n.isFolder && n.top)!;
const folderNote = plan0.notes.find((n) => n.isFolder && n.top)!;
check("ícones e cores", plan0.icons[leaf.path].icon === "lucide-bookmark-check" &&
  plan0.icons[folderNote.path].icon === "lucide-bookmark-check" &&
  plan0.icons[path.posix.dirname(folderNote.path)].icon === "lucide-layout-list" &&
  plan0.icons["Clinical Frontier/Desenvolvimento/3 - in progress"].color === "cyan");
check("subtarefas usam a cor do pai", plan0.notes.filter((n) => !n.top).every((n) =>
  plan0.icons[n.path].color === plan0.icons[plan0.notes.find((p) => p.id === n.task.parent)!.path].color));
check("ordem do ClickUp no plano", plan0.notes.every((n) => n.isFolder
  ? plan0.order[n.path] === -1 && plan0.order[path.posix.dirname(n.path)] === Number(n.task.orderindex)
  : plan0.order[n.path] === Number(n.task.orderindex)) && plan0.notes.some((n) => Number(n.task.orderindex) > 0));
st = await cycle();
check("2ª sincronização não altera nada", quietStats(st) && pushes.length === 0, JSON.stringify(st));

// editar o corpo no Obsidian → enviado; a nota local não é reescrita
const p1 = index[leaf.id].path;
fs.appendFileSync(abs(p1), "\nedição local\n");
const before = fs.readFileSync(abs(p1), "utf8");
st = await cycle();
check("edição local do corpo é enviada", pushes.length === 1 && pushes[0].ch.body!.endsWith("edição local") && fs.readFileSync(abs(p1), "utf8") === before);
st = await cycle();
check("…e depois fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));

// mover para outra pasta de status → status enviado
const target = "Clinical Frontier/" + (space.lists.find((l) => l.id === leaf.listId)!.name) + "/3 - in progress";
fs.renameSync(abs(p1), abs(`${target}/${path.posix.basename(p1)}`));
st = await cycle();
check("mover de pasta muda o status", pushes[0]?.ch.status === "in progress" && byId(leaf.id).status.status === "in progress" &&
  Object.keys(parseFm(fs.readFileSync(abs(index[leaf.id].path), "utf8"))).join() === "clickup_id" && st.moved === 0);

// renomear arquivo → nome enviado
const p2 = index[leaf.id].path;
fs.renameSync(abs(p2), abs(path.posix.join(path.posix.dirname(p2), "Nome novo.md")));
st = await cycle();
check("renomear arquivo renomeia o card", pushes[0]?.ch.name === "Nome novo" && index[leaf.id].path.endsWith("/Nome novo.md"));

// propriedades: status de subtarefa e prioridade
const sub = plan0.notes.find((n) => !n.top && !n.isFolder)!;
const sp = index[sub.id].path;
const other = plan0.listStatuses[sub.listId].find((s) => s !== sub.task.status.status)!;
fs.writeFileSync(abs(sp), fs.readFileSync(abs(sp), "utf8")
  .replace(/^(clickup_id: .*)$/m, `$1\nstatus: ${other}\nprioridade: high`).replace(/^prioridade: (?!high).*\n/m, ""));
st = await cycle();
check("propriedades status/prioridade da subtarefa são enviadas", pushes[0]?.ch.status === other && pushes[0]?.ch.priority === "high" &&
  index[sub.id].path === sp, JSON.stringify(pushes[0]?.ch));

// mover a pasta de um card com subtarefas → status do pai; filhos acompanham
const fp = index[folderNote.id].path;
const fdir = path.posix.dirname(fp);
const dest = path.posix.join(path.posix.dirname(path.posix.dirname(fdir)), "4 - espera", path.posix.basename(fdir));
fs.renameSync(abs(fdir), abs(dest));
st = await cycle();
check("mover pasta-card muda só o status do pai", pushes.length === 1 && pushes[0].id === folderNote.id && pushes[0].ch.status === "espera" &&
  st.created === 0 && st.moved === 0, JSON.stringify(st));

// mudança remota de status → nota move; conflito de corpo
byId(leaf.id).status = { status: "complete" };
st = await cycle();
check("mudança remota de status move a nota", st.moved === 1 && index[leaf.id].path.includes("/5 - complete/"));
const cp = index[leaf.id].path;
fs.appendFileSync(abs(cp), "\nlocal antigo\n");
fs.utimesSync(abs(cp), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
Object.assign(byId(leaf.id), { markdown_description: "remoto mais novo", date_updated: String(Date.now()) });
st = await cycle();
check("conflito: remoto mais recente vence, local guardado", st.conflicts === 1 && pushes.length === 0 &&
  stripFrontmatter(fs.readFileSync(abs(cp), "utf8")) === "remoto mais novo" && fs.readdirSync(abs("_conflitos")).length === 1);
fs.appendFileSync(abs(cp), "\nlocal mais novo\n");
Object.assign(byId(leaf.id), { markdown_description: "remoto antigo", date_updated: String(Date.now() - 60000) });
st = await cycle();
check("conflito: local mais recente vence, remoto guardado", st.conflicts === 1 && pushes[0]?.ch.body?.endsWith("local mais novo") === true &&
  fs.readdirSync(abs("_conflitos")).length === 2);

// exclusão remota
const list = space.lists.find((l) => l.id === leaf.listId)!;
list.tasks = list.tasks.filter((t) => t.id !== leaf.id);
st = await cycle();
check("card excluído no ClickUp vai para a lixeira", st.trashed === 1 && !fs.existsSync(abs(cp)));
st = await cycle();
check("estado final estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));

// ---- etapa 3: criar e arquivar ----
const L = space.lists[0];
const LD = "Clinical Frontier/" + L.name;
const ord = L.statuses.slice().sort((a, b) => a.orderindex - b.orderindex).map((x) => x.status);
const st1 = ord[1];
fs.writeFileSync(abs(`${LD}/2 - ${st1}/Card novo.md`), "texto do card novo\n");
fs.writeFileSync(abs(`${LD}/2 - ${st1}/Sem título.md`), "");
st = await cycle();
const novoId = Object.keys(index).find((k) => index[k].path.endsWith("/Card novo.md"));
check("nota nova em pasta de status vira card", st.added === 1 && created[0]?.t.name === "Card novo" && created[0].t.status === st1 &&
  created[0].t.body === "texto do card novo" && !created[0].t.parent && !!novoId &&
  parseFm(fs.readFileSync(abs(`${LD}/2 - ${st1}/Card novo.md`), "utf8")).clickup_id === novoId, JSON.stringify(st));
st = await cycle();
check("…sem duplicar; nota sem nome é ignorada", quietStats(st) && created.length === 0, JSON.stringify(st));
fs.rmSync(abs(`${LD}/2 - ${st1}/Sem título.md`));

// subtarefa dentro da pasta de um card que já tem subtarefas
const par = plan0.notes.find((n) => n.isFolder && n.id !== leaf.id && index[n.id])!;
fs.writeFileSync(abs(path.posix.join(path.posix.dirname(index[par.id].path), "Sub nova.md")), "sub\n");
st = await cycle();
check("nota nova na pasta de um card vira subtarefa", st.added === 1 && created[0]?.t.parent === par.id && created[0].listId === par.listId, JSON.stringify(created[0]));

// card simples ganha subtarefa: pasta com o nome do card
fs.mkdirSync(abs(`${LD}/2 - ${st1}/Card novo`));
fs.writeFileSync(abs(`${LD}/2 - ${st1}/Card novo/Filha.md`), "filha\n");
st = await cycle();
check("pasta com o nome do card cria subtarefa e a nota do pai entra na pasta", st.added === 1 && created[0]?.t.parent === novoId &&
  st.moved === 1 && index[novoId!].path === `${LD}/2 - ${st1}/Card novo/Card novo.md`, JSON.stringify(st));

// pasta nova com nota de mesmo nome + outra nota: card com subtarefa
const gdir = `${LD}/1 - ${ord[0]}/Grupo`;
fs.mkdirSync(abs(gdir));
fs.writeFileSync(abs(`${gdir}/Grupo.md`), "pai\n");
fs.writeFileSync(abs(`${gdir}/Item.md`), "item\n");
st = await cycle();
check("pasta nova com nota de mesmo nome: card + subtarefa", st.added === 2 && created[0].t.name === "Grupo" && !created[0].t.parent &&
  created[1].t.name === "Item" && !!created[1].t.parent && st.moved === 0, JSON.stringify(created));
st = await cycle();
check("…e fica estável", quietStats(st), JSON.stringify(st));

// apagar nota → arquiva (só no 2º ciclo)
const filhaId = Object.keys(index).find((k) => index[k].path.endsWith("/Filha.md"))!;
fs.rmSync(abs(index[filhaId].path));
st = await cycle();
check("nota apagada: 1º ciclo só marca", st.archived === 0 && archived.length === 0 && st.created === 0);
st = await cycle();
check("nota apagada: 2º ciclo arquiva o card", st.archived === 1 && archived[0] === filhaId && !index[filhaId] && st.created === 0, JSON.stringify(st));
st = await cycle();
check("card que perdeu a subtarefa volta a ser nota simples", index[novoId!].path === `${LD}/2 - ${st1}/Card novo.md`, index[novoId!].path);

// apagar só a nota do pai (pasta continua) → recria, não arquiva
fs.rmSync(abs(index[par.id].path));
await cycle(); st = await cycle();
check("nota do pai apagada com a pasta no lugar é recriada", archived.length === 0 && fs.existsSync(abs(index[par.id].path)));

// apagar a pasta do card → arquiva pai e subtarefas
const goneIds = Object.keys(index).filter((k) => index[k].path.startsWith(gdir + "/"));
fs.rmSync(abs(gdir), { recursive: true });
await cycle(); st = await cycle();
check("pasta de card apagada arquiva pai e subtarefas", st.archived === 2 && goneIds.every((k) => !index[k]), JSON.stringify(st));

// muitas notas sumindo de uma vez → nada é arquivado
const stDir = Object.keys(plan0.statusDirs).map((d) => ({ d, n: Object.values(index).filter((e) => e.path.startsWith(d + "/")).length }))
  .sort((a, b) => b.n - a.n)[0];
const r3 = async () => (await syncCycle(port, fake, ROOT, [space], index, { statusColors: { "in progress": "cyan" }, maxArchive: 2 })).stats;
if (stDir.n > 2) {
  archived.length = 0;
  fs.rmSync(abs(stDir.d), { recursive: true });
  await r3(); st = await r3();
  check("sumiço em massa não arquiva e recria", archived.length === 0 && st.errors.length === 1 && st.created === stDir.n, JSON.stringify(st));
}
st = await cycle();
check("estado final estável (etapa 3)", quietStats(st), JSON.stringify(st));

// ---- subtarefas seguem o status do pai ----
const casc = async () => { pushes.length = 0; return (await syncCycle(port, fake, ROOT, [space], index, { statusColors: { "in progress": "cyan" }, cascade: true })).stats; };
const rootStatus = (t: Task): string => { const p = t.parent ? all().find((x) => x.id === t.parent) : undefined; return p ? rootStatus(p) : t.status.status; };
const off = all().filter((t) => t.status.status !== rootStatus(t)).length;
st = await casc();
check("subtarefas passam a ter o status do pai", off > 0 && st.pushed === off && all().every((t) => t.status.status === rootStatus(t)) &&
  all().every((t) => !index[t.id] || parseFm(fs.readFileSync(abs(index[t.id].path), "utf8")).status === undefined), `(${off})`);
st = await casc();
check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));
const pf = all().find((t) => all().some((k) => k.parent === t.id) && !t.parent && index[t.id])!;
const pdir = path.posix.dirname(index[pf.id].path);
const other2 = ord.find((x) => x !== pf.status.status)!;
fs.renameSync(abs(pdir), abs(`${LD}/${ord.indexOf(other2) + 1} - ${other2}/${path.posix.basename(pdir)}`));
st = await casc();
check("mover a pasta do pai muda o status das subtarefas", pf.status.status === other2 && all().every((t) => t.status.status === rootStatus(t)) && st.pushed > 1, JSON.stringify(st));
st = await casc();
check("…e fica estável de novo", quietStats(st), JSON.stringify(st));

// ---- nome pela pasta do card ----
{
  const ft = all().find((t) => !t.parent && index[t.id] && all().some((k) => k.parent === t.id) && space.lists[0].tasks.includes(t))!;
  const note0 = index[ft.id].path;
  const dir0 = path.posix.dirname(note0);
  const name0 = ft.name;
  // nota do pai arrastada sozinha para a pasta de status: não renomeia o card, a nota volta
  const stray = `${path.posix.dirname(dir0)}/${path.posix.basename(note0)}`;
  fs.renameSync(abs(note0), abs(stray));
  index[ft.id].path = stray; // como o Obsidian faz ao mover
  st = await casc();
  check("nota do pai fora da pasta não renomeia o card", ft.name === name0 && pushes.length === 0 && index[ft.id].path === note0 && fs.existsSync(abs(note0)), JSON.stringify(pushes));
  // renomear a pasta do card renomeia o card
  const dir1 = `${path.posix.dirname(dir0)}/Pasta renomeada`;
  fs.renameSync(abs(dir0), abs(dir1));
  for (const e of Object.values(index)) if (e.path.startsWith(dir0 + "/")) e.path = dir1 + e.path.slice(dir0.length);
  st = await casc();
  check("renomear a pasta do card renomeia o card", ft.name === "Pasta renomeada" && index[ft.id].path === `${dir1}/Pasta renomeada.md`, ft.name);
  st = await casc();
  check("…e fica estável", quietStats(st), JSON.stringify(st));
}

// ---- trocar de pai e de lista ----
const tops = () => all().filter((t) => !t.parent && index[t.id]);
const leafTop = tops().find((t) => !all().some((k) => k.parent === t.id) && space.lists[0].tasks.includes(t))!;
const folderTop = tops().find((t) => all().some((k) => k.parent === t.id) && space.lists[0].tasks.includes(t))!;
const fdir2 = path.posix.dirname(index[folderTop.id].path);
fs.renameSync(abs(index[leafTop.id].path), abs(`${fdir2}/${path.posix.basename(index[leafTop.id].path)}`));
st = await casc();
check("arrastar card para a pasta de outro vira subtarefa", byId(leafTop.id).parent === folderTop.id &&
  byId(leafTop.id).status.status === folderTop.status.status && st.moved === 0 && index[leafTop.id].top === false, JSON.stringify(st));
st = await casc();
check("…e fica estável", quietStats(st), JSON.stringify(st));

const otherTop = tops().find((t) => t.id !== folderTop.id && all().some((k) => k.parent === t.id) && space.lists[0].tasks.includes(t))!;
fs.renameSync(abs(index[leafTop.id].path), abs(`${path.posix.dirname(index[otherTop.id].path)}/${path.posix.basename(index[leafTop.id].path)}`));
st = await casc();
check("arrastar subtarefa para a pasta de outro card troca o pai", byId(leafTop.id).parent === otherTop.id && st.moved === 0, JSON.stringify(st));

// subtarefa solta numa pasta de status: é recriada como card solto e a antiga é arquivada
await updateFake(leafTop.id, { priority: "high" });
await casc();
const dropped = `${LD}/1 - ${ord[0]}/${path.posix.basename(index[leafTop.id].path)}`;
const bodyBefore = stripFrontmatter(fs.readFileSync(abs(index[leafTop.id].path), "utf8"));
fs.renameSync(abs(index[leafTop.id].path), abs(dropped));
created.length = 0; archived.length = 0;
st = await casc();
const conv = Object.keys(index).find((k) => index[k].path === dropped)!;
check("subtarefa solta numa pasta de status vira card solto", st.converted === 1 && created.length === 1 && !created[0].t.parent &&
  created[0].t.name === leafTop.name && created[0].t.status === ord[0] && created[0].t.priority === "high" && created[0].t.body === bodyBefore &&
  archived[0] === leafTop.id && !index[leafTop.id] && !!conv && conv !== leafTop.id && index[conv].top === true &&
  parseFm(fs.readFileSync(abs(dropped), "utf8")).clickup_id === conv && st.moved === 0 && st.created === 0 && st.trashed === 0, JSON.stringify(st));
st = await casc();
check("…e fica estável", quietStats(st), JSON.stringify(st));

// subtarefa com subtarefas próprias: as filhas vão para o card novo
const mid = all().find((t) => t.parent && index[t.id] && all().some((k) => k.parent === t.id) && space.lists[0].tasks.includes(t));
if (mid) {
  const mdir = path.posix.dirname(index[mid.id].path);
  const mkids = all().filter((k) => k.parent === mid.id);
  const mdest = `${LD}/1 - ${ord[0]}/${path.posix.basename(mdir)}`;
  fs.renameSync(abs(mdir), abs(mdest));
  created.length = 0; archived.length = 0;
  st = await casc();
  const nid = Object.keys(index).find((k) => index[k].path === `${mdest}/${path.posix.basename(mdir)}.md`)!;
  check("subtarefa com filhas vira card solto e leva as filhas", st.converted === 1 && archived[0] === mid.id && !!nid && nid !== mid.id &&
    mkids.every((k) => k.parent === nid && index[k.id].path.startsWith(mdest + "/")) && st.created === 0 && st.trashed === 0, JSON.stringify(st));
  st = await casc();
  check("…e fica estável", quietStats(st), JSON.stringify(st));
} else console.log("(sem subtarefa com filhas para testar)");

// mudança de pai feita no ClickUp não é desfeita
byId(conv).parent = folderTop.id;
st = await casc();
check("troca de pai feita no ClickUp move a nota", byId(conv).parent === folderTop.id && st.moved === 1 &&
  index[conv].path.startsWith(fdir2 + "/"), JSON.stringify(st));

// outra lista
const L2 = space.lists[1];
const ord2 = L2.statuses.slice().sort((a, b) => a.orderindex - b.orderindex).map((x) => x.status);
const kidsBefore = all().filter((t) => t.parent === otherTop.id).length;
const odir = path.posix.dirname(index[otherTop.id].path);
fs.renameSync(abs(odir), abs(`Clinical Frontier/${L2.name}/2 - ${ord2[1]}/${path.posix.basename(odir)}`));
moves.length = 0;
st = await casc();
check("mover a pasta do card para outra lista troca a lista (com subtarefas)", moves.length === 1 && moves[0].id === otherTop.id &&
  moves[0].listId === L2.id && L2.tasks.includes(otherTop) && L2.tasks.filter((t) => t.parent === otherTop.id).length === kidsBefore &&
  otherTop.status.status === ord2[1] && st.moved === 0 && st.created === 0, JSON.stringify(st));
st = await casc();
check("…e fica estável", quietStats(st) && moves.length === 1, JSON.stringify(st));

// ---- imagens coladas ou anexadas no card ----
{
  const H = "https://t1.p.clickup-attachments.com/t1";
  const inl = `${H}/11111111-2222-3333-4444-555555555555/foto%20teste.png`;
  const X = L.tasks.find((t) => !t.parent && index[t.id] && !L.tasks.some((k) => k.parent === t.id))!;
  const read = () => stripFrontmatter(fs.readFileSync(abs(index[X.id].path), "utf8"));
  X.markdown_description = `texto\n\n![foto](${inl}?authz_token=abc)\n\nfim !\\[\\[Colada.png\\]\\] e \\[\\[Nota\\]\\]`;
  X.date_updated = "5";
  const d0 = downloads.length; // o space real pode já ter imagens baixadas
  attach[X.id] = [
    { id: "a", title: "foto teste.png", url: inl + "?authz_token=zz", mimetype: "image/png" },
    { id: "b", title: "image.png", url: `${H}/aaaaaaaa-2222-3333-4444-555555555555/image.png?authz_token=zz`, mimetype: "image/png" },
    { id: "c", title: "contrato.pdf", url: `${H}/bbbbbbbb-2222-3333-4444-555555555555/contrato.pdf`, mimetype: "application/pdf" },
  ];
  st = await casc();
  check("imagem do texto, imagem anexada e documento anexado viram arquivos do cofre referenciados na nota",
    read() === "texto\n\n![[foto teste 11111111.png]]\n\nfim ![[Colada.png]] e [[Nota]]\n\n![[image aaaaaaaa.png]]\n![[contrato bbbbbbbb.pdf]]" &&
    downloads.length === d0 + 3 && downloads.includes(inl) && fs.existsSync(abs("image aaaaaaaa.png")) && fs.existsSync(abs("contrato bbbbbbbb.pdf")) && pushes.length === 0 && !st.errors.length,
    JSON.stringify(read()) + JSON.stringify(downloads));
  st = await casc();
  check("…e fica estável (nada é reenviado)", quietStats(st) && pushes.length === 0 && downloads.length === d0 + 3, JSON.stringify(st));
  fs.appendFileSync(abs(index[X.id].path), "\nlinha nova\n");
  st = await casc();
  check("edição local volta ao ClickUp com o endereço da imagem, sem a anexada",
    pushes.length === 1 && pushes[0].ch.body!.includes(`![foto teste 11111111.png](${inl})`) && !pushes[0].ch.body!.includes("aaaaaaaa") &&
    !pushes[0].ch.body!.includes("contrato") &&
    pushes[0].ch.body!.includes("![[Colada.png]]") && pushes[0].ch.body!.endsWith("linha nova") && read().includes("![[image aaaaaaaa.png]]"),
    JSON.stringify(pushes.map((p) => p.ch.body)));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));
  attach[X.id] = attach[X.id].slice(0, 1);
  X.date_updated = "9";
  st = await casc();
  check("anexo removido no card sai da nota, sem mexer no resto", !read().includes("aaaaaaaa") && !read().includes("contrato") && read().includes("![[foto teste 11111111.png]]") &&
    read().endsWith("linha nova") && pushes.length === 0, JSON.stringify(read()));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));

  // imagem colada no Obsidian → sobe para o card e entra no texto dele
  fs.writeFileSync(abs("Colada2.png"), "12345");
  fs.appendFileSync(abs(index[X.id].path), "\n![[Colada2.png]]\n\ndepois da imagem\n");
  st = await casc();
  const up = "https://t1.p.clickup-attachments.com/t1/cccccccc-2222-3333-4444-000000000001/Colada2.png";
  check("imagem colada no Obsidian sobe e entra no texto do card, no mesmo lugar",
    uploads.length === 1 && uploads[0].id === X.id && uploads[0].fileName === "Colada2.png" && uploads[0].size === 5 &&
    pushes.length === 1 && pushes[0].ch.body!.includes(`![Colada2.png](${up})\n\ndepois da imagem`) && pushes[0].ch.body!.indexOf("linha nova") < pushes[0].ch.body!.indexOf("Colada2") &&
    read().includes("![[Colada2.png]]") && st.uploaded === 1, JSON.stringify(pushes.map((p) => p.ch.body)) + JSON.stringify(uploads));
  st = await casc();
  check("…e fica estável (não reenvia a imagem)", quietStats(st) && pushes.length === 0 && uploads.length === 1 && read().includes("![[Colada2.png]]"), JSON.stringify(st));
  X.markdown_description = X.markdown_description!.replace("depois da imagem", "depois, editado no ClickUp");
  X.date_updated = "12";
  const nd = downloads.length;
  st = await casc();
  check("edição no ClickUp mantém o arquivo original do cofre (sem baixar cópia)", read().includes("![[Colada2.png]]") &&
    read().endsWith("depois, editado no ClickUp") && downloads.length === nd && uploads.length === 1 && pushes.length === 0, JSON.stringify(read()));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0 && uploads.length === 1, JSON.stringify(st));

  // documento colocado na nota no Obsidian → sobe como anexo do card; o texto do card não muda
  fs.writeFileSync(abs("Planilha.xlsx"), "1234567");
  fs.appendFileSync(abs(index[X.id].path), "\n\n![[Planilha.xlsx]]\n");
  st = await casc();
  check("documento do Obsidian sobe como anexo, sem mexer no texto do card",
    uploads.length === 2 && uploads[1].fileName === "Planilha.xlsx" && uploads[1].size === 7 && pushes.length === 0 &&
    read().endsWith("![[Planilha.xlsx]]") && st.uploaded === 1 && !st.errors.length, JSON.stringify(st) + JSON.stringify(pushes.map((p) => p.ch.body)));
  // o ClickUp passa a listar o anexo: a nota não ganha cópia nem link repetido
  attach[X.id] = [...attach[X.id], { id: "d", title: "Planilha.xlsx", url: `${H}/cccccccc-2222-3333-4444-000000000002/Planilha.xlsx?authz_token=q`, mimetype: "application/vnd.ms-excel" }];
  X.date_updated = "15";
  const nd2 = downloads.length;
  st = await casc();
  check("…e o anexo listado pelo ClickUp não duplica o arquivo nem o link",
    read().split("Planilha").length === 2 && downloads.length === nd2 && uploads.length === 2 && pushes.length === 0, JSON.stringify(read()));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0 && uploads.length === 2, JSON.stringify(st));

  // nota gravada por versão antiga: imagem ainda como endereço da web
  const Y = L.tasks.find((t) => t.id !== X.id && !t.parent && index[t.id] && !L.tasks.some((k) => k.parent === t.id))!;
  const rawY = `antes

![image.png](${H}/dddddddd-2222-3333-4444-555555555555/image.png)

depois`;
  Y.markdown_description = rawY;
  const yp = index[Y.id].path;
  const fmY = () => { const c = fs.readFileSync(abs(yp), "utf8"); return c.slice(0, c.indexOf("\n---\n", 3) + 5); };
  const wantY = "antes\n\n![[image dddddddd.png]]\n\ndepois";
  fs.writeFileSync(abs(yp), `${fmY()}\n${rawY}\n`);
  index[Y.id].lBody = index[Y.id].rBody = hash(rawY);
  delete index[Y.id].files;
  st = await casc();
  const bodyY = () => stripFrontmatter(fs.readFileSync(abs(index[Y.id].path), "utf8"));
  check("nota de versão antiga: endereço da imagem vira arquivo do cofre, sem enviar nada",
    bodyY() === wantY && fs.existsSync(abs("image dddddddd.png")) && pushes.length === 0, JSON.stringify(bodyY()));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st) + JSON.stringify(pushes));
  // mesmo caso sem índice (dados do plugin perdidos)
  delete index[Y.id];
  fs.writeFileSync(abs(yp), fs.readFileSync(abs(yp), "utf8").replace("![[image dddddddd.png]]", `![image.png](${H}/dddddddd-2222-3333-4444-555555555555/image.png)`));
  st = await casc();
  check("…e também quando o índice foi perdido", bodyY() === wantY && pushes.length === 0 && st.conflicts === 0, JSON.stringify(bodyY()));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st) + JSON.stringify(pushes));
}

// ---- status mudam no ClickUp: renomear, criar, reordenar, apagar ----
{
  const where = (st: string) => Object.keys(buildPlan(ROOT, [space]).statusDirs).find((d) => d.startsWith(LD + "/") && d.endsWith(" - " + st))!;
  const inPlace = () => L.tasks.filter((t) => !t.parent).every((t) => index[t.id].path.startsWith(where(t.status.status) + "/") && fs.existsSync(abs(index[t.id].path)));
  const n0 = L.tasks.length;
  const ren = ord[1];
  for (const x of L.statuses) if (x.status === ren) x.status = "revenue";
  for (const t of L.tasks) if (t.status.status === ren) t.status = { status: "revenue" };
  L.statuses.push({ status: "interface", color: "#ff0000", orderindex: 0.5 });
  st = await casc();
  check("status renomeado/criado no ClickUp: pastas acompanham sem enviar nada", pushes.length === 0 && st.added === 0 && st.archived === 0 &&
    st.trashed === 0 && st.created === 0 && !st.errors.length && inPlace() && fs.existsSync(abs(LD + "/2 - interface")) &&
    fs.existsSync(abs(LD + "/3 - revenue")), JSON.stringify(st));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));
  // apagar um status: o ClickUp passa os cards para outro
  const del = L.statuses.find((x) => L.tasks.some((t) => t.status.status === x.status) && x.status !== ord[0])!.status;
  L.statuses = L.statuses.filter((x) => x.status !== del);
  for (const t of L.tasks) if (t.status.status === del) t.status = { status: ord[0] };
  st = await casc();
  check("status apagado no ClickUp: cards vão para a pasta nova, nada é arquivado", pushes.length === 0 && st.archived === 0 && st.trashed === 0 &&
    st.added === 0 && !st.errors.length && inPlace() && L.tasks.length === n0, JSON.stringify(st));
  st = await casc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));
}

// ---- pasta Working: status fixos ficam à parte; lista oculta sai do cofre ----
{
  const fixed = [L.statuses[L.statuses.length - 1].status, L.statuses[0].status];
  const wopts = { statusColors: { "in progress": "cyan" }, cascade: true, working: { name: "Working", statuses: [...fixed, "nao existe"] } };
  const W = "Clinical Frontier/Working";
  const dn = (p: string) => path.posix.dirname(p);
  const only = [{ ...space, lists: [L] }];
  const pw = buildPlan(ROOT, only, wopts);
  const dirs = Object.entries(pw.statusDirs);
  check("Working: status fixos na pasta à parte, na ordem pedida; os outros na lista",
    dirs.every(([d, sd]) => dn(d) === (fixed.includes(sd.status) ? W : LD)) &&
    !!pw.statusDirs[`${W}/1 - ${fixed[0]}`] && !!pw.statusDirs[`${W}/2 - ${fixed[1]}`] && dirs.length === L.statuses.length,
    JSON.stringify(Object.keys(pw.statusDirs)));
  const wc = async () => { pushes.length = 0; archived.length = 0; return (await syncCycle(port, fake, ROOT, only, index, wopts)).stats; };
  const n2 = L2.tasks.filter((t) => index[t.id]).length;
  st = await wc();
  const inW = L.tasks.filter((t) => !t.parent && fixed.includes(t.status.status));
  check("Working: cards mudam de pasta sem enviar nada; lista oculta sai do cofre sem arquivar", pushes.length === 0 && st.archived === 0 &&
    st.added === 0 && !st.errors.length && inW.length > 0 && inW.every((t) => index[t.id].path.startsWith(W + "/")) &&
    st.trashed === n2 && n2 > 0 && L2.tasks.every((t) => !index[t.id]) && archived.length === 0, JSON.stringify(st));
  st = await wc();
  check("…e fica estável", quietStats(st) && pushes.length === 0, JSON.stringify(st));
  const mv = L.tasks.find((t) => !t.parent && !fixed.includes(t.status.status) && !L.tasks.some((k) => k.parent === t.id))!;
  const from = index[mv.id].path;
  fs.renameSync(abs(from), abs(`${W}/1 - ${fixed[0]}/${path.posix.basename(from)}`));
  st = await wc();
  check("Working: arrastar um card para lá muda o status", pushes.length === 1 && pushes[0].id === mv.id && pushes[0].ch.status === fixed[0] && st.moved === 0, JSON.stringify(pushes));
}

// ---- escrita real: card temporário ----
const realList = space.lists[0].id;
const mk = await http(`https://api.clickup.com/api/v2/list/${realList}/task`, token, "POST", { name: "_teste plugin (apagar)", markdown_content: "corpo inicial" });
const tid = mk.json?.id;
check("API real: criar card temporário", !!tid, String(mk.status));
if (tid) {
  try {
    const s2 = (await fetchSpace(http, token, spaceId, "x")).lists[0].statuses.map((s) => s.status);
    const up = await updateTask(http, token, tid, { name: "_teste plugin 2", status: s2[1], priority: "high", body: "# Título\n\n- item **negrito**\n- outro" });
    check("API real: nome, status, prioridade e corpo gravados", up.name === "_teste plugin 2" && up.status.status === s2[1] &&
      up.priority?.priority === "high" && (up.markdown_description ?? "").includes("negrito"), JSON.stringify(up.markdown_description));
    const clr = await updateTask(http, token, tid, { priority: "" });
    check("API real: limpar prioridade", !clr.priority);
    check("API real: releitura estável", (await getTask(http, token, tid)).markdown_description === clr.markdown_description);
    {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const post: RawPost = async (url, tk, contentType, body) => {
        const r = await fetch(url, { method: "POST", headers: { Authorization: tk, "Content-Type": contentType }, body: Buffer.from(body) });
        return { status: r.status, json: await r.json().catch(() => null) };
      };
      const url = await uploadAttachment(post, token, tid, "imagem ção.png", new Uint8Array(png).buffer);
      const dl = await fetch(url, { headers: { Authorization: token } });
      const got = Buffer.from(await dl.arrayBuffer());
      check("API real: enviar imagem e baixar de volta idêntica", /clickup-attachments\.com\//.test(url) && !url.includes("?") &&
        (dl.headers.get("content-type") ?? "").startsWith("image/") && got.equals(png), url.replace(/t\d+/g, "t…") + " " + got.length);
      const put = await updateTask(http, token, tid, { body: `antes\n\n![imagem](${url})\n\ndepois` });
      check("API real: imagem fica no texto do card", (put.markdown_description ?? "").includes(url), JSON.stringify(put.markdown_description).replace(/t\d+/g, "t…"));
    }
    const sub = await createTask(http, token, realList, { name: "_teste sub (apagar)", body: "- a\n- b", parent: tid, status: s2[1] });
    try {
      check("API real: criar subtarefa com corpo e status", sub.parent === tid && sub.status.status === s2[1] && (sub.markdown_description ?? "").includes("a"));
      await archiveTask(http, token, sub.id);
      const after = await fetchTasks(http, token, realList);
      check("API real: arquivar tira o card da lista", !after.some((t) => t.id === sub.id) && after.some((t) => t.id === tid));
    } finally { await http(`https://api.clickup.com/api/v2/task/${sub.id}`, token, "DELETE"); }
  } finally {
    const del = await http(`https://api.clickup.com/api/v2/task/${tid}`, token, "DELETE");
    check("API real: card temporário apagado", del.status >= 200 && del.status < 300, String(del.status));
  }
}

console.log(fails ? `\n${fails} falha(s)` : "\nTudo certo");
process.exit(fails ? 1 : 0);
