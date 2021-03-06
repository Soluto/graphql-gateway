# Authorization

Stitch provides the ability to manage access to data using authorization policies. These policies are attached to schema fields that require authorized access.

## Policy definition

Policy is Stitch a resource like schema. It can be created, altered or removed by using the Registry API.

The policy object has the following properties:

| property | description                                                                                                                                                                                                                                                                            | mandatory |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| metadata | Contains two fields name and namespace.</br> Namespace is a logical group of policies.</br> Namespace and name pair is the policy's unique identifier                                                                                                                                  | true      |
| type     | Policy type.</br> Currently only [OPA](https://www.openpolicyagent.org) policies are supported                                                                                                                                                                                         | true      |
| code     | Policy body, with syntax based on the chosen Policy type.</br>For OPA, [Rego](https://www.openpolicyagent.org/docs/latest/policy-language) language is supported.</br>                                                                                                                 | true      |
| args     | Argument definitions.</br> These arguments are available in the policy code and query.</br> They support the Stitch [Parameter Injection](https://github.com/Soluto/stitch/blob/master/docs/arguments_injection.md) syntax.                                                            | false     |
| query    | Graphql query to provide additional data to policy.</br> The results are available in the policy code.</br> `query` has two properties: `gql` that defines the graphql query and `variables` for the query. `variables` can be the constant values or expressions using policy `args`. | false     |

### Examples

#### Example 1: Simple policy with argument

```yaml
metadata:
  namespace: billing
  name: adminOnly
type: opa
code: |
  default allow = false
  allow {
    input.args.userRoles[_] == "admin"
  }
args:
  userRoles:
    type: [String!]
    default: '{jwt?.roles}'
```

Explanation:

- **_metadata_**: The policy name and namespace.

- **_type_**: Policy type

- **_code_**: The [Rego](https://www.openpolicyagent.org/docs/latest/policy-language) language code block. The `input` variable has 2 optional fields.

  - `args`: derived from `@policy` directive arguments evaluation.
  - `query`: the result of `query` policy property execution. The query is executed on the Stitch schema without effect of authorization policies (a.k.a. admin privileges). See examples below.

- **_args_**: Arguments mapping. The key is argument name, the value is the options for the argument. In this example the `userRole` argument gets the value of the `roles` claim from the request JWT by default. The argument can be given a different value when setting the policy on a field or object, which will override the default.
  The options for an argument are:

  - `type`: The Graphql type of this argument. If the type is nullable type the argument is optional.
  - `default`: The default value (argument injection supported) for the argument. Can be overridden when setting the policy on a field/object.

---

#### Example 2: Policy with query

```yaml
metadata:
  namespace: admin_ns
  name: adminOnly
type: opa
code: |
  default allow = false
  allow {
    input.query.user.roles[_] == "admin"
  }
args:
  userId:
    type: ID
query:
  gql: |
    query($id: ID!) {
      user(id: $id) {
        roles
      }
    }
  variables:
    id: '{userId}'
```

- **_query_**: Graphql query definition. It has 2 properties:

  - `gql`: the [query](https://graphql.org/learn/queries) itself.
  - `variables`: [variables](https://graphql.org/learn/queries/#variables) that are injected to the Graphql request. The values of variables can be either hardcoded or derived from policy `args` property. In the last case the syntax is `"{userId}"` (See example above)

---

#### Example 3: Policy that depends on another policy

Each policy is also available for evaluation as graphql query. It can be tested while debugging.
If one policy is dependent on another the `query` property can include the following fragment:

```graphql
{
  policy.another_policy_namespace___another_policy_name(<another_policy_args>) {
    allow # As mentioned above the policy result is always object with the single boolean field "allow"
  }
}
```

The policy arguments should be set as the query arguments.

Note that due to graphql naming limitations, the name of the policy query has dashes replaced with underscores for both the namespace and the policy name (e.g. namespace `some-ns` and policy name `some-policy` will be called using `policy.some_ns___some_policy`)

In the example below the query has 2 parts: the first one fetches `roles` field from `user` and the second part evaluates `userIsActive`.

```yaml
metadata:
  namespace: admin_ns
  name: adminOnly
type: opa
code: |
  default allow = false
  allow {
    input.query.user.roles[_] == "admin"
    input.query.policy.another_ns___userIsActive.allow
  }
args:
  userId:
    type: ID
query:
  gql: |
    query($id: ID!) {
      user(id: $id) {
        roles
      },
      policy {
        another_ns___userIsActive(userId: $id) {
          allow
        }
      }
    }
  variables:
    id: '{userId}'
```

---

## Policy directive

The policies are set using graphql directives. In order to attach policy to field the `@policy` directive should be set on the field.
So if in type `User` there is field `phone` that should be accessible for user with admin role only the type definition should be as following:

```graphql
type User {
  id: ID!
  name: String!
  phone: String @policy(namespace: "billing", name: "adminOnly", args: { userRoles: "{jwt?.roles}" })
}
```

The policy is defined as in example 1 (See above). Note that since the policy definition has the same default value for the `userRoles` argument, the `args` parameter could have been omitted in this case.

In the example above, the `roles` argument value is received by using the Argument Injection mechanism. In this example, it is received from the `roles` claim in the request's JWT.

> Note: See [Arguments Injection](./arguments_injection.md) for more information about configuration of policy arguments.

## Post Resolve

`@policy` directive has optional `postResolve` argument. If the value of the argument is `true` the policy validation will be executed **after** the execution of field resolver. This argument should be used in case the policy logic depends on the result of field resolver execution.

For example if we don't want to allow to query photos marked as private and the policy and the schema should be like this:

```graphql
type Photo {
  id: ID!
  owner: String!
  private: Boolean!
}

type Query {
  photo(id: ID!) @rest(url: ...) @policy(namespace: "ns", name: "public-only", postResolve: true, args: { private: "{ result.private }" })
}
```

The `@rest` directive will be executed before the `@policy` one. And its result will be available in the policy argument injection as `result`.

```yaml
metadata:
  namespace: ns
  name: public-only
type: opa
code: |
  default allow = false
  allow {
    input.args.private == false
  }
args:
  private:
    type: Boolean!
```

## Directives order

**_Important!_** The [order of directives](https://github.com/graphql/graphql-spec/blob/master/spec/Section%202%20--%20Language.md#directives) does matter! The directives are applied in order they appear in schema. Object type directives are applied before field definition directives.

The `@policy` directive is required to be set **the last** either on object type or field definition.

## Base policy

Any policy (that doesn't contain query) can be set as base policy. Base policy is applied automatically to every single field in query.

If field has `@policy` directive both base policy and the attached policy will be checked. Base policy will be checked first. If the attached policy is defined with the `shouldOverrideBasePolicy` option the base policy won't be checked.

## Ignore policies configuration option

In development and testing environment there is option to disable policies restrictions by setting `"true"` value to `IGNORE_POLICIES` environment variable.
