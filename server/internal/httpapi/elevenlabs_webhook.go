package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/store"
)

const elevenLabsWebhookMaxBytes = 64 << 20

type elevenLabsSpeechToTextEvent struct {
	Type string `json:"type"`
	Data struct {
		RequestID       string         `json:"request_id"`
		WebhookMetadata map[string]any `json:"webhook_metadata"`
		Transcription   map[string]any `json:"transcription"`
	} `json:"data"`
}

func verifyElevenLabsSignature(body []byte, header, secret string, now time.Time) bool {
	if header == "" || secret == "" {
		return false
	}
	values := map[string]string{}
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			values[key] = value
		}
	}
	timestamp, err := strconv.ParseInt(values["t"], 10, 64)
	if err != nil || values["v0"] == "" {
		return false
	}
	when := time.Unix(timestamp, 0)
	if when.Before(now.Add(-30*time.Minute)) || when.After(now.Add(30*time.Minute)) {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(values["t"]))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	expected, err := hex.DecodeString(values["v0"])
	return err == nil && hmac.Equal(mac.Sum(nil), expected)
}

func (a *api) elevenLabsWebhook(w http.ResponseWriter, r *http.Request) {
	if a.cfg.ElevenLabsWebhookSecret == "" {
		http.Error(w, "webhook not configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, elevenLabsWebhookMaxBytes))
	if err != nil {
		http.Error(w, "invalid webhook body", http.StatusBadRequest)
		return
	}
	if !verifyElevenLabsSignature(
		body,
		r.Header.Get("ElevenLabs-Signature"),
		a.cfg.ElevenLabsWebhookSecret,
		time.Now(),
	) {
		http.Error(w, "invalid webhook signature", http.StatusUnauthorized)
		return
	}
	var event elevenLabsSpeechToTextEvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "invalid webhook body", http.StatusBadRequest)
		return
	}
	if event.Type != "speech_to_text_transcription" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
		return
	}
	internalID, _ := event.Data.WebhookMetadata["audioTranscriptionId"].(string)
	if internalID == "" || len(event.Data.Transcription) == 0 {
		http.Error(w, "invalid transcription event", http.StatusBadRequest)
		return
	}
	if err := a.s.CompleteAudioTranscriptionWebhook(
		r.Context(), internalID, event.Data.RequestID, event.Data.Transcription,
	); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The source may have been deleted while ElevenLabs was processing it.
			writeJSON(w, http.StatusOK, map[string]string{"status": "gone"})
			return
		}
		obs.CaptureErr(r.Context(), err, map[string]string{"stage": "elevenlabs_webhook"})
		http.Error(w, "webhook persistence failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}
