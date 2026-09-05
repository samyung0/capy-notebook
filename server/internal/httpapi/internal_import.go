package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/store"
)

// The pipeline's import worker drives one provider import per queue claim:
// acquire an attempt (provider metadata plus a download grant), stream the
// bytes into the attempt's incoming object with its own B2 credentials, then
// complete or fail the attempt here. Retry scheduling lives on the jobs row;
// the attempt lease on source_import_jobs only fences stale callbacks.

type importJobReq struct {
	JobID string `json:"jobId"`
}

type importCompleteReq struct {
	JobID        string `json:"jobId"`
	AttemptToken string `json:"attemptToken"`
	ActualSize   int64  `json:"actualSize"`
}

type importFailureReq struct {
	JobID        string `json:"jobId"`
	AttemptToken string `json:"attemptToken"`
	Code         string `json:"code"`
	Retryable    bool   `json:"retryable"`
}

func writeImportCapacityRetry(w http.ResponseWriter, err error) {
	w.Header().Set("Retry-After", "300")
	if errors.Is(err, store.ErrTooManyIngestLeases) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":    "too_many_ingest_leases",
			"message": "too many ingest jobs in progress",
		})
		return
	}
	var credits *store.CreditsExhaustedError
	if errors.As(err, &credits) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":                  "llm_credits_exhausted",
			"message":               "monthly AI credits exhausted",
			"creditsUsedMicros":     credits.UsedMicros,
			"creditsReservedMicros": credits.ReservedMicros,
			"creditsLimitMicros":    credits.LimitMicros,
			"planTier":              string(credits.PlanTier),
		})
		return
	}
	// A bare sentinel must still read as "retry later", never as an empty 200
	// the worker would take for a finalized file.
	writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "import_capacity"})
}

func (a *api) commitImportFailure(
	w http.ResponseWriter,
	r *http.Request,
	job store.SourceImportJob,
	code, message string,
) bool {
	err := a.s.MarkSourceImportFailed(
		r.Context(), job.ID, job.LeaseToken, code, message,
	)
	if errors.Is(err, store.ErrImportLeaseLost) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
		return false
	}
	if err != nil {
		a.fail(w, err)
		return false
	}
	return true
}

func (a *api) sourceImportActorAvailable(
	w http.ResponseWriter,
	r *http.Request,
	job store.SourceImportJob,
) bool {
	if job.ActorUserID == nil {
		if !a.commitImportFailure(
			w, r, job,
			"actor_unavailable", "import actor is unavailable",
		) {
			return false
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "actor_unavailable"})
		return false
	}
	allowed, code, err := a.s.AccountSessionAllowed(r.Context(), *job.ActorUserID)
	if err != nil {
		a.fail(w, err)
		return false
	}
	if !allowed {
		if !a.commitImportFailure(w, r, job, code, "import actor is locked") {
			return false
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": code})
		return false
	}
	if err := a.s.AssertWorkspaceEditor(r.Context(), *job.ActorUserID, job.WorkspaceID); err != nil {
		if !errors.Is(err, store.ErrForbidden) && !errors.Is(err, store.ErrNotFound) {
			a.fail(w, err)
			return false
		}
		if !a.commitImportFailure(
			w, r, job,
			"workspace_access_revoked", "workspace access was revoked",
		) {
			return false
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "workspace_access_revoked"})
		return false
	}
	return true
}

