import {
  App, ItemView, Menu, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder,
  WorkspaceLeaf, normalizePath, requestUrl,
} from "obsidian";
import {
  archiveTask, createTask, moveTask, getTask, uploadAttachment, fetchSpace, fetchStructure, fetchTasks, fetchTeamsAndSpaces, updateTask, type Http, type SpaceData,
} from "./clickup";
import {
  isImage, sanitize, stripFrontmatter, syncCycle, type Api, type Card, type ConflictNote, type Index, type Plan, type VaultPort,
} from "./core";

interface SpaceRef { teamId: string; id: string; name: string }
interface Settings {
  token: string; // usado só se o cofre de segredos do Obsidian não existir
  root: string;
  intervalSec: number;
  separator: string;
  includeTitle: boolean;
  spaces: SpaceRef[];
  statusColors: Record<string, string>; // status → cor (nome do Iconic ou #hex); substitui a cor do ClickUp
  push: boolean; // enviar alterações do Obsidian ao ClickUp
  cascade: boolean; // subtarefas seguem o status do pai
  clickupOrder: boolean; // notas na ordem manual do ClickUp
  hiddenLists: string[]; // listas do ClickUp que não aparecem no Obsidian
  workingName: string; // pasta à parte para os status fixos
  workingStatuses: string[];
  hideProps: boolean; // esconder o bloco de propriedades nas notas espelhadas
  statusTitles: boolean; // mostrar pastas de status como no ClickUp (MAIÚSCULAS, sem número)
}
interface Data { version: number; settings: Settings; index: Index; iconPaths: string[]; appliedRoot: string; log?: string[] }

const VERSION = 4;
const STRUCTURE_TTL = 30 * 1000; // status criados, apagados, renomeados ou reordenados aparecem em até 30 s
const QUIET_MS = 2000;
const CREATE_QUIET_MS = 5000;
const EMPTY_GRACE_MS = 10 * 60 * 1000;

/** Pasta do cofre para os arquivos dos cards. */
const attachDir = (name: string) => (isImage(name) ? "anexos/imagens" : "anexos/documentos");

const DEFAULTS: Settings = {
  token: "", root: "", intervalSec: 5, separator: "----------", includeTitle: false, spaces: [],
  statusColors: { "in progress": "cyan", espera: "orange", complete: "#a3e635" },
  push: true,
  cascade: true,
  statusTitles: true,
  clickupOrder: true,
  hiddenLists: ["Administração"],
  workingName: "Working",
  workingStatuses: ["to do", "in progress", "complete", "archive"],
  hideProps: true,
};
const SECRET_ID = "clickup-token";
const VIEW = "clickup-espelho-copiar";

const http: Http = async (url, token, method = "GET", body) => {
  const r = await requestUrl({
    url, method, throw: false,
    headers: { Authorization: token },
    ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
  });
  let json: any = null;
  try { json = r.json; } catch { /* corpo não-JSON */ }
  return { status: r.status, json };
};

export default class ClickUpEspelho extends Plugin {
  settings: Settings = { ...DEFAULTS };
  index: Index = {};
  iconPaths: string[] = [];
  cards: Card[] = [];
  queue: string[] = []; // caminhos na ordem de seleção
  appliedRoot = "";
  private structure: SpaceData[] | null = null;
  private structureAt = 0;
  private hadContent = new Set<string>(); // pastas que já tiveram algo dentro
  private emptySince = new Map<string, number>();
  private order: Record<string, number> = {};
  private orderKey = "";
  private sortPatched = false;
  private styleEl: HTMLStyleElement | null = null;
  private styleCss = "";
  private log: string[] = []; // últimos problemas, gravados no data.json para diagnóstico
  private codeAt = 0; // data do main.js carregado; se mudar, o plugin se recarrega sozinho
  private syncing = false;
  private syncStarted = 0;
  private lastError = "";
  private timer: number | null = null;
  private statusEl!: HTMLElement;

