import {ApolloServer, gql, IResolvers} from 'apollo-server-fastify';
import GraphQLJSON, {GraphQLJSONObject} from 'graphql-type-json';
import * as fastify from 'fastify';
import pLimit from 'p-limit';
import {S3ResourceRepository, ResourceGroup, applyResourceGroupUpdates} from './modules/resource-repository';
import * as config from './modules/config';
import {validateResourceGroupOrThrow} from './modules/validation';
import logger from './modules/logger';
import {handleSignals, handleUncaughtErrors} from './modules/shutdownHandler';
import {createSchemaConfig} from './modules/graphqlService';
import * as opaHelper from './modules/opaHelper';
// Importing directly from types because of a typescript or ts-jest bug that re-exported enums cause a runtime error for being undefined
// https://github.com/kulshekhar/ts-jest/issues/281
import {PolicyArgsObject, PolicyType, PolicyQueryType} from './modules/resource-repository/types';

const typeDefs = gql`
    scalar JSON
    scalar JSONObject

    # General

    input ResourceMetadataInput {
        namespace: String!
        name: String!
    }

    type Result {
        success: Boolean!
    }

    input ResourceGroupInput {
        schemas: [SchemaInput!]
        upstreams: [UpstreamInput!]
        upstreamClientCredentials: [UpstreamClientCredentialsInput!]
        policies: [PolicyInput!]
    }

    type Query {
        validateResourceGroup(input: ResourceGroupInput!): Result
        validateSchemas(input: [SchemaInput!]!): Result
        validateUpstreams(input: [UpstreamInput!]!): Result
        validateUpstreamClientCredentials(input: [UpstreamClientCredentialsInput!]!): Result
        validatePolicies(input: [PolicyInput!]!): Result
    }

    type Mutation {
        updateResourceGroup(input: ResourceGroupInput!): Result
        updateSchemas(input: [SchemaInput!]!): Result
        updateUpstreams(input: [UpstreamInput!]!): Result
        updateUpstreamClientCredentials(input: [UpstreamClientCredentialsInput!]!): Result
        updatePolicies(input: [PolicyInput!]!): Result
    }

    # Schemas

    input SchemaInput {
        metadata: ResourceMetadataInput!
        schema: String!
    }

    # Upstreams

    enum AuthType {
        ActiveDirectory
    }

    """
    GraphQL doesn't support unions for input types, otherwise this would be a union of different auth types.
    Instead, the AuthType enum indicates which auth type is needed, and there's a property which corresponds to each auth type, which we validate in the registry.
    """
    input AuthInput {
        type: AuthType!
        activeDirectory: ActiveDirectoryAuthInput!
    }

    input ActiveDirectoryAuthInput {
        authority: String!
        resource: String!
    }

    input UpstreamInput {
        metadata: ResourceMetadataInput!
        host: String!
        auth: AuthInput!
    }

    # Upstream client credentials

    input ActiveDirectoryCredentials {
        authority: String!
        clientId: String!
        clientSecret: String!
    }

    """
    GraphQL doesn't support unions for input types, otherwise this would be a union of different auth types.
    Instead, the AuthType enum indicates which auth type is needed, and there's a property which corresponds to each auth type, which we validate in the registry.
    """
    input UpstreamClientCredentialsInput {
        metadata: ResourceMetadataInput!
        authType: AuthType!
        activeDirectory: ActiveDirectoryCredentials!
    }

    # Policy

    enum PolicyType {
        opa
    }

    enum PolicyQueryType {
        graphql
        policy
    }

    input PolicyQueryGraphQLInput {
        query: String!
    }

    input PolicyQueryPolicyInput {
        policyName: String!
        args: JSONObject
    }

    """
    GraphQL doesn't support unions for input types, otherwise this would be a union of different policy query types.
    Instead, the PolicyQueryType enum indicates which policy query type is needed, and there's a property which corresponds to each policy query type, which we validate in the registry.
    """
    input # The query result will be available to the policy code in a parameter named as chosen in paramName, under the "data.queries" object.
    PolicyQueryInput {
        type: PolicyQueryType!
        paramName: String!
        graphql: PolicyQueryGraphQLInput
        policy: PolicyQueryPolicyInput
    }

    input PolicyInput {
        metadata: ResourceMetadataInput!
        type: PolicyType!
        code: String!
        args: JSONObject
        queries: [PolicyQueryInput!]
    }
`;

interface ResourceMetadataInput {
    namespace: string;
    name: string;
}

interface ResourceGroupInput {
    schemas?: SchemaInput[];
    upstreams?: UpstreamInput[];
    upstreamClientCredentials?: UpstreamClientCredentialsInput[];
    policies?: PolicyInput[];
}

interface SchemaInput {
    metadata: ResourceMetadataInput;
    schema: string;
}

export enum AuthType {
    ActiveDirectory = 'ActiveDirectory',
}

interface ActiveDirectoryAuthInput {
    authority: string;
    resource: string;
}

interface UpstreamInput {
    metadata: ResourceMetadataInput;
    host: string;
    auth: {
        type: AuthType;
        activeDirectory: ActiveDirectoryAuthInput;
    };
}

interface UpstreamClientCredentialsInput {
    metadata: ResourceMetadataInput;
    authType: AuthType;
    activeDirectory: {
        authority: string;
        clientId: string;
        clientSecret: string;
    };
}

interface PolicyQueryGraphQLInput {
    query: string;
}

interface PolicyQueryPolicyInput {
    policyName: string;
    args: PolicyArgsObject;
}

interface PolicyQueryInput {
    type: PolicyQueryType;
    paramName: string;
    graphql?: PolicyQueryGraphQLInput;
    policy?: PolicyQueryPolicyInput;
}

