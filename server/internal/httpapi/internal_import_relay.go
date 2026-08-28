package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/relayauth"
	"github.com/evonotes/server/internal/store"
)

type relayJobReq struct {
	JobID string `json:"jobId"`
}

type relayAttemptReq struct {
	JobID        string `json:"jobId"`
	AttemptToken string `json:"attemptToken"`
}

type relayUploadGrantReq struct {
	JobID        string `json:"jobId"`
	AttemptToken string `json:"attemptToken"`
	ActualSize   int64  `json:"actualSize"`
}

type relayFailureReq struct {
	JobID        string `json:"jobId"`
	AttemptToken string `json:"attemptToken"`
	Code         string `json:"code"`
	Message      string `json:"message"`
	Retryable    bool   `json:"retryable"`
	RetryDelay   int    `json:"retryDelaySeconds"`
}

func (a *api) relayBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid relay request"})
		return nil, false
	}
	if !relayauth.Verify(
		a.cfg.ImportRelaySecret,
		r.Header.Get(relayauth.HeaderTimestamp),
		r.Header.Get(relayauth.HeaderSignature),
		r.Method,
		r.URL.RequestURI(),
		body,
		time.Now().UTC(),
	) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return nil, false
	}
	return body, true
}

func decodeRelayBody(body []byte, dst any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("relay request must contain one JSON value")
	}
	return nil
}

func writeRelayCapacityRetry(w http.ResponseWriter, err error) {
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
	}
}

func (a *api) commitRelayFailure(
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

func (a *api) internalAcquireSourceImport(w http.ResponseWriter, r *http.Request) {
	body, ok := a.relayBody(w, r)
	if !ok {
		return
	}
	var req relayJobReq
	if decodeRelayBody(body, &req) != nil || strings.TrimSpace(req.JobID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "jobId is required"})
		return
	}
	job, err := a.s.AcquireSourceImport(r.Context(), req.JobID)
	if errors.Is(err, store.ErrImportNotReady) {
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
	if job.ActorUserID == nil {
		if !a.commitRelayFailure(
			w, r, job,
			"actor_unavailable", "import actor is unavailable",
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
		if !a.commitRelayFailure(w, r, job, code, "import actor is locked") {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": code})
		return
	}
	if err := a.s.AssertWorkspaceEditor(r.Context(), *job.ActorUserID, job.WorkspaceID); err != nil {
		if !errors.Is(err, store.ErrForbidden) && !errors.Is(err, store.ErrNotFound) {
			a.fail(w, err)
			return
		}
		if !a.commitRelayFailure(
			w, r, job,
			"workspace_access_revoked", "workspace access was revoked",
		) {
			return
		}
		writeJSON(w, http.StatusGone, map[string]string{"code": "workspace_access_revoked"})
		return
	}

	if info, err := a.blob.Head(r.Context(), job.FinalPath); err == nil &&
		info.Size == job.DeclaredSize {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":         "acquired",
			"jobId":          job.ID,
			"attemptToken":   job.LeaseToken,
			"maxBytes":       job.MaxBytes,
			"resumeComplete": true,
		})
		return
	}
	token, err := integrations.ClerkAccessToken(
		r.Context(), *job.ActorUserID, job.Provider,
	)
	if errors.Is(err, integrations.ErrNotConnected) {
		if !a.commitRelayFailure(
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
			a.relayProviderFailure(w, r, job, err)
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
			a.relayProviderFailure(w, r, job, err)
			return
		}
		download = map[string]any{
			"kind": "url",
			"url":  meta.DownloadURL,
		}
	default:
		a.relayProviderFailure(w, r, job, integrations.ErrUnsupportedImportFile)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "acquired",
		"jobId":          job.ID,
		"attemptToken":   job.LeaseToken,
		"maxBytes":       job.MaxBytes,
		"resumeComplete": false,
		"download":       download,
	})
}

func (a *api) relayProviderFailure(
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
		if !a.commitRelayFailure(
			w, r, job, code, "provider file is unavailable",
		) {
			return
		}
	} else {
		if err := a.s.MarkSourceImportRetry(
			r.Context(), job.ID, job.LeaseToken, code,
			"provider metadata request failed", 30*time.Second,
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

func (a *api) internalGrantSourceImportUpload(w http.ResponseWriter, r *http.Request) {
	body, ok := a.relayBody(w, r)
	if !ok {
		return
	}
	var req relayUploadGrantReq
	if decodeRelayBody(body, &req) != nil || req.JobID == "" ||
		req.AttemptToken == "" || req.ActualSize < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid upload grant"})
		return
	}
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
	signed, err := a.blob.PresignPut(
		r.Context(), job.AttemptObjectPath, job.ContentType,
	)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"url": signed.URL, "headers": signed.Headers,
		"expiresAt": signed.ExpiresAt,
	})
}

func (a *api) internalCompleteSourceImport(w http.ResponseWriter, r *http.Request) {
	body, ok := a.relayBody(w, r)
	if !ok {
		return
	}
	var req relayAttemptReq
	if decodeRelayBody(body, &req) != nil || req.JobID == "" ||
		req.AttemptToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid completion"})
		return
	}
	job, err := a.s.FenceSourceImportCompletion(
		r.Context(), req.JobID, req.AttemptToken,
	)
	if errors.Is(err, store.ErrImportLeaseLost) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": "import_lease_lost"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if job.ActorUserID == nil {
		if !a.commitRelayFailure(
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
		if !a.commitRelayFailure(w, r, job, code, "import actor is locked") {
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
		if !a.commitRelayFailure(
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
		if err := a.blob.Promote(
			r.Context(), job.AttemptObjectPath, job.FinalPath,
		); err != nil {
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
		if !a.commitRelayFailure(
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
		writeRelayCapacityRetry(w, err)
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

func (a *api) internalFailSourceImport(w http.ResponseWriter, r *http.Request) {
	body, ok := a.relayBody(w, r)
	if !ok {
		return
	}
	var req relayFailureReq
	if decodeRelayBody(body, &req) != nil || req.JobID == "" ||
		req.AttemptToken == "" || req.Code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid failure"})
		return
	}
	message := "source import attempt failed"
	var err error
	if req.Retryable {
		delay := time.Duration(req.RetryDelay) * time.Second
		err = a.s.MarkSourceImportRetry(
			r.Context(), req.JobID, req.AttemptToken, req.Code, message, delay,
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
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (a *api) internalDeadLetterSourceImport(w http.ResponseWriter, r *http.Request) {
	body, ok := a.relayBody(w, r)
	if !ok {
		return
	}
	var req relayJobReq
	if decodeRelayBody(body, &req) != nil || req.JobID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "jobId is required"})
		return
	}
	if err := a.s.DeadLetterSourceImport(
		r.Context(), req.JobID, "queue_retries_exhausted",
		"relay queue retries exhausted",
	); err != nil {
		if errors.Is(err, store.ErrImportNotReady) {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "import_not_ready"})
			return
		}
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
