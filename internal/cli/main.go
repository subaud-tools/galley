// Command galley builds and serves the review a branch gets before it goes
// anywhere one-way — a force-push to an in-review PR, an upstream PR, an issue.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/galley/internal/version"
	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

// about is galley's overview, shown by `galley help` above the generated
// command list and used as the man page DESCRIPTION (tools.Config.About).
// The per-command lines it used to carry are generated from the registry now,
// so they can no longer drift from what galley actually dispatches.
const about = `^ galley — review before the one-way door.

The READING commands speak --json — pending, wait, round and ledger —
and that is where the machine-readable surface is; this line used to
claim every command did, and most did not.

pending goes through a running server when there is one, and falls back to the
file. The agent's revision is the file itself: edit the .md, then 'galley ack'.
revise has no offline form — it wakes whoever is
listening, a 'galley wait' session or --on-revise's command, and without a
server there is nothing to hand it to.

galley pushes and pulls. Push wakes someone who is not here:
  galley edit doc.md --on-revise '<shell command>'

Pull is for the agent session that already IS here, holding the branch and the
discussion — it waits on the document instead of being spawned fresh:
  galley wait doc.md

Pull is the better loop and should be the default. When there is no session in
the room, push can spawn one — with the document and nothing else — and
'galley agent-prompt' is the text that tells it what to do:
  galley edit doc.md --on-revise 'claude -p "$(galley agent-prompt doc.md)"'

The channel is pull, packaged: it starts with the session, waits on every
document this session opens — and any unowned one under its root — and delivers
each Revise, settle and Approve into the session as an event. No listener to
remember. In Claude Code it comes from galley's plugin; install it once, then
start claude as usual:
  claude plugin marketplace add subaud-tools/plugins
  claude plugin install galley@subaud-tools

Turn on auto-update for the subaud-tools marketplace so the plugin stays
current: in Claude Code, run /plugin, open the Marketplaces tab, select
subaud-tools and choose Enable auto-update.

The skill that teaches the loop comes from the binary, not the plugin:
  galley skills install

In pi, the channels.tools extension runs 'galley channel'. See
plugins/galley/README.md in subaud-tools/plugins.

'galley render doc.md' writes the document's branded HTML page without an
editor, the same page Share HTML writes.

Run 'galley <command> -h' for a command's flags.
`

func usageErr(fs *flag.FlagSet, err error) error {
	if !errors.Is(err, flag.ErrHelp) {
		fs.Usage()
	}
	return err
}

// splitPositional parses fs allowing flags before or after positionals
// (tools.SplitArgs), then requires exactly one positional (every galley verb
// takes exactly one document). It replaces parsePositional for commands
// registered with NewFlags/Synopsis/Help: -h is rendered by tools.App's HelpFor
// from those, so this no longer needs a SetUsage call or usageErr's
// fs.Usage()-on-parse-error handling of its own — tools.ParseFlags already
// renders help and wraps a bad flag as a UsageError.
func splitPositional(fs *flag.FlagSet, args []string, out io.Writer) ([]string, error) {
	flagArgs, pos := tools.SplitArgs(fs, args)
	if err := tools.ParseFlags(fs, flagArgs, out); err != nil {
		return nil, err
	}
	if len(pos) != 1 {
		return nil, tools.UsageError{Msg: fmt.Sprintf("expected 1 argument(s), got %d", len(pos))}
	}
	return pos, nil
}

// Dispatch is the exported entrypoint cmd/galley's main() calls. It runs
// dispatch and then drains the decision log exactly once before returning the
// process exit code.
func Dispatch(args []string, out, errw io.Writer) int {
	code := dispatch(args, out, errw)
	// THE LAST THING, BEFORE ANY EXIT. Decisions are remembered on a background
	// goroutine so a file write can never sit in front of one; a CLI process
	// decides and exits within milliseconds, so without this drain the record
	// would leave with the process. It is bounded and it cannot fail — see
	// flushDecisions. dispatch() never itself calls os.Exit, so this drain runs
	// on every path before the one exit below.
	flushDecisions()
	flushDebug()
	return code
}

