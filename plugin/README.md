# galley plugin

The plugin carries four things: the `.mcp.json` entry pointing at `galley channel` on PATH, which serves galley's tools; the mod in `hooks/`, which runs `galley watch` and starts a turn with each event; the skill that teaches an agent the review loop; and the manifest that lets them install in one step. Everything but the skill is rendered by tools-common (`claudeplugin`), and `TestPluginIsCurrent` fails when the committed copy differs.

**The binary is the product and the licence boundary.** The plugin ships no galley code and grants no entitlement. `galley` must already be on PATH.

## Installing

This repository is its own marketplace — `.claude-plugin/marketplace.json` at the root lists the plugin at `./plugin/galley`.

```sh
claude plugin marketplace add subaud-tools/galley
claude plugin install galley@galley
```

The repository is public, so both commands work for anyone with `galley` on PATH.

## The launch flag does not go away

**Installing the plugin does not remove the per-session opt-in.** Channel servers are not ordinary MCP servers: they push events into the session, and Claude Code requires an explicit flag naming them at launch, installed or not.

What the install changes is *which* flag:

```sh
claude --channels plugin:galley@galley                          # installed
claude --dangerously-load-development-channels server:galley    # development path
```

The first needs no project `.mcp.json` and no `enabledMcpjsonServers` entry, and carries no `--dangerously-` prefix. That is the whole of the difference, and it is worth having — but a session launched without a flag hears nothing, and that is by design upstream, not a gap here.

The development path is the one that needs wiring, and **this repository does not ship the `.mcp.json` it wants** — it is per-project, and belongs in whichever repo holds the documents you are reviewing, not in galley's own tree. Write it there:

```json
{ "mcpServers": { "galley": { "command": "galley", "args": ["channel"] } } }
```

`galley` must be on PATH either way: both paths run the bare command, and neither ships the binary.

For an org, the equivalent is `channelsEnabled: true` plus an `allowedChannelPlugins` entry naming `galley` and this marketplace. Note that the key **replaces** the Anthropic default list — re-list Telegram, Discord and iMessage if the org uses them.

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

## Where the channel is not available

Channels are a research preview: they require Anthropic authentication and do not exist on Bedrock, Vertex or Foundry. Everywhere the channel cannot go, `galley wait <doc>` is the same events over a blocking pull, and `galley agent-prompt <doc>` prints the protocol for an agent starting cold. Neither needs a plugin, a flag, or Claude Code.
