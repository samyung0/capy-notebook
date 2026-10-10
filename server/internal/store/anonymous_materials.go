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
// notes. Workspace materials have no sharing of their own, so they are not
// reachable here; a visible note's embedded quizzes and flashcard sets are
// reached only through the note (AnonymousNote). Visibility and the owner's
// lifecycle are read in the same statement as the content.
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
	UpdatedAt  time.Time       `json:"updatedAt"`
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
	UpdatedAt  time.Time          `json:"updatedAt"`
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

// quizQuestions is a quiz's full questions, keys included, "[]" when empty.
func quizQuestions(content string) (json.RawMessage, error) {
	qs, _, err := materialdoc.ExtractQuiz(content)
	if len(qs) == 0 && err == nil {
		qs = json.RawMessage("[]")
	}
	return qs, err
}

// writtenCards is a set's cards without blank ones: a new set starts with one
// empty card, and visitors only study written ones.
func writtenCards(content string) ([]materialdoc.Card, error) {
	cards, err := materialdoc.ExtractFlashcards(content)
	return slices.DeleteFunc(cards, func(c materialdoc.Card) bool {
		return strings.TrimSpace(c.Front) == "" && strings.TrimSpace(c.Back) == ""
	}), err
}

func (s *Store) AnonymousQuiz(ctx context.Context, id string) (AnonymousQuiz, error) {
	mt, err := s.anonymousMaterial(ctx, id, "quiz")
	if err != nil {
		return AnonymousQuiz{}, err
	}
	qs, err := quizQuestions(mt.Content)
	if err != nil {
		return AnonymousQuiz{}, err
	}
	return AnonymousQuiz{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Questions: qs, UpdatedAt: mt.UpdatedAt, Provenance: mt.Provenance, Author: mt.Author}, nil
}

func (s *Store) AnonymousFlashcards(ctx context.Context, id string) (AnonymousFlashcards, error) {
	mt, err := s.anonymousMaterial(ctx, id, "flashcards")
	if err != nil {
		return AnonymousFlashcards{}, err
	}
	cards, err := writtenCards(mt.Content)
	if err != nil {
		return AnonymousFlashcards{}, err
	}
	return AnonymousFlashcards{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Color: mt.Color, Cards: cards, UpdatedAt: mt.UpdatedAt, Provenance: mt.Provenance, Author: mt.Author}, nil
}

// AnonymousNote is a standalone note's read projection (Plate JSON), which the
// page renders with the static renderer, and the quizzes and flashcard sets
// embedded in it.
type AnonymousNote struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	Privacy    Privacy          `json:"privacy"`
	Content    json.RawMessage  `json:"content"`
	UpdatedAt  time.Time        `json:"updatedAt"`
	Author     MaterialAuthor   `json:"author"`
	Provenance *Provenance      `json:"provenance,omitempty"`
	Embeds     []AnonymousEmbed `json:"embeds" nullable:"false"`
}

// AnonymousEmbed is a quiz or flashcard set embedded in a visible note, in the
// order the note references it. Questions hold the keys here, like
// AnonymousQuiz; the share handler sends learner views. Cards are written
// cards only. Provenance is the item's own, shown inside the embed.
type AnonymousEmbed struct {
	ID         string             `json:"id"`
	Kind       string             `json:"kind" enum:"quiz,flashcards"`
	Questions  json.RawMessage    `json:"questions,omitempty"`
	Cards      []materialdoc.Card `json:"cards,omitempty" nullable:"false"`
	Provenance *Provenance        `json:"provenance,omitempty"`
}

func (s *Store) AnonymousNote(ctx context.Context, id string) (AnonymousNote, error) {
	mt, err := s.anonymousMaterial(ctx, id, "note")
	if err != nil {
		return AnonymousNote{}, err
	}
	embeds, err := s.anonymousEmbeds(ctx, mt.ID, mt.Content)
	if err != nil {
		return AnonymousNote{}, err
	}
	sources := []*Provenance{}
	for _, embed := range embeds {
		if embed.Provenance != nil {
			sources = append(sources, embed.Provenance)
		}
	}
	return AnonymousNote{ID: mt.ID, Name: mt.Title, Privacy: mt.Privacy, Content: json.RawMessage(mt.Content), UpdatedAt: mt.UpdatedAt, Author: mt.Author,
		Provenance: WithEmbedSources(mt.Provenance, sources), Embeds: embeds}, nil
}

