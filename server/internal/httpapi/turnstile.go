package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Signed-out answer checks carry a Cloudflare Turnstile token, which the
// gateway verifies with siteverify before grading (Epo 2026-10-24, Q271).
// Signed-in checks take none.

// ErrCaptchaFailed is a Turnstile token Cloudflare refused: invalid, expired
// or already spent.
var ErrCaptchaFailed = errors.New("captcha failed")

// CaptchaVerifier checks one Turnstile token: nil when Cloudflare accepts
// it, ErrCaptchaFailed when it refuses it, any other error when it cannot
// tell (an outage, a misconfigured secret).
type CaptchaVerifier func(ctx context.Context, token string) error

const turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// turnstileTimeout bounds one siteverify call; a slower answer is an outage.
const turnstileTimeout = 5 * time.Second

// newTurnstileVerifier verifies tokens with siteverify under secret. Without
// a secret every check is an outage, never a skipped verification.
func newTurnstileVerifier(secret string) CaptchaVerifier {
	if secret == "" {
		return func(context.Context, string) error { return errors.New("TURNSTILE_SECRET_KEY is not set") }
	}
	client := &http.Client{Timeout: turnstileTimeout}
	return func(ctx context.Context, token string) error {
		form := url.Values{"secret": {secret}, "response": {token}}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, turnstileVerifyURL, strings.NewReader(form.Encode()))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("siteverify: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("siteverify: status %d", resp.StatusCode)
		}
		var out struct {
			Success    bool     `json:"success"`
			ErrorCodes []string `json:"error-codes"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
			return fmt.Errorf("siteverify: %w", err)
		}
		if out.Success {
			return nil
		}
		// Cloudflare's own failure and a refused secret are not the visitor's.
		if slices.ContainsFunc(out.ErrorCodes, func(code string) bool {
			return code == "internal-error" || strings.HasSuffix(code, "-secret")
		}) {
			return fmt.Errorf("siteverify: %v", out.ErrorCodes)
		}
		return ErrCaptchaFailed
	}
}

// checkCaptcha refuses a signed-out answer check whose Turnstile token is
// missing or refused (403 captcha_failed), and one siteverify cannot decide
// (503 captcha_unavailable): an outage refuses rather than skips the check.
func (a *api) checkCaptcha(ctx context.Context, token string) error {
	err := ErrCaptchaFailed
	if token != "" {
		err = a.captcha(ctx, token)
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrCaptchaFailed):
		return &huma.ErrorModel{
			Status: http.StatusForbidden, Title: http.StatusText(http.StatusForbidden),
			Detail: "the human check did not pass, try again", Errors: []*huma.ErrorDetail{{Message: "captcha_failed"}},
		}
	default:
		obs.Log(ctx).Warn("turnstile siteverify failed", "error", err)
		return &huma.ErrorModel{
			Status: http.StatusServiceUnavailable, Title: http.StatusText(http.StatusServiceUnavailable),
			Detail: "the human check is unavailable, try again", Errors: []*huma.ErrorDetail{{Message: "captcha_unavailable"}},
		}
	}
}
