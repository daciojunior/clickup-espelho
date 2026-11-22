// Acesso à API v2 do ClickUp.

export type Http = (url: string, token: string, method?: string, body?: unknown) => Promise<{ status: number; json: any }>;

export interface Status { status: string; color: string; orderindex: number }
export interface Task {
  id: string;
  name: string;
  markdown_description?: string | null;
  status: { status: string; color?: string };
  priority?: { priority: string } | null;
  parent: string | null;
  url: string;
  orderindex?: string; // posição manual do card no ClickUp (menor = mais acima)
  date_created?: string;
  date_updated?: string;
  /** Só vem ao ler o card sozinho (não na listagem). */
  attachments?: { id: string; title?: string; url: string; extension?: string; mimetype?: string }[];
}
export interface ListData { id: string; name: string; folderName?: string; statuses: Status[]; tasks: Task[] }
export interface SpaceData { id: string; name: string; lists: ListData[] }
/** Alterações locais a enviar. priority "" = sem prioridade. */
export interface Changes { name?: string; status?: string; priority?: string; body?: string; parent?: string }

const BASE = "https://api.clickup.com/api/v2";
const PRIORITY_NUM: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

async function call(http: Http, token: string, path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await http(path.startsWith("https://") ? path : BASE + path, token, method, body);
  if (r.status === 401) throw new Error("token do ClickUp inválido");
  if (r.status === 429) throw new Error("limite de requisições do ClickUp atingido");
  if (r.status < 200 || r.status >= 300)
    throw new Error(`ClickUp respondeu ${r.status} em ${method} ${path}${r.json?.err ? `: ${r.json.err}` : ""}`);
  return r.json;
}

export async function fetchTeamsAndSpaces(http: Http, token: string) {
  const out: { teamId: string; teamName: string; id: string; name: string }[] = [];
  const { teams } = await call(http, token, "/team");
  for (const t of teams ?? []) {
    const { spaces } = await call(http, token, `/team/${t.id}/space?archived=false`);
    for (const s of spaces ?? []) out.push({ teamId: t.id, teamName: t.name, id: s.id, name: s.name });
  }
  return out;
}

/** Estrutura do space (pastas, listas, status), sem os cards. Muda raramente. */
export async function fetchStructure(http: Http, token: string, id: string, name: string): Promise<SpaceData> {
  const lists: ListData[] = [];
  const add = async (listId: string, folderName?: string) => {
    const full = await call(http, token, `/list/${listId}`);
    lists.push({ id: listId, name: full.name, folderName, statuses: full.statuses ?? [], tasks: [] });
  };
  const { folders } = await call(http, token, `/space/${id}/folder?archived=false`);
  for (const f of folders ?? []) for (const l of f.lists ?? []) await add(l.id, f.name);
  const r = await call(http, token, `/space/${id}/list?archived=false`);
  for (const l of r.lists ?? []) await add(l.id);
  return { id, name, lists };
}

export async function fetchTasks(http: Http, token: string, listId: string): Promise<Task[]> {
  const tasks: Task[] = [];
  for (let page = 0; page < 100; page++) {
    const r = await call(
      http, token,
      `/list/${listId}/task?subtasks=true&include_closed=true&include_markdown_description=true&page=${page}`,
    );
    if (!Array.isArray(r.tasks)) throw new Error(`resposta inesperada da lista ${listId}`);
    tasks.push(...r.tasks);
    if (r.last_page !== false || r.tasks.length === 0) break;
  }
  return tasks;
}

export async function fetchSpace(http: Http, token: string, id: string, name: string): Promise<SpaceData> {
  const s = await fetchStructure(http, token, id, name);
  for (const l of s.lists) l.tasks = await fetchTasks(http, token, l.id);
  return s;
}

export async function getTask(http: Http, token: string, id: string): Promise<Task> {
  return call(http, token, `/task/${id}?include_markdown_description=true`);
}

export interface NewTask { name: string; body?: string; status?: string; parent?: string; priority?: string }

/** Cria um card (ou subtarefa, se houver parent) e devolve como ficou no ClickUp. */
export async function createTask(http: Http, token: string, listId: string, t: NewTask): Promise<Task> {
  const body: Record<string, unknown> = { name: t.name, markdown_content: t.body ?? "" };
  if (t.status) body.status = t.status;
  if (t.parent) body.parent = t.parent;
  if (t.priority && PRIORITY_NUM[t.priority]) body.priority = PRIORITY_NUM[t.priority];
  const r = await call(http, token, `/list/${listId}/task`, "POST", body);
  if (!r?.id) throw new Error("o ClickUp não devolveu o card criado");
  return getTask(http, token, r.id);
}

/** Arquiva o card (pode ser restaurado no ClickUp). */
export async function archiveTask(http: Http, token: string, id: string): Promise<void> {
  await call(http, token, `/task/${id}`, "PUT", { archived: true });
}

/** Move o card (e suas subtarefas) para outra lista. */
export async function moveTask(http: Http, token: string, teamId: string, id: string, listId: string): Promise<void> {
  await call(http, token, `https://api.clickup.com/api/v3/workspaces/${teamId}/tasks/${id}/home_list/${listId}`, "PUT", {});
}

/** Envia alterações e devolve o card como ficou no ClickUp. */
export async function updateTask(http: Http, token: string, id: string, ch: Changes): Promise<Task> {
  const body: Record<string, unknown> = {};
  if (ch.name !== undefined) body.name = ch.name;
  if (ch.status !== undefined) body.status = ch.status;
  if (ch.priority !== undefined) body.priority = PRIORITY_NUM[ch.priority] ?? null;
  if (ch.body !== undefined) body.markdown_content = ch.body;
  if (ch.parent !== undefined) body.parent = ch.parent;
  await call(http, token, `/task/${id}`, "PUT", body);
  return getTask(http, token, id);
}

export type RawPost = (url: string, token: string, contentType: string, body: ArrayBuffer) => Promise<{ status: number; json: any }>;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" };

/** Anexa um arquivo ao card e devolve o endereço dele no ClickUp. */
export async function uploadAttachment(post: RawPost, token: string, id: string, fileName: string, data: ArrayBuffer): Promise<string> {
  const boundary = "----clickupespelho" + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const mime = MIME[(fileName.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${fileName.replace(/["\r\n]/g, "")}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + data.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(data), head.length);
  body.set(tail, head.length + data.byteLength);
  const r = await post(`${BASE}/task/${id}/attachment`, token, `multipart/form-data; boundary=${boundary}`, body.buffer);
  if (r.status < 200 || r.status >= 300 || !r.json?.url) throw new Error(`envio do arquivo respondeu ${r.status}${r.json?.err ? `: ${r.json.err}` : ""}`);
  return String(r.json.url).split("?")[0];
}
