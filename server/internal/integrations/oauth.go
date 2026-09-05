package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

var (
	ErrImportFileUnavailable = errors.New("provider file is unavailable")
	ErrImportFileTooLarge    = errors.New("provider file exceeds the source upload limit")
	ErrUnsupportedImportFile = errors.New("provider file type is not supported")
	errImportProviderDNS     = errors.New("provider download host lookup failed")
	errImportProviderNetwork = errors.New("provider download connection failed")
)

type providerHTTPError struct {
	provider   string
	statusCode int
}

func (e *providerHTTPError) Error() string {
	return fmt.Sprintf("%s metadata status %d", e.provider, e.statusCode)
}

func IsRetryableImportProviderError(err error) bool {
	var providerErr *providerHTTPError
	return errors.As(err, &providerErr) || errors.Is(err, errImportProviderDNS) ||
		errors.Is(err, errImportProviderNetwork)
}

func providerMetadataStatusError(
	provider string,
	statusCode int,
	rateLimited bool,
) error {
	if statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusRequestTimeout ||
		statusCode == http.StatusTooManyRequests ||
		statusCode >= http.StatusInternalServerError ||
		rateLimited {
		return &providerHTTPError{provider: provider, statusCode: statusCode}
	}
	return fmt.Errorf(
		"%w: %s metadata status %d",
		ErrImportFileUnavailable,
		provider,
		statusCode,
	)
}

func googleRateLimitResponse(body []byte) bool {
	var payload struct {
		Error struct {
			Errors []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return false
	}
	for _, item := range payload.Error.Errors {
		switch item.Reason {
		case "rateLimitExceeded", "userRateLimitExceeded", "backendError":
			return true
		}
	}
	return false
}

const googleExportMaxBytes = int64(10_000_000)

var providerHTTP = &http.Client{Timeout: 30 * time.Second}

const (
	importDownloadResolveTimeout = 5 * time.Second
	importDownloadDialTimeout    = 10 * time.Second
	importDownloadMaxRedirects   = 5
)

// importHostResolver is a variable so the URL boundary can be tested without
// making network requests. Production downloads resolve the host again in the
// dialer, so a DNS answer cannot be changed between validation and connect.
var importHostResolver = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// These ranges are not usable public destinations. IsPrivate and the other
// netip predicates cover the common cases; the explicit prefixes cover IANA
// special-purpose ranges that otherwise report as global unicast.
var blockedImportPrefixes = [...]netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("fec0::/10"),
}

func validateImportDownloadURL(ctx context.Context, rawURL string) error {
	downloadURL, err := url.Parse(rawURL)
	if err != nil || !strings.EqualFold(downloadURL.Scheme, "https") ||
		downloadURL.Host == "" || downloadURL.User != nil {
		return ErrImportFileUnavailable
	}
	host := downloadURL.Hostname()
	if host == "" || strings.Contains(host, "%") ||
		strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return ErrImportFileUnavailable
	}
	if port := downloadURL.Port(); port != "" {
		parsedPort, err := strconv.ParseUint(port, 10, 16)
		if err != nil || parsedPort == 0 {
			return ErrImportFileUnavailable
		}
	}
	addresses, err := resolveImportHost(ctx, host)
	if err != nil {
		return classifyImportDNSError(ctx, err)
	}
	if len(addresses) == 0 {
		return ErrImportFileUnavailable
	}
	if err := validateImportAddresses(addresses); err != nil {
		return err
	}
	return nil
}

func classifyImportDNSError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var dnsErr *net.DNSError
	if errors.Is(err, context.DeadlineExceeded) ||
		(errors.As(err, &dnsErr) && (dnsErr.IsTimeout || dnsErr.IsTemporary)) {
		return fmt.Errorf("%w: %v", errImportProviderDNS, err)
	}
	return ErrImportFileUnavailable
}

func resolveImportHost(ctx context.Context, host string) ([]netip.Addr, error) {
	if host == "" || strings.Contains(host, "%") {
		return nil, ErrImportFileUnavailable
	}
	if address, err := netip.ParseAddr(host); err == nil {
		if address.Zone() != "" {
			return nil, ErrImportFileUnavailable
		}
		return []netip.Addr{address.Unmap()}, nil
	}
	lookupCtx, cancel := context.WithTimeout(ctx, importDownloadResolveTimeout)
	defer cancel()
	addresses, err := importHostResolver(lookupCtx, host)
	if err != nil {
		return nil, err
	}
	for index := range addresses {
		if addresses[index].Zone() != "" {
			return nil, ErrImportFileUnavailable
		}
		addresses[index] = addresses[index].Unmap()
	}
	return addresses, nil
}

