package serve

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	tools "github.com/subaud-tools/tools-common"
)

// savedDoc is one open document in docs.json: what Host.Open needs to open it
// again. Its id follows from the path.
type savedDoc struct {
	Path string `json:"path"`
	DocOptions
}

// DocsPath keeps the open documents across restarts (0600): a document's
// OnRevise and OnSettle are commands the server runs.
func DocsPath() string { return filepath.Join(StateDir(), "docs.json") }

// loadDocs reads docs.json; no file is no documents.
func loadDocs(path string) ([]savedDoc, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var docs []savedDoc
	if err := json.Unmarshal(b, &docs); err != nil {
		return nil, err
	}
	return docs, nil
}

// saveDocs writes docs.json whole.
func saveDocs(path string, docs []savedDoc) error {
	b, err := json.MarshalIndent(docs, "", "  ")
	if err != nil {
		return err
	}
	return tools.WriteFileAtomic(path, append(b, '\n'), 0o600)
}
