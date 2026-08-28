package ops

import "testing"

func validOpsConfig(env string) Config {
	return Config{
		AppEnv:                 env,
		ClerkSecretKey:         "clerk",
		CloudflareAccessIssuer: "https://team.cloudflareaccess.com",
		CloudflareAccessAUD:    "audience",
		CloudflareAccessJWKS:   "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
		DatabaseURL:            "postgres://evo_ops@db/evo",
		AdminDatabaseURL:       "postgres://evo_ops_admin@db/evo",
	}
}

func TestConfigStaysFailClosedWithoutUnsafeDevelopment(t *testing.T) {
	t.Parallel()
	closed := validOpsConfig("production")
	if err := closed.Validate(); err != nil {
		t.Fatalf("closed production configuration rejected: %v", err)
	}
	if closed.AllowOwnerDSN() {
		t.Fatal("production allowed an owner DSN")
	}

	development := validOpsConfig("development")
	if err := development.Validate(); err != nil {
		t.Fatalf("closed development configuration rejected: %v", err)
	}
	if development.AllowOwnerDSN() {
		t.Fatal("development allowed an owner DSN without OPS_UNSAFE_DEVELOPMENT")
	}

	cases := []Config{
		{},
		{CloudflareAccessIssuer: closed.CloudflareAccessIssuer},
		{
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
		},
		{
			AppEnv:                 "production",
			ClerkSecretKey:         closed.ClerkSecretKey,
			CloudflareAccessIssuer: "https://team.cloudflareaccess.com/with/path",
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			DatabaseURL:            closed.DatabaseURL,
			AdminDatabaseURL:       closed.AdminDatabaseURL,
		},
		{
			AppEnv:           "development",
			AccessDisabled:   true,
			ClerkSecretKey:   closed.ClerkSecretKey,
			DatabaseURL:      closed.DatabaseURL,
			AdminDatabaseURL: closed.AdminDatabaseURL,
		},
		{
			AppEnv:                 "development",
			AuthDisabled:           true,
			DevUserID:              "u_1",
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			DatabaseURL:            closed.DatabaseURL,
			AdminDatabaseURL:       closed.AdminDatabaseURL,
		},
		{
			AppEnv:                 "production",
			UnsafeDevelopment:      true,
			ClerkSecretKey:         closed.ClerkSecretKey,
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			DatabaseURL:            closed.DatabaseURL,
			AdminDatabaseURL:       closed.AdminDatabaseURL,
		},
		{
			AppEnv:            "production",
			AccessDisabled:    true,
			UnsafeDevelopment: true,
			ClerkSecretKey:    closed.ClerkSecretKey,
			DatabaseURL:       closed.DatabaseURL,
			AdminDatabaseURL:  closed.AdminDatabaseURL,
		},
		{
			AppEnv:            "development",
			UnsafeDevelopment: true,
			AccessDisabled:    true,
			DatabaseURL:       closed.DatabaseURL,
			AdminDatabaseURL:  closed.AdminDatabaseURL,
		},
		{
			AppEnv:                 "development",
			UnsafeDevelopment:      true,
			AuthDisabled:           true,
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			DatabaseURL:            closed.DatabaseURL,
			AdminDatabaseURL:       closed.AdminDatabaseURL,
		},
		{
			AppEnv:                 "development",
			UnsafeDevelopment:      true,
			ClerkSecretKey:         closed.ClerkSecretKey,
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			AdminDatabaseURL:       closed.AdminDatabaseURL,
		},
		{
			AppEnv:                 "development",
			UnsafeDevelopment:      true,
			ClerkSecretKey:         closed.ClerkSecretKey,
			CloudflareAccessIssuer: closed.CloudflareAccessIssuer,
			CloudflareAccessAUD:    closed.CloudflareAccessAUD,
			DatabaseURL:            closed.DatabaseURL,
		},
	}
	for _, config := range cases {
		if err := config.Validate(); err == nil {
			t.Fatalf("accepted %#v", config)
		}
	}
}

func TestConfigAllowsBypassAndOwnerDSNOnlyWithDevelopmentUnsafeOptIn(t *testing.T) {
	t.Parallel()
	owner := validOpsConfig("development")
	owner.UnsafeDevelopment = true
	if err := owner.Validate(); err != nil {
		t.Fatalf("owner-DSN mode rejected: %v", err)
	}
	if !owner.AllowOwnerDSN() {
		t.Fatal("development + OPS_UNSAFE_DEVELOPMENT did not allow owner DSNs")
	}

	accessBypass := owner
	accessBypass.AccessDisabled = true
	accessBypass.CloudflareAccessIssuer = ""
	accessBypass.CloudflareAccessAUD = ""
	accessBypass.CloudflareAccessJWKS = ""
	if err := accessBypass.Validate(); err != nil {
		t.Fatalf("Access bypass rejected: %v", err)
	}

	authBypass := owner
	authBypass.AuthDisabled = true
	authBypass.ClerkSecretKey = ""
	authBypass.DevUserID = "u_1"
	if err := authBypass.Validate(); err != nil {
		t.Fatalf("Clerk bypass rejected: %v", err)
	}

	both := owner
	both.AccessDisabled = true
	both.AuthDisabled = true
	both.ClerkSecretKey = ""
	both.CloudflareAccessIssuer = ""
	both.CloudflareAccessAUD = ""
	both.DevUserID = "local-operator"
	if err := both.Validate(); err != nil {
		t.Fatalf("combined bypass rejected: %v", err)
	}

	defaultsJWKS := validOpsConfig("production")
	defaultsJWKS.CloudflareAccessJWKS = ""
	if err := defaultsJWKS.Validate(); err != nil {
		t.Fatalf("issuer-derived JWKS rejected: %v", err)
	}
	if got := defaultsJWKS.resolvedJWKS(); got !=
		"https://team.cloudflareaccess.com/cdn-cgi/access/certs" {
		t.Fatalf("resolved JWKS = %q", got)
	}
}

func TestConfigRequiresAdminDatabaseURL(t *testing.T) {
	t.Parallel()
	config := validOpsConfig("production")
	config.AdminDatabaseURL = ""
	if err := config.Validate(); err == nil {
		t.Fatal("accepted missing OPS_ADMIN_DATABASE_URL")
	}
}

func TestConfigFromEnvReadsDocumentedNames(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("OPS_UNSAFE_DEVELOPMENT", "true")
	t.Setenv("OPS_ACCESS_DISABLED", "true")
	t.Setenv("OPS_AUTH_DISABLED", "true")
	t.Setenv("OPS_DEV_USER_ID", "dev-operator")
	t.Setenv("CLERK_SECRET_KEY", "")
	t.Setenv("OPS_CF_ACCESS_ISSUER", "")
	t.Setenv("OPS_CF_ACCESS_AUDIENCE", "")
	t.Setenv("OPS_CF_ACCESS_JWKS_URL", "")
	t.Setenv("OPS_DATABASE_URL", "postgres://evo@db/evo")
	t.Setenv("OPS_ADMIN_DATABASE_URL", "postgres://evo_admin@db/evo")

	config := ConfigFromEnv()
	if err := config.Validate(); err != nil {
		t.Fatalf("documented env rejected: %v", err)
	}
	if config.AdminDatabaseURL != "postgres://evo_admin@db/evo" {
		t.Fatalf("AdminDatabaseURL = %q", config.AdminDatabaseURL)
	}
	if config.DevUserID != "dev-operator" || !config.AllowOwnerDSN() {
		t.Fatalf("config = %+v", config)
	}
}
