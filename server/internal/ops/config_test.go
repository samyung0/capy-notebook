package ops

import "testing"

func TestSecurityConfigRequiresCompleteIdentityConfiguration(t *testing.T) {
	t.Parallel()
	valid := SecurityConfig{
		ClerkSecretKey:         "clerk",
		CloudflareAccessIssuer: "https://team.cloudflareaccess.com",
		CloudflareAccessAUD:    "audience",
		CloudflareAccessJWKS:   "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("closed configuration rejected: %v", err)
	}
	cases := []SecurityConfig{
		{},
		{CloudflareAccessIssuer: valid.CloudflareAccessIssuer},
		{
			CloudflareAccessIssuer: valid.CloudflareAccessIssuer,
			CloudflareAccessAUD:    valid.CloudflareAccessAUD,
		},
		{
			CloudflareAccessIssuer: valid.CloudflareAccessIssuer,
			CloudflareAccessAUD:    valid.CloudflareAccessAUD,
			CloudflareAccessJWKS:   valid.CloudflareAccessJWKS,
		},
	}
	for _, config := range cases {
		if err := config.Validate(); err == nil {
			t.Fatal("incomplete identity configuration was accepted")
		}
	}
}
