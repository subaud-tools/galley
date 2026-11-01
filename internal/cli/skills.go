package cli

import (
	"flag"
	"io"
	"strings"

	"github.com/subaud-tools/galley/skills"
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
