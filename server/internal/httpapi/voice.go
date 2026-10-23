package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/alibaba"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Chat voice input (human/agentic-retrieval.md 2026-10-23): the composer
// records at most fieldlimits.VoiceInputSeconds, this route transcribes the
// clip with Alibaba's qwen-audio-3.1-asr-flash and answers its text, which the
// composer inserts for the user to edit and send. The audio is never stored
// and nothing retries: the user records again. No audio or transcript text
// reaches a log line, an error or Sentry.
const (
	// voiceMaxBytes bounds a clip. Two minutes of the composer's 32 kb/s Opus
	// or AAC is about 0.5 MB; this leaves room for a browser that ignores the
	// bitrate and records at 128 kb/s. Huma stops reading at the limit (413).
	voiceMaxBytes = 2 << 20
	// A 2 MiB body on a slow phone connection.
	voiceBodyReadTimeout = 60 * time.Second
	// voiceSpanLimitMs refuses a clip the provider heard as longer than the
	// cap plus the recorder's stop margin. The API image has no audio
	// duration parser, so the size limit and this span are the server's
	// checks; an answer with text but no span is refused as unreadable
	// (alibaba.Transcribe). The margin is never charged: units stop at the
	// two minutes the call holds.
	voiceSpanLimitMs = (fieldlimits.VoiceInputSeconds + 5) * 1000
	// The context message names the workspace and at most this many of its
	// newest sources, cut to voiceContextMaxRunes.
	voiceContextSources  = 20
	voiceContextMaxRunes = 1000
	// A receipt for the call is accepted this long: the provider timeout and
	// a minute's grace.
	voiceReceiptWindow = 2 * time.Minute
	voiceProvider      = "alibaba"
	voicePurpose       = "transcription"
)

// voiceFormats maps the recorder's media types to Alibaba's format names:
// MediaRecorder's Opus in WebM or Ogg, and Safari's AAC in MP4.
var voiceFormats = map[string]string{
	"audio/webm": "webm",
	"audio/ogg":  "ogg",
	"audio/mp4":  "mp4",
}

type voiceTranscriptionInput struct {
	ID          string `path:"id" doc:"Workspace id"`
	ContentType string `header:"Content-Type" hidden:"true"`
	RawBody     []byte `contentType:"audio/webm"`
}

type voiceTranscriptionOutput struct {
	Body apimodel.VoiceTranscription
}

func (a *api) registerVoice(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/voice-transcriptions", "transcribeVoice", "Chat",
		"Transcribe a chat voice recording for the composer", http.StatusOK, voiceMaxBytes, a.transcribeVoice,
		func(op *huma.Operation) {
			op.BodyReadTimeout = voiceBodyReadTimeout
			content := map[string]*huma.MediaType{}
			for mediaType := range voiceFormats {
				content[mediaType] = &huma.MediaType{Schema: &huma.Schema{Type: "string", Format: "binary"}}
			}
			op.RequestBody = &huma.RequestBody{Required: true, Content: content}
		})
}

