package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
)

// SharePath signs a workspace id into its public summary path. The signature
// only proves the link came from us; privacy is still read live by the
// summary query. src/lib/shareLink.ts verifies the same format in the Worker.
func SharePath(secret []byte, workspaceID string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("share:v1:" + workspaceID))
	return "/w/" + workspaceID + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:12])
}
