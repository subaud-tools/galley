// channel.go is galley's part of `galley channel` and `galley watch`: its tools,
// and how a wait's answer becomes the wake the agent reads. The channel itself
// is tools-common pageserve's: under pi it holds one long poll on the server for
// this session (GET /api/agent/wait, which the server answers from every
// document the session owns, see serve/agent.go) and pushes each wake; under
// Claude Code the plugin's mod runs `galley watch`, the same loop printing each
// as a JSON line, and the channel only serves the tools.
//
// PRESENCE IS THE ONE THING GALLEY DOES AROUND IT. The channel announces its
// session in live() through pageserve's Around, which is where the server reads
// it (Options.Sessions), and the record lasts as long as this process:
// pageserve's loop posts no presence.
// So a server restart cannot judge a live session gone.
//
// NOT LICENSE-GATED, deliberately, agent-prompt's reasoning: this process
// lives inside an MCP harness where a gate message on stdout corrupts the
// JSON-RPC stream and presents as a silently dead server. Every mutating verb
// it leads the agent to — pending, suggest, ack — is gated at the server.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/subaud-tools/galley/internal/debug"
	"github.com/subaud-tools/galley/internal/serve"
	"github.com/subaud-tools/galley/internal/version"
	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/channelmcp"
	"github.com/subaud-tools/tools-common/pageserve"
)

// channelInstructions reaches the session's system prompt through the MCP
// handshake — the delivery mechanism `galley agent-prompt` never had. The
// content deliberately overlaps agent-prompt's: one protocol, two carriers.
// V8 rewrites agentprompt.go next against the SAME protocol, so keep this
// wording portable — its implementer reads this diff.
const channelInstructions = `You are paired with galley, a browser review surface for documents this session produces.
Events arrive as <channel source="galley" doc="…" reason="…"> or as a turn whose first line is galley event doc=… reason=…. On "revise" and "settle", the event carries the rules for answering it: read them, not only this.
Whenever you write to answer a round, on any event: make targeted, in-place edits to the .md file and never rewrite the whole file — the reviewer may be editing it at the same time, and a whole-file write can silently erase what they just wrote.
Between rounds, galley loads your edits to an open document. If you and the reviewer change it at the same time, the reviewer's copy is kept and yours is saved in .galley/recovery. Stop the review before moving or deleting the file.
If you have LOST the round — your context was compacted, or this session restarted mid-review — run galley round <doc> to read it again, with the same instructions and the same keys you were given. A sent round is no longer pending, so do not reach for galley pending instead.
On "approve", the reviewer approved the document as it stands and the review is over. On "changed", re-read the document before acting. On "closed", the editor is gone and nobody is waiting for more review work.
If you expect a review and hear nothing, call galley_channel_status. It reports which open documents this session is attached to and why any others are not.
To review a file, call galley_open with its path: it starts this session's review, opens it in the reviewer's browser and returns the URL in case they close it; rounds arrive here. Never run galley edit from a shell while this channel is present; an editor opened that way belongs to no session and any channel whose scope covers it may claim it.`

