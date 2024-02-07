import { useEngine } from "@envelop/core";
import { useResponseCache } from "@envelop/response-cache";
import { AsyncExecutor } from "@graphql-tools/utils";
import { schemaFromExecutor } from "@graphql-tools/wrap";
import cookie from "cookie";
import { parse, print, specifiedRules, validate } from "graphql";
import { YogaInitialContext, createYoga } from "graphql-yoga";
import http from "http";
import { pino } from "pino";

const log = pino({
  timestamp() {
    return `,"time":"${new Date().toISOString()}"`;
  },
  formatters: {
    level(label, number) {
      return { level: label };
    },
  },
});

const executor: AsyncExecutor<YogaInitialContext> = async (req) => {
  const { document, variables, operationName, extensions, context } = req;

  const now = process.hrtime.bigint();

  const query = print(document);

  log.info(JSON.stringify({ query, variables, operationName, extensions }));

  const headers = new Headers();

  if (context?.request?.headers) {
    context.request.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  } else {
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    headers.set("accept-encoding", "gzip, deflate, br");
  }

  const fetchResult = await fetch(
    "https://countries.trevorblades.com/graphql",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables, operationName, extensions }),
    }
  );

  const res = await fetchResult.json();

  const duration = process.hrtime.bigint() - now;
  log.info(`duration: ${duration / 1000000n}ms`);

  return res;
};

let schema = await schemaFromExecutor(executor);

const schemaRefresh = setInterval(async () => {
  try {
    const newSchema = await schemaFromExecutor(executor);
    if (newSchema.toString() === schema.toString()) {
      log.info("schema unchanged");
      return;
    }
    schema = newSchema;
    log.info("schema refreshed");
  } catch (e) {
    log.error(e, "schema refresh failed");
  }
}, 5000);

const server = createYoga({
  schema: schema,
  batching: true,
  graphiql: true,
  graphqlEndpoint: "/graphql",
  context: (req) => {
    return {
      headers: req.request.headers,
    };
  },
  plugins: [
    useEngine({
      parse,
      validate,
      specifiedRules,
      execute: executor,
      subscribe: executor,
    }),
    useResponseCache({
      session: (ctx) => {
        const c = ctx.request.headers.get("cookie");
        if (c) {
          const parsed = cookie.parse(c);
          if (parsed.session) {
            log.info("session", parsed.session);
            return parsed.session;
          }
        }
      },
    }),
  ],
});

const httpServer = http.createServer(server).listen(4000, () => {
  log.info("Server is running on http://localhost:4000");
});

process.on("SIGINT", () => {
  httpServer.close();
  clearInterval(schemaRefresh);
  log.info("Server stopped");
  process.exit(0);
});

process.on("SIGTERM", () => {
  httpServer.close();
  clearInterval(schemaRefresh);
  log.info("Server stopped");
  process.exit(0);
});
