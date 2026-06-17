import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import type { AuthenticationCreds, SignalDataTypeMap } from "@whiskeysockets/baileys";

type SingleFileData = {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
};

function emptyData(): SingleFileData {
  return { creds: initAuthCreds(), keys: {} };
}

export function decodeSessionString(sessionString: string): SingleFileData {
  const json = Buffer.from(sessionString.trim(), "base64").toString("utf-8");
  return JSON.parse(json, BufferJSON.reviver) as SingleFileData;
}

export function encodeSessionData(data: SingleFileData): string {
  return Buffer.from(JSON.stringify(data, BufferJSON.replacer)).toString("base64");
}

export function useSingleFileAuthState(filePath: string) {
  let data: SingleFileData;
  if (existsSync(filePath)) {
    data = JSON.parse(readFileSync(filePath, "utf-8"), BufferJSON.reviver) as SingleFileData;
  } else {
    data = emptyData();
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, BufferJSON.replacer, 2));
  }

  return {
    state: {
      creds: data.creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = data.keys[type]?.[id];
            if (value && type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            if (value !== undefined) result[id] = value as SignalDataTypeMap[T];
          }
          return result;
        },
        set: async (update: Record<string, Record<string, unknown>>) => {
          for (const category in update) {
            data.keys[category] = data.keys[category] || {};
            Object.assign(data.keys[category], update[category]);
          }
          save();
        },
      },
    },
    saveCreds: save,
    exportSession: () => encodeSessionData(data),
    importSession: (sessionString: string) => {
      data = decodeSessionString(sessionString);
      save();
    },
  };
}
