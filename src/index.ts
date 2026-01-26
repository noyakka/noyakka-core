import Fastify from "fastify";
import cors from "@fastify/cors";
import env from "@fastify/env";

const server = Fastify({
  logger: true
});

const envSchema = {
  type: "object",
  required: ["PORT"],
  properties: {
    PORT: { type: "string", default: "3000" }
  }
};

async function start() {
  await server.register(cors, { origin: true });
  await server.register(env, { schema: envSchema, dotenv: true });

  server.get("/health", async () => {
    return { ok: true };
  });

  const port = Number(server.getEnvs().PORT);
  await server.listen({ port, host: "0.0.0.0" });
}

start().catch((err) => {
  server.log.error(err);
  process.exit(1);
});
