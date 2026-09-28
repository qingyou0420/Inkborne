import { describe, expect, it } from "vitest";
import { redactSecrets } from "../utils/redact-secrets.js";

describe("redactSecrets", () => {
  it("hides sk- keys, bearer tokens, and long key strings", () => {
    const text = redactSecrets([
      "上游拒绝 sk-live_abcDEF1234567890",
      "Authorization: Bearer abcdefghijklmnop1234567890",
      "api_key=sk-anotherkey99999999",
      "token AbCdEf0123456789AbCdEf0123456789AbCdEf012345",
      "普通的模型超时",
    ].join("\n"));
    expect(text).not.toContain("sk-live_abcDEF1234567890");
    expect(text).not.toContain("abcdefghijklmnop1234567890");
    expect(text).not.toContain("sk-anotherkey99999999");
    expect(text).not.toContain("AbCdEf0123456789AbCdEf0123456789AbCdEf012345");
    expect(text).toContain("已隐藏");
    expect(text).toContain("普通的模型超时");
  });

  it("leaves long model names and file paths alone", () => {
    const model = "accounts/fireworks/models/llama-v3p1-405b-instruct-long-context-2024";
    const file = "D:\\Grisia Studio\\Inkborne\\packages\\core\\src\\authoring\\stages\\write.ts";
    const text = redactSecrets(`上游模型 ${model} 失败，文件 ${file}`);
    expect(text).toContain(model);
    expect(text).toContain(file);
    expect(text).not.toContain("已隐藏");
  });

  it("still hides an unbroken high-entropy alphanumeric string", () => {
    const secret = "AbCdEf0123456789AbCdEf0123456789AbCdEf012345";
    const text = redactSecrets(`token ${secret} 之后`);
    expect(text).not.toContain(secret);
    expect(text).toContain("已隐藏");
  });
});
