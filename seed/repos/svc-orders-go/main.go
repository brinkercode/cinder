// Command svc-orders-go serves the orders API on :8080 (PORT overrides).
package main

import (
	"log"
	"net/http"
	"os"
)

func main() {
	addr := ":" + os.Getenv("PORT")
	if addr == ":" {
		addr = ":8080"
	}
	log.Printf("orders listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, NewServer(NewStore())))
}
