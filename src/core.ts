// Lógica pura: transforma os dados do ClickUp no "plano" de pastas e notas e
// sincroniza nos dois sentidos com um cofre (via VaultPort). Sem dependência do Obsidian.

import type { Changes, NewTask, SpaceData, Status, Task } from "./clickup";

export interface IconSpec { icon: string; color: string | null }
export interface PlanNote {
  id: string; spaceId: string; listId: string; path: string; fileName: string;
  isFolder: boolean; top: boolean; task: Task;
}
export interface Card {
  id: string; name: string; path: string; depth: number;
  list: string; status: string; color: string | null;
}
export interface Plan {
  folders: string[];
  notes: PlanNote[];
  icons: Record<string, IconSpec>;
  cards: Card[];
  statusDirs: Record<string, { listId: string; status: string }>;
  listStatuses: Record<string, string[]>;
  /** Posição de cada nota/pasta de card dentro da sua pasta, na ordem do ClickUp. */
  order: Record<string, number>;
}
export interface PlanOptions {
  statusColors?: Record<string, string>;
  /** Status fixos que ficam numa pasta à parte (ao lado das listas), na ordem informada. */
  working?: { name: string; statuses: string[] };
}

/** Último estado sincronizado de cada card. */
export interface IndexEntry {
  path: string; spaceId: string;
  listId?: string; fileName?: string; isFolder?: boolean; top?: boolean;
  name?: string; status?: string; priority?: string;
  lBody?: string; // hash do corpo local na última sincronização
  rBody?: string; // hash do corpo remoto visto por último
  parent?: string | null; // card pai no ClickUp na última sincronização
  files?: Record<string, string>; // imagens do card: nome do arquivo no cofre → endereço no ClickUp
  att?: string[]; // imagens anexadas ao card (fora do texto), mostradas no fim da nota
  updated?: string; // date_updated do card quando os anexos foram conferidos
  gone?: boolean; // nota sumiu no ciclo anterior (arquiva o card se continuar sumida)
}
export type Index = Record<string, IndexEntry>;

export interface VaultPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  isEmptyDir(path: string): Promise<boolean>;
  rmdir(path: string): Promise<void>;
  mtime(path: string): Promise<number>;
  /** Procura a nota de um card pelo clickup_id (para quando foi movida/renomeada). */
  findById(id: string): Promise<string | null>;
  /** Todas as notas .md dentro da pasta (com subpastas). */
  list(dir: string): Promise<string[]>;
  /** Garante que a imagem existe no cofre (baixa se faltar). */
  image?(name: string, url: string, notePath: string): Promise<void>;
  /** Conteúdo de uma imagem do cofre referenciada pela nota (null se não existir). */
  readImage?(name: string, notePath: string): Promise<ArrayBuffer | null>;
}
export interface Api {
  update(id: string, changes: Changes): Promise<Task>;
  create(listId: string, task: NewTask): Promise<Task>;
  archive(id: string): Promise<void>;
  /** Move o card (com as subtarefas) para outra lista. */
  move(id: string, listId: string): Promise<void>;
  /** Lê o card completo (com anexos). */
  get(id: string): Promise<Task>;
  /** Anexa uma imagem ao card e devolve o endereço dela. */
  upload?(id: string, fileName: string, data: ArrayBuffer): Promise<string>;
}

export const CONFLICT_DIR = "_conflitos";
export const ICON_TASK = "lucide-bookmark-check";
export const ICON_TASK_FOLDER = "lucide-layout-list";
export const ICON_STATUS = "lucide-folder";
const PRIORITIES = ["", "urgent", "high", "normal", "low"];

export function sanitize(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return s || "sem nome";
}

export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ":" + s.length;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const dirname = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
// endereço de anexo sem o token temporário; [[links]] e ![[imagens]] do Obsidian sem as barras que o ClickUp acrescenta
const remoteBody = (t: Task) => norm(t.markdown_description ?? "")
  .replace(/(https:\/\/[\w.-]+\.clickup-attachments\.com\/[^\s)?]+)\?[^\s)]*/g, "$1")
  .replace(/\\\[\\\[([^\n\]]+?)\\\]\\\]/g, "[[$1]]")
  .trim();