// reviseGuidance is the rule set that governs answering a "revise" or
// "settle" event — see reasonGuidance below.
const reviseGuidance = `The rules for answering this round. Revise the document by editing the .md file directly with your normal file tools — while you hold the round, galley watches the file and streams every save into the reviewer's browser, so save as often as you like. MAKE TARGETED EDITS AND NEVER REWRITE THE WHOLE FILE: the reviewer is editing that same file at the same time, so your copy is stale from the moment you read it, and one whole-file write silently destroys everything they typed since — including passages they deliberately deleted, which reappear because they are still in your copy. This has happened, and it cost a reviewer a section. A write your tools reject with "file has been modified since read" is that guard firing correctly; re-reading one line to satisfy it and writing the whole file anyway defeats the guard rather than answering it. Ordinary Markdown expresses everything: formatting, links, headings, lists, tables. Do not use raw HTML, footnotes, reference-style links, autolinks, definition lists, ::: directives, or [!NOTE] callouts; galley refuses those dialects and holds a save that will not parse until your next save fixes it.
When the whole revision is in the file, call galley_ack once with state "answered" and a one-sentence note; that commits your round — exactly once, for the whole revision, never per save. Pass "changes" with that call: one entry per change you made, each quoting a few words of what you WROTE so galley can find it, and naming in "answers" which instruction it answers by the key the round handed you. Every instruction in the round is printed with its key — the quoted words followed by [key cm-0fe4404...], or the key alone on its line for a whole-document instruction — and that key is what "answers" takes; without it the reviewer sees a change card with no ask beside it. Galley owns the list of what changed and computes it from the two documents; your entries only annotate it, so a quote it cannot place in exactly one changed passage is ignored, and so is a key it never sent you — the change still reaches the reviewer with no sentence beside it and nobody is shown an error. Quote text you actually wrote; omit "answers" when a change answers no instruction in particular. An instruction is the reviewer's guidance, not text to paste. Work out what they are asking for and write the change in the document's own voice. Do not copy their words into the prose, unless the instruction is itself the replacement wording (for example "declared not pinned"). A reviewer who wanted their exact words in the document would have typed them there. The revision itself is the answer: not a reply, and not a proposal the reviewer must accept.
On a round that takes more than a moment, your first move is galley_ack with state "working" and a one line note saying what you are doing; the reviewer reads it under the round's pill. "declined" (you will not do it) and "failed" (you tried and could not) settle the round instead of "answered", with why in the note. If you genuinely cannot do an instruction, run galley cannot <doc> --why "what stopped you". That records an unchanged exception round for the reviewer and shows the round as failed with your reason; it is a report, not an argument or retry.`

// reasonGuidance is the rule set that governs answering THIS event, and it
// travels with the event rather than living in the handshake.
//
// The write rule below is the reason this function exists. It is not style
// advice: the reviewer edits the same .md in their browser while the agent
// holds the round, and on 2026-08-22 a 21-instruction round answered with one
// whole-document write brought back a section the reviewer had deleted. A rule
// that arrives with the revise is adjacent to the temptation; the same rule in
// a handshake blob is a hundred thousand tokens behind it.
//
// The endings get a sentence. Their MEANING is wake.go's — this only says what
// to do next, and must not disagree with it.
func reasonGuidance(reason string) string {
	switch reason {
	case reasonRevise, reasonSettle:
		return reviseGuidance
	case reasonApprove:
		return "The review is over. Do not re-arm, and do not ack."
	case reasonChanged:
		return "Re-read the document before doing anything else — it changed under you."
	case reasonClosed:
		return "The editor is gone and nobody is waiting. Stop watching this document."
	default:
		return ""
	}
}

// composeWake is the notification as the agent reads it: the envelope sentence,
// then the separator, then the guidance for this event. Clients that split on
// the separator (pi-channels) can dedupe identical guidance across a coalesced
// batch; clients that do not render it as a readable rule.
func composeWake(reason, envelope string, paged bool) string {
	g := reasonGuidance(reason)
	// A page-backed revise/settle carries the same page-mode guidance the pull
	// carrier appends (pageBacked): edit content.md for wording or the original
	// .html for structure, and never galley's derived files. It rides HERE, not
	// in reasonGuidance, because it depends on the DOCUMENT (is it a page?), not
	// on the reason — reasonGuidance answers by reason alone. It joins the
	// guidance half after the one separator, so a client that splits on "---"
	// still sees exactly one. Without it a channel-woken agent had no page-mode
	// guidance at all and reached into template.json to answer a structural ask.
	if paged && (reason == reasonRevise || reason == reasonSettle) {
		g += "\n" + pageBacked
	}
	if g == "" {
		return envelope
	}
	return envelope + "\n\n---\n" + g
}

var ackSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "doc":   {"type": "string", "description": "path to the document under review"},
    "state": {"type": "string", "enum": ["working", "answered", "declined", "failed"], "description": "working (with a one-line note, first on a round that takes more than a moment), or how the round settled: answered, declined or failed (with why in the note)"},
    "note":  {"type": "string", "description": "one sentence for the reviewer (optional)"},
    "changes": {
      "type": "array",
      "description": "optional: one entry per change you made. Galley owns the list of what changed and only matches your entries onto it; an entry it cannot place is ignored without an error.",
      "items": {
        "type": "object",
        "properties": {
          "quote":   {"type": "string", "description": "a few words of what you WROTE, so galley can find this change"},
          "answers": {"type": "array", "items": {"type": "string"}, "description": "which instruction this answers, by the key the round handed you"},
          "note":    {"type": "string", "description": "one sentence about this change, for the reviewer"}
        },
        "required": ["quote"]
      }
    }
  },
  "required": ["doc", "state"]
}`)

// statusSchema takes no arguments on purpose: the question it answers is
// always the same one, and a filter would only let the model ask it wrongly.
var statusSchema = json.RawMessage(`{"type": "object", "properties": {}}`)

// openSchema takes the document and nothing else: which session owns the
// editor is this channel's to know, and a caller-supplied owner would be the
// environment-derived owner in different clothes.
var openSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "path to the .md or .html document, absolute or relative to the session's working directory"}
  },
  "required": ["doc"]
}`)

