package store

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Signed-out visitors read standalone link/public quizzes, flashcard sets and
// notes.
// Workspace materials have no sharing of their own, and embedded ones follow a
// note visitors cannot open, so neither is reachable here. Visibility and the
// owner's lifecycle are read in the same statement as the content.
const anonymousMaterialFrom = `
 FROM materials m JOIN users owner ON owner.id=m.owner_user_id
 WHERE m.id=$1 AND m.kind=$2 AND m.workspace_id IS NULL AND m.parent_material_id IS NULL
   AND m.privacy IN ('link','public') AND m.trashed_at IS NULL
   AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
   AND owner.suspended_at IS NULL`

// AnonymousQuiz holds the full questions, keys included: the share handler
// sends learner views and grades against the keys on the server.
type AnonymousQuiz struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Privacy    Privacy         `json:"privacy"`
	Questions  json.RawMessage `json:"questions"`
	Provenance *Provenance     `json:"provenance,omitempty"`
	Author     MaterialAuthor  `json:"author"`
}

// AnonymousFlashcards carries card text only, never the owner's study state.
type AnonymousFlashcards struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Privacy    Privacy            `json:"privacy"`
	Color      UserColor          `json:"color"`
	Cards      []materialdoc.Card `json:"cards" nullable:"false"`
	Provenance *Provenance        `json:"provenance,omitempty"`
	Author     MaterialAuthor     `json:"author"`
}

// MaterialAuthor is the owner public pages show next to a shared item.
type MaterialAuthor struct {
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// The owner's display name and avatar, resolved like the collaborator list.
const authorCols = `COALESCE(owner.name,''), COALESCE('/icons/' || NULLIF(owner.avatar_icon_id,'') || '.svg', owner.avatar_url,'')`

// MaterialAuthorOf reads the owner of a material for its shared page.
func (s *Store) MaterialAuthorOf(ctx context.Context, materialID string) (MaterialAuthor, error) {
	var author MaterialAuthor
	err := s.pool.QueryRow(ctx, `SELECT `+authorCols+` FROM materials m JOIN users owner ON owner.id=m.owner_user_id WHERE m.id=$1`, materialID).
		Scan(&author.Name, &author.AvatarURL)
	if isNoRows(err) {
		return author, ErrNotFound
	}
	return author, err
}

type anonymousRow struct {
	Material
	Author MaterialAuthor
}

func (s *Store) anonymousMaterial(ctx context.Context, id, kind string) (anonymousRow, error) {
	var row anonymousRow
	var provenance []byte
	err := s.pool.QueryRow(ctx, `SELECT m.id, m.title, m.privacy, m.color, m.content, m.provenance, m.updated_at, `+authorCols+anonymousMaterialFrom, id, kind).
		Scan(&row.ID, &row.Title, &row.Privacy, &row.Color, &row.Content, &provenance, &row.UpdatedAt, &row.Author.Name, &row.Author.AvatarURL)
	if isNoRows(err) {
		return row, ErrNotFound
	}
	if err != nil {
		return row, err
	}
	row.Provenance, err = decodeProvenance(provenance)
	return row, err
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
	return AnonymousQuiz{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Questions: qs, Provenance: mt.Provenance, Author: mt.Author}, nil
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
	return AnonymousFlashcards{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Color: mt.Color, Cards: cards, Provenance: mt.Provenance, Author: mt.Author}, nil
}

// AnonymousNote is a standalone note's read projection (Plate JSON), which the
// page renders with the static renderer.
type AnonymousNote struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Privacy    Privacy         `json:"privacy"`
	Content    json.RawMessage `json:"content"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	Author     MaterialAuthor  `json:"author"`
	Provenance *Provenance     `json:"provenance,omitempty"`
}

func (s *Store) AnonymousNote(ctx context.Context, id string) (AnonymousNote, error) {
	mt, err := s.anonymousMaterial(ctx, id, "note")
	if err != nil {
		return AnonymousNote{}, err
	}
	return AnonymousNote{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Content: json.RawMessage(mt.Content), UpdatedAt: mt.UpdatedAt, Author: mt.Author, Provenance: mt.Provenance}, nil
}

// AnonymousNoteAssetPath is AnonymousQuizAssetPath for a visible note: only an
// image the note's current content shows can be read through its link.
func (s *Store) AnonymousNoteAssetPath(ctx context.Context, noteID, assetID string) (objectPath, contentType string, err error) {
	mt, err := s.anonymousMaterial(ctx, noteID, "note")
	if err != nil {
		return "", "", err
	}
	ids, err := materialdoc.EditorAssetIDs(mt.Content)
	if err != nil {
		return "", "", err
	}
	if !slices.Contains(ids, assetID) {
		return "", "", ErrNotFound
	}
	return s.anonymousAssetPath(ctx, noteID, assetID)
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
	return s.anonymousAssetPath(ctx, quizID, assetID)
}

// AnonymousFlashcardAssetPath is AnonymousQuizAssetPath for a visible set's
// card images: only a card a visitor studies can name the asset.
func (s *Store) AnonymousFlashcardAssetPath(ctx context.Context, setID, assetID string) (objectPath, contentType string, err error) {
	set, err := s.AnonymousFlashcards(ctx, setID)
	if err != nil {
		return "", "", err
	}
	if !slices.ContainsFunc(set.Cards, func(c materialdoc.Card) bool {
		return c.Image != nil && c.Image.AssetID == assetID
	}) {
		return "", "", ErrNotFound
	}
	return s.anonymousAssetPath(ctx, setID, assetID)
}

func (s *Store) anonymousAssetPath(ctx context.Context, materialID, assetID string) (objectPath, contentType string, err error) {
	err = s.pool.QueryRow(ctx, `SELECT object_path, content_type FROM editor_assets
		WHERE id=$1 AND material_id=$2 AND status='ready' AND trashed_at IS NULL`, assetID, materialID).Scan(&objectPath, &contentType)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	return objectPath, contentType, err
}
