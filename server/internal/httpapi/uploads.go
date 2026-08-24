package httpapi

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