// dispatch routes every invocation through the shared tools.App: help,
// version, man, commands and unknown-command handling are the family's; galley
// supplies its commands, groups and About text. It returns the exit code
// rather than exiting, so Dispatch can drain the decision log exactly once.
func dispatch(args []string, out, errw io.Writer) int {
	return newApp().Dispatch(args, out, errw)
}

// newApp builds the tools.App with every galley command registered. Summaries
// are short one-liners; per-command Synopsis/Help/NewFlags come in later tasks,
// and each command still self-handles its own flags (including -h) through its
// own flag set for now.
func newApp() *tools.App {
	app := tools.New(tools.Config{
		Name:   "galley",
		Domain: "galley.tools",
		About:  about,
		Groups: []tools.Group{
			{Key: "review", Heading: "Review"},
			{Key: "agent", Heading: "Agent"},
			{Key: "record", Heading: "Record"},
		},
		Version: tools.Version{
			Number: version.Version(),
			Commit: version.Commit(),
			Date:   version.Date(),
		},
	})
	app.Register(tools.Command{
		Name:     "edit",
		Group:    "review",
		Summary:  "serve a markdown document as a live, TipTap editor",
		Synopsis: "edit <doc.md|page.html> [flags]",
		Help: "Revise wakes whoever is listening: a session blocked on `galley wait <doc>`\n" +
			"always, plus --on-revise's command if one is configured — refused only when\n" +
			"neither is present. A hook and a waiter are not alternatives; both fire if\n" +
			"both are there. A settle only reaches `galley wait` while the editor is in\n" +
			"● live mode (toggled in the browser), whether or not --on-settle is set.\n\n" +
			"The hook is told a round arrived, NOT to go read `galley pending` — a sent\n" +
			"round is no longer pending, so the woken agent runs `galley wait <doc>`,\n" +
			"which prints the captured round it was woken by.\n\n" +
			"Starts `galley serve` if it is not running and opens the document on it, prints\n" +
			"its address and stays until the document closes. Ctrl-C closes the document and\n" +
			"leaves the server. --port reaches the server only when this command starts it;\n" +
			"a server already running elsewhere is said on stderr, and the document opens there.\n\n" +
			"--owner <session-id> binds the document to a session whose channel is live: the\n" +
			"channel's galley_open tool passes it, and the document closes when that session\n" +
			"ends. Without --owner it belongs to no session.\n\n" +
			"--on-revise example:\n" +
			"  galley edit doc.md --on-revise 'muster send <alias> " +
			"\"galley: revision requested — run: galley wait <doc>\" " +
			"--from galley --intent action-requested && muster nudge <alias>'",
		NewFlags: func() *flag.FlagSet { fs, _ := newEditFlags(); return fs },
		Run:      runEdit,
	})
	app.Register(tools.Command{
		Name:     "pending",
		Group:    "review",
		Summary:  "list the reviewer's instructions for the open round",
		Synopsis: "pending <doc.md> [flags]",
		Help: "List the reviewer's instructions for the OPEN round — the ones they have\n" +
			"left but not yet sent. A SENT round is no longer pending, so after a wake\n" +
			"this shows only newer, unsent work; `galley wait <doc>` is what re-reads\n" +
			"the round that woke you.\n\n" +
			"Goes through a running editor when there is one, and falls back to the\n" +
			"file.",
		NewFlags: func() *flag.FlagSet { fs, _ := newPendingFlags(); return fs },
		Run:      runPending,
	})
	app.Register(tools.Command{
		Name:     "cannot",
		Group:    "review",
		Summary:  "report the one case you could not do it",
		Synopsis: "cannot <doc.md> --why \"what stopped you\"",
		Help: "For the one case a revision has no answer for: you genuinely could\n" +
			"not do what was asked. It is recorded as a round of its own — the document\n" +
			"unchanged, the reason beside the instruction — so the reviewer reads it where\n" +
			"they read everything else, and answers with a different instruction.\n\n" +
			"It is not a retry and not a refusal to be argued with. A reason is required:\n" +
			"a report with none is something the reviewer cannot act on.",
		NewFlags: func() *flag.FlagSet { fs, _ := newCannotFlags(); return fs },
		Run:      runCannot,
	})
	app.Register(tools.Command{
		Name:     "revise",
		Group:    "review",
		Summary:  "wake whoever is listening",
		Synopsis: "revise <doc.md>",
		Help: "Sends the round and wakes whoever is listening for its instructions: a\n" +
			"session blocked on `galley wait <doc>` if one is there, and --on-revise's\n" +
			"command if `galley edit` was started with one. Refused only when neither\n" +
			"is — see `galley edit -h`. There is no offline equivalent: without a\n" +
			"server there is nothing to hand the work to.",
		NewFlags: newReviseFlags,
		Run:      runRevise,
	})
	app.Register(tools.Command{
		Name:     "ack",
		Group:    "review",
		Summary:  "tell the reviewer where their ask stands",
		Synopsis: "ack <doc.md> --state <state> [--note \"…\"]",
		Help: "Tell the reviewer where their ask stands. received and working keep the\n" +
			"revising counter honest; answered, declined and failed close it with a\n" +
			"stated outcome. The revision itself goes into the document — edit the .md\n" +
			"directly with your normal file tools; this ack commits the round ONCE, for\n" +
			"the whole revision, never per save.\n\n" +
			"--changes annotates what you wrote. Galley owns the list of what changed and\n" +
			"matches your entries onto it; an entry whose quote it cannot place, or which\n" +
			"names a key it never sent, is dropped without an error.",
		NewFlags: func() *flag.FlagSet { fs, _ := newAckFlags(); return fs },
		Run:      runAck,
	})
	app.Register(tools.Command{
		Name:     "round",
		Group:    "review",
		Summary:  "re-read a round already sent",
		Synopsis: "round <doc.md> [--n N] [--json]",
		Help: "Re-read a round that was already sent — the instructions, with their keys,\n" +
			"exactly as the agent was given them.\n\n" +
			"Without --n it prints the most recent round that ASKED for something, which\n" +
			"is the one an agent that restarted is trying to recover. --n names a round\n" +
			"by its number, whatever kind it is.",
		NewFlags: func() *flag.FlagSet { fs, _ := newRoundFlags(); return fs },
		Run:      runRound,
	})
	app.Register(tools.Command{
		Name:     "wait",
		Group:    "review",
		Summary:  "block until the reviewer asks, then print what is pending",
		Synopsis: "wait <doc.md> [flags]",
		Help: "Blocks until the reviewer presses Revise, presses Approve, or — in ● live\n" +
			"mode — until the document settles, then prints the captured round. An\n" +
			"approve ends the review; the other wakes ask for an answer. A review that\n" +
			"has ALREADY ended is reported at once rather than waited on. There is no\n" +
			"offline form: without a running editor there is nothing to wait for in a\n" +
			"file.\n\n" +
			"Pass the fingerprint each wake prints back as --since on the next call, so\n" +
			"an event that arrives between two waits is caught up rather than lost. A\n" +
			"catch-up wakes with the reason `changed`, which names no event: the cursor\n" +
			"was behind and the document moved, and the editor does not record what\n" +
			"moved it — re-read everything and diff it against what you last saw.\n\n" +
			"Exit codes: 0 woke · 3 --timeout elapsed · 4 the editor stopped",
		NewFlags: func() *flag.FlagSet { fs, _ := newWaitFlags(); return fs },
		Run:      runWait,
	})
	app.Register(tools.Command{
		Name:     "render",
		Group:    "review",
		Summary:  "write the document's branded HTML page, without an editor",
		Synopsis: "render <doc.md> [-o out.html]",
		Help: "Writes the page Share HTML writes — the project's theme, the same renderer,\n" +
			"diagrams drawn by the embedded mermaid.js — without starting an editor, and\n" +
			"prints the path it wrote. By default that is <name>.html beside the\n" +
			"document; -o writes it elsewhere.\n\n" +
			"A theme or render error is printed and nothing is written, so it is also\n" +
			"how to check a theme. Markdown only: a page review is already HTML.",
		NewFlags: func() *flag.FlagSet { fs, _ := newRenderFlags(); return fs },
		Run:      runRender,
	})
	app.Register(tools.Command{
		Name:     "agent-prompt",
		Group:    "agent",
		Summary:  "print instructions for an agent about to answer the review",
		Synopsis: "agent-prompt <doc.md>",
		Help: "Print instructions for an agent answering this document review.\n" +
			"The output is static; galley never calls a model.",
		NewFlags: newAgentPromptFlags,
		Run:      runAgentPrompt,
	})
	app.Register(channelCommand())
	app.Register(watchCommand())
	app.Register(tools.Command{
		Name:        "skills",
		Group:       "agent",
		Summary:     "install galley's agent skill for each harness",
		Synopsis:    "skills install [--agent NAME]…",
		Subcommands: []string{"install"},
		Help: "Installs the reviewing-a-document skill this binary was built with, as\n" +
			"<skills dir>/reviewing-a-document/SKILL.md, for each agent harness found\n" +
			"(Claude Code ~/.claude, Codex ~/.codex, pi ~/.pi/agent: by their home\n" +
			"directories), or for each --agent named (claude-code, codex, pi). An existing\n" +
			"SKILL.md there is replaced only when it is galley's own\n" +
			"(name: reviewing-a-document). galley channel rewrites an installed copy that\n" +
			"differs from its own each time it starts, so install once per harness.",
		NewFlags: newSkillsFlags,
		Run:      runSkills,
	})
	app.Register(serveCommand())
	app.Register(reportCommand())
	// ledger dispatches its own sub-verbs; declaring them as Subcommands lets
	// `galley ledger -h` show this help while `galley ledger sync -h` reaches
	// the sub-verb's own flag set.
	app.Register(tools.Command{
		Name:        "ledger",
		Group:       "record",
		Summary:     "galley's memory — sync, rebuild, stats",
		Synopsis:    "ledger <sync|rebuild|stats> [flags]",
		Help:        strings.TrimPrefix(ledgerUsage, "Usage: galley ledger <sync|rebuild|stats> [flags]\n\n"),
		Subcommands: []string{"sync", "rebuild", "stats"},
		Run:         runLedger,
	})
	return app
}

