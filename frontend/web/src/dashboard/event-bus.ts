import type { SseEvent } from '@portal/schemas';

export type EventListener = (event: SseEvent) => void;

export interface EventBus {
  /** `topics` undefined = every frame; returns the unsubscribe. */
  subscribe: (topics: readonly string[] | undefined, listener: EventListener) => () => void;
  emit: (event: SseEvent) => void;
}

/**
 * Fans the dashboard's one SSE stream out to the screens that want a topic of it (ADR
 * 0019 §1): a D3 generation, feedback or test call listens here instead of opening a
 * second `GET /events` of its own. One listener that throws does not starve the rest.
 */
export function createEventBus(): EventBus {
  const listeners = new Set<{ topics: Set<string> | null; listener: EventListener }>();
  return {
    subscribe(topics, listener) {
      const entry = { topics: topics ? new Set(topics) : null, listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    emit(event) {
      for (const entry of [...listeners]) {
        if (entry.topics && !entry.topics.has(event.topic)) continue;
        try {
          entry.listener(event);
        } catch (error) {
          // A screen's bug must not stop the balance pill or the calls list from hearing the frame.
          console.error(error);
        }
      }
    },
  };
}
