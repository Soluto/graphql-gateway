export interface KeyValue {
  key: string;
  value: string;
  required?: boolean;
}

export interface RestParams {
  url: string;
  method?: string;
  body?: string;
  bodyArg?: string;
  query?: KeyValue[];
  headers?: KeyValue[];
  timeoutMs?: number;
  notFoundAsNull?: boolean;
}
