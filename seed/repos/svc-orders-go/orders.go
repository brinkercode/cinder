package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"sync"
)

// Order is one customer order. Total is in cents.
type Order struct {
	ID       int    `json:"id"`
	Customer string `json:"customer"`
	Items    []Item `json:"items"`
	Total    int    `json:"total"`
	Status   string `json:"status"`
}

// Item is one order line.
type Item struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
	Price    int    `json:"price"`
}

// Store keeps orders in memory; it is safe for concurrent use.
type Store struct {
	mu     sync.Mutex
	next   int
	orders map[int]Order
}

func NewStore() *Store { return &Store{next: 1, orders: map[int]Order{}} }

func (s *Store) Create(o Order) Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	o.ID = s.next
	s.next++
	o.Status = "open"
	o.Total = 0
	for _, it := range o.Items {
		o.Total += it.Quantity * it.Price
	}
	s.orders[o.ID] = o
	return o
}

func (s *Store) Get(id int) (Order, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.orders[id]
	return o, ok
}

// List returns every order by id. TODO: paginate (?limit=&after=); it returns the whole store today.
func (s *Store) List() []Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Order, 0, len(s.orders))
	for _, o := range s.orders {
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (s *Store) Delete(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.orders[id]
	delete(s.orders, id)
	return ok
}

func validate(o Order) error {
	if o.Customer == "" {
		return errors.New("customer is required")
	}
	if len(o.Items) == 0 {
		return errors.New("at least one item is required")
	}
	for _, it := range o.Items {
		if it.SKU == "" || it.Quantity <= 0 || it.Price < 0 {
			return errors.New("each item needs a sku, a positive quantity and a non-negative price")
		}
	}
	return nil
}

// NewServer routes the orders API onto s.
func NewServer(s *Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /orders", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, s.List()) })
	mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
		var o Order
		if err := json.NewDecoder(r.Body).Decode(&o); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := validate(o); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, s.Create(o))
	})
	mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		o, ok := s.Get(id)
		if err != nil || !ok {
			writeError(w, http.StatusNotFound, "order not found")
			return
		}
		writeJSON(w, http.StatusOK, o)
	})
	mux.HandleFunc("DELETE /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil || !s.Delete(id) {
			writeError(w, http.StatusNotFound, "order not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