// approveSchema takes the document and nothing else, like the button.
var approveSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "doc": {"type": "string", "description": "path to the document under review"}
  },
  "required": ["doc"]
}`)

// channelSpec is galley's channel for pageserve. Scope makes the session's folder
// the root its wait names, which unowned documents are claimed from; there is no
// presence route, since the server reads presence from live().
func channelSpec() pageserve.Spec {
	return pageserve.Spec{
		Tool: "galley", Version: version.String(), Instructions: channelInstructions,
		Tools: []channelmcp.Tool{{
			Name:        "galley_ack",
			Description: "Acknowledge a galley review: tell the reviewer where their ask stands.",
			InputSchema: ackSchema,
		}, {
			Name: "galley_channel_status",
			Description: "Why is galley attached, or not? Lists every open document on this machine, " +
				"which ones this session receives wakes from, and the reason for each one it does not. " +
				"Call it when a reviewer says they pressed Revise and nothing arrived.",
			InputSchema: statusSchema,
		}, {
			Name: "galley_open",
			Description: "Put a document under review: add it to galley's server for THIS session and open the page in the reviewer's browser. " +
				"Returns the URL too, to give the reviewer if they closed the tab. " +
				"A document this session already has open returns the same URL, and opens its page again only when no tab shows it; " +
				"calling it on a document whose review has ended (approved or discarded) starts a fresh review. " +
				"This is the only way to open a document; do not run `galley edit` from a shell.",
			InputSchema: openSchema,
		}, {
			Name: "galley_approve",
			Description: "Approve a document under review. Call it only when the reviewer says in the conversation that they approve the document. " +
				"It ends the review exactly like the page's Approve button: the document is sealed as it stands and the page locks itself.",
			InputSchema: approveSchema,
		}},
		Call:       callTool,
		Scope:      func(cwd string) string { return cwd },
		Wake:       channelWake,
		Answers:    "review rounds",
		NoPresence: true,
		OnServe:    reannounce,
	}
}

// reannounce is a new server reached: it reads presence from live(), so says the
// session is here if the record has gone, and otherwise leaves the record alone.
// Under Claude Code this is `galley watch`, whose record would replace the
// channel's, and a session must not stop being live when watch restarts.
func reannounce(_ context.Context, ch *pageserve.Channel, _ pageserve.Entry) {
	if !live().SessionLive(ch.ID.Session) {
		if err := live().AnnounceSession(ch.ID.Session); err != nil {
			_, _ = fmt.Fprintf(ch.Log, "galley channel: cannot record this session's presence: %v\n", err)
		}
	}
}

// errNeedsDoc is a tool call that named no document: said as that, rather
// than as no editor running for the empty path.
func errNeedsDoc(tool string) error {
	return fmt.Errorf("%s needs the document path (doc)", tool)
}

func callTool(ctx context.Context, ch *pageserve.Channel, name string, args json.RawMessage) (string, error) {
	var p struct {
		Doc     string      `json:"doc"`
		State   string      `json:"state"`
		Note    string      `json:"note"`
		Changes []AckChange `json:"changes"`
	}
	if name != "galley_channel_status" {
		if err := json.Unmarshal(args, &p); err != nil {
			return "", err
		}
	}
	switch name {
	case "galley_channel_status":
		return status(ctx, ch), nil
	case "galley_open":
		return open(ctx, ch, p.Doc)
	case "galley_ack", "galley_approve":
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
	if p.Doc == "" {
		return "", errNeedsDoc(name)
	}
	rt, ok := serve.FindOn(ctx, ch.Client, p.Doc)
	if !ok {
		return "", fmt.Errorf("no running editor for %s", p.Doc)
	}
	if name == "galley_approve" {
		if err := postApprove(rt.URL); err != nil {
			return "", err
		}
		return "approved: the review of " + p.Doc + " is over and the page is locked", nil
	}
	if err := postAck(rt.URL, p.State, p.Note, p.Changes); err != nil {
		return "", err
	}
	return "acknowledged: " + p.State, nil
}

// --- why a document does or does not reach this session ---

// resolveSymlinks answers what a path REALLY is, and answers it for a path
// that does not exist yet: EvalSymlinks fails outright on a missing leaf, so
// the deepest existing ancestor is resolved and the rest re-joined.
func resolveSymlinks(p string) string {
	if p == "" {
		return p
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	dir, base := filepath.Split(p)
	dir = filepath.Clean(dir)
	if base == "" || dir == p {
		return p
	}
	return filepath.Join(resolveSymlinks(dir), base)
}

// inFolder is the containment test status reports, in one spelling of each path:
// one directory can have two names (/tmp is /private/tmp on macOS).
func inFolder(page, folder string) bool {
	page, folder = resolveSymlinks(page), resolveSymlinks(folder)
	return page == folder || strings.HasPrefix(page, strings.TrimSuffix(folder, string(filepath.Separator))+string(filepath.Separator))
}

// status is galley_channel_status: the answer to "I pressed Revise and nothing
// happened — why?".
//
// THE THREE SILENCES IT TELLS APART are the ones that look identical from
// inside a session and call for different actions: nothing is open (open
// something), something is open that another live session owns (that session
// is answering, not this one), and something is open outside this channel's
// root (the scope is wrong, or the document is). A fourth is new with one
// server: this session's documents are open and nothing of it is waiting on
// them, so a Revise has nobody to wake.
func status(ctx context.Context, ch *pageserve.Channel) string {
	self := ch.ID.Session
	scope := ch.ID.CWD
	var b strings.Builder
	if self == "" {
		fmt.Fprintf(&b, "galley channel — scope %s, no session id "+
			"(neither CLAUDE_CODE_SESSION_ID nor AGENT_SESSION_ID was set, so no wake reaches this channel)\n", scope)
	} else {
		fmt.Fprintf(&b, "galley channel — scope %s, session %s\n", scope, self)
	}
	var st serve.AgentStatus
	if _, err := ch.Client.Do(ctx, http.MethodGet, "/api/agent/status?"+pageserve.Query("session", self), nil, &st); err != nil {
		fmt.Fprintf(&b, "cannot reach galley serve: %v\n", err)
		return strings.TrimRight(b.String(), "\n")
	}
	var attached, unattached []string
	for _, d := range st.Docs {
		switch {
		case self != "" && d.Owner == self:
			attached = append(attached, "  "+d.Page)
		case d.Owner == "" && inFolder(d.Page, scope):
			unattached = append(unattached, fmt.Sprintf("  %s is open and no session owns it; the next session waiting under its folder takes it", d.Page))
		case d.Owner == "":
			unattached = append(unattached, fmt.Sprintf("  %s is open, but outside this channel's scope (%s)", d.Page, scope))
		case live().SessionLive(d.Owner):
			unattached = append(unattached, fmt.Sprintf("  %s is open, owned by session %s, whose channel is still running — "+
				"its wakes go to that session, not this one", d.Page, d.Owner))
		default:
			unattached = append(unattached, fmt.Sprintf("  %s is open, opened by session %s, which is no longer running — "+
				"it is closing; open it again with galley_open to review it in this session", d.Page, d.Owner))
		}
	}
	sort.Strings(attached)
	sort.Strings(unattached)
	switch {
	case len(attached) > 0 && st.Waiting:
		fmt.Fprintf(&b, "attached (%d) — a Revise here reaches this session:\n%s\n", len(attached), strings.Join(attached, "\n"))
	case len(attached) > 0:
		fmt.Fprintf(&b, "this session's documents (%d), and NOTHING of this session is waiting on them, so a Revise has nobody to wake:\n%s\n",
			len(attached), strings.Join(attached, "\n"))
	default:
		b.WriteString("attached (0) — no document is currently sending wakes to this session.\n")
	}
	if ch.ServeOnly && !st.Waiting {
		b.WriteString("This is a Claude Code session: rounds reach it through `galley watch`, which the galley plugin starts, " +
			"not through this process. If a Revise never arrived, check that the galley plugin is installed and enabled (/plugin).\n")
	}
	if len(unattached) > 0 {
		fmt.Fprintf(&b, "open but NOT attached (%d):\n%s\n", len(unattached), strings.Join(unattached, "\n"))
	}
	if len(st.Docs) == 0 {
		b.WriteString("no live editor is open: the server holds no document, " +
			"so there is no review to hear from. Call galley_open with a document to start one.\n")
	}
	if len(st.Gone) > 0 {
		fmt.Fprintf(&b, "recently gone (%d):\n  %s\n", len(st.Gone), strings.Join(st.Gone, "\n  "))
	}
	return strings.TrimRight(b.String(), "\n")
}

// channelWake reads one answer of the server's wait into the wake the agent
// gets. ok is false for nothing to push.
func channelWake(body json.RawMessage) (text string, meta map[string]string, ok bool) {
	var w serve.AgentWake
	if err := json.Unmarshal(body, &w); err != nil || w.Reason == "" {
		return "", nil, false
	}
	text, meta = renderWake(w)
	return text, meta, true
}

// countUnknown is what a caller passes for a count it could not read, and
// countMeta is what the meta says about one: `unknown`, never a digit.
//
// A closed document produces it: every other wake carries the counts in the
// same answer that carried the reason, and with the document gone there is
// nothing to read them from. `0` would say the document is clean at the moment
// the whole review was lost.
const countUnknown = -1

func countMeta(n int) string {
	if n < 0 {
		return "unknown"
	}
	return strconv.Itoa(n)
}

// renderWake renders one wake as a channel event.
func renderWake(w serve.AgentWake) (string, map[string]string) {
	var pending pendingPayload
	instructions := countUnknown
	if w.Pending != nil {
		pending, instructions = *w.Pending, len(w.Pending.Instructions)
	}
	reason, fp, note, report := w.Reason, w.Fingerprint, w.Note, w.Report
	// THE FOUR ENDINGS COME FROM wake.go, which is the ONE place either
	// carrier turns a wake into a meaning. This switch used to hold them, and
	// `galley wait` held its own four — which is how the pull carrier came to
	// tell an agent the review was over during an open handoff.
	//
	// It answers "" for the two wakes each carrier says in its own voice, and
	// those two are this switch: they name galley_ack, an MCP tool a shell
	// loop cannot call, so there is nothing here for the other carrier to
	// agree or disagree with. See wake.go's header.
	content := wake{reason: reason, page: w.Page, note: note, instructions: instructions}.sentence()
	if content == "" {
		switch reason {
		case reasonSettle:
			content = fmt.Sprintf("%s settled in live mode — %d instruction(s).", w.Page, instructions)
		default:
			content = fmt.Sprintf("Revision requested on %s — %d instruction(s).", w.Page, instructions)
		}
		if len(pending.Instructions) > 0 {
			// THE REVIEWER'S OWN EDITS LEAD THE ROUND. An agent reads in
			// order and acts in order; "do not undo these" arriving after
			// eight asks to expand and clarify has already lost. This is the
			// carrier the measured failure happened on.
			content += " The captured round follows:\n\n" +
				formatReviewerChanges(pending.Changes, pending.ChangesDropped) +
				strings.TrimRight(formatInstructions(pending.Instructions), "\n")
		}
	}
	content = composeWake(reason, content, pageBackedDoc(w.Page))
	meta := map[string]string{
		"doc":          w.Page,
		"reason":       reason,
		"fingerprint":  fp,
		"instructions": countMeta(instructions),
	}
	// Additive, and only where there is one: a "note" key on every wake would
	// advertise a field that means nothing on four of the five.
	if note != "" {
		meta["note"] = note
	}
	if report != "" {
		meta[channelmcp.MetaReport] = report
	}
	// THE NOTIFICATION AS SENT, and it is recorded HERE — after `content` is
	// composed and before it goes out — because the whole point is the rendered
	// text the agent actually read, not a reconstruction of it from the parts.
	// On 2026-08-22 the only surviving copy of this string was a Claude Code
	// transcript belonging to a different project. Opt-in; see internal/debug.
	debug.Log(debug.Event{
		Kind:         debug.KindRoundSent,
		Where:        "channel",
		Doc:          w.Page,
		Room:         w.Room,
		Reason:       reason,
		Fingerprint:  fp,
		Note:         note,
		Rendered:     content,
		Instructions: debug.Int(instructions),
		Asks:         debugAsks(pending.Instructions),
	})
	return content, meta
}

// debugAsks copies the captured round into the debug record's own type. It is
// the ASKS AS DELIVERED — key, words and quote — which is the second half of
// the question the rendered text alone cannot answer: whether the key the agent
// was handed is the key the server recorded on the round.
func debugAsks(in []instructionPayload) []debug.Ask {
	if len(in) == 0 || !debug.On() {
		return nil
	}
	out := make([]debug.Ask, 0, len(in))
	for _, p := range in {
		out = append(out, debug.Ask{Key: p.Key, Text: p.Text, Quote: p.Quote})
	}
	return out
}

// aroundChannel runs the channel with the session announced throughout: a
// document leaves with its owner's presence, and galley_open's owner must be
// live. Under Claude Code too, where the channel only serves tools: it is the
// process that lasts the session. Best-effort in both directions: one that dies
// without withdrawing is reaped by PID on the next read.
func aroundChannel(_ context.Context, ch *pageserve.Channel, run func() error) error {
	refreshSkill(ch.Log)
	// The three measurements from the design spec, answered on every start and
	// visible in the harness debug log (~/.claude/debug/<session>.txt).
	cwd, _ := os.Getwd()
	_, _ = fmt.Fprintf(ch.Log, "[galley channel] cwd=%s session_id_present=%t scope=%s\n", cwd, ch.ID.Session != "", ch.ID.CWD)
	if id := ch.ID.Session; id != "" {
		if err := live().AnnounceSession(id); err != nil {
			_, _ = fmt.Fprintf(ch.Log, "[galley channel] cannot record this session's presence: %v — "+
				"documents it opens cannot bind to its lifetime\n", err)
		}
		defer func() { _ = live().WithdrawSession(id) }()
	}
	return run()
}

// shell is galley's channel, watch and report: pageserve's, over galley's
// channel. Skill is not set: pageserve looks for a skill named after the tool, and
// galley's is reviewing-a-document, which aroundChannel refreshes.
func shell() pageserve.Commands {
	return pageserve.Commands{Spec: channelSpec(), Process: serve.Process(), Group: "agent", Around: aroundChannel}
}

// channelCommand is `galley channel`: the session's MCP server on stdio.
func channelCommand() tools.Command {
	const help = "An MCP channel server on stdio. It opens documents for this session through\n" +
		"its galley_open tool, starting the server if needed, and serves galley's other\n" +
		"tools. Under pi it also waits on the server for every document this session owns,\n" +
		"plus any under --scope that no session owns at all, and pushes each Revise,\n" +
		"settle, Approve — and a document going away — into the session as an event.\n" +
		"The galley_channel_status tool says why any other open document does not reach it.\n" +
		"Under Claude Code it serves the tools only: `galley watch`, which the galley plugin\n" +
		"runs, delivers the events.\n"
	cmd := shell().ChannelCommand(os.Stdin, pageserve.Help{
		Synopsis: "[--scope <dir>]",
		Summary:  "MCP channel server — pushes review wakes into the session",
		Long:     help,
	})
	cmd.Synopsis, cmd.Help = "channel [--scope <dir>]", help
	return cmd
}

// watchCommand is `galley watch`: the channel's wait loop, printing each wake as
// one JSON line on stdout for the Claude Code plugin's mod.
func watchCommand() tools.Command {
	const help = "Waits on the server for this session and prints each Revise, settle, Approve — and\n" +
		"its document going away — as one JSON line {\"text\": ..., \"content\": ..., \"meta\":\n" +
		"{...}} on stdout. The galley plugin's mod runs it for a Claude Code session and starts a\n" +
		"turn with each line's text. Diagnostics go to stderr. Runs until signalled. It never\n" +
		"starts the server. In a session pi's claude-bridge runs, it prints {\"stop\": ...} and\n" +
		"exits 0."
	cmd := shell().WatchCommand(pageserve.Help{
		Summary: "print review wakes as JSON lines — the Claude Code plugin's feed",
		Long:    help,
	})
	cmd.Synopsis, cmd.Help = "watch", help
	return cmd
}
