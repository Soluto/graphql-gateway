package main

import (
	"agogos/registry"
	"agogos/schema"
	"context"
	"net/http"

	"agogos/metrics"

	"github.com/graphql-go/handler"
	log "github.com/sirupsen/logrus"
)

func main() {
	err := InitLogger()
	if err != nil {
		log.WithError(err).Fatalln("Failed to init logger")
	}

	log.Info("Graphql Server is starting...")

	configCh, errCh := registry.Connect(context.Background())
	if err != nil {
		log.WithError(err).Fatalln("Failed to connect to registry")
	}

	var graphqlHTTPHandler http.Handler

	// Handle registry connection errors
	go func() {
		errors := 0
		for {
			err := <-errCh
			log.WithError(err).Println("Registry connection/subscription failure")
			errors++

			if graphqlHTTPHandler == nil && errors > 30 {
				log.WithError(err).Fatalln("Couldn't connect to registry")
			}
		}
	}()

	schemaCh := schema.Process(configCh)

	// Handle new schemas
	go func() {
		for {
			schemaResult := <-schemaCh

			if schemaResult.Error != nil {
				log.WithError(schemaResult.Error).Error("Error processing new schema")
				continue
			}

			log.Info("Updating graphql server...")

			graphqlHTTPHandler = handler.New(&handler.Config{
				Schema:     schemaResult.Schema,
				Pretty:     true,
				Playground: true,
				GraphiQL:   false,
			})
		}
	}()

	graphqlHandler := metrics.InstrumentHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if graphqlHTTPHandler != nil {
			graphqlHTTPHandler.ServeHTTP(w, r)
		} else {
			http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		}
	}))
	metricsHandler := metrics.Init()

	healthHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("true"))
	})

	http.Handle("/graphql", graphqlHandler)
	http.Handle("/health", healthHandler)
	http.Handle("/metrics", metricsHandler)
	http.ListenAndServe(":8011", nil)
}
