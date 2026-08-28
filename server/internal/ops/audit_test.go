package ops

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func registryRequestFromSnapshot(snapshot RegistrySnapshot) RegistrySaveRequest {
	latest := make(map[models.Ref]CatalogConfig)
	for _, config := range snapshot.Configs {
		if config.Enabled && config.Version > latest[config.Ref()].Version {
			latest[config.Ref()] = config
		}
	}
	refs := make([]models.Ref, 0, len(latest))
	for ref := range latest {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		return refs[i].String() < refs[j].String()
	})
	request := RegistrySaveRequest{Revision: snapshot.Version}
	for _, ref := range refs {
		config := latest[ref]
		request.Active = append(request.Active, DraftConfig{
			ProviderName:        config.ProviderName,
			ModelName:           config.ModelName,
			ProviderSlug:        config.ProviderSlug,
			ModelSlug:           config.ModelSlug,
			PlatformEnabled:     config.PlatformEnabled,
			ByokEnabled:         config.ByokEnabled,
			ContextWindowTokens: config.ContextWindowTokens,
			ThinkingLevels:      append([]string(nil), config.ThinkingLevels...),
			DefaultThinking:     config.DefaultThinking,
			Params:              append([]byte(nil), config.Params...),
			Surfaces:            append([]string(nil), config.Surfaces...),
			DefaultFor:          append([]string(nil), config.IsDefaultFor...),
			Rates: CreditRates{
				InputMicros:       config.MicrosPerInputToken,
				CachedInputMicros: config.MicrosPerCachedInputToken,
				OutputMicros:      config.MicrosPerOutputToken,
			},
		})
	}
	return request
}

func TestOperatorAuditRecordsActionsAndRollsBackUnauditedRegistrySave(t *testing.T) {
	dsn := integrationDSN(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	read := NewReadStore(store.NewWithPool(pool))
	registry := NewRegistryStore(pool, pool)
	snapshot, err := registry.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	request := registryRequestFromSnapshot(snapshot)

	missingActor := fmt.Sprintf("missing-audit-actor-%d", time.Now().UnixNano())
	_, err = registry.Save(ctx, Principal{
		UserID: missingActor,
		Role:   RoleAdmin,
		Permissions: []string{
			PermReadAll,
			PermWriteRegistry,
		},
	}, request)
	if !isInsufficientPrivilege(err) {
		t.Fatalf("registry save without database membership error = %v", err)
	}
	var versionAfterRejected int64
	if err := pool.QueryRow(ctx,
		`SELECT version FROM model_registry_state WHERE id=true`,
	).Scan(&versionAfterRejected); err != nil {
		t.Fatal(err)
	}
	if versionAfterRejected != snapshot.Version {
		t.Fatalf(
			"unaudited registry save advanced revision to %d, want %d",
			versionAfterRejected, snapshot.Version,
		)
	}

	actorID := fmt.Sprintf("audit-operator-%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, name, email) VALUES ($1, 'Audit Operator', $2)`,
		actorID, actorID+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO operators (user_id, role) VALUES ($1, 'admin')`, actorID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
			UPDATE reconcile_runs
			   SET status='succeeded', finished_at=now()
			 WHERE requested_by_id=$1 AND status='pending'`, actorID)
		_, _ = pool.Exec(
			context.Background(), `DELETE FROM users WHERE id=$1`, actorID,
		)
	})
	principal := Principal{
		UserID: actorID,
		Role:   RoleAdmin,
		Permissions: []string{
			PermReadAll,
			PermExecuteReconciliation,
			PermWriteRegistry,
		},
	}
	registryTrace := "11111111111111111111111111111111"
	registryCtx := obs.WithTrace(ctx, registryTrace, "1111111111111111")
	updated, err := registry.Save(registryCtx, principal, request)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != snapshot.Version+1 {
		t.Fatalf("registry revision = %d, want %d", updated.Version, snapshot.Version+1)
	}

	actions := NewAdminStore(pool)
	reconciliationTrace := "22222222222222222222222222222222"
	reconciliationCtx := obs.WithTrace(ctx, reconciliationTrace, "2222222222222222")
	reconciliation, err := actions.RequestReconciliation(
		reconciliationCtx, principal, "storage",
	)
	if err != nil {
		t.Fatal(err)
	}
	if reconciliation.RunID == 0 {
		t.Fatal("reconciliation action returned no run")
	}

	page, err := read.AuditEvents(ctx, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.NextBeforeID == nil {
		t.Fatalf("first audit page = %+v, want one event and an older cursor", page)
	}
	older, err := read.AuditEvents(ctx, *page.NextBeforeID, auditPageMax)
	if err != nil {
		t.Fatal(err)
	}
	events := append(page.Events, older.Events...)
	seen := map[string]OperatorAuditEvent{}
	for _, event := range events {
		if event.ActorUserID == actorID {
			seen[event.Action] = event
		}
	}
	if seen["registry.saved"].TraceID != registryTrace {
		t.Fatalf("registry audit event = %+v", seen["registry.saved"])
	}
	if seen["reconciliation.requested"].TraceID != reconciliationTrace {
		t.Fatalf("reconciliation audit event = %+v", seen["reconciliation.requested"])
	}

	for _, testCase := range []struct {
		statement string
		args      []any
	}{
		{
			statement: `UPDATE operator_audit_events SET outcome='changed' WHERE actor_user_id=$1`,
			args:      []any{actorID},
		},
		{
			statement: `DELETE FROM operator_audit_events WHERE actor_user_id=$1`,
			args:      []any{actorID},
		},
		{statement: `TRUNCATE operator_audit_events`},
	} {
		_, err := pool.Exec(ctx, testCase.statement, testCase.args...)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "55000" {
			t.Fatalf("append-only statement %q error = %v", testCase.statement, err)
		}
	}
}
