import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { parseCanon, serializeCanon } from "../authoring/canon.js";
import { generateGroundEntries, proposeSettingsCatalog, reviewGroundEntries, reviseGroundEntry } from "../authoring/stages/ground.js";
import { adoptWeave, generateWeaveRange as generateWeaveRangeCore, generateWeaveStructure, resolveWeaveTargetChapters, reviewWeave, reviseWeave } from "../authoring/stages/weave.js";
import { generateChapterDraft as generateChapterDraftCore } from "../authoring/stages/write.js";
import { loadArtifact, loadManifest, loadRun, newRunId, saveRunControl } from "../authoring/store.js";

async function generateWeaveRange(input: Parameters<typeof generateWeaveRangeCore>[0]) {
  const manifest = await loadManifest(input.root);
  if (!manifest.adopted.weave && input.root.bookId) {
    const target = await resolveWeaveTargetChapters(input.root, input.targetChapters);
    const structured = await generateWeaveStructure({
      root: input.root,
      project: input.project,
      llm: async () => JSON.stringify({
        bookOutline: "测试结构",
        volumes: [{ volumeNumber: 1, title: "测试卷", startChapter: 1, endChapter: target, body: "测试卷目标" }],
      }),
    });
    await adoptWeave({ root: input.root, project: input.project, artifactId: structured.artifactId });
  }
  return generateWeaveRangeCore(input);
}

async function generateChapterDraft(input: Parameters<typeof generateChapterDraftCore>[0]) {
  const manifest = await loadManifest(input.root);
  if (!manifest.adopted.weave && input.root.bookId) {
    const target = await resolveWeaveTargetChapters(input.root);
    const structured = await generateWeaveStructure({
      root: input.root,
      project: input.project,
      llm: async () => JSON.stringify({
        bookOutline: "测试结构",
        volumes: [{ volumeNumber: 1, title: "测试卷", startChapter: 1, endChapter: target, body: "测试卷目标" }],
      }),
    });
    await adoptWeave({ root: input.root, project: input.project, artifactId: structured.artifactId });
    const planned = await generateWeaveRangeCore({
      root: input.root,
      project: input.project,
      startChapter: input.chapterNumber,
      endChapter: input.chapterNumber,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: input.chapterNumber, title: "渡口", summary: "测试章概要，含视角地点冲突转折。" }],
      }),
    });
    await adoptWeave({ root: input.root, project: input.project, artifactId: planned.artifactId });
  }
  return generateChapterDraftCore(input);
}
import type { AuthoringLlmFn } from "../authoring/types.js";

const project = ProjectConfigSchema.parse({ name:"test", version:"0.1.0", llm:{ provider:"custom", service:"test", configSource:"studio", baseUrl:"https://example.invalid/v1", model:"test", apiKey:"test" } });
const canon = { title:"渡口", oneLine:"归还旧信", proposition:"", protagonist:"", conflict:"", voice:"", boundaries:"", direction:"", openQuestions:[] };
const requirement = "保留内容：渡口旧信。修改重点：收紧冲突。";
describe("ink task requirements", () => {
  const roots:string[]=[];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
  async function fixture(llm:AuthoringLlmFn) {
    const projectRoot = await mkdtemp(join(tmpdir(),"ink-requirements-")); roots.push(projectRoot);
    const created = await createLightweightBook({projectRoot,canon});
    return {root:{projectRoot,bookId:created.bookId},project,llm};
  }
  it("round trips quoted titles and genres through canon metadata", () => {
    const original = {...canon,title:'渡口：他说"回来"\\第二页',genre:"现实\n短篇"};
    const read = parseCanon(serializeCanon(original));
    expect(read.title).toBe(original.title); expect(read.genre).toBe(original.genre);
  });
  it("ground regeneration and revision receive requirements and the current candidate", async () => {
    const prompts:string[]=[];
    const ctx=await fixture(async (call) => {
      const prompt=call.messages.map(message=>message.content).join("\n"); prompts.push(prompt);
      if (prompt.includes("拟定本书设定目录")) return JSON.stringify({categories:["人物"],entries:[{id:"person",name:"归人",category:"人物"}]});
      if (call.roleId === "ground.review") return JSON.stringify({summary:"需调整",coverage:"1项",issues:[{issueId:"g1",target:"person",title:"冲突",severity:"improve",suggestion:"更具体"}]});
      return "只属于当前候选的渡口旧信。";
    });
    await proposeSettingsCatalog(ctx);
    await generateGroundEntries(ctx);
    await generateGroundEntries({...ctx,entryIds:["person"],regenerate:true,requirements:requirement});
    expect(prompts.at(-1)).toContain(requirement);
    expect(prompts.at(-1)).toContain("只属于当前候选");
    const report=await reviewGroundEntries({...ctx,entryIds:["person"]});
    const revised=await reviseGroundEntry({...ctx,entryId:"person",reportId:report.reportId,selectedIssueIds:["g1"],requirements:requirement});
    expect(prompts.at(-1)).toContain(requirement);
    expect((await loadArtifact(ctx.root,revised.artifactIds[0]!))?.meta.status).toBe("candidate");
    expect((await loadManifest(ctx.root)).adopted.ground).toHaveLength(0);
  });
  it("weave checkpoints preserve requirements across pause, resume, and review revision", async () => {
    const prompts:string[]=[]; const runId=newRunId(); let first=true;
    const ctx=await fixture(async (call) => {
      const prompt=call.messages.map(message=>message.content).join("\n"); prompts.push(prompt);
      if(call.roleId === "weave.review") return JSON.stringify({summary:"冲突建议",coverage:"8章",issues:[{issueId:"v1",title:"冲突",severity:"improve",suggestion:"更明确"}]});
      const range=/第 (\d+)-(\d+) 章/.exec(prompt); const start=Number(range?.[1]??1); const end=Number(range?.[2]??4);
      if(first) { first=false; await saveRunControl(ctx.root,runId,"pause"); }
      return JSON.stringify({chapters:Array.from({length:end-start+1},(_,i)=>({chapterNumber:start+i,title:`渡口${start+i}`,summary:"保留渡口旧信，再收紧冲突。"}))});
    });
    const paused=await generateWeaveRange({...ctx,startChapter:1,endChapter:8,requirements:requirement,runId});
    expect(paused.status).toBe("paused");
    expect((await loadRun(ctx.root,runId))?.checkpoint?.requirements).toBe(requirement);
    const resumed=await generateWeaveRange({...ctx,startChapter:1,endChapter:8,resumeRunId:runId});
    expect(resumed.status).toBe("completed"); expect(prompts.at(-1)).toContain(requirement);
    const report=await reviewWeave({...ctx,artifactId:resumed.artifactId,coverage:"8章"});
    const revised=await reviseWeave({...ctx,artifactId:resumed.artifactId,reportId:report.reportId,selectedIssueIds:["v1"],startChapter:1,endChapter:4,requirements:requirement});
    expect(prompts.at(-1)).toContain(requirement);
    expect((await loadArtifact(ctx.root,revised))?.meta.status).toBe("candidate");
  });
  it("write regeneration uses the current candidate even before adoption", async () => {
    const prompts:string[]=[];
    const ctx=await fixture(async call=>{ prompts.push(call.messages.map(message=>message.content).join("\n")); return "尚未采用的渡口正文。"; });
    await generateChapterDraft({...ctx,chapterNumber:1});
    await generateChapterDraft({...ctx,chapterNumber:1,requirements:requirement});
    expect(prompts.at(-1)).toContain(requirement);
    expect(prompts.at(-1)).toContain("尚未采用的渡口正文");
  });
});
