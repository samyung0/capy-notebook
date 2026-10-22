package store

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"sort"
	"strconv"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// UndoPayload is an agent step's Undo (or Redo) as the collaboration server
// builds it (Epo 2026-10-21): per document the step wrote, the Yjs update
// that reverses it (base64), and the lineage it was made in. The chat keeps
// it in the browser for a day and sends it back; nothing here stores it, and
// it is never logged. The MAC binds it to its step and document, so a payload
// cannot be replayed onto another file or forged. DocumentID tells the
// browser which document's lineage retires it (Epo 2026-10-22, Q122); the
// server reads the document from the step, never from it.
type UndoPayload struct {
	OperationID string            `json:"operationId,omitempty" maxLength:"64" doc:"The step this payload reverses"`
	DocumentID  string            `json:"documentId,omitempty" maxLength:"64" doc:"The material or file the step changed"`
	Epoch       int64             `json:"epoch" doc:"The document lineage it was made in"`
	Updates     map[string]string `json:"updates" doc:"Per document, the base64 Yjs update that reverses the step"`
	MAC         string            `json:"mac,omitempty" maxLength:"64" doc:"The server's signature over the step, the document, the epoch and the updates"`
}

// undoPayloadKey is the MAC key, derived from the collaboration secret for
// this purpose alone.
func (s *Store) undoPayloadKey() []byte {
	if s.collaborationSecret == "" {
		return nil
	}
	mac := hmac.New(sha256.New, []byte(s.collaborationSecret))
	mac.Write([]byte("capy agent undo payload v1"))
	return mac.Sum(nil)
}

// undoPayloadMAC signs (step, target kind and id, epoch, updates digest); the
// digest reads the updates in name order, each as its name, a zero byte, its
// length and its decoded bytes. False when an update is not base64.
func undoPayloadMAC(key []byte, step string, target DocumentTarget, payload *UndoPayload) (string, bool) {
	names := make([]string, 0, len(payload.Updates))
	for name := range payload.Updates {
		names = append(names, name)
	}
	sort.Strings(names)
	digest := sha256.New()
	for _, name := range names {
		update, err := base64.StdEncoding.DecodeString(payload.Updates[name])
		if err != nil {
			return "", false
		}
		digest.Write([]byte(name))
		digest.Write([]byte{0})
		digest.Write(binary.BigEndian.AppendUint64(nil, uint64(len(update))))
		digest.Write(update)
	}
	mac := hmac.New(sha256.New, key)
	for _, field := range []string{"v1", step, string(target.Kind), target.ID, strconv.FormatInt(payload.Epoch, 10)} {
		mac.Write([]byte(field))
		mac.Write([]byte{0})
	}
	mac.Write(digest.Sum(nil))
	return hex.EncodeToString(mac.Sum(nil)), true
}

// signUndoPayload names the payload's step and signs it; nil when it cannot
// be signed (no secret configured, an update that is not base64), which only
// means that step gets no Undo in the browser.
func (s *Store) signUndoPayload(step string, target DocumentTarget, payload *UndoPayload) *UndoPayload {
	key := s.undoPayloadKey()
	if payload == nil || len(payload.Updates) == 0 || key == nil {
		return nil
	}
	mac, ok := undoPayloadMAC(key, step, target, payload)
	if !ok {
		return nil
	}
	return &UndoPayload{OperationID: step, DocumentID: target.ID, Epoch: payload.Epoch, Updates: payload.Updates, MAC: mac}
}

// verifyUndoPayload reports whether the browser sent back a payload this
// server signed for this step of this document.
func (s *Store) verifyUndoPayload(step string, resource agenttools.ResourceRef, payload *UndoPayload) bool {
	key := s.undoPayloadKey()
	if payload == nil || len(payload.Updates) == 0 || key == nil {
		return false
	}
	want, ok := undoPayloadMAC(key, step, DocumentTarget{Kind: resource.Kind, ID: resource.ID}, payload)
	if !ok {
		return false
	}
	got, err := hex.DecodeString(payload.MAC)
	if err != nil {
		return false
	}
	wantBytes, _ := hex.DecodeString(want)
	return hmac.Equal(got, wantBytes)
}