// ---- imagens: no ClickUp ficam como endereço; na nota, como arquivo do cofre (![[nome.png]]) ----
interface Imgs { files: Record<string, string>; att: string[] }
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const IMG_MD = /!\[[^\]\n]*\]\((https:\/\/[\w.-]+\.clickup-attachments\.com\/[^\s)?]+)\)/g;
const EMBED = /!\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g;
const uuidOf = (url: string) => (/\/([0-9a-f]{8}-[0-9a-f-]{27})\//i.exec(url) ?? [])[1] ?? "";
export function imageName(url: string, title?: string): string {
  let raw = title ?? "";
  if (!raw) { try { raw = decodeURIComponent(basename(url)); } catch { raw = basename(url); } }
  const m = /\.[A-Za-z0-9]+$/.exec(raw);
  const id = uuidOf(url).slice(0, 8) || hash(url).split(":")[0];
  return `${sanitize(m ? raw.slice(0, -m[0].length) : raw)} ${id}${(m ? m[0] : ".png").toLowerCase()}`;
}
const imgsOf = (e?: IndexEntry): Imgs | undefined => (e && (e.files || e.att) ? { files: e.files ?? {}, att: e.att ?? [] } : undefined);
/** Texto do ClickUp → texto da nota (registra em im.files as imagens encontradas). */
function toLocal(body: string, im: Imgs): string {
  const out = body.replace(IMG_MD, (m, url: string) => {
    if (!IMG_EXT.test(url)) return m;
    const n = Object.keys(im.files).find((k) => im.files[k] === url) ?? imageName(url);
    im.files[n] = url;
    return `![[${n}]]`;
  });
  const extra = im.att.filter((n) => !out.includes(`![[${n}`)).map((n) => `![[${n}]]`);
  return extra.length ? (out ? out + "\n\n" : "") + extra.join("\n") : out;
}
/** Texto da nota → texto do ClickUp: imagens do texto voltam a ser endereço; as anexadas saem (já estão no card). */
function toRemote(body: string, im?: Imgs): string {
  if (!im) return body;
  return body
    .replace(EMBED, (m, n: string) => (im.att.includes(n) ? "\u0000" : im.files[n] ? `![${n}](${im.files[n]})` : m))
    .replace(/\n?[ \t]*\u0000[ \t]*/g, "").trim();
}
const prio = (t: Task) => t.priority?.priority ?? "";

// ---- frontmatter ----
const FM = /^---\n([\s\S]*?)\n---\n?/;

export function stripFrontmatter(content: string): string {
  return norm(content).replace(FM, "").trim();
}

export function parseFm(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = FM.exec(norm(content));
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* mantém cru */ } }
    else if (v.startsWith("'") && v.endsWith("'") && v.length > 1) v = v.slice(1, -1).replace(/''/g, "'");
    out[mm[1]] = v;
  }
  return out;
}

