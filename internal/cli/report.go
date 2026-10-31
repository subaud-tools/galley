package cli

import (
	tools "github.com/subaud-tools/tools-common"
)

// reportCommand is `galley report`, which the galley plugin runs under Claude
// Code when a wake is held, lands, or its turn ends. It posts to the server,
// which hands it to every document the session owns; under pi the channel posts
// its own reports the same way.
func reportCommand() tools.Command {
	cmd := shell().ReportCommand()
	cmd.Group = "agent"
	cmd.Help = "Tells every document this session owns that a wake is held while the agent is\n" +
		"mid-turn, landed in the agent's turn, or that the turn ended, so the page shows\n" +
		"where the Revise stands. The galley plugin runs it under Claude Code, passing\n" +
		"the token from the wake's line; under pi the channel reports by itself.\n"
	return cmd
}
