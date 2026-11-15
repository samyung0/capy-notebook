package store

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// Graded Assignments (Epo 2026-11-14, todo-graded-quizzes.md, after Canvas): a
// class's Assignment with points takes one grade per member, which its staff
// enter from that member's row on the report (migration 0176). Every read of
// marks (Mine, the report, the Average, Members) takes the grade where a graded
// quiz takes its counted submission, with the late penalty off it and held
// under Show grades Manual until release.

// SetAssignmentGrade sets a member's grade on a graded Assignment, or clears it
// (nil). Only its class's staff change it, as quiz marks: half points from 0 to
// its points, for someone it went to, open or closed alike.
func (s *Store) SetAssignmentGrade(ctx context.Context, actorID, id, memberID string, points *float64, now time.Time) error {
	row, err := s.taskRow(ctx, s.pool, id)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockStaffOfTx(ctx, tx, row, actorID); err != nil {
			return err
		}
		var outOf *int
		var draft bool
		if err := tx.QueryRow(ctx, `SELECT points, draft FROM assignments WHERE id=$1 FOR SHARE`, id).Scan(&outOf, &draft); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		if outOf == nil || draft {
			return assignmentInput("this assignment is not graded")
		}
		assigned, err := assignedTx(ctx, tx, id, memberID)
		if err != nil {
			return err
		}
		if !assigned {
			return ErrNotFound
		}
		if points == nil {
			_, err := tx.Exec(ctx, `DELETE FROM assignment_grades WHERE assignment_id=$1 AND user_id=$2`, id, memberID)
			return err
		}
		if !validHalfMark(*points, float64(*outOf)) {
			return assignmentInput("a grade is 0 to " + strconv.Itoa(*outOf) + " in half points")
		}
		_, err = tx.Exec(ctx, `INSERT INTO assignment_grades (assignment_id, user_id, points, graded_by, graded_at)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (assignment_id, user_id) DO UPDATE SET points=EXCLUDED.points, graded_by=EXCLUDED.graded_by, graded_at=EXCLUDED.graded_at`,
			id, memberID, *points, actorID, now)
		return err
	})
}

// assignmentGrades reads an assignment's grades as given, by member.
func assignmentGrades(ctx context.Context, q rowsQueryer, id string) (map[string]float64, error) {
	rows, err := q.Query(ctx, `SELECT user_id, points::float8 FROM assignment_grades WHERE assignment_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var user string
		var points float64
		if err := rows.Scan(&user, &points); err != nil {
			return nil, err
		}
		out[user] = points
	}
	return out, rows.Err()
}
