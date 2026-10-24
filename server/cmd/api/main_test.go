package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

const validClerkWebhook = "whsec_dGVzdC1jbGVyay1zaWduaW5nLWtleQ=="

func TestValidateAuthConfiguration(t *testing.T) {
	for _, test := range []struct {
		name         string
		appEnv       string
		authDisabled bool
		e2eAuth      bool
		clerkSecret  string
		clerkWebhook string
		wantErr      bool
	}{
		{name: "production Clerk", appEnv: "production", clerkSecret: "secret", clerkWebhook: validClerkWebhook},
		{name: "development bypass", appEnv: "development", authDisabled: true},
		{name: "e2e", appEnv: "e2e", e2eAuth: true},
		{name: "missing API secret", appEnv: "production", clerkWebhook: validClerkWebhook, wantErr: true},
		{name: "missing webhook secret", appEnv: "production", clerkSecret: "secret", wantErr: true},
		{name: "development Clerk missing webhook", appEnv: "development", clerkSecret: "secret", wantErr: true},
		{name: "production bypass", appEnv: "production", authDisabled: true, wantErr: true},
		// Security regression: a malformed signing secret is refused at boot
		// rather than failing every delivery after reading its body.
		{name: "malformed webhook secret", appEnv: "production", clerkSecret: "secret", clerkWebhook: "whsec_not-base64!", wantErr: true},
		{name: "empty webhook key", appEnv: "production", clerkSecret: "secret", clerkWebhook: "whsec_", wantErr: true},
		{name: "e2e with a malformed webhook secret", appEnv: "e2e", e2eAuth: true, clerkWebhook: "webhook", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateAuthConfiguration(
				test.appEnv,
				test.authDisabled,
				test.e2eAuth,
				test.clerkSecret,
				test.clerkWebhook,
			)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateAuthConfiguration() error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

// Security regression (human deployment-runbook and authorization,
// 2026-10-21): outside development and e2e the gateway refuses to boot without
// a CORS allowlist or with a `*` in it, or with Clerk on and no origins for its
// session tokens' azp (an empty list would accept every azp). The azp list is
// COLLABORATION_ALLOWED_ORIGINS.
func TestOriginConfiguration(t *testing.T) {
	const cors, azps = "https://app.test", "https://app.test, https://local.app.test"
	for _, test := range []struct {
		name             string
		appEnv           string
		clerkOn          bool
		corsEnv, azpsEnv string
		wantErr          bool
	}{
		{name: "production configured", appEnv: "production", clerkOn: true, corsEnv: cors, azpsEnv: azps},
		{name: "production without Clerk", appEnv: "production", corsEnv: cors},
		{name: "development without lists", appEnv: "development", clerkOn: true},
		{name: "e2e without lists", appEnv: "e2e"},
		{name: "production without CORS", appEnv: "production", clerkOn: true, azpsEnv: azps, wantErr: true},
		{name: "uat without CORS", appEnv: "uat", azpsEnv: azps, wantErr: true},
		{name: "production Clerk without azp origins", appEnv: "production", clerkOn: true, corsEnv: cors, wantErr: true},
		{name: "production CORS wildcard", appEnv: "production", corsEnv: cors + ", *", wantErr: true},
		{name: "uat CORS wildcard subdomain", appEnv: "uat", corsEnv: "https://*.app.test", wantErr: true},
		{name: "development CORS wildcard", appEnv: "development", corsEnv: "*"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("CORS_ALLOWED_ORIGINS", test.corsEnv)
			t.Setenv("COLLABORATION_ALLOWED_ORIGINS", test.azpsEnv)
			_, parties, err := originConfiguration(test.appEnv, test.clerkOn)
			if (err != nil) != test.wantErr {
				t.Fatalf("originConfiguration() error = %v, wantErr %t", err, test.wantErr)
			}
			if test.azpsEnv != "" && !test.wantErr &&
				strings.Join(parties, ",") != "https://app.test,https://local.app.test" {
				t.Fatalf("azp origins = %q, want COLLABORATION_ALLOWED_ORIGINS", parties)
			}
		})
	}
}

func TestValidateStripeConfiguration(t *testing.T) {
	for _, test := range []struct {
		name          string
		secretKey     string
		webhookSecret string
		pricePro      string
		wantErr       bool
	}{
		{name: "billing disabled"},
		{name: "secret only", secretKey: "secret"},
		{name: "billing configured", secretKey: "secret", webhookSecret: "webhook", pricePro: "price"},
		{name: "webhook without secret", webhookSecret: "webhook", wantErr: true},
		{name: "price without secret", pricePro: "price", wantErr: true},
		{name: "blank secret", secretKey: "  ", pricePro: "price", wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateStripeConfiguration(
				test.secretKey,
				test.webhookSecret,
				test.pricePro,
			)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateStripeConfiguration() error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

// Security regression (human deployment-runbook 2026-10-20): the gateway
// refuses to start with APP_ENV unset or empty, so local-only behaviour
// (AUTH_DISABLED, API docs, the dev seed) never comes from a missing value.
func TestStartupRefusesAMissingAppEnv(t *testing.T) {
	if os.Getenv("CAPY_TEST_GATEWAY_MAIN") == "1" {
		main()
		return
	}
	for _, appEnv := range []string{"unset", "empty"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStartupRefusesAMissingAppEnv$")
		cmd.Env = []string{"CAPY_TEST_GATEWAY_MAIN=1", "PATH=" + os.Getenv("PATH"), "SYSTEMROOT=" + os.Getenv("SYSTEMROOT")}
		if appEnv == "empty" {
			cmd.Env = append(cmd.Env, "APP_ENV=")
		}
		out, err := cmd.CombinedOutput()
		cancel()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || !strings.Contains(string(out), "APP_ENV must be set") {
			t.Fatalf("APP_ENV %s: err = %v, output: %s", appEnv, err, out)
		}
	}
}

// TestDeployedGatewaysRefuseShortServiceSecrets (security regression:
// rate-limit audit M4). Outside development and e2e, a set PIPELINE_SECRET or
// the collaboration secret in use shorter than 32 characters stops the boot;
// local stacks keep their short development values.
func TestDeployedGatewaysRefuseShortServiceSecrets(t *testing.T) {
	long := strings.Repeat("s", 32)
	for _, appEnv := range []string{"development", "e2e"} {
		if err := validateServiceSecrets(appEnv, "dev-pipeline-secret", "dev-collaboration-secret"); err != nil {
			t.Fatalf("%s: %v", appEnv, err)
		}
	}
	if err := validateServiceSecrets("production", "", long); err != nil {
		t.Fatalf("production without a pipeline secret: %v", err)
	}
	if err := validateServiceSecrets("production", long, long); err != nil {
		t.Fatalf("production with long secrets: %v", err)
	}
	for name, secrets := range map[string][2]string{
		"short pipeline secret":         {"dev-pipeline-secret", long},
		"short collaboration secret":    {long, "prod-collaboration-secret"},
		"development collaboration one": {"", "dev-collaboration-secret"},
	} {
		if err := validateServiceSecrets("production", secrets[0], secrets[1]); err == nil {
			t.Errorf("production with a %s started", name)
		}
	}
}

// TestProductionNeedsTheTurnstileSecret (rate-limit audit Q271). A deployed
// gateway does not boot without the secret that verifies signed-out answer
// checks; local stacks may run without it.
func TestProductionNeedsTheTurnstileSecret(t *testing.T) {
	if err := validateTurnstileSecret("production", ""); err == nil {
		t.Fatal("production booted without TURNSTILE_SECRET_KEY")
	}
	if err := validateTurnstileSecret("production", "0x4AAAAAAA-secret"); err != nil {
		t.Fatal(err)
	}
	for _, appEnv := range []string{"development", "e2e"} {
		if err := validateTurnstileSecret(appEnv, ""); err != nil {
			t.Fatalf("%s: %v", appEnv, err)
		}
		if err := validateTurnstileSecret(appEnv, turnstileTestSecrets[0]); err != nil {
			t.Fatalf("%s with the test secret: %v", appEnv, err)
		}
	}
	// Cloudflare's published test secrets verify nothing (security
	// regression: rate-limit audit r2 N-1, Q308).
	for _, secret := range turnstileTestSecrets {
		if err := validateTurnstileSecret("production", secret); err == nil {
			t.Fatalf("production booted with the test secret %s", secret)
		}
	}
}

// TestTurnstileTokensMustComeFromTheAppHosts (security regression:
// rate-limit audit r2 N-2, Q308). Outside development and e2e a token must
// have been solved on one of the environment's app origins; UAT's lists
// give uat and local.uat. A deployed gateway with no app host refuses
// to boot (security regression: rate-limit audit r3 S-2, Q350).
func TestTurnstileTokensMustComeFromTheAppHosts(t *testing.T) {
	got, err := turnstileHosts("production",
		"https://uat.capynotebook.com",
		"https://uat.capynotebook.com",
		"https://uat.capynotebook.com", "https://local.uat.capynotebook.com")
	want := []string{"uat.capynotebook.com", "local.uat.capynotebook.com"}
	if err != nil || !slices.Equal(got, want) {
		t.Fatalf("turnstile hosts = %v, %v, want %v", got, err, want)
	}
	if got, err := turnstileHosts("e2e", "http://localhost:5173"); got != nil || err != nil {
		t.Fatalf("e2e turnstile hosts = %v, %v, want none", got, err)
	}
	if _, err := turnstileHosts("production", "", "not a url"); err == nil {
		t.Fatal("production booted with no Turnstile host")
	}
}
