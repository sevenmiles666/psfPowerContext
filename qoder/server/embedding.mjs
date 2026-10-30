import { resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

export const model = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const revision =
  process.env.MODEL_REVISION || "2c4055b12046f11709e9df2c122e59ffbdc2f900";
env.cacheDir = resolve(".cache/models");
env.remoteHost =
  (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/$/, "") +
  "/";
env.allowLocalModels = false;
let extractor;
let state = "未加载";
export function modelInfo() {
  return { name: model, revision, dimension: 384, dtype: "q8", state };
}
export async function embed(texts) {
  if (!extractor) {
    state = "加载中";
    extractor = pipeline("feature-extraction", model, {
      dtype: "q8",
      revision,
      device: "cpu",
    })
      .then((p) => {
        state = "已就绪";
        return p;
      })
      .catch((error) => {
        extractor = null;
        state = "加载失败";
        throw error;
      });
  }
  const pipe = await extractor;
  const result = [];
  for (let i = 0; i < texts.length; i += 8) {
    const output = await pipe(texts.slice(i, i + 8), {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 256,
    });
    result.push(...output.tolist());
  }
  return result;
}
