package store

import "context"

func (s *Store) BankEditor(ctx context.Context, userID string) (bool, error) {
	var allowed bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (
   SELECT 1 FROM bank_editors e JOIN users u ON u.id=e.user_id
   WHERE e.user_id=$1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL
   AND u.deletion_requested_at IS NULL)`, userID).Scan(&allowed)
	return allowed, err
}

// BankUserNames resolves production IDs locally. A foreign environment has no name.
func (s *Store) BankUserNames(ctx context.Context, ids []string) (map[string]string, error) {
	names := map[string]string{}
	if len(ids) == 0 {
		return names, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id,name FROM users WHERE id=ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		names[id] = name
	}
	return names, rows.Err()
}

func (s *Store) BankCommentAuthor(ctx context.Context, id string) (string, string, error) {
	var name, email string
	err := s.pool.QueryRow(ctx, `SELECT name,COALESCE(email,'') FROM users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL AND deletion_requested_at IS NULL`, id).Scan(&name, &email)
	return name, email, err
}