func (a *api) internalAcquireSourceImport(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req importJobReq
	if err := decode(r, &req); err != nil || strings.TrimSpace(req.JobID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "jobId is required"})
		return
	}
	job, err := a.s.AcquireSourceImport(r.Context(), req.JobID)
	if errors.Is(err, store.ErrImportNotReady) {
		// failed, cancelled, or an expired upload session the sweeper will
		// close: the worker ends its queue row and stops, even if a stale
		// attempt still holds the lease.
		status := job.Status
		if job.SessionExpired {
			status = "expired"
		}
		if status != "running" {
			writeJSON(w, http.StatusOK, map[string]any{"status": status, "jobId": job.ID})
			return
		}
		// Another attempt still holds the lease; the worker waits it out using
		// the remaining lease time as its backoff.
		if job.LeaseExpiresAt != nil {
			remaining := max(int(time.Until(*job.LeaseExpiresAt).Seconds()), 1)
			w.Header().Set("Retry-After", strconv.Itoa(remaining))
		}
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_not_ready"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if job.Status == "succeeded" {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "succeeded",
			"jobId":  job.ID,
		})
		return
	}
	if !a.sourceImportActorAvailable(w, r, job) {
		return
	}

	acquired := map[string]any{
		"status":            "acquired",
		"jobId":             job.ID,
		"attemptToken":      job.LeaseToken,
		"attemptObjectPath": job.AttemptObjectPath,
		"contentType":       job.ContentType,
		"declaredSize":      job.DeclaredSize,
		"maxBytes":          job.MaxBytes,
	}
	if info, err := a.blob.Head(r.Context(), job.FinalPath); err == nil &&
		info.Size == job.DeclaredSize {
		acquired["resumeComplete"] = true
		writeJSON(w, http.StatusOK, acquired)
		return
	}
	// The HEAD above is an external call. Recheck immediately before asking
	// Clerk/provider APIs for access so a suspension, deletion, or role removal
	// during that call cannot still yield a fresh download grant.
	if !a.sourceImportActorAvailable(w, r, job) {
		return
	}
	token, err := integrations.ClerkAccessToken(
		r.Context(), *job.ActorUserID, job.Provider,
	)
	if errors.Is(err, integrations.ErrNotConnected) {
		if !a.commitImportFailure(
			w, r, job,
			"provider_disconnected", "provider account is disconnected",
		) {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "provider_disconnected"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}

	download := map[string]any{}
	switch job.Provider {
	case integrations.ProviderGoogle:
		meta, err := integrations.GetGoogleFileMetadata(
			r.Context(), token, job.ProviderFileID,
		)
		if err != nil {
			a.importProviderFailure(w, r, job, err)
			return
		}
		download = map[string]any{
			"kind": "bearer",
			"url": integrations.GoogleDownloadURL(
				job.ProviderFileID,
				meta.ExportPDF,
			),
			"token": token,
		}
	case integrations.ProviderMicrosoft:
		meta, err := integrations.GetMicrosoftFileMetadata(
			r.Context(), token, job.ProviderFileID, job.ProviderDriveID,
		)
		if err != nil {
			a.importProviderFailure(w, r, job, err)
			return
		}
		download = map[string]any{
			"kind": "url",
			"url":  meta.DownloadURL,
		}
	default:
		a.importProviderFailure(w, r, job, integrations.ErrUnsupportedImportFile)
		return
	}
	// Do not return a bearer token or provider URL if authorization changed
	// while metadata was loading. Completion remains transactionally fenced as
	// a separate durable boundary.
	if !a.sourceImportActorAvailable(w, r, job) {
		return
	}
	acquired["resumeComplete"] = false
	acquired["download"] = download
	writeJSON(w, http.StatusOK, acquired)
}

// importProviderFailure closes the attempt for a terminal provider answer and
// releases it for a transient one. The worker maps the status onto its own
// retry policy: 410 is terminal, 503 retries.
func (a *api) importProviderFailure(
	w http.ResponseWriter,
	r *http.Request,
	job store.SourceImportJob,
	err error,
) {
	code := "provider_unavailable"
	status := http.StatusServiceUnavailable
	if errors.Is(err, integrations.ErrImportFileUnavailable) ||
		errors.Is(err, integrations.ErrUnsupportedImportFile) {
		code = "provider_file_unavailable"
		status = http.StatusGone
		if !a.commitImportFailure(
			w, r, job, code, "provider file is unavailable",
		) {
			return
		}
	} else {
		if err := a.s.MarkSourceImportRetry(
			r.Context(), job.ID, job.LeaseToken, code,
			"provider metadata request failed",
		); err != nil {
			if errors.Is(err, store.ErrImportLeaseLost) {
				writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
			} else {
				a.fail(w, err)
			}
			return
		}
	}
	writeJSON(w, status, map[string]string{"code": code})
}

