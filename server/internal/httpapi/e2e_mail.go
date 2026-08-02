package httpapi

import (
	"crypto/subtle"
	"net/http"

	"github.com/evonotes/server/internal/auth"
)

type capturedEmail struct {
	Subject string `json:"subject"`
	Text    string `json:"text"`
	To      string `json:"to"`
}

// e2eEmails returns the mail the API "delivered" during a Playwright run. It is
// registered only when the disposable E2E identity bypass is enabled (which
// main.go restricts to APP_ENV=e2e) and still requires the E2E secret.
func (a *api) e2eEmails(w http.ResponseWriter, r *http.Request) {
	secret := r.Header.Get(auth.HeaderE2ESecret)
	if subtle.ConstantTimeCompare([]byte(secret), []byte(a.cfg.E2ESecret)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	messages := a.mailRecorder.Captured()
	out := make([]capturedEmail, 0, len(messages))
	for _, message := range messages {
		out = append(out, capturedEmail{
			Subject: message.Subject,
			Text:    message.Text,
			To:      message.To,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
