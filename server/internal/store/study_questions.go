package store

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// StudyQuestion is one question on a topic's page or Frequently wrong, with
// its person's latest result (Epo 2026-11-22, the topic questions mock).
type StudyQuestion struct {
	MaterialID    string `json:"materialId"`
	MaterialTitle string `json:"materialTitle"`
	QuestionID    string `json:"questionId"`
	Text          string `json:"text"`
	Group         string `json:"group" enum:"topic,others"`
	// TopicID is its first topic (itemTopics); TopicName names every one,
	// joined with commas.
	TopicID   *string `json:"topicId,omitempty"`
	TopicName string  `json:"topicName,omitempty"`
	// Result is the latest check's: right with full marks, partial with some.
	Result string `json:"result" enum:"right,partial,wrong,unattempted"`
	// Misses counts the checks that were not right.
	Misses int        `json:"misses"`
	At     *time.Time `json:"at,omitempty"`
	// Question is its content, for practising it here (the API sends it
	// answer-free); absent on a staff read and where it can't be practised: a
	// graded quiz's own, one hidden from them, or trashed.
	Question map[string]any `json:"question,omitempty"`
}

// QuestionsFilter picks a topic's questions (TopicID, or Others for Other
// files) or Frequently wrong's (Wrong): every question whose latest check was
// not right, most missed first. All is every question, unordered.
type QuestionsFilter struct {
	TopicID string
	Others  bool
	Wrong   bool
	All     bool
}

// MemberAnswer is a member's latest answer to a question, marked, for a
// class's staff to open from the member's lists.
type MemberAnswer struct {
	Answers map[string]any `json:"answers"`
	// Question is the question as checked, with its key and marks per part.
	Question map[string]any `json:"question"`
	At       time.Time      `json:"at"`
}

// WorkspaceStudyQuestions reads the caller's own list, refused to a class's
// owner and editors as Summary is.
func (s *Store) WorkspaceStudyQuestions(ctx context.Context, userID, wsID string, canEdit bool, f QuestionsFilter) ([]StudyQuestion, error) {
	var kind WorkspaceKind
	if err := s.pool.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return nil, err
	}
	if canEdit && kind == WorkspaceClass {
		return nil, ErrForbidden
	}
	topics, err := s.topicsOf(ctx, wsID)
	if err != nil {
		return nil, err
	}
	return s.studyQuestions(ctx, wsID, userID, f, true, topics)
}

// WorkspaceMemberQuestions reads a viewer member's list for a class's owner
// and teaching assistants, read only: without the member's own practice
// quizzes, which are private, and without question content.
func (s *Store) WorkspaceMemberQuestions(ctx context.Context, userID, wsID, memberID string, f QuestionsFilter) ([]StudyQuestion, error) {
	if err := s.staffOfMember(ctx, userID, wsID, memberID); err != nil {
		return nil, err
	}
	topics, err := s.topicsOf(ctx, wsID)
	if err != nil {
		return nil, err
	}
	return s.studyQuestions(ctx, wsID, memberID, f, false, topics)
}

// WorkspaceMemberAnswer reads a member's latest answer to a question their
// lists show answered, for the same staff. ErrNotFound when the lists don't
// show it answered or no answer was kept.
func (s *Store) WorkspaceMemberAnswer(ctx context.Context, userID, wsID, memberID, materialID, questionID string) (MemberAnswer, error) {
	var out MemberAnswer
	listed, err := s.WorkspaceMemberQuestions(ctx, userID, wsID, memberID, QuestionsFilter{All: true})
	if err != nil {
		return out, err
	}
	if !slices.ContainsFunc(listed, func(q StudyQuestion) bool {
		return q.MaterialID == materialID && q.QuestionID == questionID && q.At != nil
	}) {
		return out, ErrNotFound
	}
	err = s.pool.QueryRow(ctx, `SELECT answers, graded, answered_at FROM question_answers
		WHERE user_id=$1 AND material_id=$2 AND question_id=$3`, memberID, materialID, questionID).
		Scan(&out.Answers, &out.Question, &out.At)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	return out, err
}

