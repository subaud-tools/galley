# galley

galley is a review page for a Markdown file, shared between you and Claude Code.

Ask Claude to open a draft in galley and it returns a URL. On that page you read the draft and edit anything you want to change yourself. Where Claude should do the work, highlight the sentence or paragraph and write the instruction. Press **Revise** and Claude receives those instructions, rewrites the file, and the result appears in front of you with the changes marked. Give another instruction if it is not right. Press **Approve** when it is.

Claude's changes land in the document the way an assistant's edits would.

Each time you send, and each time Claude answers, a copy of the file is saved beside it on your own machine. You can open any point in the review and see exactly what changed. Nothing is uploaded. The file remains ordinary Markdown throughout: your instructions are held beside it, the file carries only a short ID mark where each one sits, and pressing Revise removes the marks.

`galley edit` also accepts HTML files: `galley edit page.html` extracts the prose into a Markdown document, the review proceeds as normal, and every projection re-renders the page.

One `galley serve` per machine holds every open document behind one port and token. `galley edit` starts it if it is not running, opens the document on it, prints the address and stays until the document closes; Ctrl-C closes the document and leaves the server. `--port` reaches the server only when that command starts it. `galley pending`, `wait`, `ack`, `cannot` and `revise` find the document through the server by its path.

## Install

```sh
curl -fsSL https://galley.tools/install.sh | sh
```

## Connect Claude Code

Install the galley plugin from the subaud-tools marketplace, then install galley's skill:

```sh
claude plugin marketplace add subaud-tools/plugins
claude plugin install galley@subaud-tools
galley skills install
```

Your session then receives each Revise as you press it, and the skill teaches Claude how a review works, so asking it to open a draft is enough. `galley skills install` writes the skill for each agent harness it finds (Claude Code, Codex, pi), and `galley channel` keeps it current each time it starts. The plugin is described in [plugins/galley/README.md](https://github.com/subaud-tools/plugins/blob/main/plugins/galley/README.md).

## Licensing

galley is source-available under the **Business Source License 1.1**
(`BUSL-1.1`) and is **free for any organization under 25 people** — individuals
and small teams pay nothing and nothing is held back. At 25 employees or more, a
company licenses galley; it is an honor-based commercial license, not a lock.
galley never gates a feature, never asks for a key, and never phones home — the
purchase receipt is the proof of compliance, and there is nothing to install or
activate.

Pricing is a one-time purchase by company size (Starter / Team / Company /
Growth, with a contact-us tier for 500+), available at
[**galley.tools/buy**](https://galley.tools/buy/). Each release converts to
Apache-2.0 three years after it ships, so no company is ever stranded on a
binary it cannot fork. The binding terms are in [LICENSE.md](LICENSE.md).
