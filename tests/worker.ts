import { api } from "../worker/api";
import type { Env } from "../worker/env";

export { ChatRoom } from "../worker/do/chat-room";
export { DateTimer } from "../worker/do/date-timer";
export { RateLimiter } from "../worker/do/rate-limiter";
export { UserHub } from "../worker/do/user-hub";

// Queues have producers only in tests: jobs are captured and run explicitly, so every test is deterministic.
export default { fetch: (request, env, ctx) => api.fetch(request, env, ctx) } satisfies ExportedHandler<Env>;