interface PolicyInput {
    metadata: ResourceMetadataInput;
    type: PolicyType;
    code: string;
    args?: PolicyArgsObject;
    queries?: PolicyQueryInput[];
}

const resourceRepository = S3ResourceRepository.fromEnvironment();

async function fetchAndValidate(updates: Partial<ResourceGroup>): Promise<ResourceGroup> {
    const {resourceGroup} = await resourceRepository.fetchLatest();
    const newRg = applyResourceGroupUpdates(resourceGroup, updates);
    validateResourceGroupOrThrow(newRg);
    createSchemaConfig(newRg);

    return newRg;
}

type TempLocalPolicyAttachment = {metadata: ResourceMetadataInput; path: string; type: PolicyType};

const policyAttachmentStrategies = {
    [PolicyType.opa]: {
        generate: async (input: PolicyInput) => {
            const path = await opaHelper.prepareCompiledRegoFile(input.metadata, input.code);
            return {path, metadata: input.metadata, type: PolicyType.opa};
        },
        cleanup: async (attachment: TempLocalPolicyAttachment) => {
            try {
                await opaHelper.deleteLocalRegoFile(attachment.path);
            } catch (err) {
                logger.warn(
                    {err, attachment},
                    'Failed cleanup of compiled rego file, this did not affect the request outcome'
                );
            }
        },
        writeToRepo: async (attachment: TempLocalPolicyAttachment) => {
            const compiledRego = await opaHelper.readLocalRegoFile(attachment.path);
            const filename = opaHelper.getCompiledFilename(attachment.metadata);
            await resourceRepository.writePolicyAttachment(filename, compiledRego);
        },
    },
};

const singleton = pLimit(1);
const resolvers: IResolvers = {
    JSON: GraphQLJSON,
    JSONObject: GraphQLJSONObject,
    Query: {
        async validateResourceGroup(_, args: {input: ResourceGroupInput}) {
            await fetchAndValidate(args.input);

            return {success: true};
        },
        async validateSchemas(_, args: {input: SchemaInput[]}) {
            await fetchAndValidate({schemas: args.input});

            return {success: true};
        },
        async validateUpstreams(_, args: {input: UpstreamInput[]}) {
            await fetchAndValidate({upstreams: args.input});

            return {success: true};
        },
        async validateUpstreamClientCredentials(_, args: {input: UpstreamClientCredentialsInput[]}) {
            await fetchAndValidate({upstreamClientCredentials: args.input});

            return {success: true};
        },
        async validatePolicies(_, args: {input: PolicyInput[]}) {
            const policyAttachments: TempLocalPolicyAttachment[] = [];

            for (const input of args.input) {
                if (!policyAttachmentStrategies[input.type]) continue;

                const attachment = await policyAttachmentStrategies[input.type].generate(input);
                policyAttachments.push(attachment);
            }

            try {
                await fetchAndValidate({policies: args.input});
            } finally {
                for (const attachment of policyAttachments) {
                    await policyAttachmentStrategies[attachment.type].cleanup(attachment);
                }
            }

            return {success: true};
        },
    },
    Mutation: {
        updateResourceGroup(_, args: {input: ResourceGroupInput}) {
            return singleton(async () => {
                const rg = await fetchAndValidate(args.input);
                await resourceRepository.update(rg);

                return {success: true};
            });
        },
        updateSchemas(_, args: {input: SchemaInput[]}) {
            return singleton(async () => {
                const rg = await fetchAndValidate({schemas: args.input});
                await resourceRepository.update(rg);

                return {success: true};
            });
        },
        updateUpstreams(_, args: {input: UpstreamInput[]}) {
            return singleton(async () => {
                const rg = await fetchAndValidate({upstreams: args.input});
                await resourceRepository.update(rg);

                return {success: true};
            });
        },
        updateUpstreamClientCredentials(_, args: {input: UpstreamClientCredentialsInput[]}) {
            return singleton(async () => {
                const rg = await fetchAndValidate({upstreamClientCredentials: args.input});
                await resourceRepository.update(rg);

                return {success: true};
            });
        },
        updatePolicies(_, args: {input: PolicyInput[]}) {
            return singleton(async () => {
                const policyAttachments: TempLocalPolicyAttachment[] = [];

                for (const input of args.input) {
                    if (!policyAttachmentStrategies[input.type]) continue;

                    const attachment = await policyAttachmentStrategies[input.type].generate(input);
                    policyAttachments.push(attachment);
                }

                try {
                    const rg = await fetchAndValidate({policies: args.input});

                    for (const attachment of policyAttachments) {
                        await policyAttachmentStrategies[attachment.type].writeToRepo(attachment);
                    }

                    await resourceRepository.update(rg);
                } finally {
                    for (const attachment of policyAttachments) {
                        await policyAttachmentStrategies[attachment.type].cleanup(attachment);
                    }
                }

                return {success: true};
            });
        },
    },
};

export const app = new ApolloServer({
    typeDefs,
    resolvers,
    tracing: config.enableGraphQLTracing,
    playground: config.enableGraphQLPlayground,
    introspection: config.enableGraphQLIntrospection,
});

async function run() {
    await opaHelper.initializeForRegistry();

    logger.info('Stitch registry booting up...');
    const server = fastify();
    server.register(app.createHandler({path: '/graphql'}));
    const address = await server.listen(config.httpPort, '0.0.0.0');
    logger.info({address}, 'Stitch registry started');

    handleSignals(() => app.stop());
    handleUncaughtErrors();
}

// Only run when file is being executed, not when being imported
if (require.main === module) {
    run();
}
