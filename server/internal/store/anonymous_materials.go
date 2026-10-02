package store

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Signed-out visitors read standalone link/public quizzes and flashcard sets.
// Workspace materials have no sharing of their own, and embedded ones follow a
// note visitors cannot open, so neither is reachable here. Visibility and the
// owner's lifecycle are read in the same statement as the content.
const anonymousMaterialFrom = `
 FROM materials m JOIN users owner ON owner.id=m.owner_user_id
 WHERE m.id=$1 AND m.kind=$2 AND m.workspace_id IS NULL AND m.parent_material_id IS NULL
   AND m.privacy IN ('link','public') AND m.trashed_at IS NULL
   AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
   AND owner.suspended_at IS NULL`

// AnonymousQuiz keeps answer keys and marking schemes: the browser grades
// closed parts, as it does for signed-in link viewers.
type AnonymousQuiz struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Privacy    Privacy         `json:"privacy"`
	Questions  json.RawMessage `json:"questions"`
	Provenance *Provenance     `json:"provenance,omitempty"`
}

// AnonymousFlashcards carries card text only, never the owner's study state.
type AnonymousFlashcards struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Privacy    Privacy            `json:"privacy"`
	Color      UserColor          `json:"color"`
	Cards      []materialdoc.Card `json:"cards" nullable:"false"`
	Provenance *Provenance        `json:"provenance,omitempty"`
}

func (s *Store) anonymousMaterial(ctx context.Context, id, kind string) (Material, error) {
	var mt Material
	var provenance []byte
	err := s.pool.QueryRow(ctx, `SELECT m.id, m.title, m.privacy, m.color, m.content, m.provenance`+anonymousMaterialFrom, id, kind).
		Scan(&mt.ID, &mt.Title, &mt.Privacy, &mt.Color, &mt.Content, &provenance)
	if isNoRows(err) {
		return mt, ErrNotFound
	}
	if err != nil {
		return mt, err
	}
	mt.Provenance, err = decodeProvenance(provenance)
	return mt, err
}

func (s *Store) AnonymousQuiz(ctx context.Context, id string) (AnonymousQuiz, error) {
	mt, err := s.anonymousMaterial(ctx, id, "quiz")
	if err != nil {
		return AnonymousQuiz{}, err
	}
	qs, _, err := materialdoc.ExtractQuiz(mt.Content)
	if err != nil {
		return AnonymousQuiz{}, err
	}
	if len(qs) == 0 {
		qs = json.RawMessage("[]")
	}
	return AnonymousQuiz{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Questions: qs, Provenance: mt.Provenance}, nil
}

func (s *Store) AnonymousFlashcards(ctx context.Context, id string) (AnonymousFlashcards, error) {
	mt, err := s.anonymousMaterial(ctx, id, "flashcards")
	if err != nil {
		return AnonymousFlashcards{}, err
	}
	cards, err := materialdoc.ExtractFlashcards(mt.Content)
	if err != nil {
		return AnonymousFlashcards{}, err
	}
	// A new set starts with one empty card; visitors only study written ones.
	cards = slices.DeleteFunc(cards, func(c materialdoc.Card) bool {
		return strings.TrimSpace(c.Front) == "" && strings.TrimSpace(c.Back) == ""
	})
	return AnonymousFlashcards{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Color: mt.Color, Cards: cards, Provenance: mt.Provenance}, nil
}

// AnonymousQuizAssetPath returns the object behind one of a visible quiz's
// images. The asset must belong to the quiz and appear in its current content,
// so a signed quiz link cannot be used to read any other editor asset.
func (s *Store) AnonymousQuizAssetPath(ctx context.Context, quizID, assetID string) (objectPath, contentType string, err error) {
	quiz, err := s.AnonymousQuiz(ctx, quizID)
	if err != nil {
		return "", "", err
	}
	var list []map[string]any
	if err := json.Unmarshal(quiz.Questions, &list); err != nil {
		return "", "", err
	}
	referenced := false
	for _, q := range list {
		referenced = referenced || slices.Contains(questions.AssetIDs(q), assetID)
	}
	if !referenced {
		return "", "", ErrNotFound
	}
	err = s.pool.QueryRow(ctx, `SELECT object_path, content_type FROM editor_assets
		WHERE id=$1 AND material_id=$2 AND status='ready'`, assetID, quizID).Scan(&objectPath, &contentType)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	return objectPath, contentType, err
}