func (a *api) internalCompleteSourceImport(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req importCompleteReq
	if err := decode(r, &req); err != nil || req.JobID == "" ||
		req.AttemptToken == "" || req.ActualSize < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid completion"})
		return
	}
	if _, err := a.s.FenceSourceImportCompletion(
		r.Context(), req.JobID, req.AttemptToken,
	); err != nil {
		if errors.Is(err, store.ErrImportLeaseLost) {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
			return
		}
		a.fail(w, err)
		return
	}
	// The provider's declared size was only a reservation estimate. Settle the
	// reservation on the bytes that actually landed before finalizing.
	job, err := a.s.PrepareSourceImportUpload(
		r.Context(), req.JobID, req.AttemptToken, req.ActualSize,
	)
	if errors.Is(err, store.ErrImportTooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"code": "file_too_large"})
		return
	}
	if errors.Is(err, store.ErrImportLeaseLost) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if job.ActorUserID == nil {
		if !a.commitImportFailure(
			w, r, job, "actor_unavailable", "import actor is unavailable",
		) {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "actor_unavailable"})
		return
	}
	allowed, code, err := a.s.AccountSessionAllowed(r.Context(), *job.ActorUserID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !allowed {
		if !a.commitImportFailure(w, r, job, code, "import actor is locked") {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": code})
		return
	}
	if err := a.s.AssertWorkspaceEditor(
		r.Context(), *job.ActorUserID, job.WorkspaceID,
	); err != nil {
		if !errors.Is(err, store.ErrForbidden) && !errors.Is(err, store.ErrNotFound) {
			a.fail(w, err)
			return
		}
		if !a.commitImportFailure(
			w, r, job,
			"workspace_access_revoked", "workspace access was revoked",
		) {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "workspace_access_revoked"})
		return
	}
	info, finalErr := a.blob.Head(r.Context(), job.FinalPath)
	if finalErr != nil {
		info, err = a.blob.Head(r.Context(), job.AttemptObjectPath)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "object_unavailable"})
			return
		}
	}
	if info.Size != job.DeclaredSize {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "object_size_mismatch"})
		return
	}
	if info.ContentType != "" && info.ContentType != job.ContentType {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "object_type_mismatch"})
		return
	}
	if finalErr != nil {
		info, err = promoteMatchingObject(
			r.Context(), a.blob, job.AttemptObjectPath, job.FinalPath,
			job.DeclaredSize, job.ContentType, info,
		)
		if err != nil {
			a.fail(w, err)
			return
		}
	}
	file, err := a.s.FinalizeSourceImport(
		r.Context(), job.ID, req.AttemptToken, info.ETag, a.parser, a.engine,
	)
	if errors.Is(err, store.ErrImportLeaseLost) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
		return
	}
	if errors.Is(err, store.ErrForbidden) {
		if !a.commitImportFailure(
			w, r, job,
			"authorization_revoked", "import authorization was revoked",
		) {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "authorization_revoked"})
		return
	}
	if errors.Is(err, store.ErrTooManyIngestLeases) ||
		errors.Is(err, store.ErrCreditsExhausted) {
		writeImportCapacityRetry(w, err)
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jobId": job.ID, "fileId": file.ID, "status": "succeeded",
	})
}

// internalFailSourceImport records the worker's verdict on one attempt. A
// retryable report releases the lease so the next queue claim can acquire; a
// terminal report closes the import and releases its reservation. An empty
// attempt token closes a job the worker gave up on before acquiring.
func (a *api) internalFailSourceImport(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req importFailureReq
	if err := decode(r, &req); err != nil || req.JobID == "" || req.Code == "" ||
		(req.Retryable && req.AttemptToken == "") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid failure"})
		return
	}
	message := "source import attempt failed"
	var err error
	if req.Retryable {
		err = a.s.MarkSourceImportRetry(
			r.Context(), req.JobID, req.AttemptToken, req.Code, message,
		)
	} else {
		err = a.s.MarkSourceImportFailed(
			r.Context(), req.JobID, req.AttemptToken, req.Code, message,
		)
	}
	if errors.Is(err, store.ErrImportLeaseLost) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
		return
	}
	if errors.Is(err, store.ErrImportNotReady) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_not_ready"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
