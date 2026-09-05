package main

import "testing"

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
		{name: "production Clerk", appEnv: "production", clerkSecret: "secret", clerkWebhook: "webhook"},
		{name: "development bypass", appEnv: "development", authDisabled: true},
		{name: "e2e", appEnv: "e2e", e2eAuth: true},
		{name: "missing API secret", appEnv: "production", clerkWebhook: "webhook", wantErr: true},
		{name: "missing webhook secret", appEnv: "production", clerkSecret: "secret", wantErr: true},
		{name: "development Clerk missing webhook", appEnv: "development", clerkSecret: "secret", wantErr: true},
		{name: "production bypass", appEnv: "production", authDisabled: true, wantErr: true},
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
