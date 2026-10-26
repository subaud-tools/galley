package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/subaud-tools/galley/internal/registry"
	tools "github.com/subaud-tools/tools-common"
	"github.com/subaud-tools/tools-common/channelmcp"
)

// reportClient bounds one report's post: an editor that does not answer must
// not hold up the next report, or the command the plugin ran.
var reportClient = &http.Client{Timeout: 5 * time.Second}

// deliverReport hands the harness's report to every live editor the registry
// lists as owned by session: POST <url>/_galley/report with {event, token}.
// Each editor resolves it against its own window, so a token that is not its
// message's changes nothing there. A failed post is returned (and logged by
// the caller), not retried. `galley report` calls it under Claude Code; the
// channel's report queue calls it under pi.
func deliverReport(session string, event channelmcp.ReportEvent, token string) error {
	entries, err := registry.List()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"event": string(event), "token": token})
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		if e.Owner == "" || e.Owner != session {
			continue
		}
		resp, err := reportClient.Post(e.URL+"/_galley/report", "application/json", bytes.NewReader(body))
		if err != nil {
			errs = append(errs, fmt.Errorf("report %s to %s: %w", event, e.Page, err))
			continue
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			errs = append(errs, fmt.Errorf("report %s to %s: %s", event, e.Page, resp.Status))
		}
	}
	return errors.Join(errs...)
}

// reportCommand is `galley report`, which the galley plugin runs under Claude
// Code when a wake is held, lands, or its turn ends.
func reportCommand() tools.Command {
	cmd := channelmcp.ReportCommand(deliverReport)
	cmd.Group = "agent"
	cmd.Help = "Tells every editor this session owns that a wake is held while the agent is\n" +
		"mid-turn, landed in the agent's turn, or that the turn ended, so the page shows\n" +
		"where the Revise stands. The galley plugin runs it under Claude Code, passing\n" +
		"the token from the wake's line; under pi the channel reports by itself.\n"
	return cmd
}
