package integrations

import (
	"encoding/json"
	"sync"
	"time"
)

// Clerk's Backend API limit is shared by the whole instance, so a user's OAuth
// tokens and connected providers are served from memory for a few minutes. A
// token is never served within tokenExpiryMargin of its expiry, and one whose
// expiry Clerk does not state is not kept. A disconnect and Clerk's user
// webhooks drop the user's entries (ForgetClerkUser).
const (
	clerkCacheTTL      = 3 * time.Minute
	tokenExpiryMargin  = time.Minute
	clerkCacheMaxUsers = 10_000
)

type cachedToken struct {
	token  string
	scopes []string
	until  time.Time
}

type cachedProviders struct {
	providers map[string]bool
	until     time.Time
}

var clerkCache = struct {
	sync.Mutex
	tokens    map[string]cachedToken // userID + "\x00" + provider
	providers map[string]cachedProviders
}{tokens: map[string]cachedToken{}, providers: map[string]cachedProviders{}}

func tokenKey(userID, provider string) string { return userID + "\x00" + provider }

func cachedAccessToken(userID, provider string, now time.Time) (cachedToken, bool) {
	clerkCache.Lock()
	defer clerkCache.Unlock()
	entry, ok := clerkCache.tokens[tokenKey(userID, provider)]
	return entry, ok && now.Before(entry.until)
}

// keepAccessToken caches a token until clerkCacheTTL or tokenExpiryMargin
// before expiresAt, whichever is sooner; a zero expiresAt keeps nothing.
func keepAccessToken(userID, provider, token string, scopes []string, expiresAt, now time.Time) {
	if expiresAt.IsZero() {
		return
	}
	until := now.Add(clerkCacheTTL)
	if last := expiresAt.Add(-tokenExpiryMargin); last.Before(until) {
		until = last
	}
	if !until.After(now) {
		return
	}
	clerkCache.Lock()
	defer clerkCache.Unlock()
	if len(clerkCache.tokens) >= clerkCacheMaxUsers {
		pruneClerkCache(now)
	}
	clerkCache.tokens[tokenKey(userID, provider)] = cachedToken{token: token, scopes: scopes, until: until}
}

func cachedConnectedProviders(userID string, now time.Time) (map[string]bool, bool) {
	clerkCache.Lock()
	defer clerkCache.Unlock()
	entry, ok := clerkCache.providers[userID]
	if !ok || !now.Before(entry.until) {
		return nil, false
	}
	out := make(map[string]bool, len(entry.providers))
	for key, value := range entry.providers {
		out[key] = value
	}
	return out, true
}

func keepConnectedProviders(userID string, providers map[string]bool, now time.Time) {
	clerkCache.Lock()
	defer clerkCache.Unlock()
	if len(clerkCache.providers) >= clerkCacheMaxUsers {
		pruneClerkCache(now)
	}
	clerkCache.providers[userID] = cachedProviders{providers: providers, until: now.Add(clerkCacheTTL)}
}

// pruneClerkCache drops expired entries; the caller holds the lock.
func pruneClerkCache(now time.Time) {
	for key, entry := range clerkCache.tokens {
		if !now.Before(entry.until) {
			delete(clerkCache.tokens, key)
		}
	}
	for key, entry := range clerkCache.providers {
		if !now.Before(entry.until) {
			delete(clerkCache.providers, key)
		}
	}
}

// ForgetClerkUser drops a user's cached tokens and connected providers, after
// a disconnect or a Clerk user webhook.
func ForgetClerkUser(userID string) {
	clerkCache.Lock()
	defer clerkCache.Unlock()
	delete(clerkCache.providers, userID)
	for _, provider := range []string{ProviderGoogle, ProviderMicrosoft} {
		delete(clerkCache.tokens, tokenKey(userID, provider))
	}
}

// tokenExpiries reads each listed token's expires_at from Clerk's raw answer
// (the SDK's type has no field for it), in list order; zero where absent.
// Clerk states it in Unix seconds or milliseconds; both are read.
func tokenExpiries(raw json.RawMessage) []time.Time {
	var list struct {
		Data []struct {
			ExpiresAt int64 `json:"expires_at"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	out := make([]time.Time, len(list.Data))
	for i, item := range list.Data {
		switch {
		case item.ExpiresAt > 1e12:
			out[i] = time.UnixMilli(item.ExpiresAt)
		case item.ExpiresAt > 0:
			out[i] = time.Unix(item.ExpiresAt, 0)
		}
	}
	return out
}
