declare module 'ali-oss' {
  import type { Readable } from 'node:stream';

  interface OssOptions {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    stsToken: string;
    secure?: boolean;
  }

  interface OssResponse {
    res: { headers: Record<string, string | number | undefined> };
    meta?: Record<string, string> | null;
  }

  export default class OSS {
    constructor(options: OssOptions);
    calculatePostSignature(policy: object): {
      OSSAccessKeyId: string;
      Signature: string;
      policy: string;
    };
    generateObjectUrl(name: string): string;
    getBucketInfo(name: string): Promise<unknown>;
    head(name: string): Promise<OssResponse>;
    get(
      name: string,
      options: { headers: Record<string, string> },
    ): Promise<OssResponse & { content: Buffer }>;
    delete(name: string): Promise<unknown>;
    putStream(
      name: string,
      stream: Readable,
      options?: { mime?: string; headers?: Record<string, string> },
    ): Promise<unknown>;
  }
}
