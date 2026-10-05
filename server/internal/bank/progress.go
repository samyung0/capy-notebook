package bank

import (
	"context"
	"slices"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/review"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TopicHashes maps each current (not retracted) question of a topic to
// review.QuestionHash of its content, which learners' progress rows in the app
// database are checked against. An unknown topic is ErrNotFound.
func (s *Store) TopicHashes(ctx context.Context, topic string) (map[string]string, error) {
	p, err := s.pool(ctx, false)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err = p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM topics WHERE id=$1)`, topic).Scan(&exists); err != nil {
		return nil, dbError(err)
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.Query(ctx, `SELECT id,content FROM questions WHERE topic_id=$1 AND retracted_at IS NULL`, topic)
	if err != nil {
		return nil, dbError(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id string
		var q map[string]any
		if err := rows.Scan(&id, &q); err != nil {
			return nil, dbError(err)
		}
		out[id] = review.QuestionHash(q)
	}
	return out, dbError(rows.Err())
}

// TopicProgress is one topic on the /bank landing: its labels and the
// learner's latest results against its current questions.
type TopicProgress struct {
	ExamID         string    `json:"examId"`
	ExamLabel      string    `json:"examLabel"`
	SubjectID      string    `json:"subjectId"`
	SubjectLabel   string    `json:"subjectLabel"`
	TopicID        string    `json:"topicId"`
	TopicLabel     string    `json:"topicLabel"`
	Total          int       `json:"total" doc:"Current (not retracted) questions"`
	Answered       int       `json:"answered" doc:"Current questions with a result for their current content"`
	Correct        int       `json:"correct" doc:"Answered questions whose latest score is full marks"`
	LastAnsweredAt time.Time `json:"lastAnsweredAt"`
	NextQuestionID *string   `json:"nextQuestionId" doc:"The next unanswered question after the most recently answered one, in topic order and wrapping to the start; null once every question is answered"`
}

// topicQuestions is a topic's labels and its current questions' hashes in
// topic order.
type topicQuestions struct {
	TopicProgress
	ids, hashes []string
}

// Progress summarizes a learner's results by topic: only topics with at least
// one current answered question, the most recently answered first.
func (s *Store) Progress(ctx context.Context, results []store.BankResult) ([]TopicProgress, error) {
	out := []TopicProgress{}
	ids := []string{}
	for _, r := range results {
		if !slices.Contains(ids, r.TopicID) {
			ids = append(ids, r.TopicID)
		}
	}
	if len(ids) == 0 {
		return out, nil
	}
	topics, err := s.topicQuestions(ctx, ids)
	if err != nil {
		return nil, err
	}
	return summarize(topics, results), nil
}

func (s *Store) topicQuestions(ctx context.Context, ids []string) ([]topicQuestions, error) {
	p, err := s.pool(ctx, false)
	if err != nil {
		return nil, err
	}
	rows, err := p.Query(ctx, `SELECT e.id,e.label,s.id,s.label,t.id,t.label,q.id,q.content
 FROM topics t JOIN subjects s ON s.id=t.subject_id JOIN exams e ON e.id=s.exam_id
 LEFT JOIN questions q ON q.topic_id=t.id AND q.retracted_at IS NULL
 WHERE t.id=ANY($1) ORDER BY t.id,q.position,q.id`, ids)
	if err != nil {
		return nil, dbError(err)
	}
	defer rows.Close()
	out := []topicQuestions{}
	for rows.Next() {
		var t TopicProgress
		var id *string
		var q map[string]any
		if err := rows.Scan(&t.ExamID, &t.ExamLabel, &t.SubjectID, &t.SubjectLabel, &t.TopicID, &t.TopicLabel, &id, &q); err != nil {
			return nil, dbError(err)
		}
		if len(out) == 0 || out[len(out)-1].TopicID != t.TopicID {
			out = append(out, topicQuestions{TopicProgress: t})
		}
		if id != nil {
			last := &out[len(out)-1]
			last.ids = append(last.ids, *id)
			last.hashes = append(last.hashes, review.QuestionHash(q))
		}
	}
	return out, dbError(rows.Err())
}

func summarize(topics []topicQuestions, results []store.BankResult) []TopicProgress {
	byID := map[string]store.BankResult{}
	for _, r := range results {
		byID[r.QuestionID] = r
	}
	out := []TopicProgress{}
	for _, t := range topics {
		answered := make([]bool, len(t.ids))
		last := -1
		for i, id := range t.ids {
			r, ok := byID[id]
			if !ok || r.Hash != t.hashes[i] {
				continue
			}
			answered[i] = true
			t.Answered++
			if r.Score >= 1 {
				t.Correct++
			}
			if last < 0 || r.AnsweredAt.After(t.LastAnsweredAt) {
				last, t.LastAnsweredAt = i, r.AnsweredAt
			}
		}
		if last < 0 {
			continue
		}
		t.Total = len(t.ids)
		for step := 1; step < len(t.ids); step++ {
			if i := (last + step) % len(t.ids); !answered[i] {
				t.NextQuestionID = &t.ids[i]
				break
			}
		}
		out = append(out, t.TopicProgress)
	}
	slices.SortStableFunc(out, func(a, b TopicProgress) int { return b.LastAnsweredAt.Compare(a.LastAnsweredAt) })
	return out
}
