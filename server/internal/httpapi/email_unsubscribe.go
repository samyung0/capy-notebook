package httpapi

import (
	"fmt"
	"html"
	"net/http"

	"github.com/evonotes/server/internal/mail"
)

func (a *api) emailUnsubscribe(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" && r.Method == http.MethodPost {
		_ = r.ParseForm()
		token = r.FormValue("token")
	}
	userID, category, err := mail.ParseUnsubscribeToken(a.cfg.EmailUnsubscribeSecret, token)
	if err != nil {
		http.Error(w, "invalid unsubscribe link", http.StatusBadRequest)
		return
	}
	if category != "workspace_invite" && category != "membership" && category != "billing" {
		http.Error(w, "invalid unsubscribe category", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodPost {
		if err := a.s.DisableNotificationCategory(r.Context(), userID, category); err != nil {
			a.fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	escapedToken := html.EscapeString(token)
	_, _ = fmt.Fprintf(w, `<!doctype html>
<title>Confirm email unsubscribe</title>
<p>Confirm to stop these product emails.</p>
<form method="post">
<input type="hidden" name="token" value="%s">
<button type="submit">Confirm unsubscribe</button>
</form>`, escapedToken)
}