func validateImportAddresses(addresses []netip.Addr) error {
	for _, address := range addresses {
		if blockedImportAddress(address) {
			return ErrImportFileUnavailable
		}
	}
	return nil
}

func blockedImportAddress(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return true
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() ||
		address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsUnspecified() || address.IsMulticast() {
		return true
	}
	for _, prefix := range blockedImportPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func importDownloadClient() *http.Client {
	base := providerHTTP
	if base == nil {
		base = http.DefaultClient
	}
	client := *base
	client.Jar = nil
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= importDownloadMaxRedirects {
			return ErrImportFileUnavailable
		}
		if err := validateImportDownloadURL(req.Context(), req.URL.String()); err != nil {
			return err
		}
		// Microsoft preauthenticated URLs carry credentials in their query
		// string. Never let net/http turn one into a cross-origin Referer.
		req.Header.Del("Referer")
		if len(via) > 0 && !sameImportOrigin(via[len(via)-1].URL, req.URL) {
			req.Header.Del("Authorization")
		}
		return nil
	}
	client.Transport = hardenedImportTransport(base.Transport)
	return &client
}

func sameImportOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		left.Port() == right.Port()
}

func hardenedImportTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	transport, ok := base.(*http.Transport)
	if !ok {
		return base
	}
	clone := transport.Clone()
	// A proxy would resolve the destination outside the guarded dialer.
	clone.Proxy = nil
	clone.DialContext = importDialContext
	clone.DialTLSContext = nil
	clone.DialTLS = nil
	return clone
}

func importDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrImportFileUnavailable
	}
	addresses, err := resolveImportHost(ctx, host)
	if err != nil {
		return nil, classifyImportDNSError(ctx, err)
	}
	if err := validateImportAddresses(addresses); err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: importDownloadDialTimeout}
	var lastErr error
	for _, resolved := range addresses {
		if (network == "tcp4" && !resolved.Is4()) ||
			(network == "tcp6" && !resolved.Is6()) {
			continue
		}
		connection, err := dialer.DialContext(
			ctx,
			network,
			net.JoinHostPort(resolved.String(), port),
		)
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		return nil, ErrImportFileUnavailable
	}
	return nil, classifyImportDialError(ctx, lastErr)
}

func classifyImportDialError(ctx context.Context, err error) error {
	return classifyImportRequestError(ctx, err)
}

func classifyImportRequestError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var providerErr *providerHTTPError
	if errors.As(err, &providerErr) ||
		errors.Is(err, ErrImportFileUnavailable) ||
		errors.Is(err, ErrImportFileTooLarge) ||
		errors.Is(err, ErrUnsupportedImportFile) ||
		errors.Is(err, errImportProviderDNS) ||
		errors.Is(err, errImportProviderNetwork) {
		return err
	}
	return fmt.Errorf("%w: %v", errImportProviderNetwork, err)
}

type ImportFileMetadata struct {
	Name        string
	MIMEType    string
	Size        *int64
	DownloadURL string
	ExportPDF   bool
}

