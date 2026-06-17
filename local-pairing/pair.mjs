import makeWASocket, { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import { readFileSync, writeFileSync, existsSync } from "fs";
import readline from "readline";

const SESSION_FILE = "./session.json";
const usePairingCode = process.argv.includes("--pairing-code");

function emptyData() {
  return { creds: initAuthCreds(), keys: {} };
}

function useSingleFileAuthState(filePath) {
  let data = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf-8"), BufferJSON.reviver)
    : emptyData();

  function save() {
    writeFileSync(filePath, JSON.stringify(data, BufferJSON.replacer, 2));
  }

  return {
    state: {
      creds: data.creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            let value = data.keys[type]?.[id];
            if (value && type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== undefined) result[id] = value;
          }
          return result;
        },
        set: async (update) => {
          for (const category in update) {
            data.keys[category] = data.keys[category] || {};
            Object.assign(data.keys[category], update[category]);
          }
          save();
        },
      },
    },
    saveCreds: save,
    exportSession: () => Buffer.from(JSON.stringify(data, BufferJSON.replacer)).toString("base64"),
  };
}

const { state, saveCreds, exportSession } = useSingleFileAuthState(SESSION_FILE);

console.log("Connexion à WhatsApp en cours...\n");

const sock = makeWASocket({ auth: state });

sock.ev.on("creds.update", saveCreds);

let pairingRequested = false;

sock.ev.on("connection.update", async (update) => {
  const { connection, qr } = update;

  if (qr) {
    if (usePairingCode) {
      if (!pairingRequested && !state.creds.registered) {
        pairingRequested = true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("Numéro WhatsApp avec indicatif pays, sans + (ex: 22997439379) : ", async (phone) => {
          rl.close();
          try {
            const code = await sock.requestPairingCode(phone.replace(/\D/g, ""));
            console.log(`\nCode d'appairage : ${code}\n`);
            console.log("Ouvrez WhatsApp → Paramètres → Appareils connectés → Connecter avec un numéro de téléphone, puis entrez ce code.\n");
          } catch (error) {
            console.error("Erreur lors de la génération du code :", error.message);
          }
        });
      }
    } else {
      console.log("Scannez ce QR code avec WhatsApp (Paramètres → Appareils connectés → Connecter un appareil) :\n");
      qrcodeTerminal.generate(qr, { small: true });
    }
  }

  if (connection === "open") {
    console.log("\n✅ Connecté à WhatsApp !\n");
    console.log("Copiez TOUTE la chaîne ci-dessous et collez-la dans Arissa (Paramètres → WhatsApp → Importer une session) :\n");
    console.log("----- DÉBUT DE LA SESSION -----");
    console.log(exportSession());
    console.log("----- FIN DE LA SESSION -----\n");
    process.exit(0);
  }

  if (connection === "close") {
    console.log("Connexion fermée. Relancez le script (npm run pair) pour réessayer.");
    process.exit(1);
  }
});
