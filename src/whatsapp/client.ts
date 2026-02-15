import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import logger from "../logger";
import { WhatsAppStore } from "./store";

const AUTH_DIR = "auth_info_baileys";
const log = logger.child({ module: "whatsapp" });
const baileysLogger = logger.child({ module: "baileys" });

let sock: WASocket | null = null;
let connectionReady: Promise<void>;
let resolveConnection: () => void;

export const store = new WhatsAppStore();

export function getSocket(): WASocket | null {
  return sock;
}

export function isConnected(): boolean {
  return sock !== null;
}

export async function connectWhatsApp(): Promise<void> {
  connectionReady = new Promise((resolve) => {
    resolveConnection = resolve;
  });

  await startSocket();
  await connectionReady;
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: ["Kairo", "Desktop", "1.0.0"],
  });

  // Bind store to events
  store.bind(sock.ev);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log.info("QR code received — scan in WhatsApp > Linked Devices > Link a Device");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log.warn({ statusCode, shouldReconnect }, "WhatsApp connection closed");

      if (shouldReconnect) {
        await startSocket();
      } else {
        sock = null;
        log.error("WhatsApp logged out. Delete auth_info_baileys/ and restart to re-pair.");
        resolveConnection(); // Don't block startup
      }
    }

    if (connection === "open") {
      log.info("WhatsApp connected");
      resolveConnection();
    }
  });
}
