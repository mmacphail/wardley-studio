import { native } from "./storage.ts";

export interface AppFeatures {
  chat: boolean;
  chatCompiled: boolean;
}

export async function loadFeatures(): Promise<AppFeatures> {
  const features = native
    ? await window.__TAURI__!.core.invoke<AppFeatures>("app_features")
    : { chat: true, chatCompiled: true };
  return {
    chat: __CHAT_ENABLED__ && features.chat,
    chatCompiled: __CHAT_ENABLED__ && features.chatCompiled,
  };
}
