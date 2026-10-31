// net.ts — talking to the server, and nothing else.
//
// getJSON and postJSON are the whole of it: every mutation this editor makes
// goes through one of these two, and nothing else in the browser half issues a
// request. It cannot live in a mixin because entry.ts itself calls it — the
// constructor's own polling loop reaches for getJSON before any mixin is
// wired in.

// Every route the page calls, as whole literals: the one place a URL is spelled.
const routes = {
  downloadMd: '/_galley/download/md',
  handoffCancel: '/_galley/handoff/cancel',
  instruct: '/_galley/instruct',
  instructionDelete: '/_galley/instruction/delete',
  mermaid: '/_galley/mermaid.js',
  mode: '/_galley/mode',
  pending: '/_galley/pending',
  render: '/_galley/render',
  rev: '/_galley/rev',
  revert: '/_galley/revert',
  revise: '/_galley/revise',
  saved: '/_galley/saved',
  shareHtml: '/_galley/share/html',
  shareMd: '/_galley/share/md',
  versions: '/_galley/versions',
  versionsRestore: '/_galley/versions/restore',
  versionsView: '/_galley/versions/view',
} as const;

// apiUrl puts a route under this document's base, which the shell's <base> names.
function apiUrl(path: string): string {
  const base = document.querySelector('base')?.getAttribute('href') ?? '/';
  return base.replace(/\/$/, '') + path;
}

// wsUrl is what y-websocket appends the room to: the path WITHOUT the room.
function wsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  return `${scheme}${window.location.host}${apiUrl('/yjs')}`;
}

// GENERIC, DEFAULTING TO `unknown` — a caller that names no `T` gets exactly
// the old signature back, so every existing untyped call site is unchanged.
// `VersionsPanelOptions.getJSON` (web/versions.ts) already declared its
// injected dependency as `<T>(path: string) => Promise<T>` and entry.ts
// passes this function to satisfy it — a mismatch invisible only because
// entry.ts is not yet typechecked (Task 8). A caller that DOES name `T` is
// trusting the endpoint's own wire contract, the same trust `getJSON<T>` in
// versions.ts already spends: `/_galley/*`'s shape is `wire.d.ts`'s or the
// Go handler's, checked at the boundary that generates that file, not by
// walking the JSON by hand a second time here.
function getJSON<T = unknown>(path: string): Promise<T | null> {
  return fetch(apiUrl(path), { headers: { Accept: 'application/json' } }).then(
    (res) => (res.ok ? res.json() : null),
  );
}

function postJSON(path: string, body: unknown): Promise<Response> {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export { apiUrl, getJSON, postJSON, routes, wsUrl };
