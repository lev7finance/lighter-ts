import curve from "../../conformance/vectors/curve.json" with { type: "json" };
import gfp5 from "../../conformance/vectors/gfp5.json" with { type: "json" };
import goldilocks from "../../conformance/vectors/goldilocks.json" with { type: "json" };
import poseidon2 from "../../conformance/vectors/poseidon2.json" with { type: "json" };
import schnorr from "../../conformance/vectors/schnorr.json" with { type: "json" };
import tx from "../../conformance/vectors/tx.json" with { type: "json" };
import { runBehaviour } from "./behaviour.js";
import type { BehaviourSummary } from "./behaviour.js";
import type { RunSummary, VectorBundle } from "./run-vectors.js";

interface WorkerSummary {
  readonly runtime: "workerd";
  readonly vectors: RunSummary;
  readonly behaviour: BehaviourSummary;
}

const vectors: VectorBundle = {
  "curve.json": curve,
  "gfp5.json": gfp5,
  "goldilocks.json": goldilocks,
  "poseidon2.json": poseidon2,
  "schnorr.json": schnorr,
  "tx.json": tx,
};

let run: Promise<WorkerSummary> | undefined;

async function execute(): Promise<WorkerSummary> {
  // Behaviour must run first: it installs import-time side-effect spies before loading dist/.
  const behaviour = await runBehaviour();
  const { runVectors } = await import("./run-vectors.js");
  const vectorSummary = await runVectors(vectors);
  return { runtime: "workerd", vectors: vectorSummary, behaviour };
}

export default {
  async fetch(): Promise<Response> {
    run ??= execute();
    try {
      const summary = await run;
      const status =
        summary.vectors.failures === 0 && summary.behaviour.failures === 0 ? 200 : 500;
      return Response.json(summary, { status });
    } catch (error: unknown) {
      return Response.json(
        {
          runtime: "workerd",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        { status: 500 },
      );
    }
  },
};
