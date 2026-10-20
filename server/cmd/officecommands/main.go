// Command officecommands turns edit_office_document's commands into the
// engine's as the gateway does (httpapi.NormalizeOfficeCommands), for the lab
// playground's local Office edits. It reads {"format", "commands"} on stdin and
// prints the engine commands as a JSON array, or the refusal as
// {"code", "message"} with exit status 1.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func main() {
	var req struct {
		Format   string            `json:"format"`
		Commands []json.RawMessage `json:"commands"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	out, err := httpapi.NormalizeOfficeCommands(req.Format, req.Commands)
	var refusal *store.EditRefusal
	switch {
	case errors.As(err, &refusal):
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"code": string(refusal.Code), "message": refusal.Message})
		os.Exit(1)
	case err != nil:
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
