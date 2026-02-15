export type StoredMessage = {
  id: string;
  jid: string;
  fromMe: boolean;
  sender: string;
  text: string;
  timestamp: number;
};

export type StoredChat = {
  jid: string;
  name: string;
  unreadCount: number;
  lastMessageTimestamp: number;
  lastMessage?: string;
};

export type StoredContact = {
  jid: string;
  name: string;
  notify?: string;
};
