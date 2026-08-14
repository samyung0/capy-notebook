package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

// transcribe proxies an uploaded audio blob (multipart field "file") to the
// Python pipeline's /transcribe (Whisper) and returns {"text": ...}. When the
// pipeline is unavailable it returns an empty transcript so the editor degrades
// gracefully rather than erroring.
func (a *api) transcribe(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32 MiB
		a.fail(w, err)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		a.fail(w, err)
		return
	}
	defer file.Close()

	ctx := r.Context()
	userID := uid(r)
	charge, err := a.reserveSpend(ctx, userID, "", store.SurfaceTranscribe, store.EstimateTranscribeMicros)
	if err != nil {
		a.fail(w, err)
		return
	}
	defer charge.release(ctx)

	if a.pipe == nil {
		writeJSON(w, http.StatusOK, map[string]string{"text": ""})
		return
	}

	name := hdr.Filename
	if name == "" {
		name = "audio.webm"
	}
	raw, err := a.pipe.PostMultipart(ctx, "/transcribe", name, file)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"text": ""})
		return
	}

	var envelope struct {
		Text           string `json:"text"`
		DurationMillis int64  `json:"durationMillis"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
		return
	}
	if envelope.DurationMillis > 0 {
		ev := store.UsageEvent{
			ActorUserID:  userID,
			Kind:         store.KindTranscribe,
			Surface:      store.SurfaceTranscribe,
			Provider:     "openai",
			Model:        "whisper-1",
			Units:        envelope.DurationMillis,
			Unit:         "ms",
			CreditMicros: store.CreditsForTranscribe(envelope.DurationMillis),
		}
		if a.modelReg != nil {
			if cfg, err := a.modelReg.Default(ctx, models.SurfaceSTT); err == nil {
				ev.Provider = cfg.ProviderSlug
				ev.Model = cfg.ProviderModelID
				ev.ModelKey = cfg.Key
				ev.ModelVersion = cfg.Version
			}
		}
		charge.settle(ctx, ev)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}