// staffOfMember is membersStaff for a viewer member of the class; anyone else
// is ErrNotFound.
func (s *Store) staffOfMember(ctx context.Context, userID, wsID, memberID string) error {
	if err := s.membersStaff(ctx, userID, wsID); err != nil {
		return err
	}
	var member bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='viewer')`,
		wsID, memberID).Scan(&member); err != nil {
		return err
	}
	if !member {
		return ErrNotFound
	}
	return nil
}

// studyQuestions lists the questions the user's standings count, in reading
// order, or most missed first with Wrong: every question of a quiz they can
// practise, and the answered ones of a graded quiz's own quiz, a hidden or a
// trashed one. own adds their own practice quizzes and each practisable
// question's content. A topic not in the workspace is ErrNotFound. An
// assignment's answers wait for its grades (gradesHeldSQL), as labels do.
func (s *Store) studyQuestions(ctx context.Context, wsID, userID string, f QuestionsFilter, own bool, topics workspaceTopics) ([]StudyQuestion, error) {
	if f.TopicID != "" && !topics.has(f.TopicID) {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.revision, m.title, COALESCE(m.topic_id, m.practice_topic_id),
			m.trashed_at IS NOT NULL OR m.assignment_id IS NOT NULL OR NOT workspace_item_visible(`+materialHiddenSQL+`, m.workspace_id, $2)
		FROM materials m LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
		WHERE (m.workspace_id=$1 OR ($3 AND m.practice_workspace_id=$1 AND m.owner_user_id=$2))
			AND m.kind='quiz' AND m.parent_material_id IS NULL AND `+standingQuizSQL("$2")+`
		ORDER BY t.id IS NULL, t.position, m.position, m.created_at DESC, m.id`, wsID, userID, own)
	if err != nil {
		return nil, err
	}
	type quiz struct {
		id, title string
		topic     *string
		held      bool
	}
	var quizzes []quiz
	ids := []string{}
	revisions := map[string]int64{}
	for rows.Next() {
		var q quiz
		var revision int64
		if err := rows.Scan(&q.id, &revision, &q.title, &q.topic, &q.held); err != nil {
			rows.Close()
			return nil, err
		}
		quizzes = append(quizzes, q)
		ids = append(ids, q.id)
		revisions[q.id] = revision
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	checks, err := s.questionChecks(ctx, userID, ids)
	if err != nil {
		return nil, err
	}
	docs, err := s.cachedItems(ctx, revisions)
	if err != nil {
		return nil, err
	}
	out := []StudyQuestion{}
	for _, q := range quizzes {
		for _, it := range docs[q.id] {
			if it.Question == nil {
				continue
			}
			topicIDs := itemTopics(it, q.topic, topics)
			if !f.Wrong && !f.All && !slices.Contains(topicKeys(topicIDs), topicKey(&f.TopicID)) {
				continue
			}
			sq := StudyQuestion{MaterialID: q.id, MaterialTitle: q.title, QuestionID: it.ItemID,
				Group: GroupOthers, Result: resultUnattempted}
			if c := checks[q.id+"/"+it.ItemID]; c != nil {
				sq.Result, sq.Misses, sq.At = c.result, c.misses, &c.at
			}
			// A held quiz lists only what was answered.
			if q.held && sq.At == nil || f.Wrong && (sq.At == nil || sq.Result == resultRight) {
				continue
			}
			sq.Text = strings.Join(strings.Fields(questions.PromptText(it.Question)), " ")
			var names []string
			for _, id := range topicIDs {
				if topics.has(id) {
					if sq.TopicID == nil {
						sq.Group, sq.TopicID = GroupTopic, &id
					}
					names = append(names, topics.names[id])
				}
			}
			sq.TopicName = strings.Join(names, ", ")
			if own && !q.held {
				sq.Question = it.Question
			}
			out = append(out, sq)
		}
	}
	if f.Wrong {
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Misses != out[j].Misses {
				return out[i].Misses > out[j].Misses
			}
			return out[i].At.After(*out[j].At)
		})
	}
	return out, nil
}

const (
	resultRight       = "right"
	resultPartial     = "partial"
	resultWrong       = "wrong"
	resultUnattempted = "unattempted"
)

// questionCheck is a question's latest check, read from answer_events.
type questionCheck struct {
	result string
	misses int
	at     time.Time
}

// questionChecks reads each question's checks by the user in the quizzes,
// by material/question id: a check is one attempt's parts of it or, with no
// attempt (a review), those sharing a time, the latest row per attempt and
// part standing. An edited question starts again, as its label does; parts
// worth no marks (Not marked) say nothing.
func (s *Store) questionChecks(ctx context.Context, userID string, materialIDs []string) (map[string]*questionCheck, error) {
	rows, err := s.pool.Query(ctx, `SELECT ae.material_id, ae.question_id, COALESCE(ae.attempt_id, ''), ae.item_hash,
			ae.awarded, ae.marks, ae.created_at
		FROM answer_events ae
		WHERE ae.user_id=$1 AND ae.material_id = ANY($2) AND ae.marks > 0
			AND NOT EXISTS (SELECT 1 FROM answer_events newer WHERE newer.material_id=ae.material_id AND newer.question_id=ae.question_id
				AND newer.attempt_id=ae.attempt_id AND newer.part_id=ae.part_id AND newer.id>ae.id)
			AND NOT `+gradesHeldSQL+`
		ORDER BY ae.created_at, ae.id`, userID, materialIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type check struct {
		awarded, marks float64
		at             time.Time
	}
	type question struct {
		hash   string
		checks map[string]*check
		order  []string
	}
	byQuestion := map[string]*question{}
	for rows.Next() {
		var materialID, questionID, attempt, hash string
		var awarded, marks float64
		var at time.Time
		if err := rows.Scan(&materialID, &questionID, &attempt, &hash, &awarded, &marks, &at); err != nil {
			return nil, err
		}
		key := materialID + "/" + questionID
		q := byQuestion[key]
		if q == nil || q.hash != hash {
			q = &question{hash: hash, checks: map[string]*check{}}
			byQuestion[key] = q
		}
		ck := attempt
		if ck == "" {
			ck = at.Format(time.RFC3339Nano)
		}
		c := q.checks[ck]
		if c == nil {
			c = &check{}
			q.checks[ck] = c
			q.order = append(q.order, ck)
		}
		c.awarded, c.marks, c.at = c.awarded+awarded, c.marks+marks, at
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := func(awarded, marks float64) string {
		switch {
		case awarded >= marks:
			return resultRight
		case awarded > 0:
			return resultPartial
		}
		return resultWrong
	}
	out := make(map[string]*questionCheck, len(byQuestion))
	for key, q := range byQuestion {
		latest := q.checks[q.order[len(q.order)-1]]
		qc := &questionCheck{result: result(latest.awarded, latest.marks), at: latest.at}
		for _, ck := range q.order {
			if c := q.checks[ck]; c.awarded < c.marks {
				qc.misses++
			}
		}
		out[key] = qc
	}
	return out, nil
}
