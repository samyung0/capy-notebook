package ops

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type HandlerConfig struct {
	StaticDir       string
	StuckJobMinutes int
}

func NewHandler(
	read *ReadStore,
	registry *RegistryStore,
	config HandlerConfig,
) http.Handler {
	router := chi.NewRouter()
	router.Use(noIndexHeaders)
	router.Use(noStore)
	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Route("/api/ops", func(api chi.Router) {
		api.Get("/session", func(w http.ResponseWriter, r *http.Request) {
			principal, _ := PrincipalFromContext(r.Context())
			writeJSON(w, http.StatusOK, principal)
		})
		api.Get("/overview", func(w http.ResponseWriter, r *http.Request) {
			days, err := overviewDays(r)
			if err != nil {
				respond(w, nil, err)
				return
			}
			value, err := read.Overview(r.Context(), days)
			respond(w, value, err)
		})
		api.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			value, err := read.Health(r.Context(), config.StuckJobMinutes)
			respond(w, value, err)
		})
		api.Get("/users/search", func(w http.ResponseWriter, r *http.Request) {
			value, err := read.SearchUsers(r.Context(), r.URL.Query().Get("q"))
			respond(w, value, err)
		})
		api.Get("/users/{userID}", func(w http.ResponseWriter, r *http.Request) {
			value, err := read.User(r.Context(), chi.URLParam(r, "userID"))
			respond(w, value, err)
		})
		api.Get("/costs", func(w http.ResponseWriter, r *http.Request) {
			from, to, err := costRange(r)
			if err != nil {
				respond(w, nil, err)
				return
			}
			value, err := read.Costs(
				r.Context(), from, to, r.URL.Query().Get("groupBy"),
			)
			respond(w, value, err)
		})
		api.Get("/registry", func(w http.ResponseWriter, r *http.Request) {
			if registry == nil {
				writeError(
					w, http.StatusServiceUnavailable, "registry_unavailable",
					"registry unavailable",
				)
				return
			}
			value, err := registry.Snapshot(r.Context())
			respond(w, value, err)
		})
		api.Post("/registry/save", func(w http.ResponseWriter, r *http.Request) {
			principal, _ := PrincipalFromContext(r.Context())
			if principal.Role != RoleAdmin {
				writeError(
					w, http.StatusForbidden, "admin_required", "admin role required",
				)
				return
			}
			if registry == nil || !registry.WriteConfigured() {
				writeError(
					w, http.StatusServiceUnavailable, "registry_write_unavailable",
					"registry writes are not configured",
				)
				return
			}
			var request RegistrySaveRequest
			if err := decodeJSON(w, r, &request); err != nil {
				respond(w, nil, err)
				return
			}
			value, err := registry.Save(r.Context(), principal, request)
			respond(w, value, err)
		})
		api.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "not_found", "route not found")
		})
	})
	router.NotFound(spaHandler(config.StaticDir).ServeHTTP)
	return router
}

func overviewDays(r *http.Request) (int, error) {
	raw := r.URL.Query().Get("days")
	if raw == "" {
		return 30, nil
	}
	days, err := strconv.Atoi(raw)
	if err != nil || days < 1 || days > 90 {
		return 0, validation("days must be between 1 and 90")
	}
	return days, nil
}

func costRange(r *http.Request) (time.Time, time.Time, error) {
	now := time.Now().UTC()
	to, from := now, now.AddDate(0, 0, -29)
	var err error
	if raw := r.URL.Query().Get("from"); raw != "" {
		from, err = time.Parse("2006-01-02", raw)
		if err != nil {
			return time.Time{}, time.Time{}, validation("from must be YYYY-MM-DD")
		}
	}
	if raw := r.URL.Query().Get("to"); raw != "" {
		to, err = time.Parse("2006-01-02", raw)
		if err != nil {
			return time.Time{}, time.Time{}, validation("to must be YYYY-MM-DD")
		}
	}
	if to.Before(from) || to.Sub(from) > 365*24*time.Hour {
		return time.Time{}, time.Time{}, validation(
			"cost range must be ordered and at most 366 days",
		)
	}
	return from, to, nil
}

func splitQueryList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	defer r.Body.Close()
	if mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]); mediaType != "application/json" {
		return validation("Content-Type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return validation("invalid JSON body")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return validation("request must contain one JSON object")
	}
	return nil
}

func respond(w http.ResponseWriter, value any, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, value)
		return
	}
	if message, ok := databaseValidationMessage(err); ok {
		writeError(w, http.StatusBadRequest, "invalid_registry", message)
		return
	}
	switch {
	case IsValidation(err):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	case IsConflict(err):
		var conflict *ConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"code":    "registry_conflict",
				"message": err.Error(),
				"current": conflict.Current,
			})
			return
		}
		writeError(w, http.StatusConflict, "registry_conflict", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "record not found")
	case errors.Is(err, ErrForbidden):
		writeError(w, http.StatusForbidden, "admin_required", "admin role required")
	default:
		slog.Error("ops request failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "request failed")
	}
}

func databaseValidationMessage(err error) (string, bool) {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return "", false
	}
	if postgresError.Code == "23505" || postgresError.Code == "23514" {
		if strings.HasPrefix(postgresError.ConstraintName, "model_configs_") {
			return fmt.Sprintf(
				"registry draft violates %s", postgresError.ConstraintName,
			), true
		}
	}
	return "", false
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func noIndexHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; connect-src 'self'; img-src 'self' data:; "+
				"script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func spaHandler(staticDir string) http.Handler {
	if staticDir == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeError(
				w, http.StatusNotFound, "not_found", "dashboard assets unavailable",
			)
		})
	}
	files := http.FileServer(http.Dir(staticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusNotFound, "not_found", "route not found")
			return
		}
		cleanPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if cleanPath == "." {
			cleanPath = "index.html"
		}
		if strings.HasPrefix(cleanPath, "..") {
			writeError(w, http.StatusBadRequest, "invalid_path", "invalid path")
			return
		}
		fullPath := filepath.Join(staticDir, cleanPath)
		info, err := os.Stat(fullPath)
		if err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})
}
