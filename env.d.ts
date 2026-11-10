// Gives `env` from "cloudflare:workers" (used by the tests) the same type as the Worker's own Env.
type WorkerEnv = import("./worker/env").Env;
declare namespace Cloudflare {
  interface Env extends WorkerEnv {}
}
