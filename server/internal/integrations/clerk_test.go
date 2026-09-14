package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/clerk/clerk-sdk-go/v2"
)

func TestClerkConnectedProvidersSeparatesLoginFromImportGrants(t *testing.T) {
	previous := clerk.GetBackend()
	t.Cleanup(func() { clerk.SetBackend(previous) })
	for _, tc := range []struct {
		name, provider, scopes, verification, grant string
		wantLinked, wantImport                      bool
	}{
		{"Microsoft login", "oauth_microsoft", "openid profile email User.Read", "verified", "microsoftFilesRead", true, false},
		{"Microsoft import", "oauth_microsoft", "openid Files.Read offline_access", "verified", "microsoftFilesRead", true, true},
		{"Microsoft grant removed", "oauth_microsoft", "", "verified", "microsoftFilesRead", true, false},
		{"Microsoft incomplete consent", "oauth_microsoft", "Files.Read", "unverified", "microsoftFilesRead", false, false},
		{"Microsoft unrelated file scope", "oauth_microsoft", "Files.Read.Selected", "verified", "microsoftFilesRead", true, false},
		{"Google login", "oauth_google", "openid profile email", "verified", "googleDriveReadonly", true, false},
		{"Google import", "oauth_google", GoogleDriveReadonlyScope, "verified", "googleDriveReadonly", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(clerk.User{
				ID: "user_import",
				ExternalAccounts: []*clerk.ExternalAccount{{
					Provider:       tc.provider,
					ApprovedScopes: tc.scopes,
					Verification:   &clerk.Verification{Status: tc.verification},
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			clerk.SetBackend(clerk.NewBackend(&clerk.BackendConfig{
				Key: clerk.String("test-key"),
				HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					if req.Method != http.MethodGet || req.URL.Path != "/v1/users/user_import" {
						t.Fatalf("unexpected Clerk request: %s %s", req.Method, req.URL.Path)
					}
					return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{"Content-Type": {"application/json"}}}, nil
				})},
			}))
			status, err := ClerkConnectedProviders(context.Background(), "user_import")
			if err != nil {
				t.Fatal(err)
			}
			provider := strings.TrimPrefix(tc.provider, "oauth_")
			if status[provider] != tc.wantLinked || status[tc.grant] != tc.wantImport {
				t.Fatalf("status=%v, want linked=%t import=%t", status, tc.wantLinked, tc.wantImport)
			}
		})
	}
}
