import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';

export function chatInputLimit(text: string) {
  const count = Array.from(text).length;
  return {
    count,
    exceeded: count > CHAT_CHARACTER_LIMIT,
    visible: count >= CHAT_CHARACTER_LIMIT * 0.8,
  };
}
