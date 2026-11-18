import assert from "node:assert/strict"
import test from "node:test"

import {
  embeddingModel,
  isStarting,
  retryAfterMs,
  serviceHeaders,
  serviceToken,
  serviceUrl,
  startingWaitMs,
  STARTING_HEADER,
} from "@omacode/core/services"

import { DecisionClient, DeciderError } from "../packages/micromanager/src/decider.ts"

const QUESTIONS = { harmful: { type: "noul" as const, instructions: "This task asks for help to hurt people." } }
const ANSWER = JSON.stringify({ model: "gliner", answers: { harmful: { noul: 0.1 } } })

test("a desktop has the fixed ports, no token and no wait", () => {
  assert.equal(serviceUrl("decider", {}), "http://127.0.0.1:8781")
  assert.equal(serviceUrl("embedding", {}), "http://127.0.0.1:8093")
  assert.equal(serviceToken({}), undefined)
  assert.deepEqual(serviceHeaders({}), {})
  assert.equal(embeddingModel({}), undefined)
  assert.equal(startingWaitMs({}), 0)
})

test("the container's environment names the services, the token and the model", () => {
  const env = {
    OMACODE_DECIDER_URL: "http://127.0.0.1:41000/",
    OMACODE_EMBEDDING_URL: " http://127.0.0.1:41001 ",
    OMACODE_SERVICE_TOKEN: "t0k",
    OMACODE_EMBEDDING_MODEL: "qwen3-embedding-0.6b",
  }
  assert.equal(serviceUrl("decider", env), "http://127.0.0.1:41000")
  assert.equal(serviceUrl("embedding", env), "http://127.0.0.1:41001")
  assert.deepEqual(serviceHeaders(env), { Authorization: "Bearer t0k" })
  assert.equal(embeddingModel(env), "qwen3-embedding-0.6b")
  assert.equal(startingWaitMs(env), 90_000, "with a token there is a supervisor that may be starting a service")
  assert.equal(startingWaitMs({ ...env, OMACODE_STARTING_WAIT_MS: "0" }), 0)
})

test("only a 503 that says so is a start, and its pause stays within bounds", () => {
  const starting = new Response("", { status: 503, headers: { [STARTING_HEADER]: "1", "retry-after": "60" } })
  assert.equal(isStarting(starting), true)
  assert.equal(isStarting(new Response("", { status: 503 })), false)
  assert.equal(retryAfterMs(starting), 5000)
  assert.equal(retryAfterMs(new Response("", { status: 503, headers: { "retry-after": "0" } })), 500)
})

test("the decision client waits out a start and then answers", async () => {
  let calls = 0
  const seen: string[] = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    calls++
    seen.push(new Headers(init.headers).get("authorization") ?? "")
    if (calls < 3) return new Response("", { status: 503, headers: { [STARTING_HEADER]: "1", "retry-after": "0" } })
    return new Response(ANSWER, { status: 200 })
  }) as typeof fetch
  const client = new DecisionClient("t0k", { url: "http://127.0.0.1:41000/v1/systemone", fetch: fetcher, startingWaitMs: 10_000 })
  const decision = await client.ask("a state", QUESTIONS)
  assert.equal(calls, 3)
  assert.equal(decision.model, "gliner")
  assert.deepEqual(seen, ["Bearer t0k", "Bearer t0k", "Bearer t0k"])
})

test("without a wait a start is a failure, so a desktop falls back at once", async () => {
  const fetcher = (async () => new Response("", { status: 503, headers: { [STARTING_HEADER]: "1" } })) as typeof fetch
  const client = new DecisionClient("local", { url: "http://127.0.0.1:8781/v1/systemone", fetch: fetcher, startingWaitMs: 0 })
  await assert.rejects(client.ask("a state", QUESTIONS), DeciderError)
})
