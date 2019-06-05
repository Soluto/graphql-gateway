import { take, map } from "rxjs/operators";

import gqlObjects$ from "../sync/sync-service";
import { makeGqlDocumentFromGqlSources } from "../sync/sync-gqlschemas";

const validateSchema = async (
    source: string,
    name: string,
    definition: string
) => {
    const schemas = await gqlObjects$
        .pipe(
            map(x => x.gqlschemas),
            take(1),
        ).toPromise();
    schemas[`${source}.${name}`] = definition;
    makeGqlDocumentFromGqlSources(schemas);
};

export default validateSchema;