func openBrowser(url string) {
	// Opening a browser is a convenience; failing to is not an error worth
	// stopping the server for.
	_ = localweb.OpenBrowser(url)
}

// serveCommand is `galley serve`: pageserve's command over galley's server, in
// the foreground with no flag and opening no browser, as its channel will start
// it and galley_open opens the page.
func serveCommand() tools.Command {
	cmd := pageserve.Commands{
		Spec:       pageserve.Spec{Tool: "galley"},
		Process:    serve.Process(),
		Group:      "review",
		Foreground: true,
		Serve: func(ctx context.Context, port int, errw io.Writer) error {
			return serve.Run(ctx, serve.Options{
				Port: port, Version: version.Version(), Sessions: live(), Log: errw,
				Ready: func(url string) { _, _ = fmt.Fprintln(errw, url) },
			})
		},
	}.ServeCommand(pageserve.Help{
		Synopsis: "[--port N] [--stop]",
		Summary:  "run the local server that holds every open document (one per machine), or stop it",
		Long:     serveHelp,
	})
	cmd.Help = serveHelp
	return cmd
}

const serveHelp = "Runs the review server in this process until it is stopped: one per machine, holding\n" +
	"every open document behind one port and token. Open documents and the token are kept in\n" +
	"its state folder, so a restart brings back each one whose owning session is still live.\n" +
	"A document leaves when its owning session is gone, or once it is approved and no page\n" +
	"holds it. Opens no browser and needs no network."