  async onload() {
    let d = ((await this.loadData()) ?? {}) as Partial<Data>;
    if (!d.settings) {
      // arquivo de dados vazio (ex.: Obsidian congelou gravando): usa a cópia de segurança
      try {
        const base = (this.app.vault.adapter as any).getBasePath?.();
        d = JSON.parse((window as any).require("fs").readFileSync(`${base}/${this.manifest.dir}/data.bak.json`, "utf8"));
      } catch { /* sem cópia: começa do zero */ }
    }
    this.settings = { ...DEFAULTS, ...(d.settings ?? {}) };
    this.index = d.index ?? {};
    this.iconPaths = d.iconPaths ?? [];
    this.log = d.log ?? [];
    this.appliedRoot = d.appliedRoot ?? this.settings.root;
    if ((d.version ?? 1) < 2 && d.index) {
      // v1 espelhava dentro de "ClickUp/"; agora o space fica direto na raiz e o intervalo é curto
      this.appliedRoot = this.settings.root || "ClickUp";
      this.settings.root = "";
      this.settings.intervalSec = DEFAULTS.intervalSec;
    }

    // v3 passou a trazer documentos anexados: relê os anexos de cada card uma vez
    if ((d.version ?? 1) < 3) for (const e of Object.values(this.index)) delete e.updated;

    // v4: o status TO DO entra na pasta de trabalho, logo antes de IN PROGRESS
    if ((d.version ?? 1) < 4 && !this.settings.workingStatuses.includes("to do")) {
      const w = this.settings.workingStatuses, i = w.indexOf("in progress");
      w.splice(i < 0 ? 0 : i, 0, "to do");
    }

    this.codeAt = await this.codeTime();
    this.checkLastTrace();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("ClickUp …");
    this.registerView(VIEW, (leaf) => new CopyView(leaf, this));
    this.addRibbonIcon("clipboard-list", "ClickUp: copiar prompts", () => this.openView());
    this.addCommand({ id: "sincronizar", name: "Sincronizar agora", callback: () => this.sync(true) });
    this.addCommand({ id: "painel-copiar", name: "Abrir painel de copiar prompts", callback: () => this.openView() });
    this.addCommand({ id: "historico", name: "Abrir histórico de segurança", callback: () => this.openHistory() });
    this.pruneHistory();
    this.addCommand({ id: "copiar-fila", name: "Copiar fila de prompts", callback: () => this.copyQueue() });
    this.addSettingTab(new Tab(this.app, this));

    const addToQueue = (menu: Menu, files: TAbstractFile[]) => {
      const mds = files.filter((f): f is TFile => f instanceof TFile && f.extension === "md");
      if (!mds.length) return;
      menu.addItem((i) =>
        i.setTitle("Adicionar à fila de prompts").setIcon("clipboard-list").onClick(() => {
          for (const f of mds) if (!this.queue.includes(f.path)) this.queue.push(f.path);
          this.refreshView();
          this.openView();
        }));
    };
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => addToQueue(menu, [file])));
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => addToQueue(menu, files)));
    this.registerEvent(this.app.vault.on("rename", (file, old) => {
      const moved = (p: string) => (p === old ? file.path : p.startsWith(old + "/") ? file.path + p.slice(old.length) : null);
      for (const e of Object.values(this.index)) { const n = moved(e.path); if (n) e.path = n; }
      let q = false;
      this.queue = this.queue.map((p) => { const n = moved(p); if (n) q = true; return n ?? p; });
      if (q) this.refreshView();
    }));

    this.registerEvent(this.app.workspace.on("file-open", () => this.markNotes()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.markNotes()));
    this.register(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) (leaf.view as any)?.containerEl?.removeClass?.("clickup-espelho-note");
    });
    this.app.workspace.onLayoutReady(() => { this.sync(false); this.restartTimer(); });
  }

  onunload() { if (this.timer !== null) window.clearInterval(this.timer); }

  restartTimer() {
    if (this.timer !== null) window.clearInterval(this.timer);
    const sec = Math.max(3, this.settings.intervalSec || 5);
    this.timer = window.setInterval(() => this.sync(false), sec * 1000);
  }

  async persist() {
    this.trace("persist");
    const d: Data = {
      version: VERSION, settings: this.settings, index: this.index, iconPaths: this.iconPaths, appliedRoot: this.appliedRoot, log: this.log,
    };
    await this.saveData(d);
    try {
      const base = (this.app.vault.adapter as any).getBasePath?.();
      if (base) (window as any).require("fs").writeFileSync(`${base}/${this.manifest.dir}/data.bak.json`, JSON.stringify(d));
    } catch { /* cópia de segurança é opcional */ }
  }

  // ---- token ----
  private get secrets(): any { return (this.app as any).secretStorage; }
  async getToken(): Promise<string> {
    try {
      const s = await this.secrets?.getSecret?.(SECRET_ID);
      if (s) return s;
    } catch { /* usa o fallback */ }
    return this.settings.token;
  }
  async setToken(value: string) {
    value = value.trim();
    if (this.secrets?.setSecret) {
      await this.secrets.setSecret(SECRET_ID, value);
      this.settings.token = "";
    } else this.settings.token = value;
    await this.persist();
  }

  // ---- histórico de segurança: cópia de tudo o que o plugin sobrescreve, remove ou envia por cima ----
  private histDir() { return normalizePath(`${this.manifest.dir}/historico`); }
  private lastKept = new Map<string, string>(); // evita cópias repetidas do mesmo conteúdo
  private async backup(path: string, content: string, why: string): Promise<string | undefined> {
    const key = `${why}|${path}`;
    if (this.lastKept.get(key) === content) return undefined;
    const a = this.app.vault.adapter;
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const time = `${p2(now.getHours())}h${p2(now.getMinutes())}m${p2(now.getSeconds())}`;
    const dir = `${this.histDir()}/${day}`;
    if (!(await a.exists(this.histDir()))) await a.mkdir(this.histDir());
    if (!(await a.exists(dir))) await a.mkdir(dir);
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    let file = `${dir}/${time} ${name} (${why}).md`;
    for (let i = 2; await a.exists(file); i++) file = `${dir}/${time} ${name} (${why}) ${i}.md`;
    await a.write(file, content);
    await a.append(`${this.histDir()}/registro.log`, `${day} ${time} | ${why} | ${path}\n`);
    this.lastKept.set(key, content);
    return file;
  }
  /** Apaga do histórico o que tem mais de 30 dias. */
  private async pruneHistory() {
    try {
      const a = this.app.vault.adapter;
      if (!(await a.exists(this.histDir()))) return;
      const limit = Date.now() - 30 * 24 * 3600 * 1000;
      for (const d of (await a.list(this.histDir())).folders) {
        const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < limit) await a.rmdir(d, true);
      }
    } catch (e) { console.error("ClickUp Espelho: limpeza do histórico", e); }
  }
  private openHistory() {
    const base = (this.app.vault.adapter as any).getBasePath?.();
    if (!base) { new Notice(`ClickUp Espelho: o histórico fica em ${this.histDir()}`); return; }
    const full = `${base}/${this.histDir()}`;
    try { (window as any).require("fs").mkdirSync(full, { recursive: true }); (window as any).require("electron").shell.openPath(full); }
    catch { new Notice(`ClickUp Espelho: o histórico fica em ${full}`); }
  }
  /** Nota alterada dos dois lados: avisa, diz qual versão ficou e deixa trocar com um clique. */
  private conflictNotice(c: ConflictNote) {
    const other = c.kept === "ClickUp" ? "do Obsidian" : "do ClickUp";
    this.note(`conflito em "${c.name}": ficou a versão do ${c.kept}; a outra está no histórico`);
    const msg = `ClickUp Espelho: "${c.name}" foi alterada no Obsidian e no ClickUp ao mesmo tempo. Ficou a versão do ${c.kept}; a versão ${other} está guardada no histórico.` +
      (c.backup ? ` Clique aqui para trocar pela versão ${other}.` : "");
    const n = new Notice(msg, 0);
    if (!c.backup) return;
    const el: HTMLElement | undefined = (n as any).messageEl ?? (n as any).noticeEl;
    el?.addEventListener("click", async () => {
      try {
        const f = this.app.vault.getAbstractFileByPath(c.path);
        if (!(f instanceof TFile)) { new Notice("ClickUp Espelho: a nota não está mais nesse lugar; a cópia continua no histórico."); return; }
        const cur = await this.app.vault.read(f);
        const saved = await this.app.vault.adapter.read(c.backup!);
        await this.backup(c.path, cur, "nota-antes-de-trocar");
        const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(cur)?.[0] ?? "";
        await this.app.vault.modify(f, fm + stripFrontmatter(saved));
        new Notice(`ClickUp Espelho: "${c.name}" voltou para a versão ${other}.`);
      } catch (e: any) { new Notice(`ClickUp Espelho: não consegui trocar — ${e?.message ?? e}. A cópia continua no histórico.`); }
    });
  }

  private async ensureFolder(dir: string) {
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur).catch(() => { /* já existe */ });
    }
  }
  /** Arquivos dos cards que estão fora de anexos/ (raiz ou outra pasta) vão para o lugar certo; os links acompanham. */
  private async tidyAttachments() {
    for (const e of Object.values(this.index)) {
      for (const name of Object.keys(e.files ?? {})) {
        try {
          const f = this.app.metadataCache.getFirstLinkpathDest(name, e.path);
          if (!(f instanceof TFile)) continue;
          const dir = attachDir(f.name);
          const dest = `${dir}/${f.name}`;
          if (f.path === dest || this.app.vault.getAbstractFileByPath(dest)) continue;
          await this.ensureFolder(dir);
          await this.app.fileManager.renameFile(f, dest);
        } catch (err) { console.error("ClickUp Espelho: mover anexo", name, err); }
      }
    }
  }

  // ---- sincronização (ClickUp → Obsidian) ----
  private port(): VaultPort {
    const v = this.app.vault;
    const at = (p: string) => v.getAbstractFileByPath(normalizePath(p));
    let byId: Map<string, string> | null = null;
    return {
      mtime: async (p) => (at(p) as TFile).stat.mtime,
      backup: (p, content, why) => this.backup(p, content, why),
      readImage: async (name, notePath) => {
        const f = this.app.metadataCache.getFirstLinkpathDest(name, notePath);
        return f instanceof TFile && f.stat.size <= 20 * 1024 * 1024 ? v.readBinary(f) : null;
      },
      image: async (name, url, notePath) => {
        if (this.app.metadataCache.getFirstLinkpathDest(name, notePath)) return; // já está no cofre
        if (!/^https:\/\/[\w.-]+\.clickup-attachments\.com\//.test(url)) return;
        // o endereço sem token só entrega o arquivo com o token da API (sem ele vem a página de login)
        const r = await requestUrl({ url, throw: false, headers: { Authorization: await this.getToken() } });
        const type = String(r.headers?.["content-type"] ?? r.headers?.["Content-Type"] ?? "");
        // sem login o ClickUp devolve uma página HTML no lugar do arquivo
        const bad = isImage(name) ? !type.startsWith("image/") : type.startsWith("text/html") && !/\.html?$/i.test(name);
        if (r.status !== 200 || bad) throw new Error(`download respondeu ${r.status} (${type || "sem tipo"})`);
        const dir = attachDir(name);
        await this.ensureFolder(dir);
        const dest = `${dir}/${name}`;
        if (!at(dest)) await v.createBinary(dest, r.arrayBuffer);
      },
      findById: async (id) => {
        if (!byId) {
          byId = new Map();
          for (const f of v.getMarkdownFiles()) {
            const cid = this.app.metadataCache.getFileCache(f)?.frontmatter?.clickup_id;
            if (typeof cid === "string" && !byId.has(cid)) byId.set(cid, f.path);
          }
        }
        return byId.get(id) ?? null;
      },
      list: async (p) => {
        const out: string[] = [];
        const walk = (f: TAbstractFile | null) => {
          if (f instanceof TFile) { if (f.extension === "md") out.push(f.path); }
          else if (f instanceof TFolder) f.children.forEach(walk);
        };
        walk(at(p));
        return out;
      },
      exists: async (p) => at(p) !== null,
      read: async (p) => v.read(at(p) as TFile),
      write: async (p, c) => {
        const f = at(p);
        if (f instanceof TFile) await v.modify(f, c);
        else await v.create(normalizePath(p), c);
      },
      mkdir: async (p) => void (await v.createFolder(normalizePath(p))),
      rename: async (a, b) => v.rename(at(a)!, normalizePath(b)),
      trash: async (p) => this.app.fileManager.trashFile(at(p)!),
      isEmptyDir: async (p) => { const f = at(p); return f instanceof TFolder && f.children.length === 0; },
      rmdir: async (p) => { const f = at(p); if (f instanceof TFolder && f.children.length === 0) await this.removeEmptyFolder(f); },
    };
  }

  /**
   * Mostra as pastas de status como no ClickUp: "BACKLOG" em vez de "1 - backlog".
   * É só a exibição: o nome real da pasta mantém o número, que garante a ordem do quadro.
   */
  applyStatusTitles(plan: Plan | null) {
    let css = "";
    if (plan && this.settings.statusTitles) {
      const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      for (const [dir, sd] of Object.entries(plan.statusDirs)) {
        const sel = `.nav-folder-title[data-path="${q(dir)}"]:not(.is-being-renamed) .nav-folder-title-content`;
        css += `${sel}{font-size:0;}\n${sel}::before{content:"${q(sd.status.toUpperCase())}";font-size:var(--nav-item-size,var(--font-ui-small));}\n`;
      }
    }
    if (css === this.styleCss) return;
    this.styleCss = css;
    if (!this.styleEl) {
      this.styleEl = document.head.createEl("style", { attr: { id: "clickup-espelho-status" } });
      this.register(() => this.styleEl?.remove());
    }
    this.styleEl.textContent = css;
  }

  /**
   * Faz a árvore de arquivos mostrar os cards na ordem manual do ClickUp.
   * Não renomeia nada: só troca a ordenação da árvore dentro das pastas espelhadas.
   */
  async applyOrder(plan: Plan) {
    const want = this.settings.clickupOrder ? plan.order : {};
    const key = JSON.stringify(want);
    const view: any = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    if (!this.sortPatched && this.settings.clickupOrder) {
      const proto = view ? Object.getPrototypeOf(view) : null;
      const orig = proto?.getSortedFolderItems;
      if (typeof orig !== "function") {
        // árvore ainda não carregada (ou versão do Obsidian sem esse recurso): tenta de novo no próximo ciclo
        if (view && this.note("ordem do ClickUp: a árvore de arquivos não oferece getSortedFolderItems")) await this.persist();
        return;
      }
      const plugin = this;
      proto.getSortedFolderItems = function (...args: any[]) {
        const items = orig.apply(this, args);
        try { return plugin.sortItems(items); } catch { return items; }
      };
      this.register(() => { proto.getSortedFolderItems = orig; try { view.requestSort?.(); } catch { /* fechado */ } });
      this.sortPatched = true;
      this.orderKey = "";
      if (this.note("ordem do ClickUp: ativa")) await this.persist();
    }
    if (key === this.orderKey) return;
    this.order = want;
    this.orderKey = key;
    try { view?.requestSort?.(); } catch (e: any) { this.note(`ordem do ClickUp: ${e?.message ?? e}`); }
  }
  sortItems(items: any[]): any[] {
    if (!Array.isArray(items)) return items;
    const rank = (it: any): number | undefined => this.order[it?.file?.path];
    if (!items.some((it) => rank(it) !== undefined)) return items;
    return items
      .map((it, i) => ({ it, i, r: rank(it) }))
      .sort((a, b) => Number(a.r === undefined) - Number(b.r === undefined) || (a.r ?? 0) - (b.r ?? 0) || a.i - b.i)
      .map((x) => x.it);
  }

  private traceN = 0;
  private tracePath(): string | null {
    const base = (this.app.vault.adapter as any).getBasePath?.();
    return base ? `${base}/${this.manifest.dir}/trace.log` : null;
  }
  /** Diagnóstico da aba de configurações. Nunca recebe o token nem conteúdo de notas. */
  trace(msg: string) {
    if (++this.traceN > 600) return;
    try {
      const f = this.tracePath();
      if (f) (window as any).require("fs").appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* só diagnóstico */ }
  }
  /** Ao iniciar: se a aba de configurações travou da última vez, oferece o diagnóstico para copiar. */
  private checkLastTrace() {
    try {
      const f = this.tracePath();
      const fs = (window as any).require("fs");
      if (!f || !fs.existsSync(f)) return;
      const lines: string[] = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(f, "");
      const last = (needle: string) => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return i; return -1; };
      const opened = last("display: início");
      if (opened < 0 || last("display: estável") > opened) return; // não abriu, ou abriu e ficou estável
      const info = `ClickUp Espelho ${this.manifest.version} | Obsidian ${(window as any).require?.("obsidian")?.apiVersion ?? "?"} | ${navigator.platform}`;
      const text = [info, ...lines.slice(-120)].join("\n");
      const n = new Notice("ClickUp Espelho: as configurações travaram da última vez. Clique aqui para copiar o diagnóstico e cole no chat do Claude.", 0);
      const el: HTMLElement | undefined = (n as any).messageEl ?? (n as any).noticeEl;
      el?.addEventListener("click", () => { navigator.clipboard.writeText(text).then(() => new Notice("Diagnóstico copiado.")); });
    } catch { /* só diagnóstico */ }
  }

  report(msg: string) { if (this.note(msg)) this.persist().catch(() => {}); }

  /** Guarda um problema no data.json (sem repetir o último). Devolve true se for novo. */
  private note(msg: string): boolean {
    if (this.log.length && this.log[this.log.length - 1].endsWith(msg)) return false;
    this.log.push(`${new Date().toISOString()} ${msg}`);
    this.log = this.log.slice(-30);
    return true;
  }

  /** Apaga uma pasta vazia; se o Obsidian não conseguir, apaga direto no disco. */
  private async removeEmptyFolder(f: TFolder) {
    const path = f.path;
    const ad = this.app.vault.adapter;
    try { await this.app.vault.delete(f, true); } catch (e: any) { this.note(`apagar pasta (vault) ${path}: ${e?.message ?? e}`); }
    try { if (await ad.exists(path)) await ad.rmdir(path, false); } catch (e: any) { this.note(`apagar pasta (disco) ${path}: ${e?.message ?? e}`); }
    if (await ad.exists(path)) { if (this.note(`pasta vazia continua existindo: ${path}`)) await this.persist(); }
  }

  private working() {
    const name = this.settings.workingName.trim();
    return name && this.settings.workingStatuses.length ? { name, statuses: this.settings.workingStatuses } : undefined;
  }

  /** Apaga a pasta de uma lista oculta, depois que as notas dela saíram (só se não sobrou nenhum arquivo). */
  private async removeHidden(root: string, spaces: SpaceData[], shown: (l: { name: string }) => boolean) {
    const hasFiles = (f: TFolder): boolean => f.children.some((c) => !(c instanceof TFolder) || hasFiles(c));
    for (const s of spaces) for (const l of s.lists) {
      if (shown(l)) continue;
      const path = [root, sanitize(s.name), l.folderName ? sanitize(l.folderName) : "", sanitize(l.name)].filter(Boolean).join("/");
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFolder && !hasFiles(f)) await this.removeEmptyFolder(f);
    }
  }

  /** Marca as abas de notas espelhadas, para o CSS esconder o bloco de propriedades delas. */
  markNotes() {
    this.trace("markNotes");
    const paths = this.settings.hideProps ? new Set(Object.values(this.index).map((e) => e.path)) : new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const v: any = leaf.view;
      v?.containerEl?.toggleClass?.("clickup-espelho-note", !!v?.file && paths.has(v.file.path));
    }
  }

  private async codeTime(): Promise<number> {
    try { return (await this.app.vault.adapter.stat(`${this.manifest.dir}/main.js`))?.mtime ?? 0; } catch { return 0; }
  }

  async sync(manual: boolean) {
    if (this.syncing && Date.now() - this.syncStarted < 60000) return;
    const now = await this.codeTime();
    if (this.codeAt && now && now !== this.codeAt) {
      // uma versão nova foi instalada. Recarregar só o plugin (desligar/ligar) deixava o Obsidian travado
      // (Enter sem efeito, menus presos), então pedimos a recarga completa, quando o usuário quiser.
      this.codeAt = now;
      const n = new Notice("ClickUp Espelho: versão nova instalada. Clique aqui para recarregar o Obsidian (ou aperte Ctrl+R).", 0);
      const el: HTMLElement | undefined = (n as any).messageEl ?? (n as any).noticeEl;
      el?.addEventListener("click", () => (this.app as any).commands?.executeCommandById?.("app:reload"));
      return;
    }
    const token = await this.getToken();
    if (!token || !this.settings.spaces.length) {
      this.statusEl.setText("ClickUp: configurar");
      if (manual) new Notice("ClickUp Espelho: informe o token e escolha os spaces nas configurações.");
      return;
    }
    this.syncing = true;
    this.syncStarted = Date.now();
    this.statusEl.setText(this.statusEl.getText().replace(/^ClickUp …?$/, "ClickUp ↻"));
    try {
      const root = this.settings.root.trim() ? normalizePath(this.settings.root.trim()) : "";
      if (manual || !this.structure || Date.now() - this.structureAt > STRUCTURE_TTL ||
          this.structure.length !== this.settings.spaces.length ||
          this.structure.some((s, i) => s.id !== this.settings.spaces[i].id)) {
        const fresh: SpaceData[] = [];
        for (const s of this.settings.spaces) fresh.push(await fetchStructure(http, token, s.id, s.name));
        this.structure = fresh;
        this.structureAt = Date.now();
      }
      let spaces = this.structure;
      const hidden = new Set(this.settings.hiddenLists.map((x) => x.trim().toLowerCase()).filter(Boolean));
      const shown = (l: { name: string }) => !hidden.has(l.name.trim().toLowerCase());
      for (const s of spaces) for (const l of s.lists) l.tasks = shown(l) ? await fetchTasks(http, token, l.id) : [];
      // card com status que a lista (em memória) não conhece: os status mudaram no ClickUp → relê a estrutura já
      if (Date.now() - this.structureAt > 3000 &&
          spaces.some((s) => s.lists.some((l) => l.tasks.some((t) => !l.statuses.some((x) => x.status === t.status.status))))) {
        const fresh: SpaceData[] = [];
        for (const s of this.settings.spaces) fresh.push(await fetchSpace(http, token, s.id, s.name));
        spaces = this.structure = fresh;
        this.structureAt = Date.now();
      }
      // listas ocultas: ficam só no ClickUp (as notas delas saem do cofre, os cards não são tocados)
      const all = spaces;
      spaces = all.map((s) => ({ ...s, lists: s.lists.filter(shown) }));
      await this.migrateRoot(root);

      const api: Api = {
        update: (id, ch) => updateTask(http, token, id, ch),
        create: (listId, t) => createTask(http, token, listId, t),
        archive: (id) => archiveTask(http, token, id),
        get: (id) => getTask(http, token, id),
        upload: (id, fileName, data) => uploadAttachment(async (url, tk, contentType, body) => {
          const r = await requestUrl({ url, method: "POST", throw: false, headers: { Authorization: tk }, contentType, body });
          let json: any = null;
          try { json = r.json; } catch { /* corpo não-JSON */ }
          return { status: r.status, json };
        }, token, id, fileName, data),
        move: (id, listId) => {
          const sp = spaces.find((s) => s.lists.some((l) => l.id === listId));
          const team = this.settings.spaces.find((s) => s.id === sp?.id)?.teamId;
          if (!team) throw new Error("workspace da lista de destino não encontrado");
          return moveTask(http, token, team, id, listId);
        },
      };
      const { plan, stats: st } = await syncCycle(this.port(), api, root, spaces, this.index, {
        statusColors: this.settings.statusColors, working: this.working(), quietMs: QUIET_MS, createQuietMs: CREATE_QUIET_MS, push: this.settings.push, cascade: this.settings.cascade,
      });
      const changes = st.created + st.updated + st.moved + st.trashed + st.conflicts + st.pushed + st.added + st.archived + st.converted + st.checked + st.uploaded;
      await this.tidyAttachments();
      await this.pruneEmpty(plan);
      await this.removeHidden(root, all, shown);
      this.markNotes();
      this.applyStatusTitles(plan);
      await this.applyOrder(plan);
      const iconsChanged = await this.applyIcons(plan, st.created + st.moved + st.added + st.converted > 0);
      this.cards = plan.cards;
      if (changes || iconsChanged) await this.persist();
      this.refreshView();
      const hh = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const extra = st.errors.length ? ` · ${st.errors.length} erro(s) de envio` : st.keptLocal ? ` · ${st.keptLocal} pendente(s)` : "";
      this.statusEl.setText(`ClickUp ${st.errors.length ? "⚠" : "✓"} ${hh}${extra}`);
      if (st.errors.length) {
        console.error("ClickUp Espelho: erros de envio", st.errors);
        let fresh = false;
        for (const m of st.errors) fresh = this.note(m) || fresh;
        if (fresh) await this.persist();
        if (manual || st.errors[0] !== this.lastError) new Notice(`ClickUp Espelho: falha ao enviar — ${st.errors[0]}`, 10000);
      }
      this.lastError = st.errors[0] ?? "";
      if (st.converted) new Notice(`ClickUp Espelho: ${st.converted} subtarefa(s) virou card solto (card novo criado, o antigo foi arquivado).`);
      if (st.uploaded) new Notice(`ClickUp Espelho: ${st.uploaded} arquivo(s) enviado(s) ao ClickUp.`);
      if (st.added) new Notice(`ClickUp Espelho: ${st.added} card(s) criado(s) no ClickUp.`);
      if (st.archived) new Notice(`ClickUp Espelho: ${st.archived} card(s) arquivado(s) no ClickUp (dá para restaurar por lá).`);
      for (const c of st.conflictNotes) this.conflictNotice(c);
      if (manual) new Notice(`ClickUp: ${st.pushed} enviadas, ${st.created} novas, ${st.updated} atualizadas, ${st.moved} movidas, ${st.trashed} removidas.`);
    } catch (e: any) {
      console.error("ClickUp Espelho", e);
      const msg = String(e?.message ?? e);
      if (this.note(`sincronização: ${msg}`)) await this.persist().catch(() => {});
      this.statusEl.setText(`ClickUp ⚠ ${msg.slice(0, 60)}`);
      if (manual || msg !== this.lastError) new Notice(`ClickUp Espelho: ${msg}`, 10000);
      this.lastError = msg;
    } finally {
      this.syncing = false;
    }
  }

  /** Quando a pasta raiz muda, move as pastas dos spaces para o novo lugar. */
  private async migrateRoot(root: string) {
    if (this.appliedRoot === root) return;
    const v = this.app.vault;
    const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
    for (const s of this.settings.spaces) {
      const from = v.getAbstractFileByPath(join(this.appliedRoot, sanitize(s.name)));
      const to = join(root, sanitize(s.name));
      if (!(from instanceof TFolder) || v.getAbstractFileByPath(to)) continue;
      const fromPath = from.path;
      if (root && !v.getAbstractFileByPath(root)) await v.createFolder(root);
      await v.rename(from, to);
      for (const e of Object.values(this.index))
        if (e.path.startsWith(fromPath + "/")) e.path = to + e.path.slice(fromPath.length);
    }
    const old = this.appliedRoot ? v.getAbstractFileByPath(this.appliedRoot) : null;
    this.appliedRoot = root;
    await this.persist();
    try { if (old instanceof TFolder && old.children.length === 0) await v.delete(old); } catch (e) { console.error(e); }
  }

  /** Grava cor (status) e ícone (tipo de card) no plugin Iconic, se instalado. */
  /** Apaga pastas vazias que sobraram dentro das listas espelhadas (ex.: card que deixou de ter subtarefas). */
  private async pruneEmpty(plan: Plan) {
    const keep = new Set(plan.folders);
    const lists = new Set(this.listDirs(plan));
    const walk = async (folder: TFolder) => {
      for (const child of [...folder.children]) {
        if (!(child instanceof TFolder)) continue;
        await walk(child);
        if (keep.has(child.path)) continue;
        if (child.children.length > 0) { this.hadContent.add(child.path); this.emptySince.delete(child.path); continue; }
        // pasta que esvaziou some na hora; pasta recém-criada (ainda vazia) ganha 10 minutos para receber notas
        const since = this.emptySince.get(child.path) ?? Date.now();
        this.emptySince.set(child.path, since);
        // pasta de um status que deixou de existir (ou mudou de nome/posição) no ClickUp também some na hora
        const oldStatus = lists.has(folder.path) && /^\d+ - /.test(child.name);
        if (oldStatus || this.hadContent.has(child.path) || Date.now() - since > EMPTY_GRACE_MS) {
          this.hadContent.delete(child.path);
          this.emptySince.delete(child.path);
          await this.removeEmptyFolder(child);
        }
      }
    };
    for (const dir of this.listDirs(plan)) {
      const f = this.app.vault.getAbstractFileByPath(dir);
      if (f instanceof TFolder) await walk(f);
    }
  }
  private listDirs(plan: Plan): string[] {
    return [...new Set(Object.keys(plan.statusDirs).map((d) => d.slice(0, d.lastIndexOf("/"))))];
  }

  private async applyIcons(plan: Plan, forceRefresh = false): Promise<boolean> {
    const desired = plan.icons;
    const iconic = (this.app as any).plugins?.plugins?.["iconic"];
    const store = iconic?.settings?.fileIcons;
    if (!store) return false;
    let changed = false;
    for (const [path, spec] of Object.entries(desired)) {
      const cur = store[path];
      if (cur?.icon !== spec.icon || (cur?.color ?? null) !== spec.color) {
        store[path] = spec.color ? { icon: spec.icon, color: spec.color } : { icon: spec.icon };
        changed = true;
      }
    }
    // remove ícones antigos: os que este plugin gravou e tudo que sobrou dentro das listas espelhadas
    const prefixes = this.listDirs(plan).map((d) => d + "/");
    const stale = new Set(this.iconPaths.filter((p) => !this.app.vault.getAbstractFileByPath(p)));
    for (const p of Object.keys(store)) if (prefixes.some((x) => p.startsWith(x))) stale.add(p);
    for (const p of stale) if (!(p in desired) && p in store) { delete store[p]; changed = true; }
    const paths = Object.keys(desired);
    const listChanged = paths.length !== this.iconPaths.length || paths.some((p, i) => p !== this.iconPaths[i]);
    this.iconPaths = paths;
    if (changed) await iconic.saveSettings?.();
    if (changed || forceRefresh) iconic.refreshManagers?.("file", "folder");
    return changed || listChanged;
  }

  // ---- fila de cópia ----
  async openView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW, active: true });
    }
    ws.revealLeaf(leaf);
  }
  refreshView() {
    for (const l of this.app.workspace.getLeavesOfType(VIEW)) (l.view as CopyView).render();
  }
  toggle(path: string) {
    const i = this.queue.indexOf(path);
    if (i >= 0) this.queue.splice(i, 1);
    else this.queue.push(path);
    this.refreshView();
  }
  async copyQueue() {
    const parts: string[] = [];
    const empty: string[] = [];
    for (const p of this.queue) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      const body = stripFrontmatter(await this.app.vault.read(f));
      if (!body) { empty.push(f.basename); continue; }
      parts.push(this.settings.includeTitle ? `# ${f.basename}\n\n${body}` : body);
    }
    if (!parts.length) { new Notice("Nenhum prompt com texto na fila."); return; }
    await navigator.clipboard.writeText(parts.join(`\n\n${this.settings.separator}\n\n`));
    new Notice(`${parts.length} prompt(s) copiado(s).` + (empty.length ? ` Sem texto: ${empty.join(", ")}.` : ""));
  }
}

