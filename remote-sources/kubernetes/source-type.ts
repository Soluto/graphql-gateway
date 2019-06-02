export default interface Source {
    getGqlObjects(kind: string): Promise<{ [name: string]: string }>;
    registerGqlObject(name: string, kind: string, definition: string): Promise<void>;
}
