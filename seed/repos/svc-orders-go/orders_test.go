package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

func TestCreate_ComputesTotalAndOpens(t *testing.T) {
	h := NewServer(NewStore())
	rec := do(t, h, "POST", "/orders", `{"customer":"ada","items":[{"sku":"A1","quantity":2,"price":250},{"sku":"B2","quantity":1,"price":100}]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var o Order
	json.Unmarshal(rec.Body.Bytes(), &o)
	if o.ID != 1 || o.Total != 600 || o.Status != "open" {
		t.Fatalf("got %+v", o)
	}
}

func TestCreate_RejectsInvalidOrder(t *testing.T) {
	h := NewServer(NewStore())
	for _, body := range []string{`{`, `{"customer":"","items":[{"sku":"A","quantity":1,"price":1}]}`, `{"customer":"ada","items":[]}`, `{"customer":"ada","items":[{"sku":"A","quantity":0,"price":1}]}`} {
		if rec := do(t, h, "POST", "/orders", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", body, rec.Code)
		}
	}
}

func TestGetListDelete(t *testing.T) {
	h := NewServer(NewStore())
	do(t, h, "POST", "/orders", `{"customer":"ada","items":[{"sku":"A","quantity":1,"price":5}]}`)
	do(t, h, "POST", "/orders", `{"customer":"bob","items":[{"sku":"B","quantity":1,"price":7}]}`)
	var list []Order
	json.Unmarshal(do(t, h, "GET", "/orders", "").Body.Bytes(), &list)
	if len(list) != 2 || list[0].Customer != "ada" {
		t.Fatalf("list %+v", list)
	}
	if rec := do(t, h, "GET", "/orders/2", ""); rec.Code != http.StatusOK {
		t.Fatalf("get status %d", rec.Code)
	}
	if rec := do(t, h, "DELETE", "/orders/2", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/orders/2", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete status %d", rec.Code)
	}
	if rec := do(t, h, "GET", "/orders/abc", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("bad id status %d", rec.Code)
	}
}

func TestUpdateStatus_MovesOpenToShipped(t *testing.T) {
	t.Skip("open gap: PATCH /orders/{id} with {\"status\":\"shipped\"} is not implemented; only open → paid → shipped should be allowed")
}
