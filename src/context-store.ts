import { AsyncLocalStorage } from "node:async_hooks";

export const chatContext = new AsyncLocalStorage<number>();
