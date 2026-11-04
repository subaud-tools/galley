package serve

import (
	"fmt"
	"net/http"
	"time"
)

const VerdictApproved = "approved"

type sealRecord struct {
	Sealed    bool      `json:"sealed"`
	Verdict   string    `json:"verdict,omitempty"`
	VerdictAt time.Time `json:"verdictAt,omitempty"`
}

func (s *EditServer) Sealed() bool {
	s.sealMu.Lock()
	defer s.sealMu.Unlock()
	return s.sealed
}

func (s *EditServer) sealState() sealRecord {
	s.sealMu.Lock()
	defer s.sealMu.Unlock()
	return sealRecord{Sealed: s.sealed, Verdict: s.verdict, VerdictAt: s.verdictAt}
}

func (s *EditServer) seal(verdict string, _ int) {
	s.sealMu.Lock()
	s.sealed = true
	s.verdict = verdict
	s.verdictAt = time.Now().UTC()
	s.sealMu.Unlock()
}

// restoreSeal seals a review approved before this server opened it, at the
// time it was approved: a kept review opened again.
func (s *EditServer) restoreSeal(verdict string, at time.Time) {
	s.sealMu.Lock()
	s.sealed = true
	s.verdict = verdict
	s.verdictAt = at
	s.sealMu.Unlock()
}

type sealedVerb int

const verbReview sealedVerb = 0

func (s *EditServer) refuseSealed(w http.ResponseWriter, _ sealedVerb) bool {
	st := s.sealState()
	if !st.Sealed {
		return false
	}
	http.Error(w, fmt.Sprintf("the review is sealed (%s)", st.Verdict), http.StatusConflict)
	return true
}

func (s *EditServer) handleStop(w http.ResponseWriter, r *http.Request) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	stop := s.OnStop
	if stop == nil {
		http.Error(w, "this server was started without a stop hook — Ctrl-C in the session that started it",
			http.StatusNotImplemented)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	go stop()
}