// transcribeVoice holds the two-minute maximum of the caller's credits while
// the call runs, then charges the seconds the provider heard (ceil, at most
// the two minutes held) once, or nothing when the call fails or the clip is
// refused.
func (a *api) transcribeVoice(ctx context.Context, in *voiceTranscriptionInput) (*voiceTranscriptionOutput, error) {
	// Anyone who may chat in the workspace, the chat stream's own check.
	if _, err := a.s.WorkspaceEffectiveRole(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	mediaType, _, err := mime.ParseMediaType(in.ContentType)
	format, ok := voiceFormats[mediaType]
	if err != nil || !ok {
		return nil, voiceError(http.StatusUnsupportedMediaType, "voice_format_unsupported",
			"a recording is WebM or Ogg Opus, or MP4 AAC")
	}
	if a.cfg.Voice == nil {
		return nil, voiceError(http.StatusServiceUnavailable, "voice_unavailable", "voice input is not configured")
	}
	title, sources, err := a.s.VoiceContext(ctx, in.ID, voiceContextSources)
	if err != nil {
		return nil, hErr(err)
	}
	rates, err := a.s.ActiveResourceRates(ctx, []string{store.ResourceVoiceInputSecond})
	if err != nil {
		return nil, hErr(err)
	}
	most := store.CreditsForAudioSeconds(fieldlimits.VoiceInputSeconds, rates[store.ResourceVoiceInputSecond].CreditMicrosPerUnit)
	sessionID, err := a.s.BeginReservedSession(ctx, userID(ctx), in.ID, store.SurfaceChat, most)
	if err != nil {
		return nil, hErr(err)
	}
	charge := &spend{api: a, id: sessionID}
	// Releases the hold on every refusal below; a no-op once settled.
	defer charge.release(ctx)
	callID, err := a.s.OpenProviderCall(ctx, sessionID, store.KindAudio, voicePurpose, voiceProvider, alibaba.Model, voiceReceiptWindow)
	if err != nil {
		return nil, hErr(err)
	}

	transcript, err := a.cfg.Voice.Transcribe(ctx, in.RawBody, format, mediaType, voiceContextText(title, sources))
	if err != nil {
		var provider *alibaba.Error
		switch {
		case ctx.Err() != nil:
			a.abandonVoiceCall(ctx, callID, "request", "cancelled", 0)
			return nil, hErr(ctx.Err())
		case errors.As(err, &provider):
			a.abandonVoiceCall(ctx, callID, "provider", provider.Code, provider.Status)
		default:
			a.abandonVoiceCall(ctx, callID, "provider", "transport", 0)
		}
		if errors.Is(err, alibaba.ErrBusy) {
			// A 4xx reaches no Sentry event: the log line is the signal to
			// raise the workspace's quota.
			obs.Log(ctx).Warn("voice transcription throttled", "error", err)
			return nil, voiceError(http.StatusTooManyRequests, "transcription_busy", "voice input is busy, record again shortly")
		}
		// The 502 reports the provider's status and code to Sentry.
		return nil, &handlerError{
			error: voiceError(http.StatusBadGateway, "transcription_failed", "the recording could not be transcribed"),
			cause: err,
		}
	}
	if transcript.EndMs > voiceSpanLimitMs {
		a.abandonVoiceCall(ctx, callID, "request", "audio_duration_limit", 0)
		return nil, voiceError(http.StatusUnprocessableEntity, "voice_too_long", "a recording is at most 2 minutes")
	}
	text := strings.TrimSpace(transcript.Text)
	if text == "" {
		a.abandonVoiceCall(ctx, callID, "request", "no_speech", 0)
		return nil, voiceError(http.StatusUnprocessableEntity, "voice_no_speech", "no speech was heard")
	}

	// The hold goes first, so the spend's own check sees the credits the user
	// has rather than this call's hold; a closed session still takes the
	// receipt of a call opened under it.
	charge.settle(ctx)
	settleCtx, cancel := obs.Detach(ctx, settleTimeout)
	defer cancel()
	if _, err := a.s.SettleProviderCall(settleCtx, sessionID, store.ProviderCallUsage{
		CallID: callID, Kind: store.KindAudio, Purpose: voicePurpose,
		Provider: voiceProvider, Model: alibaba.Model,
		InputTokens: transcript.InputTokens, OutputTokens: transcript.OutputTokens,
		Units: min((transcript.EndMs+999)/1000, fieldlimits.VoiceInputSeconds), Unit: "seconds",
	}); err != nil {
		// The call stays open until the sweep abandons it at its receipt
		// deadline: under-charged, never charged twice. The user still gets
		// the text they waited for.
		obs.CaptureErr(settleCtx, err, map[string]string{"stage": "voice_settle"})
	}
	return &voiceTranscriptionOutput{Body: apimodel.VoiceTranscription{Text: text}}, nil
}

// abandonVoiceCall closes the call uncharged; the deferred release then frees
// the hold.
func (a *api) abandonVoiceCall(ctx context.Context, callID, category, code string, status int) {
	abandonCtx, cancel := obs.Detach(ctx, settleTimeout)
	defer cancel()
	if err := a.s.AbandonProviderCall(abandonCtx, callID, category, code, status); err != nil {
		obs.CaptureErr(abandonCtx, err, map[string]string{"stage": "voice_abandon"})
	}
}

// voiceContextText is the message sent ahead of the audio so course
// vocabulary comes out right.
func voiceContextText(title string, sources []string) string {
	text := "Workspace: " + title
	if len(sources) > 0 {
		text += "\nSources: " + strings.Join(sources, ", ")
	}
	if runes := []rune(text); len(runes) > voiceContextMaxRunes {
		text = string(runes[:voiceContextMaxRunes])
	}
	return text
}

// voiceError is a refusal with the machine code the composer shows copy for.
func voiceError(status int, code, detail string) *huma.ErrorModel {
	return &huma.ErrorModel{
		Status: status,
		Title:  http.StatusText(status),
		Detail: detail,
		Errors: []*huma.ErrorDetail{{Message: code}},
	}
}
