import { serializeJsonToLith } from './lithic-format';

export type LocalFileHandle = {
  name: string;
  createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void> }>;
};

export type LocalSaver = (text: string, callback: (error?: unknown) => void) => boolean;

export function createLocalSaver(fileHandle: LocalFileHandle, isLith = true): LocalSaver {
  return (text, callback) => {
    const output = isLith ? serializeJsonToLith(text) : text;
    fileHandle.createWritable()
      .then(async (writable) => {
        await writable.write(output || text);
        await writable.close();
        callback();
      })
      .catch(callback);
    return true;
  };
}