/** Define/remove chaves do frontmatter, preservando as demais linhas e o corpo. */
export function setFm(content: string, fields: [string, string | null][]): string {
  content = norm(content);
  const m = FM.exec(content);
  const lines = m ? m[1].split("\n") : [];
  const rest = m ? content.slice(m[0].length) : content;
  for (const [key, value] of fields) {
    const i = lines.findIndex((l) => l.startsWith(key + ":"));
    if (value === null) { if (i >= 0) lines.splice(i, 1); continue; }
    const line = `${key}: ${JSON.stringify(value)}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  return `---\n${lines.join("\n")}\n---\n${rest}`;
}

const fields = (t: Task): [string, string | null][] => [
  // só o necessário: clickup_id liga a nota ao card; status e url eram apenas informativos
  ["clickup_id", t.id], ["status", null], ["prioridade", prio(t) || null], ["url", null],
];
function fmMatches(local: string, t: Task): boolean {
  const f = parseFm(local);
  return f.clickup_id === t.id && f.status === undefined && (f.prioridade ?? "") === prio(t) && f.url === undefined;
}
/** Conteúdo da nota: frontmatter do card + corpo (remoto, se informado; senão mantém o local). */
function compose(local: string | null, t: Task, body: string | null): string {
  if (local !== null && body === null) return fmMatches(local, t) ? norm(local) : setFm(local, fields(t));
  const fmOnly = local ? FM.exec(norm(local))?.[0] ?? "" : "";
  return setFm(fmOnly, fields(t)) + (body ? `\n${body}\n` : "");
}
export const render = (t: Task) => compose(null, t, remoteBody(t));

// ---- plano ----
function unique(used: Set<string>, base: string): string {
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return name;
}

export function buildPlan(root: string, spaces: SpaceData[], opts: PlanOptions = {}): Plan {
  const folders = new Set<string>();
  if (root) folders.add(root);
  const plan: Plan = { folders: [], notes: [], icons: {}, cards: [], statusDirs: {}, listStatuses: {}, order: {} };
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.statusColors ?? {})) overrides[k.trim().toLowerCase()] = v;
  const usedByDir = new Map<string, Set<string>>();
  const usedIn = (dir: string) => {
    let s = usedByDir.get(dir);
    if (!s) usedByDir.set(dir, (s = new Set()));
    return s;
  };
  const addDir = (parent: string, name: string) => {
    const p = join(parent, unique(usedIn(parent), sanitize(name)));
    folders.add(p);
    return p;
  };
  const byAge = (a: Task, b: Task) =>
    Number(a.date_created ?? 0) - Number(b.date_created ?? 0) || a.id.localeCompare(b.id);

  const wset = (opts.working?.statuses ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const wpos = (x: Status) => wset.indexOf(x.status.toLowerCase());
  for (const space of spaces) {
    const spaceDir = addDir(root, space.name);
    let workDir: string | undefined;
    const folderDirs = new Map<string, string>();
    for (const list of space.lists) {
      let parent = spaceDir;
      if (list.folderName) {
        if (!folderDirs.has(list.folderName)) folderDirs.set(list.folderName, addDir(spaceDir, list.folderName));
        parent = folderDirs.get(list.folderName)!;
      }
      const listDir = addDir(parent, list.name);

      const statuses = [...list.statuses].sort((a, b) => a.orderindex - b.orderindex);
      plan.listStatuses[list.id] = statuses.map((s) => s.status);
      const statusDir = new Map<string, string>();
      const statusColor = new Map<string, string | null>();
      const addStatus = (parentDir: string) => (s: Status, i: number) => {
        const dir = addDir(parentDir, `${i + 1} - ${s.status}`);
        plan.order[dir] = i;
        const color = overrides[s.status.toLowerCase()] ?? s.color ?? null;
        statusDir.set(s.status, dir);
        statusColor.set(s.status, color);
        plan.statusDirs[dir] = { listId: list.id, status: s.status };
        plan.icons[dir] = { icon: ICON_STATUS, color };
      };
      statuses.filter((x) => wpos(x) < 0).forEach(addStatus(listDir));
      const work = statuses.filter((x) => wpos(x) >= 0).sort((a, b) => wpos(a) - wpos(b));
      if (work.length) {
        work.forEach(addStatus(workDir ??= addDir(spaceDir, opts.working!.name)));
        plan.order[workDir] = -1; // a pasta de trabalho aparece antes das listas
      }

      const ids = new Set(list.tasks.map((t) => t.id));
      const children = new Map<string, Task[]>();
      const tops: Task[] = [];
      for (const t of list.tasks) {
        if (t.parent && ids.has(t.parent)) {
          if (!children.has(t.parent)) children.set(t.parent, []);
          children.get(t.parent)!.push(t);
        } else tops.push(t);
      }

      const place = (t: Task, dir: string, depth: number, inherited?: string | null) => {
        const name = unique(usedIn(dir), sanitize(t.name));
        // subtarefa usa sempre a cor do card pai
        const color = inherited !== undefined ? inherited
          : statusColor.get(t.status.status) ?? overrides[t.status.status.toLowerCase()] ?? t.status.color ?? null;
        const kids = (children.get(t.id) ?? []).sort(byAge);
        let path: string;
        if (kids.length) {
          const folder = `${dir}/${name}`;
          folders.add(folder);
          usedIn(folder).add(name.toLowerCase()); // reserva o nome da nota do pai
          path = `${folder}/${name}.md`;
          plan.icons[folder] = { icon: ICON_TASK_FOLDER, color };
        } else path = `${dir}/${name}.md`;
        plan.icons[path] = { icon: ICON_TASK, color };
        const oi = Number(t.orderindex);
        const pos = Number.isFinite(oi) ? oi : Number(t.date_created ?? 0);
        if (kids.length) { plan.order[dirname(path)] = pos; plan.order[path] = -1; } // nota do pai no topo da pasta dele
        else plan.order[path] = pos;
        plan.notes.push({
          id: t.id, spaceId: space.id, listId: list.id, path, fileName: name,
          isFolder: kids.length > 0, top: depth === 0, task: t,
        });
        plan.cards.push({ id: t.id, name: t.name, path, depth, list: list.name, status: t.status.status, color });
        for (const k of kids) place(k, dirname(path), depth + 1, color);
      };

      for (const s of statuses)
        for (const t of tops.filter((t) => t.status.status === s.status).sort(byAge))
          place(t, statusDir.get(s.status)!, 0);
      // cards cujo status não existe na lista (não deveria ocorrer)
      for (const t of tops.filter((t) => !statusDir.has(t.status.status)).sort(byAge)) place(t, listDir, 0);
    }
  }
  plan.folders = [...folders].sort((a, b) => a.length - b.length);
  return plan;
}

// ---- sincronização ----
export interface Stats {
  created: number; updated: number; moved: number; trashed: number;
  conflicts: number; keptLocal: number; pushed: number; errors: string[];
  added: number; // cards criados no ClickUp a partir de notas novas
  archived: number; // cards arquivados porque a nota foi apagada
  converted: number; // subtarefas recriadas como card solto
  checked: number; // cards cujos anexos foram conferidos
  uploaded: number; // imagens do cofre enviadas ao ClickUp
}
export interface SyncOptions extends PlanOptions {
  /** Não envia nem sobrescreve notas alteradas há menos que isto (usuário ainda digitando). */
  quietMs?: number;
  /** false = só ClickUp → Obsidian. */
  push?: boolean;
  /** Espera antes de transformar uma nota nova em card (tempo de dar o nome). */
  createQuietMs?: number;
  /** Acima disto, notas sumidas de uma vez são tratadas como acidente e recriadas. */
  maxArchive?: number;
  /** Subtarefas ficam sempre com o mesmo status do card pai. */
  cascade?: boolean;
  /** Quantos cards alterados têm os anexos conferidos por ciclo (cada um é uma consulta ao ClickUp). */
  maxChecks?: number;
}
const DEFAULT_NAME = /^(sem t[ií]tulo|untitled)/i;

export async function syncCycle(
  port: VaultPort, api: Api, root: string, spaces: SpaceData[], index: Index, opts: SyncOptions = {},
): Promise<{ plan: Plan; stats: Stats }> {
  const st: Stats = { created: 0, updated: 0, moved: 0, trashed: 0, conflicts: 0, keptLocal: 0, pushed: 0, errors: [], added: 0, archived: 0, converted: 0, checked: 0, uploaded: 0 };
  const quiet = opts.quietMs ?? 0;
  const busy = new Set<string>();

  const saveConflict = async (path: string, content: string, who: string) => {
    const dir = join(root, CONFLICT_DIR);
    if (!(await port.exists(dir))) await port.mkdir(dir);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    await port.write(`${dir}/${basename(path).replace(/\.md$/, "")} (${who} ${stamp}).md`, content);
    st.conflicts++;
  };

  // ---- Fase A: alterações locais → ClickUp ----
  let plan = buildPlan(root, spaces, opts);
  const gone: PlanNote[] = [];
  // onde cada card está agora: pasta → card dono dela (para detectar troca de pai)
  const dirOf = new Map<string, PlanNote>();
  const taskById = new Map<string, Task>();
  for (const n of plan.notes) {
    taskById.set(n.id, n.task);
    const e = index[n.id];
    if (!e || e.rBody === undefined) continue;
    const p = (await port.exists(e.path)) ? e.path : await port.findById(n.id);
    if (!p) continue;
    const b = basename(p).replace(/\.md$/, "");
    dirOf.set(b === basename(dirname(p)) ? dirname(p) : p.replace(/\.md$/, ""), n);
  }
  const isUnder = (id: string, ancestor: string) => {
    for (let t = taskById.get(id), i = 0; t && i < 50; t = t.parent ? taskById.get(t.parent) : undefined, i++)
      if (t.id === ancestor) return true;
    return false;
  };
  const moveLists = (id: string, to: string) => {
    for (const s of spaces) for (const l of s.lists) {
      if (l.id === to) continue;
      const out = l.tasks.filter((t) => isUnder(t.id, id));
      if (!out.length) continue;
      l.tasks = l.tasks.filter((t) => !out.includes(t));
      for (const s2 of spaces) for (const l2 of s2.lists) if (l2.id === to) l2.tasks.push(...out);
    }
  };
  for (const n of plan.notes) {
    const e = index[n.id];
    if (!e || e.rBody === undefined) continue; // ainda sem base de comparação
    const t = n.task;
    const oldPath = e.path;
    let path: string | null = oldPath;
    if (!(await port.exists(oldPath))) path = await port.findById(n.id);
    if (!path) {
      // nota apagada: arquiva o card se continuar sumida no ciclo seguinte.
      // Se só a nota de um card com subtarefas sumiu (a pasta continua), ela é recriada.
      if (opts.push === false || (e.isFolder && (await port.exists(dirname(oldPath))))) { delete e.gone; continue; }
      busy.add(n.id);
      if (e.gone) gone.push(n); else e.gone = true;
      continue;
    }
    delete e.gone;
    e.path = path;

    if (quiet && Date.now() - (await port.mtime(path)) < quiet) { busy.add(n.id); continue; }
    if (opts.push === false) continue;

    const local = norm(await port.read(path));
    const fm = parseFm(local);
    const ch: Changes = {};

    // nome: arquivo renomeado (ou a pasta, no caso de card com subtarefas)
    const base = basename(path).replace(/\.md$/, "");
    let localName = base;
    if (e.isFolder && base === e.fileName) {
      // a pasta só dá nome ao card se for mesmo a pasta dele: não uma pasta de status nem a de outro card
      const folder = dirname(path);
      const folderName = basename(folder);
      const ownDir = !plan.statusDirs[folder] && !dirOf.has(folder) &&
        (!!plan.statusDirs[dirname(folder)] || dirOf.has(dirname(folder)));
      if (folderName !== e.fileName && ownDir) localName = folderName;
    }
    if (localName !== e.fileName && t.name === e.name) ch.name = localName;

    // status: pasta onde o card de 1º nível está; senão, a propriedade "status"
    // lugar: dentro da pasta de outro card (troca de pai) ou numa pasta de status de outra lista
    const loc = base === basename(dirname(path)) ? dirname(dirname(path)) : dirname(path);
    const locSd = plan.statusDirs[loc];
    const locCard = locSd ? undefined : dirOf.get(loc);
    let reparent: PlanNote | undefined;
    let relist: string | undefined;
    if (e.parent !== undefined && (t.parent ?? null) === e.parent && e.listId === n.listId) {
      if (locCard && locCard.id !== n.id && locCard.id !== (e.top ? null : t.parent) && !isUnder(locCard.id, n.id)) {
        reparent = locCard;
        if (locCard.listId !== e.listId) relist = locCard.listId;
      } else if (locSd && !e.top) {
        // O ClickUp não transforma subtarefa em card solto: cria um card novo com os mesmos dados,
        // passa as subtarefas dela para o novo e arquiva a antiga.
        const kids = [...taskById.values()].filter((k) => k.parent === n.id);
        if (kids.length && locSd.listId !== e.listId) {
          st.errors.push(`${t.name}: tem subtarefas; solte primeiro numa pasta de status da mesma lista`);
          continue;
        }
        try {
          const body = toRemote(stripFrontmatter(local), imgsOf(e));
          const fresh = await api.create(locSd.listId, { name: t.name, body, status: locSd.status, priority: prio(t) || undefined });
          for (const k of kids) Object.assign(k, await api.update(k.id, { parent: fresh.id }));
          await api.archive(n.id);
          await port.write(path, setFm(local, fields(fresh)));
          for (const s of spaces) for (const l of s.lists) {
            l.tasks = l.tasks.filter((x) => x.id !== n.id);
            if (l.id === locSd.listId) l.tasks.push(fresh);
          }
          taskById.delete(n.id);
          taskById.set(fresh.id, fresh);
          delete index[n.id];
          index[fresh.id] = {
            path, spaceId: e.spaceId, listId: locSd.listId, fileName: base, isFolder: kids.length > 0, top: true,
            name: fresh.name, status: fresh.status.status, priority: prio(fresh),
            lBody: hash(body), rBody: hash(remoteBody(fresh)), parent: null, files: e.files,
          };
          st.converted++;
        } catch (err: any) { st.errors.push(`${t.name}: ${err?.message ?? err}`); busy.add(n.id); }
        continue;
      } else if (locSd && locSd.listId !== e.listId) relist = locSd.listId;
    }
    if (relist) {
      try {
        await api.move(n.id, relist);
        moveLists(n.id, relist);
        e.listId = relist;
        st.pushed++;
      } catch (err: any) {
        st.errors.push(`${t.name}: ${err?.message ?? err}`);
        busy.add(n.id);
        continue;
      }
    }
    if (reparent) ch.parent = reparent.id;

    const valid = plan.listStatuses[e.listId ?? ""] ?? [];
    let localStatus: string | undefined;
    if (e.top && !reparent) {
      const sd = locSd ?? plan.statusDirs[dirname(path)] ?? plan.statusDirs[dirname(dirname(path))];
      if (sd && sd.listId === e.listId && sd.status !== e.status) localStatus = sd.status;
    }
    if (!localStatus && !reparent && !(opts.cascade && !e.top) && fm.status && fm.status !== e.status && valid.includes(fm.status)) localStatus = fm.status;
    if (localStatus && t.status.status === e.status) ch.status = localStatus;

    // prioridade: propriedade "prioridade"
    const lp = fm.prioridade ?? "";
    if (lp !== e.priority && PRIORITIES.includes(lp) && prio(t) === e.priority) ch.priority = lp;

    // corpo
    // imagens coladas no Obsidian: sobem para o card e entram no texto dele pelo endereço
    if (port.readImage && api.upload) {
      for (const m of stripFrontmatter(local).matchAll(EMBED)) {
        const name = m[1].trim();
        if (!IMG_EXT.test(name) || e.files?.[name] || e.att?.includes(name)) continue;
        try {
          const data = await port.readImage(name, path);
          if (!data) continue;
          (e.files ??= {})[name] = await api.upload(n.id, basename(name), data);
          st.uploaded++;
        } catch (err: any) { st.errors.push(`${t.name}: imagem ${name} — ${err?.message ?? err}`); }
      }
    }
    const lbody = toRemote(stripFrontmatter(local), imgsOf(e));
    const lh = hash(lbody);
    const rh = hash(remoteBody(t));
    const localChanged = lh !== e.lBody;
    const remoteChanged = rh !== e.rBody;
    if (localChanged && lh !== rh) {
      if (!remoteChanged) ch.body = lbody;
      else if ((await port.mtime(path)) > Number(t.date_updated ?? 0)) {
        // conflito: o local é mais recente; guarda a versão do ClickUp
        await saveConflict(path, remoteBody(t), "ClickUp");
        ch.body = lbody;
      } // senão o remoto vence na fase B (que guarda a versão local)
    }

    if (!Object.keys(ch).length) continue;
    try {
      const fresh = await api.update(n.id, ch);
      Object.assign(t, fresh);
      e.name = t.name; e.status = t.status.status; e.priority = prio(t);
      if (ch.body !== undefined) { e.lBody = lh; e.rBody = hash(remoteBody(t)); }
      st.pushed++;
    } catch (err: any) {
      st.errors.push(`${t.name}: ${err?.message ?? err}`);
      busy.add(n.id); // não sobrescreve a edição local que falhou ao enviar
    }
  }
  // notas apagadas → arquiva os cards
  if (gone.length > (opts.maxArchive ?? 10)) {
    st.errors.push(`${gone.length} notas sumiram de uma vez; nenhum card foi arquivado e elas serão recriadas`);
    for (const n of gone) { busy.delete(n.id); delete index[n.id].gone; }
  } else for (const n of gone) {
    try {
      await api.archive(n.id);
      for (const s of spaces) for (const l of s.lists) l.tasks = l.tasks.filter((t) => t.id !== n.id);
      delete index[n.id];
      st.archived++;
    } catch (err: any) { st.errors.push(`${n.task.name}: ${err?.message ?? err}`); }
  }

  // notas novas (sem clickup_id) dentro das listas → cria os cards
  if (opts.push !== false) {
    const known = new Set(Object.values(index).map((e) => e.path));
    const cardAt = new Map<string, { id: string; listId: string }>(); // pasta → card dono dela
    for (const n of plan.notes) {
      const e = index[n.id];
      if (!e) continue;
      cardAt.set(e.isFolder ? dirname(e.path) : e.path.replace(/.md$/, ""), { id: n.id, listId: n.listId });
    }
    const spaceOf = new Map<string, string>();
    for (const s of spaces) for (const l of s.lists) spaceOf.set(l.id, s.id);
    const depth = (p: string) => p.split("/").length;
    const own = (p: string) => basename(p).replace(/.md$/, "") === basename(dirname(p)); // nota com o nome da pasta
    const listDirs = [...new Set(Object.keys(plan.statusDirs).map(dirname))];
    const files: string[] = [];
    for (const d of listDirs) if (await port.exists(d)) files.push(...(await port.list(d)));
    files.sort((a, b) => depth(a) - depth(b) || Number(own(b)) - Number(own(a)) || a.localeCompare(b));
    for (const f of files) {
      if (known.has(f)) continue;
      const name = basename(f).replace(/.md$/, "");
      if (DEFAULT_NAME.test(name)) continue;
      if (opts.createQuietMs && Date.now() - (await port.mtime(f)) < opts.createQuietMs) continue;
      const local = norm(await port.read(f));
      const fm = parseFm(local);
      if (fm.clickup_id) continue;
      // onde a nota está: pasta de status (card), pasta de um card (subtarefa),
      // ou pasta nova com o mesmo nome da nota (card que vai ter subtarefas)
      let dir = dirname(f);
      if (own(f) && !plan.statusDirs[dir] && !cardAt.has(dir)) dir = dirname(dir);
      const sd = plan.statusDirs[dir];
      const parent = sd ? undefined : cardAt.get(dir);
      if (!sd && !parent) continue;
      const listId = sd ? sd.listId : parent!.listId;
      const valid = plan.listStatuses[listId] ?? [];
      const status = sd ? sd.status : fm.status && valid.includes(fm.status) ? fm.status : undefined;
      const body = stripFrontmatter(local);
      try {
        const t = await api.create(listId, { name, body, status, parent: parent?.id });
        await port.write(f, setFm(local, fields(t)));
        for (const s of spaces) for (const l of s.lists) if (l.id === listId) l.tasks.push(t);
        index[t.id] = {
          path: f, spaceId: spaceOf.get(listId)!, listId, fileName: name, isFolder: false, top: !parent,
          name: t.name, status: t.status.status, priority: prio(t), lBody: hash(body), rBody: hash(remoteBody(t)),
        };
        known.add(f);
        cardAt.set(dir === dirname(f) ? f.replace(/.md$/, "") : dirname(f), { id: t.id, listId });
        st.added++;
      } catch (err: any) { st.errors.push(`${name}: ${err?.message ?? err}`); }
    }
  }
  // subtarefas seguem o status do card pai
  if (opts.push !== false && opts.cascade) {
    for (const s of spaces) for (const l of s.lists) {
      const map = new Map(l.tasks.map((t) => [t.id, t] as const));
      const want = (t: Task): string => { const p = t.parent ? map.get(t.parent) : undefined; return p ? want(p) : t.status.status; };
      for (const t of l.tasks) {
        const w = want(t);
        if (t.status.status === w) continue;
        try {
          Object.assign(t, await api.update(t.id, { status: w }));
          if (index[t.id]) index[t.id].status = t.status.status;
          st.pushed++;
        } catch (err: any) { st.errors.push(`${t.name}: ${err?.message ?? err}`); }
      }
    }
  }
  if (st.pushed || st.added || st.archived || st.converted) plan = buildPlan(root, spaces, opts);

  // ---- Fase B: ClickUp → cofre ----
  const touchedDirs = new Set<string>();
  let checks = opts.maxChecks ?? 8;
  const planFolders = new Set(plan.folders);
  // pastas de cards apagadas (aguardando confirmação para arquivar) não são recriadas
  const goneDirs = plan.notes.filter((n) => n.isFolder && busy.has(n.id) && index[n.id]?.gone).map((n) => dirname(n.path));
  for (const f of plan.folders) {
    if (goneDirs.some((d) => f === d || f.startsWith(d + "/"))) continue;
    if (!(await port.exists(f))) await port.mkdir(f);
  }

  for (const n of plan.notes) {
    if (busy.has(n.id)) continue;
    const t = n.task;
    const e = index[n.id];

    if (e && e.path !== n.path && (await port.exists(e.path))) {
      if (await port.exists(n.path)) continue; // destino ocupado; tenta no próximo ciclo
      await port.rename(e.path, n.path);
      touchedDirs.add(dirname(e.path));
      st.moved++;
    }

    const rbody = remoteBody(t);
    const rh = hash(rbody);
    let lBody = rh;
    // imagens: as do texto vêm no próprio corpo; as anexadas só aparecem lendo o card (quando ele mudou)
    const old = imgsOf(e);
    const im: Imgs = { files: { ...(old?.files ?? {}) }, att: [...(old?.att ?? [])] };
    let updated = e?.updated;
    if (updated !== t.date_updated && checks > 0) {
      checks--;
      try {
        const full = await api.get(n.id);
        im.att = [];
        for (const a of full.attachments ?? []) {
          const url = (a.url ?? "").split("?")[0];
          const id = uuidOf(url);
          if (!url || !(IMG_EXT.test(a.title ?? url) || (a.mimetype ?? "").startsWith("image/"))) continue;
          if (id && rbody.includes(id)) continue; // já está no texto
          const name = imageName(url, a.title);
          im.files[name] = url;
          im.att.push(name);
        }
        updated = t.date_updated;
        st.checked++;
      } catch (err: any) { st.errors.push(`${t.name}: anexos — ${err?.message ?? err}`); }
    }
    const rlocal = toLocal(rbody, im);
    let finalBody: string;
    if (!(await port.exists(n.path))) {
      await port.write(n.path, compose(null, t, rlocal));
      lBody = hash(toRemote(rlocal, im));
      finalBody = rlocal;
      st.created++;
    } else {
      const local = norm(await port.read(n.path));
      const lraw = stripFrontmatter(local);
      const lbody = toRemote(lraw, old);
      const lh = hash(lbody);
      const baseL = e ? e.lBody ?? rh : undefined; // entrada antiga (sem base): assume o remoto
      const baseR = e ? e.rBody ?? rh : undefined;
      const localChanged = lh !== baseL;
      const remoteChanged = rh !== baseR;
      let useRemote = false;
      if (lh !== rh) {
        if (remoteChanged) {
          if (localChanged) await saveConflict(n.path, local, "Obsidian");
          useRemote = true;
        } else if (localChanged) { st.keptLocal++; lBody = baseL!; } // pendente de envio
        else lBody = lh; // em sincronia, só a formatação difere
      }
      let body: string | null = null;
      if (useRemote) { body = rlocal; lBody = hash(toRemote(rlocal, im)); }
      else {
        // anexo novo ou removido no card, sem mudança no texto: só acrescenta/retira a linha da imagem
        const add = im.att.filter((x) => !(old?.att ?? []).includes(x) && !lraw.includes(`![[${x}`));
        const del = (old?.att ?? []).filter((x) => !im.att.includes(x));
        if (add.length || del.length) {
          const drop = new Set(del);
          let nb = lraw.replace(EMBED, (m, x: string) => (drop.has(x) ? "\u0000" : m)).replace(/\n?[ \t]*\u0000[ \t]*/g, "").trim();
          if (add.length) nb = (nb ? nb + "\n\n" : "") + add.map((x) => `![[${x}]]`).join("\n");
          body = nb;
        }
      }
      // nota gravada por versão antiga (imagem ainda como endereço da web): passa a usar o arquivo do cofre
      const base = body ?? lraw;
      const conv = toLocal(base, im);
      if (conv !== base) {
        body = conv;
        const pending = localChanged && lh !== rh && !remoteChanged; // edição local ainda não enviada
        if (!pending) lBody = hash(toRemote(conv, im));
      }
      finalBody = body ?? lraw;
      const next = compose(local, t, body);
      if (next !== local) { await port.write(n.path, next); st.updated++; }
    }
    // guarda só as imagens que a nota usa e baixa as que faltam no cofre
    const files: Record<string, string> = {};
    for (const [name, url] of Object.entries(im.files)) {
      if (!im.att.includes(name) && !finalBody.includes(`![[${name}`)) continue;
      files[name] = url;
      if (port.image) try { await port.image(name, url, n.path); } catch (err: any) { st.errors.push(`${t.name}: imagem ${name} — ${err?.message ?? err}`); }
    }
    index[n.id] = {
      path: n.path, spaceId: n.spaceId, listId: n.listId, fileName: n.fileName, isFolder: n.isFolder, top: n.top,
      name: t.name, status: t.status.status, priority: prio(t), lBody, rBody: rh, parent: t.parent ?? null,
      ...(Object.keys(files).length ? { files } : {}), ...(im.att.length ? { att: im.att } : {}), ...(updated ? { updated } : {}),
    };
  }

  const alive = new Set(plan.notes.map((n) => n.id));
  const synced = new Set(spaces.map((s) => s.id));
  for (const id of Object.keys(index)) {
    const e = index[id];
    if (alive.has(id) || !synced.has(e.spaceId)) continue;
    if (await port.exists(e.path)) {
      await port.trash(e.path);
      touchedDirs.add(dirname(e.path));
      st.trashed++;
    }
    delete index[id];
  }

  // remove pastas que ficaram vazias e não fazem mais parte do plano
  const candidates = new Set<string>();
  for (let d of touchedDirs)
    for (; d && (!root || d.startsWith(root + "/")); d = dirname(d)) candidates.add(d);
  for (const d of [...candidates].sort((a, b) => b.length - a.length))
    if (!planFolders.has(d) && (await port.exists(d)) && (await port.isEmptyDir(d))) await port.rmdir(d);

  return { plan, stats: st };
}
