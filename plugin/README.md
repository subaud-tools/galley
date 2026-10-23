# galley plugin

The plugin carries four things: the `.mcp.json` entry pointing at `galley channel` on PATH, which serves galley's tools; the mod in `hooks/`, which runs `galley watch` and starts a turn with each event; the skill that teaches an agent the review loop; and the manifest that lets them install in one step. Everything but the skill is rendered by tools-common (`claudeplugin`), and `TestPluginIsCurrent` fails when the committed copy differs.

**The binary is the product and the licence boundary.** The plugin ships no galley code and grants no entitlement. `galley` must already be on PATH.

## Installing

This repository is its own marketplace — `.claude-plugin/marketplace.json` at the root lists the plugin at `./plugin/galley`.

```sh
claude plugin marketplace add subaud-tools/galley
claude plugin install galley@galley
```

The repository is public, so both commands work for anyone with `galley` on PATH. A session started after the install hears galley with plain `claude`. In a session that is already open, run `/reload-plugins` to load it.

## Versions

A version sweep across this repo will find two numbers and one place without one, and they are not the same thing. Nothing here should ever be "kept in sync".

| Where | What it is | Moves when |
|---|---|---|
| `/VERSION` | galley the binary | a galley release is cut |
| `plugin/galley/.claude-plugin/plugin.json` | **no version at all**: Claude Code versions the plugin by the commit it was installed from | any commit that changes the plugin |
| `skills/…/SKILL.md`'s "galley 0.4.0 or newer" | **a compatibility floor, not a stamp** | never, unless the floor itself moves |

The plugin does not track the binary. It ships protocol text and a mod, not galley code, and its manifest carries no version on purpose, so nobody has to bump one.

The floor is the one that catches people. **v0.4.0 is the first build with the verification key embedded**, so anything older runs trial-only whatever key it is given. Raising that sentence to the current version would tell a 0.4.0 user their licence is no good, which is false. It is a statement about the past and it stays put.

## Opening a document

The channel opens documents for its own session through the `galley_open` tool. It starts `galley edit <doc> --owner <session>` detached, which opens the page in the reviewer's browser, waits for the editor's advert, and returns the URL. A document the session already has open returns the same URL and opens nothing. The editor is bound to the session's channel presence and stops itself a few seconds after the session ends. An agent must not run `galley edit` from a shell while the channel is present: an editor opened that way carries no owner, and the first channel whose scope covers it claims it. `galley edit` without `--owner` is the human's command. The skill says so, and so do the channel instructions.

## Without the plugin

In an agent without the plugin or channels.tools, `galley wait <doc>` is the same events over a blocking pull, and `galley agent-prompt <doc>` prints the protocol for an agent starting cold. Neither needs a plugin or Claude Code.
