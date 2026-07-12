// Package store reads github_users rows from PostgreSQL. It is read-only.
package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jaredchao/zuowen-go-service/internal/intro"
)

// ErrNotFound is returned when no row matches the username.
var ErrNotFound = errors.New("user not found")

// Store owns a pgx connection pool. The pool is safe for concurrent use and is
// created once at startup, not per request.
type Store struct {
	pool *pgxpool.Pool
}

// New opens a connection pool against databaseURL and verifies it with a ping.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool. Safe to call on a nil-safe Store.
func (s *Store) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// Ping checks connectivity, used by the health endpoint.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

const selectByUsername = `
	SELECT username, name, bio, company, location,
	       public_repos, followers, github_created_at
	FROM github_users
	WHERE username = $1`

// GetUser returns the intro.User for username, or ErrNotFound if none exists.
func (s *Store) GetUser(ctx context.Context, username string) (intro.User, error) {
	var u intro.User
	err := s.pool.QueryRow(ctx, selectByUsername, username).Scan(
		&u.Username, &u.Name, &u.Bio, &u.Company, &u.Location,
		&u.PublicRepos, &u.Followers, &u.GitHubCreated,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return intro.User{}, ErrNotFound
	}
	if err != nil {
		return intro.User{}, err
	}
	return u, nil
}