class CopyView extends ItemView {
  private filter = "";
  constructor(leaf: WorkspaceLeaf, private plugin: ClickUpEspelho) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return "Copiar prompts"; }
  getIcon() { return "clipboard-list"; }
  async onOpen() { this.render(); }

  render() {
    const p = this.plugin;
    const el = this.contentEl;
    const scroll = el.scrollTop;
    el.empty();
    el.addClass("cue-view");

    const bar = el.createDiv({ cls: "cue-bar" });
    const copy = bar.createEl("button", { text: `Copiar (${p.queue.length})`, cls: "mod-cta" });
    copy.disabled = !p.queue.length;
    copy.onclick = () => p.copyQueue();
    bar.createEl("button", { text: "Limpar" }).onclick = () => { p.queue = []; this.render(); };
    bar.createEl("button", { text: "↻" , attr: { "aria-label": "Sincronizar agora" } }).onclick = () => p.sync(true);

    if (p.queue.length) {
      const q = el.createDiv({ cls: "cue-queue" });
      p.queue.forEach((path, i) => {
        const row = q.createDiv({ cls: "cue-row" });
        row.createSpan({ cls: "cue-num", text: String(i + 1) });
        row.createSpan({ text: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "") });
        row.setAttr("aria-label", "Remover da fila");
        row.onclick = () => p.toggle(path);
      });
    }

    const search = el.createEl("input", { type: "text", placeholder: "Filtrar cards…", cls: "cue-search" });
    search.value = this.filter;
    search.oninput = () => { this.filter = search.value; this.renderCards(listEl); };
    const listEl = el.createDiv();
    this.renderCards(listEl);
    el.scrollTop = scroll;
  }

  private renderCards(el: HTMLElement) {
    const p = this.plugin;
    el.empty();
    const f = this.filter.trim().toLowerCase();
    if (!p.cards.length) { el.createDiv({ cls: "cue-empty", text: "Nenhum card sincronizado ainda." }); return; }
    let group = "";
    for (const c of p.cards) {
      if (f && !c.name.toLowerCase().includes(f)) continue;
      // subtarefas ficam sob o grupo do card pai
      const g = c.depth === 0 ? `${c.list} · ${c.status}` : group;
      if (g !== group) { group = g; el.createDiv({ cls: "cue-group", text: g }); }
      const n = p.queue.indexOf(c.path);
      const row = el.createDiv({ cls: "cue-row" + (n >= 0 ? " is-selected" : "") });
      row.style.paddingLeft = `${8 + c.depth * 16}px`;
      const dot = row.createSpan({ cls: "cue-dot" });
      if (c.color) dot.style.backgroundColor = c.color;
      row.createSpan({ cls: "cue-name", text: c.name });
      if (c.depth > 0) row.createSpan({ cls: "cue-status", text: c.status });
      if (n >= 0) row.createSpan({ cls: "cue-num", text: String(n + 1) });
      row.onclick = () => p.toggle(c.path);
    }
  }
}

