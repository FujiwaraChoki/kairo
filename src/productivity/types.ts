export interface Reminder {
  id: string;
  chatId: number;
  message: string;
  time: string; // ISO 8601
  createdAt: string;
  fired: boolean;
}

export interface Note {
  id: string;
  chatId: number;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}
