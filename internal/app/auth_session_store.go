package app

import (
	"database/sql"
	"errors"
	"time"

	"github.com/alexedwards/scs/sqlite3store"
)

var errRetiredAuthSession = errors.New("session has been retired")

// SCS's SQLite store normally upserts sessions. A request that loaded a session
// before logout must never recreate it or rotate it after logout has retired it.
// Keep SCS's encoding and cookie handling, adding atomic lifecycle checks here.
type authSessionStore struct {
	*sqlite3store.SQLite3Store
	db       *sql.DB
	lifetime time.Duration
}

func (s *authSessionStore) Commit(token string, data []byte, expiry time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM auth_retired_sessions WHERE expires < ?`, time.Now().Unix()); err != nil {
		return err
	}
	result, err := tx.Exec(`REPLACE INTO auth_sessions(token,data,expiry)
 SELECT ?,?,julianday(?) WHERE NOT EXISTS(SELECT 1 FROM auth_retired_sessions WHERE token=?)`, token, data, expiry.UTC().Format("2006-01-02T15:04:05.999"), token)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return errRetiredAuthSession
	}
	return tx.Commit()
}

func (s *authSessionStore) Delete(token string) error {
	if token == "" {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM auth_retired_sessions WHERE expires < ?`, time.Now().Unix()); err != nil {
		return err
	}
	result, err := tx.Exec(`INSERT INTO auth_retired_sessions(token,expires) VALUES(?,?) ON CONFLICT(token) DO NOTHING`, token, time.Now().Add(s.lifetime).Unix())
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	// Refuse a second rotation from a stale request, as well as stale commits.
	if count == 0 {
		return errRetiredAuthSession
	}
	if _, err = tx.Exec(`DELETE FROM auth_sessions WHERE token=?`, token); err != nil {
		return err
	}
	return tx.Commit()
}
