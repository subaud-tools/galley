package cli

import (
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/subaud-tools/galley/plugin/galley/skills"
	tools "github.com/subaud-tools/tools-common"
	commonskills "github.com/subaud-tools/tools-common/skills"
)

// agents is a repeatable --agent flag.
type agents []string

func (a *agents) String() string     { return strings.Join(*a, ",") }
func (a *agents) Set(v string) error { *a = append(*a, v); return nil }

func newSkillsFlags() *flag.FlagSet {
	fs := flag.NewFlagSet("skills", flag.ContinueOnError)
	fs.Var(new(agents), "agent", "a harness to install for (repeatable): claude-code, codex or pi")
	return fs
}

// runSkills is `galley skills install`: the skill this binary was built with,
// written for each harness found or named.
func runSkills(args []string, out, errw io.Writer) error {
	fs := newSkillsFlags()
	flagArgs, pos := tools.SplitArgs(fs, args)
	if err := tools.ParseFlags(fs, flagArgs, out); err != nil {
		return err
	}
	if len(pos) != 1 || pos[0] != "install" {
		return tools.UsageError{Msg: "expected: galley skills install [--agent NAME]…"}
	}
	body, err := skills.Body()
	if err != nil {
		return tools.Exitf(2, "%v", err)
	}
	return commonskills.Install(skills.Name, body, *fs.Lookup("agent").Value.(*agents), out, errw)
}

// refreshSkill rewrites each installed copy of galley's skill that differs
// from the one this binary was built with, so the skill an agent reads
// matches the binary it calls. It logs each path it rewrote to errw, never
// stdout (the channel's MCP stream); an error is logged and the channel
// starts anyway.
func refreshSkill(errw io.Writer) {
	body, err := skills.Body()
	if err == nil {
		var paths []string
		paths, err = commonskills.Refresh(skills.Name, body)
		for _, p := range paths {
			_, _ = fmt.Fprintf(errw, "[galley channel] refreshed the %s skill at %s\n", skills.Name, p)
		}
	}
	if err != nil {
		_, _ = fmt.Fprintf(errw, "[galley channel] refreshing the %s skill: %v\n", skills.Name, err)
	}
}
