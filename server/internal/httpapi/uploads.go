package httpapi

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Object keys are built only through these helpers so every source object lands
// under one prefix. Three shapes used to coexist — `sources/blob_…` from the
// presign flow against bare `blob_…` from the legacy multipart and import paths —
// which made the incoming/ lifecycle rule and the orphan sweep unable to reason
// about a key from its name alone.
func sourceObjectKey(name string) string { return "sources/" + name }

// incomingObjectKey is where a browser PUTs before promotion. The prefix carries
// a bucket lifecycle rule expiring objects after a day, so an upload that is
// never completed costs nothing even if the outbox never hears about it.
func incomingObjectKey(uploadID, name string) string {
	return "incoming/" + uploadID + "/" + name
}

// sourceObjectKeys names a source upload's incoming and final objects: a
// 128-bit blob id plus the filename's plain extension. Browser uploads and
// cloud imports both take their keys here.
func sourceObjectKeys(uploadID, name string) (incoming, final string) {
	blob := store.ObjectKeyID("blob") + keyExtension(name)
	return incomingObjectKey(uploadID, blob), sourceObjectKey(blob)
}

// keyExtension is the filename's extension as an object key suffix, kept only
// when it is plain lowercase letters and digits: the name is user input, and
// control or space characters must not reach a bucket key.
func keyExtension(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if !keyExtensionPattern.MatchString(ext) {
		return ""
	}
	return ext
}

var keyExtensionPattern = regexp.MustCompile(`^\.[a-z0-9]{1,11}$`)
