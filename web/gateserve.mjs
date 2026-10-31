// gateserve.mjs — one server of the gate's own.
//
// `galley serve` is one per machine, found through the state folder. A gate that
// shared the machine's would drive somebody else's documents (#128), and two
// gates sharing one would collide, so importing this file gives the run a temp
// XDG_STATE_HOME and GALLEY_LIVE_DIR before anything is spawned, and stops the
// server and removes them when the run exits. Import it above the gate's first
// spawn. A child the gate runs (--agent) inherits the folders and the token,
// and leaves the stopping to its parent.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN_HEADER = 'X-Local-Token';

if (!process.env.GALLEY_GATE_STATE) {
  const state = mkdtempSync(join(tmpdir(), 'galley-gate-'));
  process.env.GALLEY_GATE_STATE = state;
  process.env.XDG_STATE_HOME = join(state, 'state');
  process.env.GALLEY_LIVE_DIR = join(state, 'live');
  // An interrupt reaches this too: the probe scaffolding every gate loads turns
  // SIGINT and SIGTERM into an exit.
  process.on('exit', () => {
    for (const child of editors) {
      child.kill('SIGTERM');
    }
    spawnSync(process.env.GALLEY || 'bin/galley', ['serve', '--stop'], {
      stdio: 'ignore',
      timeout: 10000,
    });
    try {
      rmSync(state, { recursive: true, force: true });
    } catch {
      // A tmpdir left behind is nothing; a throwing exit handler is not.
    }
  });
}

const editors = new Set();

// A gate's own requests carry the token, as the verbs' do. The page signs in
// with the address `served` returns and uses the cookie.
const unsigned = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const origin = process.env.GALLEY_GATE_ORIGIN;
  if (!origin || !String(input.url || input).startsWith(origin)) {
    return unsigned(input, init);
  }
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, process.env.GALLEY_GATE_TOKEN);
  return unsigned(input, { ...init, headers });
};

/** Wait for a spawned `galley edit` (stdout piped) to print its address.
 * base is the document's root, for `${base}/_galley/...`; url is the signed-in
 * address a browser opens. Rejects with what the editor said if it exits. */
export function served(child, ms = 20000) {
  editors.add(child);
  child.once('exit', () => editors.delete(child));
  return new Promise((resolve, reject) => {
    let said = '';
    const timer = setTimeout(
      () => reject(new Error(`galley edit printed no address: ${said}`)),
      ms,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`galley edit exited (${code}): ${said}`));
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (b) => {
        said += b;
        const line = said.match(/serving\s+(http:\/\/\S+)/);
        if (!line) return;
        clearTimeout(timer);
        const url = new URL(line[1]);
        process.env.GALLEY_GATE_ORIGIN = url.origin;
        process.env.GALLEY_GATE_TOKEN = url.searchParams.get('t');
        resolve({
          base: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          url: line[1],
        });
      });
    }
  });
}

/** What the run's server has logged so far: a document's own lines go here,
 * not to the `galley edit` that opened it. */
export const serverLog = () =>
  readFileSync(join(process.env.XDG_STATE_HOME, 'galley', 'serve.log'), 'utf8');
