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
	actions *AdminStore,
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
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.Overview(r.Context())
			respond(w, value, err)
		})
		api.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.Health(r.Context(), config.StuckJobMinutes)
			respond(w, value, err)
		})
		api.Get("/parser", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			hours := 24
			if raw := r.URL.Query().Get("hours"); raw != "" {
				value, err := strconv.Atoi(raw)
				if err != nil {
					respond(w, nil, validation("hours must be an integer"))
					return
				}
				hours = value
			}
			value, err := read.ParserMetrics(r.Context(), hours)
			respond(w, value, err)
		})
		api.Get("/reconciliation", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.Reconciliation(r.Context())
			respond(w, value, err)
		})
		api.Get("/audit", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			beforeID, limit, err := auditPageParams(r)
			if err != nil {
				respond(w, nil, err)
				return
			}
			value, err := read.AuditEvents(r.Context(), beforeID, limit)
			respond(w, value, err)
		})
		api.Post("/reconciliation/{jobType}", func(w http.ResponseWriter, r *http.Request) {
			principal, ok := requirePermission(w, r, PermExecuteReconciliation)
			if !ok {
				return
			}
			jobType := chi.URLParam(r, "jobType")
			if jobType != "storage" && jobType != "stripe" {
				writeError(
					w, http.StatusBadRequest,
					"invalid_reconciliation_job",
					"reconciliation job must be storage or stripe",
				)
				return
			}
			if actions == nil || !actions.Configured() {
				writeError(
					w, http.StatusServiceUnavailable,
					"actions_unavailable", "operator actions unavailable",
				)
				return
			}
			value, err := actions.RequestReconciliation(
				r.Context(), principal, jobType,
			)
			if err != nil {
				respond(w, nil, err)
				return
			}
			writeJSON(w, http.StatusAccepted, value)
		})
		api.Get("/users/search", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.SearchUsers(r.Context(), r.URL.Query().Get("q"))
			respond(w, value, err)
		})
		api.Get("/users/{userID}", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.User(r.Context(), chi.URLParam(r, "userID"))
			respond(w, value, err)
		})
		api.Get("/costs", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			from, to, err := costRange(r)
			if err != nil {
				respond(w, nil, err)
				return
			}
			value, err := read.Costs(
				r.Context(), from, to, r.URL.Query().Get("groupBy"),
				r.URL.Query().Get("bucket"),
			)
			respond(w, value, err)
		})
		api.Get("/resource-rates", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			value, err := read.ResourceCreditRates(r.Context())
			respond(w, value, err)
		})
		api.Post("/resource-rates/{resourceKey}", func(w http.ResponseWriter, r *http.Request) {
			principal, ok := requirePermission(w, r, PermWriteRegistry)
			if !ok {
				return
			}
			if actions == nil || !actions.Configured() {
				writeError(w, http.StatusServiceUnavailable, "actions_unavailable", "operator actions unavailable")
				return
			}
			var request SaveResourceCreditRateRequest
			if err := decodeJSON(w, r, &request); err != nil {
				respond(w, nil, err)
				return
			}
			value, err := actions.SaveResourceCreditRate(
				r.Context(), principal, chi.URLParam(r, "resourceKey"), request.CreditMicrosPerUnit,
			)
			respond(w, value, err)
		})
		api.Get("/providers", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
			respond(w, listEliteLLMProviders(), nil)
		})
		api.Get("/registry", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := requirePermission(w, r, PermReadAll); !ok {
				return
			}
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
			principal, ok := requirePermission(w, r, PermWriteRegistry)
			if !ok {
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

func auditPageParams(r *http.Request) (int64, int, error) {
	beforeID := int64(0)
	limit := auditPageMax
	var err error
	if raw := r.URL.Query().Get("beforeId"); raw != "" {
		beforeID, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || beforeID < 1 {
			return 0, 0, validation("beforeId must be a positive integer")
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > auditPageMax {
			return 0, 0, validation(
				"audit limit must be between 1 and %d", auditPageMax,
			)
		}
	}
	return beforeID, limit, nil
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
		var invalid *ValidationError
		if errors.As(err, &invalid) && invalid.Code != "" {
			payload := map[string]any{"code": invalid.Code, "message": invalid.Message}
			if invalid.ModelSlug != "" {
				payload["modelSlug"] = invalid.ModelSlug
			}
			if invalid.Surface != "" {
				payload["surface"] = invalid.Surface
			}
			if invalid.Reason != "" {
				payload["reason"] = invalid.Reason
			}
			writeJSON(w, http.StatusBadRequest, payload)
			return
		}
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
		writePermissionDenied(w)
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

func writePermissionDenied(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "permission_denied", "permission denied")
}

func requirePermission(
	w http.ResponseWriter,
	r *http.Request,
	permission string,
) (Principal, bool) {
	principal, _ := PrincipalFromContext(r.Context())
	if !principal.Has(permission) {
		writePermissionDenied(w)
		return principal, false
	}
	return principal, true
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