// DownloadImportFile retrieves one provider object for browser-side analysis.
// The caller supplies the workspace upload cap so an export with no metadata
// size cannot make the gateway buffer an unbounded response.
func DownloadImportFile(
	ctx context.Context,
	provider, accessToken string,
	ref ImportRef,
	maxBytes int64,
) ([]byte, string, error) {
	var (
		meta ImportFileMetadata
		err  error
	)
	switch provider {
	case ProviderGoogle:
		meta, err = GetGoogleFileMetadata(ctx, accessToken, ref.ID)
	case ProviderMicrosoft:
		meta, err = GetMicrosoftFileMetadata(ctx, accessToken, ref.ID, ref.DriveID)
	default:
		return nil, "", ErrImportFileUnavailable
	}
	if err != nil {
		return nil, "", err
	}
	if maxBytes < 0 || (meta.Size != nil && *meta.Size > maxBytes) {
		return nil, "", ErrImportFileTooLarge
	}

	downloadURL := meta.DownloadURL
	if provider == ProviderGoogle {
		downloadURL = GoogleDownloadURL(ref.ID, meta.ExportPDF)
	}
	if err := validateImportDownloadURL(ctx, downloadURL); err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	if provider == ProviderGoogle {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	resp, err := importDownloadClient().Do(req)
	if err != nil {
		return nil, "", classifyImportRequestError(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if err != nil {
			return nil, "", classifyImportRequestError(ctx, err)
		}
		return nil, "", providerMetadataStatusError(
			provider,
			resp.StatusCode,
			provider == ProviderGoogle && resp.StatusCode == http.StatusForbidden &&
				googleRateLimitResponse(body),
		)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", classifyImportRequestError(ctx, err)
	}
	if int64(len(data)) > maxBytes {
		return nil, "", ErrImportFileTooLarge
	}
	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = meta.MIMEType
	}
	return data, contentType, nil
}

func GoogleExportMaxBytes() int64 { return googleExportMaxBytes }

func GetGoogleFileMetadata(
	ctx context.Context,
	accessToken, fileID string,
) (ImportFileMetadata, error) {
	if !validGoogleFileID(fileID) {
		return ImportFileMetadata{}, ErrImportFileUnavailable
	}
	endpoint := "https://www.googleapis.com/drive/v3/files/" +
		url.PathEscape(fileID) +
		"?fields=id,name,mimeType,size,capabilities(canDownload)"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ImportFileMetadata{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := providerHTTP.Do(req)
	if err != nil {
		return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
	}
	defer resp.Body.Close()
	var body struct {
		Name         string `json:"name"`
		MIMEType     string `json:"mimeType"`
		Size         *int64 `json:"size,string"`
		Capabilities struct {
			CanDownload bool `json:"canDownload"`
		} `json:"capabilities"`
	}
	if resp.StatusCode >= 400 {
		errorBody, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if err != nil {
			return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
		}
		return ImportFileMetadata{}, providerMetadataStatusError(
			"google",
			resp.StatusCode,
			resp.StatusCode == http.StatusForbidden &&
				googleRateLimitResponse(errorBody),
		)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&body); err != nil {
		return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
	}
	if strings.TrimSpace(body.Name) == "" || !body.Capabilities.CanDownload {
		return ImportFileMetadata{}, ErrImportFileUnavailable
	}
	meta := ImportFileMetadata{
		Name:     body.Name,
		MIMEType: body.MIMEType,
		Size:     body.Size,
	}
	if strings.HasPrefix(body.MIMEType, "application/vnd.google-apps.") {
		switch body.MIMEType {
		case "application/vnd.google-apps.document",
			"application/vnd.google-apps.spreadsheet",
			"application/vnd.google-apps.presentation",
			"application/vnd.google-apps.drawing":
			meta.ExportPDF = true
			meta.MIMEType = "application/pdf"
			meta.Size = nil
			if !strings.EqualFold(path.Ext(meta.Name), ".pdf") {
				meta.Name += ".pdf"
			}
		default:
			return ImportFileMetadata{}, ErrUnsupportedImportFile
		}
	}
	return meta, nil
}

func GoogleDownloadURL(fileID string, exportPDF bool) string {
	escaped := url.PathEscape(fileID)
	if exportPDF {
		return "https://www.googleapis.com/drive/v3/files/" + escaped +
			"/export?mimeType=application/pdf"
	}
	return "https://www.googleapis.com/drive/v3/files/" + escaped + "?alt=media"
}

func validGoogleFileID(fileID string) bool {
	if fileID == "" {
		return false
	}
	for _, ch := range fileID {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return false
	}
	return true
}

func GetMicrosoftFileMetadata(
	ctx context.Context,
	accessToken, itemID, driveID string,
) (ImportFileMetadata, error) {
	base := MicrosoftItemURL(driveID, itemID)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		base+"?select=id,name,size,file,@microsoft.graph.downloadUrl",
		nil,
	)
	if err != nil {
		return ImportFileMetadata{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := providerHTTP.Do(req)
	if err != nil {
		return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		if _, err := io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)); err != nil {
			return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
		}
		return ImportFileMetadata{}, providerMetadataStatusError(
			"microsoft", resp.StatusCode, false,
		)
	}
	var body struct {
		Name        string `json:"name"`
		Size        *int64 `json:"size"`
		DownloadURL string `json:"@microsoft.graph.downloadUrl"`
		File        *struct {
			MIMEType string `json:"mimeType"`
		} `json:"file"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&body); err != nil {
		return ImportFileMetadata{}, classifyImportRequestError(ctx, err)
	}
	if strings.TrimSpace(body.Name) == "" || body.File == nil ||
		body.Size == nil || *body.Size < 0 || body.DownloadURL == "" {
		return ImportFileMetadata{}, ErrUnsupportedImportFile
	}
	if err := validateImportDownloadURL(ctx, body.DownloadURL); err != nil {
		return ImportFileMetadata{}, err
	}
	return ImportFileMetadata{
		Name:        body.Name,
		MIMEType:    body.File.MIMEType,
		Size:        body.Size,
		DownloadURL: body.DownloadURL,
	}, nil
}

// Providers supported for file import. OAuth token management lives in Clerk
// (see clerk.go); this file only talks to the providers' file APIs.
const (
	ProviderGoogle    = "google"
	ProviderMicrosoft = "microsoft"
)

func DownloadGoogleFile(accessToken, fileID string) ([]byte, string, error) {
	metaReq, _ := http.NewRequest("GET", "https://www.googleapis.com/drive/v3/files/"+fileID+"?fields=name,mimeType", nil)
	metaReq.Header.Set("Authorization", "Bearer "+accessToken)
	metaResp, err := http.DefaultClient.Do(metaReq)
	if err != nil {
		return nil, "", err
	}
	defer metaResp.Body.Close()
	var meta struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
	}
	_ = json.NewDecoder(metaResp.Body).Decode(&meta)

	dlURL := "https://www.googleapis.com/drive/v3/files/" + fileID + "?alt=media"
	if strings.HasPrefix(meta.MimeType, "application/vnd.google-apps.") {
		dlURL = "https://www.googleapis.com/drive/v3/files/" + fileID + "/export?mimeType=application/pdf"
		if meta.MimeType == "application/vnd.google-apps.document" {
			meta.Name = strings.TrimSuffix(meta.Name, ".gdoc") + ".pdf"
		}
	}
	req, _ := http.NewRequest("GET", dlURL, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("drive download: %s", string(data))
	}
	return data, meta.Name, nil
}

// MicrosoftDrive is the Graph /me/drive payload the picker host needs.
type MicrosoftDrive struct {
	ID        string `json:"id"`
	DriveType string `json:"driveType"`
	WebURL    string `json:"webUrl"`
}

// MicrosoftItemURL is the Graph item path. Shared or other-drive picks must
// use /drives/{id}/items/{id}; /me/drive/items/{id} only sees the user's drive.
func MicrosoftItemURL(driveID, itemID string) string {
	item := url.PathEscape(itemID)
	if strings.TrimSpace(driveID) == "" {
		return "https://graph.microsoft.com/v1.0/me/drive/items/" + item
	}
	return "https://graph.microsoft.com/v1.0/drives/" + url.PathEscape(driveID) + "/items/" + item
}

func DownloadMicrosoftFile(accessToken, itemID, driveID string) ([]byte, string, error) {
	base := MicrosoftItemURL(driveID, itemID)
	metaReq, err := http.NewRequest(http.MethodGet, base+"?select=name", nil)
	if err != nil {
		return nil, "", err
	}
	metaReq.Header.Set("Authorization", "Bearer "+accessToken)
	metaResp, err := http.DefaultClient.Do(metaReq)
	if err != nil {
		return nil, "", err
	}
	defer metaResp.Body.Close()
	if metaResp.StatusCode >= 400 {
		body, _ := io.ReadAll(metaResp.Body)
		return nil, "", fmt.Errorf("onedrive metadata: %s", string(body))
	}
	var meta struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(metaResp.Body).Decode(&meta); err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest(http.MethodGet, base+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("onedrive download: %s", string(data))
	}
	return data, meta.Name, nil
}

func GetMicrosoftDrive(ctx context.Context, accessToken string) (MicrosoftDrive, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me/drive?select=id,driveType,webUrl", nil)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	if resp.StatusCode >= 400 {
		return MicrosoftDrive{}, fmt.Errorf("onedrive drive: %s", string(body))
	}
	var drive MicrosoftDrive
	if err := json.Unmarshal(body, &drive); err != nil {
		return MicrosoftDrive{}, err
	}
	if strings.TrimSpace(drive.DriveType) == "" || strings.TrimSpace(drive.WebURL) == "" {
		return MicrosoftDrive{}, fmt.Errorf("onedrive drive: missing driveType or webUrl")
	}
	return drive, nil
}

// ImportRef is one picked file. DriveID is empty for Google and for a
// Microsoft item that still lives on /me/drive.
type ImportRef struct {
	ID      string
	DriveID string
}

func ZipImportDriveIDs(fileIDs, driveIDs []string) ([]ImportRef, error) {
	if len(driveIDs) > 0 && len(driveIDs) != len(fileIDs) {
		return nil, fmt.Errorf("driveIds must match fileIds")
	}
	out := make([]ImportRef, len(fileIDs))
	for i, id := range fileIDs {
		ref := ImportRef{ID: id}
		if i < len(driveIDs) {
			ref.DriveID = strings.TrimSpace(driveIDs[i])
		}
		out[i] = ref
	}
	return out, nil
}

func KindFromName(name string) string {
	return sourceupload.KindFromName(name)
}