class Tab extends PluginSettingTab {
  constructor(app: App, private plugin: ClickUpEspelho) { super(app, plugin); }

  private opens: number[] = [];
  private ready = false;
  private readyTimer = 0;

  display() {
    const p = this.plugin;
    p.trace("display: início");
    // proteção: se o Obsidian pedir para montar a aba várias vezes seguidas, paramos em vez de travar a janela
    const now = Date.now();
    this.opens = this.opens.filter((t) => now - t < 3000);
    this.opens.push(now);
    if (this.opens.length > 3) {
      p.trace("display: laço detectado, montagem cancelada");
      try { this.containerEl.setText("ClickUp Espelho: configurações pausadas por proteção contra travamento. Feche esta janela e abra de novo."); } catch { /* nada */ }
      return;
    }
    // os campos só passam a gravar depois que a aba está montada e parada (ignora mudanças feitas por código)
    this.ready = false;
    window.clearTimeout(this.readyTimer);
    this.readyTimer = window.setTimeout(() => { this.ready = true; p.trace("display: estável"); }, 400);
    try { this.build(); p.trace("display: montada"); }
    catch (e: any) {
      // um erro aqui deixava o menu preso e a janela de configurações sem resposta
      p.trace(`display: erro ${e?.message ?? e}`);
      p.report(`configurações: ${e?.stack ?? e?.message ?? e}`);
      try { this.containerEl.setText(`ClickUp Espelho: erro ao montar as configurações — ${e?.message ?? e}`); } catch { /* nada */ }
    }
  }

