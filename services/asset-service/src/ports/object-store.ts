export interface ObjectStore {
  createUpload(input: {
    objectKey: string;
    contentType: string;
    maxBytes: bigint;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  head(objectKey: string): Promise<{
    contentType: string;
    sizeBytes: bigint;
    checksum?: string;
  }>;
  readPrefix(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  createDownload(objectKey: string, expiresInSeconds: number): Promise<string>;
  delete(objectKey: string): Promise<void>;
  copyFromUrl(input: {
    sourceUrl: string;
    destinationKey: string;
    maxBytes: bigint;
    allowedHosts: string[];
  }): Promise<{ sizeBytes: bigint; contentType: string; checksum?: string }>;
}