// anonymousEmbeds reads the note's own live embedded rows that its current
// content references. A reference to another note's row, or to a trashed
// one, is left out.
func (s *Store) anonymousEmbeds(ctx context.Context, noteID, content string) ([]AnonymousEmbed, error) {
	refs, err := materialdoc.ExtractMaterialRefs(content)
	if err != nil {
		return nil, err
	}
	embeds := []AnonymousEmbed{}
	if len(refs) == 0 {
		return embeds, nil
	}
	ids := make([]string, len(refs))
	for i, ref := range refs {
		ids[i] = ref.MaterialID
	}
	rows, err := s.pool.Query(ctx, `SELECT id, kind, content, provenance FROM materials
		WHERE parent_material_id=$1 AND id = ANY($2) AND trashed_at IS NULL AND kind IN ('quiz','flashcards')`, noteID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := map[string]AnonymousEmbed{}
	for rows.Next() {
		var embed AnonymousEmbed
		var content string
		var provenance []byte
		if err := rows.Scan(&embed.ID, &embed.Kind, &content, &provenance); err != nil {
			return nil, err
		}
		if embed.Provenance, err = decodeProvenance(provenance); err != nil {
			return nil, err
		}
		if embed.Kind == "quiz" {
			embed.Questions, err = quizQuestions(content)
		} else {
			embed.Cards, err = writtenCards(content)
		}
		if err != nil {
			return nil, err
		}
		found[embed.ID] = embed
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if embed, ok := found[id]; ok {
			embeds = append(embeds, embed)
			delete(found, id) // a row referenced twice is sent once
		}
	}
	return embeds, nil
}

// AnonymousNoteQuiz returns the full questions of quizID, a quiz embedded in
// the visible note noteID and referenced by its current content, for grading
// through the note's link.
func (s *Store) AnonymousNoteQuiz(ctx context.Context, noteID, quizID string) (json.RawMessage, error) {
	note, err := s.AnonymousNote(ctx, noteID)
	if err != nil {
		return nil, err
	}
	for _, embed := range note.Embeds {
		if embed.ID == quizID && embed.Kind == "quiz" {
			return embed.Questions, nil
		}
	}
	return nil, ErrNotFound
}

// AnonymousNoteAssetPath is AnonymousQuizAssetPath for a visible note: only an
// image the note's current content shows, or one an embedded quiz or written
// card of the note shows (owned by that quiz or set), can be read through its
// link.
func (s *Store) AnonymousNoteAssetPath(ctx context.Context, noteID, assetID string) (objectPath, contentType string, err error) {
	mt, err := s.anonymousMaterial(ctx, noteID, "note")
	if err != nil {
		return "", "", err
	}
	ids, err := materialdoc.EditorAssetIDs(mt.Content)
	if err != nil {
		return "", "", err
	}
	if slices.Contains(ids, assetID) {
		return s.anonymousAssetPath(ctx, noteID, assetID)
	}
	embeds, err := s.anonymousEmbeds(ctx, mt.ID, mt.Content)
	if err != nil {
		return "", "", err
	}
	for _, embed := range embeds {
		shown := slices.ContainsFunc(embed.Cards, func(c materialdoc.Card) bool {
			return c.Image != nil && c.Image.AssetID == assetID
		})
		if embed.Kind == "quiz" {
			if shown, err = questionsShowAsset(embed.Questions, assetID); err != nil {
				return "", "", err
			}
		}
		if shown {
			return s.anonymousAssetPath(ctx, embed.ID, assetID)
		}
	}
	return "", "", ErrNotFound
}

// questionsShowAsset reports whether any of the full questions shows assetID,
// worked solutions included, so their images resolve after grading.
func questionsShowAsset(raw json.RawMessage, assetID string) (bool, error) {
	var list []map[string]any
	if err := json.Unmarshal(raw, &list); err != nil {
		return false, err
	}
	for _, q := range list {
		if slices.Contains(questions.AssetIDs(q), assetID) {
			return true, nil
		}
	}
	return false, nil
}

// AnonymousQuizAssetPath returns the object behind one of a visible quiz's
// images. The asset must belong to the quiz and appear in its current content,
// so a signed quiz link cannot be used to read any other editor asset.
func (s *Store) AnonymousQuizAssetPath(ctx context.Context, quizID, assetID string) (objectPath, contentType string, err error) {
	quiz, err := s.AnonymousQuiz(ctx, quizID)
	if err != nil {
		return "", "", err
	}
	shown, err := questionsShowAsset(quiz.Questions, assetID)
	if err != nil {
		return "", "", err
	}
	if !shown {
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