  private build() {
    const p = this.plugin;
    const el = this.containerEl;
    el.empty();

    p.trace("build 1");
    new Setting(el)
      .setName("Token do ClickUp")
      .setDesc("ClickUp → Configurações → Apps → API Token. Fica guardado no cofre de segredos do Obsidian, quando disponível.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("pk_…");
        // não preencher o campo por código: no Obsidian 1.15 isso travava a janela de configurações
        p.trace("token: lendo");
        p.getToken().then((v) => { p.trace("token: lido"); t.setPlaceholder(v ? "token salvo (digite para trocar)" : "pk_…"); p.trace("token: placeholder ok"); });
        let busy = false;
        t.onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #1"); return; } p.trace("onChange #1");
          v = v.trim();
          if (busy || !v.startsWith("pk_") || v.length < 20) return; // só grava um token completo, digitado ou colado
          busy = true;
          try { if (v !== (await p.getToken())) await p.setToken(v); } finally { busy = false; }
        });
      });

    p.trace("build 2");
    new Setting(el)
      .setName("Pasta raiz")
      .setDesc("Pasta do cofre onde os spaces são espelhados. Vazio = direto na raiz do cofre.")
      .addText((t) => t.setValue(p.settings.root).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #2"); return; } p.trace("onChange #2"); p.settings.root = v.trim(); await p.persist(); }));

    p.trace("build 3");
    new Setting(el)
      .setName("Enviar alterações ao ClickUp")
      .setDesc("Editar, mover de pasta de status, renomear e mudar status/prioridade atualiza o card. Nota nova numa pasta de status vira card; dentro da pasta de um card vira subtarefa. Arrastar um card para a pasta de outro troca o pai; para uma pasta de status de outra lista, troca a lista. Subtarefa solta numa pasta de status vira card solto (é recriada e a antiga é arquivada). Apagar a nota arquiva o card. Desligado = só leitura.")
      .addToggle((t) => t.setValue(p.settings.push).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #3"); return; } p.trace("onChange #3"); p.settings.push = v; await p.persist(); }));

    p.trace("build 4");
    new Setting(el)
      .setName("Subtarefas seguem o status do pai")
      .setDesc("Quando o card pai muda de status, o plugin muda as subtarefas para o mesmo status no ClickUp. Só funciona com o Obsidian aberto.")
      .addToggle((t) => t.setValue(p.settings.cascade).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #4"); return; } p.trace("onChange #4"); p.settings.cascade = v; await p.persist(); }));

    p.trace("build 5");
    new Setting(el)
      .setName("Ordem dos cards como no ClickUp")
      .setDesc("Dentro de cada pasta, as notas aparecem na ordem em que os cards estão no ClickUp. Para reordenar, arraste no ClickUp. Desligado = ordem do Obsidian.")
      .addToggle((t) => t.setValue(p.settings.clickupOrder).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #5"); return; } p.trace("onChange #5"); p.settings.clickupOrder = v; await p.persist(); p.sync(true); }));

    p.trace("build 6");
    new Setting(el)
      .setName("Títulos de status como no ClickUp")
      .setDesc("Mostra as pastas de status em maiúsculas e sem número (BACKLOG, TO DO…). O nome real da pasta continua com o número, para manter a ordem do quadro.")
      .addToggle((t) => t.setValue(p.settings.statusTitles).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #6"); return; } p.trace("onChange #6"); p.settings.statusTitles = v; await p.persist(); p.sync(true); }));

    const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
    p.trace("build 7");
    new Setting(el)
      .setName("Esconder propriedades nas notas")
      .setDesc("Esconde o bloco Properties nas notas espelhadas. O clickup_id continua gravado no arquivo: é ele que liga a nota ao card.")
      .addToggle((t) => t.setValue(p.settings.hideProps).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #7"); return; } p.trace("onChange #7"); p.settings.hideProps = v; await p.persist(); p.markNotes(); }));

    p.trace("build 8");
    new Setting(el)
      .setName("Listas ocultas")
      .setDesc("Listas do ClickUp que não aparecem no Obsidian, separadas por vírgula. Os cards continuam intactos no ClickUp.")
      .addText((t) => t.setValue(p.settings.hiddenLists.join(", ")).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #8"); return; } p.trace("onChange #8"); p.settings.hiddenLists = csv(v); await p.persist(); }));

    p.trace("build 9");
    new Setting(el)
      .setName("Pasta de trabalho")
      .setDesc("Nome da pasta à parte e os status que ficam dentro dela, na ordem (separados por vírgula). Os demais status seguem o ClickUp.")
      .addText((t) => t.setValue(p.settings.workingName).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #9"); return; } p.trace("onChange #9"); p.settings.workingName = v.trim(); await p.persist(); }))
      .addText((t) => t.setValue(p.settings.workingStatuses.join(", ")).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #10"); return; } p.trace("onChange #10"); p.settings.workingStatuses = csv(v).map((x) => x.toLowerCase()); await p.persist(); }));

    p.trace("build 10");
    new Setting(el)
      .setName("Cores por status")
      .setDesc("Uma por linha: status = cor. Cores: red, orange, yellow, green, cyan, blue, purple, pink, gray ou #hex. Status fora da lista usam a cor do ClickUp.")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.setValue(Object.entries(p.settings.statusColors).map(([k, v]) => `${k} = ${v}`).join("\n"));
        t.onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #11"); return; } p.trace("onChange #11");
          const map: Record<string, string> = {};
          for (const line of v.split("\n")) {
            const i = line.indexOf("=");
            if (i > 0 && line.slice(i + 1).trim()) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          }
          p.settings.statusColors = map;
          await p.persist();
        });
      });

    p.trace("build 11");
    new Setting(el)
      .setName("Intervalo (segundos)")
      .setDesc("De quanto em quanto tempo consultar o ClickUp. Mínimo 3.")
      .addText((t) => t.setValue(String(p.settings.intervalSec)).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #12"); return; } p.trace("onChange #12");
        p.settings.intervalSec = Math.max(3, Number(v) || 5);
        await p.persist();
        p.restartTimer();
      }));

    p.trace("build 12");
    new Setting(el)
      .setName("Separador entre prompts")
      .addText((t) => t.setValue(p.settings.separator).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #13"); return; } p.trace("onChange #13"); p.settings.separator = v; await p.persist(); }));

    p.trace("build 13");
    new Setting(el)
      .setName("Incluir o nome do card ao copiar")
      .addToggle((t) => t.setValue(p.settings.includeTitle).onChange(async (v) => { if (!this.ready) { p.trace("onChange ignorado #14"); return; } p.trace("onChange #14"); p.settings.includeTitle = v; await p.persist(); }));

    p.trace("build 14");
    new Setting(el).setName("Spaces espelhados").setHeading();
    const box = el.createDiv();
    const draw = (all: { teamId: string; teamName: string; id: string; name: string }[]) => {
      box.empty();
      for (const s of all)
        new Setting(box).setName(s.name).setDesc(`Workspace: ${s.teamName}`).addToggle((t) =>
          t.setValue(p.settings.spaces.some((x) => x.id === s.id)).onChange(async (on) => { if (!this.ready) { p.trace("onChange ignorado #15"); return; } p.trace("onChange #15");
            p.settings.spaces = p.settings.spaces.filter((x) => x.id !== s.id);
            if (on) p.settings.spaces.push({ teamId: s.teamId, id: s.id, name: s.name });
            await p.persist();
            p.sync(true);
          }));
    };
    for (const s of p.settings.spaces) new Setting(box).setName(s.name).setDesc("Espelhado");
    p.trace("build 15");
    new Setting(el).addButton((b) => b.setButtonText("Carregar spaces do ClickUp").onClick(async () => {
      try { draw(await fetchTeamsAndSpaces(http, await p.getToken())); }
      catch (e: any) { new Notice(`ClickUp Espelho: ${e?.message ?? e}`); }
    }));
  }
}
