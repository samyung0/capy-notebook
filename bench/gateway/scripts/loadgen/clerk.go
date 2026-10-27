package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"
)

// The gateway's loadtest build sends the Clerk SDK here: the JWKS its session
// tokens verify against, and the profile it reads when it provisions a user
// and then hourly. The key lives in the results volume so `serve` and the
// `setup`/`run` processes sign and verify with the same one.
const keyID = "kid_loadtest"

func loadKey(path string) (*rsa.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		block := &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}
		return key, os.WriteFile(path, pem.EncodeToMemory(block), 0o600)
	}
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s holds no PEM key", path)
	}
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

var b64 = base64.RawURLEncoding

// sessionToken is a Clerk session JWT for userID, valid for a day: a browser
// refreshes its minute-long token from Clerk, never from the gateway, so the
// gateway's cost per request is the same.
func sessionToken(key *rsa.PrivateKey, userID, origin string) (string, error) {
	now := time.Now()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": keyID, "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"sub": userID,
		"sid": "sess_" + userID,
		"iss": "https://clerk.loadtest.test",
		"azp": origin,
		"iat": now.Unix(),
		"nbf": now.Add(-time.Minute).Unix(),
		"exp": now.Add(24 * time.Hour).Unix(),
	})
	signing := b64.EncodeToString(header) + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signing + "." + b64.EncodeToString(sig), nil
}

func serveFakes(addr string, key *rsa.PrivateKey) error {
	jwks, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "kid": keyID, "alg": "RS256", "use": "sig",
		"n": b64.EncodeToString(key.N.Bytes()),
		"e": b64.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/jwks", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwks)
	})
	mux.HandleFunc("GET /v1/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		emailID := "idn_" + id
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object":                   "user",
			"id":                       id,
			"first_name":               "Load",
			"last_name":                strings.TrimPrefix(id, "user_"),
			"primary_email_address_id": emailID,
			"email_addresses": []map[string]any{{
				"id": emailID, "object": "email_address",
				"email_address": strings.ToLower(id) + "@loadtest.test",
				"verification":  map[string]string{"status": "verified", "strategy": "email_code"},
			}},
			"has_image": false,
		})
	})
	// Sentry's envelope ingest: the gateway's error and trace reports.
	mux.HandleFunc("POST /api/{project}/envelope/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	})
	return http.ListenAndServe(addr, mux)
}
