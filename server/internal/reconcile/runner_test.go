package reconcile

import "testing"

func TestDecideSubscriptionCleanup(t *testing.T) {
	tests := []struct {
		name              string
		canceled          bool
		cancelAtPeriodEnd bool
		want              subscriptionCleanupDecision
	}{
		{
			name: "live immediate cancellation",
			want: subscriptionCleanupDecision{refund: true, cancel: true},
		},
		{
			name:              "live period-end cancellation",
			cancelAtPeriodEnd: true,
			want:              subscriptionCleanupDecision{suppress: true},
		},
		{
			name:     "already canceled",
			canceled: true,
			want:     subscriptionCleanupDecision{refund: true},
		},
		{
			name:              "already canceled with retained period-end flag",
			canceled:          true,
			cancelAtPeriodEnd: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := decideSubscriptionCleanup(test.canceled, test.cancelAtPeriodEnd); got != test.want {
				t.Fatalf("decision = %#v, want %#v", got, test.want)
			}
		})
	}
}
