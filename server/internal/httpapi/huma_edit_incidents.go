package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func (a *api) registerEditIncidents(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/edit-incidents", "reportEditIncident", "Editing",
		"Report an editing incident", http.StatusNoContent, 4<<10, a.reportEditIncident)
}

type editIncidentInput struct {
	Body apimodel.ReportEditIncidentReq
}

// reportEditIncident stores the incident as the caller's. The file is not
// checked: drafts of a file the account lost are reported too, and a row is
// operator data attributed to its reporter.
func (a *api) reportEditIncident(ctx context.Context, in *editIncidentInput) (*Empty, error) {
	if err := a.s.RecordEditIncident(ctx, userID(ctx), store.EditIncident{
		FileID:    in.Body.FileID,
		FileKind:  in.Body.FileKind,
		Kind:      in.Body.Kind,
		Reason:    in.Body.Reason,
		SizeBytes: in.Body.SizeBytes,
	}); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
