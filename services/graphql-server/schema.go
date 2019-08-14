package main

import (
	graphql "github.com/graphql-go/graphql"
	"github.com/vektah/gqlparser"
	"github.com/vektah/gqlparser/ast"

	agogos "agogos/generated"
	"agogos/server"
	"agogos/server/schema"
	"agogos/utils"
	"context"
	"io"
	"os"
	"time"

	log "github.com/sirupsen/logrus"
	"google.golang.org/grpc"

	upstreams "agogos/extensions/upstreams"
	upstreamsAuthentication "agogos/extensions/upstreams/authentication"
)

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if len(value) == 0 {
		return fallback
	}
	return value
}

var (
	address = getenv("REGISTRY_URL", "agogos.registry:81")
)

type gqlConfigurationResult struct {
	schema *graphql.Schema
	err    error
}

func subscribeToRegistry(gqlConfigurations chan gqlConfigurationResult) (err error) {
	defer utils.Recovery(&err)

	conn, err := grpc.Dial(address, grpc.WithInsecure())
	if err != nil {
		log.WithField("error", err).Warn("Error initiating GRPC channel")
		return err
	}
	defer conn.Close()

	registryClient := agogos.NewRegistryClient(conn)

	stream, err := subscribe(registryClient)
	if err != nil {
		log.WithField("error", err).Warn("Error subscribing to registry", err)
		return err
	}

	for {
		registryMessage, err := stream.Recv()

		if err == io.EOF {
			log.Warn("got EOF")
			break
		}
		if err != nil {
			log.WithField("error", err).Warn("Error receiving message")
			gqlConfigurations <- gqlConfigurationResult{
				schema: nil,
				err:    err,
			}
			return err
		}

		upstreams.Init(registryMessage.Upstreams)
		upstreamsAuthentication.Init(registryMessage.UpstreamAuthCredentials)

		astSchema, err := parseSdl(source{
			name: "schema registry sdl",
			sdl:  registryMessage.Schema.Definition,
		})
		if err != nil {
			log.WithField("error", err).Warn("Error parsing SDL")
			gqlConfigurations <- gqlConfigurationResult{
				schema: nil,
				err:    err,
			}
			return err
		}

		upstreamsMap := createUpstreams(registryMessage.Upstreams)
		upstreamsAuthMap := createUpstreamAuths(registryMessage.UpstreamAuthCredentials)
		serverContext := server.CreateServerContext(upstreamsMap, upstreamsAuthMap)

		convertedSchema, err := schema.ConvertSchema(serverContext, astSchema)
		if err != nil {
			log.WithField("error", err).Warn("Error converting schema")
			gqlConfigurations <- gqlConfigurationResult{
				schema: nil,
				err:    err,
			}
			return err
		}

		gqlConfigurations <- gqlConfigurationResult{
			schema: convertedSchema,
			err:    nil,
		}
	}
	return nil
}

func subscribe(client agogos.RegistryClient) (stream agogos.Registry_SubscribeClient, err error) {
	for i := 0; i < 3; i++ {
		stream, err = client.Subscribe(context.Background(), &agogos.SubscribeParams{})
		if err == nil {
			break
		}
		if i+1 < 3 {
			time.Sleep(3000 * time.Millisecond)
		}
	}
	return
}

type source struct {
	name string
	sdl  string
}

func parseSdl(s source) (*ast.Schema, error) {
	schema, err := gqlparser.LoadSchema(&ast.Source{
		Name:  s.name,
		Input: s.sdl,
	})

	if err != nil {
		return nil, err
	}

	return schema, nil
}

func createUpstreams(upsConfig []*agogos.Upstream) map[string]upstreams.Upstream {
	ups := make(map[string]upstreams.Upstream, len(upsConfig))

	for _, upConfig := range upsConfig {
		ups[upConfig.Host] = upstreams.From(upConfig)
	}

	return ups
}

func createUpstreamAuths(upsAuthConfigs []*agogos.UpstreamAuthCredentials) map[string]map[string]upstreamsAuthentication.UpstreamAuthentication {
	upAuths := make(map[string]map[string]upstreamsAuthentication.UpstreamAuthentication)

	for _, upAuthConfig := range upsAuthConfigs {
		_, ok := upAuths[upAuthConfig.AuthType]
		if !ok {
			upAuths[upAuthConfig.AuthType] = make(map[string]upstreamsAuthentication.UpstreamAuthentication)
		}

		upAuths[upAuthConfig.AuthType][upAuthConfig.Authority] = upstreamsAuthentication.From(upAuthConfig)
	}

	return upAuths
}
