//go:build integration

package main

import (
	"net/http"
	"testing"
)

// Runs in the ci flow's integration stage (go test -tags integration); fails until PATCH /orders/{id} exists.
func TestIntegration_PatchMovesOrderToPaid(t *testing.T) {
	h := NewServer(NewStore())
	do(t, h, "POST", "/orders", `{"customer":"ada","items":[{"sku":"A","quantity":1,"price":5}]}`)
	if rec := do(t, h, "PATCH", "/orders/1", `{"status":"paid"}`); rec.Code != http.StatusOK {
		t.Fatalf("PATCH /orders/1: status %d, want 200", rec.Code)
	}
}
