import { AgogosCustomResource, AgogosObjectConfig } from '../object-types';
import upstreamAuthEnricher from './upstreamAuthEnricher';

const enrichers: {
    [kind: string]: (obj: AgogosCustomResource) => Promise<AgogosObjectConfig>;
} = {
    upstreamclientcredentials: upstreamAuthEnricher,
};

export default async (resource: AgogosCustomResource<AgogosObjectConfig>): Promise<AgogosObjectConfig> => {
    const kind = resource.kind.toLowerCase();
    if (enrichers[kind]) {
        return enrichers[kind](resource);
    }
    return resource.spec;
};
